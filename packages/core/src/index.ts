import { createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import type {
  AdapterInfo, AgentAdapter, AgentInstance, Binding, Catalog, Project,
} from '@agentdeck/contracts';

type RegisterInstanceInput = { agentId: string; name?: string; configRoot: string; writable?: boolean };
type RegisterProjectInput = { name?: string; rootPath: string };
type ScanInput = { discover?: boolean; instanceId?: string; projectId?: string };

export interface ManagerOptions {
  store: ManagerStore;
  adapters: AgentAdapter[];
  homeDir: string;
  demoDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface ManagerStore {
  catalog(): Catalog;
  setMetadata(key: string, value: string): void;
  putInstance(value: AgentInstance): void;
  getInstance(id: string): AgentInstance | null;
  putProject(value: Project): void;
  getProject(id: string): Project | null;
  replaceBindings(instanceId: string, values: Binding[]): void;
}

export class ManagerService {
  readonly store: ManagerStore;
  readonly adapters: AgentAdapter[];
  readonly homeDir: string;
  readonly demoDir: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;

  constructor(options: ManagerOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.homeDir = path.resolve(options.homeDir);
    this.demoDir = path.resolve(options.demoDir ?? (process.env.AGENTDECK_HOME ? path.join(process.env.AGENTDECK_HOME, 'demo') : path.join(process.cwd(), 'work', 'demo')));
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  catalog(): Catalog { return this.store.catalog(); }
  adapterInfos(): AdapterInfo[] { return this.adapters.map(adapter => adapter.info); }

  registerInstance(input: RegisterInstanceInput): AgentInstance {
    const adapter = this.adapter(input.agentId);
    if (!adapter) throw new ManagerError(400, 'UNSUPPORTED_AGENT', `No adapter is registered for ${input.agentId}.`);
    const configRoot = path.resolve(input.configRoot);
    const existing = this.store.catalog().instances.find(instance =>
      instance.agentId === input.agentId && canonical(instance.configRoot) === canonical(configRoot),
    );
    const discovery = 'manual' as const;
    const instance: AgentInstance = {
      id: existing?.id ?? stableId('instance', `${input.agentId}\0${canonical(configRoot)}`),
      agentId: input.agentId,
      name: input.name?.trim() || existing?.name || `${adapter.name} (manual)`,
      configRoot,
      version: existing?.version ?? null,
      executable: existing?.executable ?? null,
      discovery,
      // Writing is intentionally limited to explicit user registration of a Codex root.
      writable: input.writable === true && input.agentId === 'codex',
      checkedAt: this.now().toISOString(),
      diagnostics: [...(existing?.diagnostics ?? []), ...(input.writable === true && input.agentId !== 'codex'
        ? ['This adapter has no first-round write support; registered read-only.']
        : [])],
    };
    this.store.putInstance(instance);
    return instance;
  }

  registerProject(input: RegisterProjectInput): Project {
    const rootPath = path.resolve(input.rootPath);
    const name = input.name?.trim() || path.basename(rootPath) || rootPath;
    const project: Project = { id: stableId('project', canonical(rootPath)), name, rootPath };
    this.store.putProject(project);
    return project;
  }

  async scan(input: ScanInput = {}): Promise<Catalog> {
    if (input.discover) {
      const discovered = await Promise.allSettled(this.adapters.map(adapter => adapter.discover({ homeDir: this.homeDir, env: this.env })));
      for (let index = 0; index < discovered.length; index += 1) {
        const result = discovered[index];
        const adapter = this.adapters[index];
        if (!result || !adapter || result.status !== 'fulfilled') continue;
        for (const found of result.value) {
          const configRoot = path.resolve(found.configRoot);
          const existing = this.store.catalog().instances.find(instance =>
            instance.agentId === adapter.id && canonical(instance.configRoot) === canonical(configRoot),
          );
          if (existing?.discovery === 'manual') {
            // Discovery may refresh observations, but it must never revoke an explicit opt-in.
            this.store.putInstance({
              ...existing,
              version: found.version ?? existing.version,
              executable: found.executable ?? existing.executable,
              checkedAt: this.now().toISOString(),
              diagnostics: [...new Set([...existing.diagnostics, ...found.diagnostics])],
            });
            continue;
          }
          const instance = { ...found, id: existing?.id ?? found.id, configRoot: existing?.configRoot ?? configRoot, agentId: adapter.id, discovery: 'auto' as const, writable: false };
          this.store.putInstance(instance);
        }
      }
    }

    const project = input.projectId ? this.store.getProject(input.projectId) : null;
    if (input.projectId && !project) throw new ManagerError(404, 'PROJECT_NOT_FOUND', 'The selected project is not registered.');
    const catalog = this.store.catalog();
    const instances = input.instanceId
      ? catalog.instances.filter(instance => instance.id === input.instanceId)
      : catalog.instances;
    if (input.instanceId && instances.length === 0) throw new ManagerError(404, 'INSTANCE_NOT_FOUND', 'The selected Agent instance is not registered.');

    for (const instance of instances) {
      const adapter = this.adapter(instance.agentId);
      if (!adapter) continue;
      try {
        const report = await adapter.scan(project ? { instance, project } : { instance });
        const scanned = report.bindings.map(binding => {
          const demoCodexMcp = instance.discovery === 'demo' && instance.agentId === 'codex' && binding.kind === 'mcp' && binding.name === 'agentdeck-demo' && binding.writable && isInside(binding.sourcePath, instance.configRoot);
          const explicitlyWritableCodex = instance.discovery === 'manual' && instance.agentId === 'codex' && instance.writable && binding.writable;
          const writable = Boolean(demoCodexMcp || explicitlyWritableCodex);
          return {
          ...binding,
          instanceId: instance.id,
          writable,
          readOnlyReason: writable ? null : binding.readOnlyReason ?? (instance.discovery === 'auto' ? 'Automatically discovered instances are read-only.' : 'This resource has no verified write mechanism.'),
          runtime: binding.runtime ?? 'unknown',
          diagnostics: [...binding.diagnostics, ...report.diagnostics],
          updatedAt: this.now().toISOString(),
          };
        });
        const retained = this.store.catalog().bindings.filter(binding =>
          binding.instanceId === instance.id && (project ? binding.projectId !== project.id : binding.projectId !== null),
        );
        const merged = new Map<string, Binding>();
        for (const binding of retained) merged.set(binding.id, binding);
        for (const binding of scanned) merged.set(binding.id, binding);
        this.store.replaceBindings(instance.id, [...merged.values()]);
      } catch {
        // Preserve the last known index when an adapter cannot complete a scan.
        const prior = this.store.getInstance(instance.id);
        if (prior) this.store.putInstance({ ...prior, diagnostics: [...prior.diagnostics, 'Scanning failed; the previous index was retained.'] });
      }
    }
    this.store.setMetadata('lastScanAt', this.now().toISOString());
    return this.store.catalog();
  }

  async initializeDemo(): Promise<Catalog> {
    await mkdir(this.demoDir, { recursive: true });
    const samples: Array<{ agentId: string; relative: string; name: string; skill: string }> = [
      { agentId: 'codex', relative: 'codex', name: 'Codex Demo', skill: 'codex-review' },
      { agentId: 'claude-code', relative: 'claude-code', name: 'Claude Code Demo', skill: 'claude-review' },
      { agentId: 'zcode', relative: 'zcode', name: 'ZCode Demo', skill: 'zcode-review' },
      { agentId: 'deepseek-harness', relative: 'deepseek-harness', name: 'DeepSeek Harness Demo', skill: 'dsh-review' },
    ];
    const skillBody = (name: string, client: string) => `---\nname: ${name}\ndescription: Isolated ${client} AgentDeck demo skill.\n---\n\nUse this local sample to review a change before committing.\n`;
    const instances: AgentInstance[] = [];
    for (const sample of samples) {
      const configRoot = path.join(this.demoDir, sample.relative);
      const instance: AgentInstance = {
        id: stableId('instance', `demo\0${sample.agentId}`), agentId: sample.agentId,
        name: sample.name, configRoot, version: null, executable: null,
        discovery: 'demo', writable: sample.agentId === 'codex',
        checkedAt: this.now().toISOString(),
        diagnostics: ['Isolated demo files; no real Agent configuration is touched.', 'Client-version compatibility is experimental and has not been verified.'],
      };
      await mkdir(configRoot, { recursive: true });
      const skillDirectory = path.join(configRoot, 'skills', sample.skill);
      await mkdir(skillDirectory, { recursive: true });
      await writeIfMissing(path.join(skillDirectory, 'SKILL.md'), skillBody(sample.skill, sample.name));
      instances.push(instance);
      this.store.putInstance(instance);
    }

    const codex = instances.find(instance => instance.agentId === 'codex')!;
    const codexConfig = path.join(codex.configRoot, 'config.toml');
    await writeIfMissing(codexConfig, '[mcp_servers.agentdeck-demo]\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\nenabled = true\n');
    for (const instance of instances) {
      // Use each adapter's real scanner so demo rows exercise the same discovery rules and IDs as real catalog rows.
      await this.scan({ instanceId: instance.id });
    }
    this.store.setMetadata('lastScanAt', this.now().toISOString());
    return this.store.catalog();
  }

  adapter(id: string): AgentAdapter | undefined { return this.adapters.find(item => item.id === id); }
}

export class ManagerError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function stableId(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
export function canonical(inputPath: string): string { return path.resolve(inputPath).replace(/\\/g, '/').toLocaleLowerCase('en-US'); }
function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function writeIfMissing(filePath: string, contents: string): Promise<void> {
  try { await access(filePath); } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    try { await writeFile(filePath, contents, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
