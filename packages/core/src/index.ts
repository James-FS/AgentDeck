import { createHash } from 'node:crypto';
import { mkdir, writeFile, access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AdapterInfo, AgentAdapter, AgentId, AgentInstance, Binding, Catalog, ClientCompatibilityReport,
  ClientVersionEvidence, CompatibilityReport, ExecutableIdentity, Project,
} from '@agentdeck/contracts';
import {
  inspectExecutable, parseRecognizedVersion, resolvePathExecutable, runVersionCommand, sameExecutable,
  VERSION_CHECK_MAX_OUTPUT_BYTES, VERSION_CHECK_TIMEOUT_MS,
  type ExecutableResolver, type VersionCheckRunner,
} from './version-check.js';
import { buildCapabilityEvidence } from './compatibility.js';
import { assessRuntimeEvidence, type RuntimeEvidenceProvider } from './runtime.js';
export type { RuntimeEvidenceProvider, RuntimeEvidenceSnapshot, VerifiedClientSession, McpSessionEvidence } from './runtime.js';

type RegisterInstanceInput = { agentId: string; name?: string; configRoot: string; writable?: boolean };
type RegisterProjectInput = { name?: string; rootPath: string };
type ScanInput = { discover?: boolean; instanceId?: string; projectId?: string; discoveryContext?: { homeDir: string; env: NodeJS.ProcessEnv } };

export interface ManagerOptions {
  store: ManagerStore;
  adapters: AgentAdapter[];
  homeDir: string;
  demoDir?: string;
  env?: NodeJS.ProcessEnv;
  isolationRoot?: string;
  executableResolver?: ExecutableResolver;
  versionRunner?: VersionCheckRunner;
  platform?: NodeJS.Platform;
  now?: () => Date;
  runtimeEvidenceProvider?: RuntimeEvidenceProvider;
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
  readonly isolationRoot: string;
  readonly executableResolver: ExecutableResolver;
  readonly versionRunner: VersionCheckRunner;
  readonly platform: NodeJS.Platform;
  private readonly now: () => Date;
  private readonly runtimeEvidenceProvider: RuntimeEvidenceProvider | undefined;

  constructor(options: ManagerOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.homeDir = path.resolve(options.homeDir);
    this.demoDir = path.resolve(options.demoDir ?? (process.env.AGENTDECK_HOME ? path.join(process.env.AGENTDECK_HOME, 'demo') : path.join(process.cwd(), 'work', 'demo')));
    this.env = options.env ?? process.env;
    this.isolationRoot = path.resolve(options.isolationRoot ?? path.join(os.tmpdir(), `agentdeck-version-checks-${process.pid}`));
    this.executableResolver = options.executableResolver ?? resolvePathExecutable;
    this.versionRunner = options.versionRunner ?? runVersionCommand;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date());
    this.runtimeEvidenceProvider = options.runtimeEvidenceProvider;
  }

  catalog(): Catalog { return this.store.catalog(); }
  async runtimeReport() {
    const catalog = this.store.catalog();
    if (!this.runtimeEvidenceProvider) return assessRuntimeEvidence(catalog, this.now());
    try {
      const snapshot = await this.runtimeEvidenceProvider.readCurrentEvidence(catalog);
      return assessRuntimeEvidence(catalog, this.now(), snapshot);
    } catch {
      // A provider failure never becomes a resource failure or exposes its raw response.
      return assessRuntimeEvidence(catalog, this.now());
    }
  }
  adapterInfos(): AdapterInfo[] { return this.adapters.map(adapter => adapter.info); }

  async compatibilityReport(): Promise<CompatibilityReport> {
    const generatedAt = this.now().toISOString();
    const catalog = this.store.catalog();
    const clients: ClientCompatibilityReport[] = [];
    for (const adapter of this.adapters) {
      const registered = catalog.instances.filter(instance => instance.agentId === adapter.id);
      if (registered.length === 0) {
        const knownAgent = isAgentId(adapter.id);
        const agentId = adapter.id as AgentId;
        const configRoot = knownAgent ? this.defaultConfigRoot(agentId) : null;
        const candidate = knownAgent ? await this.currentExecutable(agentId, generatedAt) : null;
        const configurationState = configRoot && await directoryExists(configRoot) ? 'present' : 'missing';
        const status = candidate ? 'executable-unverified' : configurationState === 'present' ? 'configuration-only' : 'not-found';
        clients.push({
          id: stableId('compatibility', `${agentId}\0unregistered`), agentId, agentName: adapter.info.name,
          instanceId: null, instanceName: null, configRoot, status, configurationState,
          executableCandidate: candidate, versionEvidence: null, checkedAt: null,
          capabilities: buildCapabilityEvidence({ agentId, versionEvidence: null, optedInCodexWrite: false }),
          diagnostics: [
            ...(candidate ? ['存在 PATH 可执行候选；尚未检查出已识别的客户端版本。这不证明官方安装。'] : []),
            ...(configurationState === 'present' && !candidate ? ['The configuration directory exists, but no PATH executable candidate was found.'] : []),
          ],
        });
        continue;
      }
      for (const instance of registered) clients.push(await this.clientCompatibility(adapter.info.name, instance, generatedAt));
    }
    return { generatedAt, clients };
  }

  async checkVersion(instanceId: string): Promise<CompatibilityReport> {
    const instance = this.store.getInstance(instanceId);
    if (!instance) throw new ManagerError(404, 'INSTANCE_NOT_FOUND', '所选 Agent 实例未登记。');
    if (instance.discovery === 'demo') {
      const diagnostics = instance.diagnostics.filter(item => !item.startsWith('版本检查：'));
      diagnostics.push('版本检查：隔离演示实例不探测主机可执行文件。');
      this.store.putInstance({ ...instance, version: null, executable: null, versionEvidence: null, diagnostics });
      return this.compatibilityReport();
    }
    const agentId = instance.agentId as AgentId;
    const checkedAt = this.now().toISOString();
    let candidate: ExecutableIdentity | null = null;
    let versionEvidence: ClientVersionEvidence | null = null;
    let message: string | null = null;
    try {
      if (!isAgentId(instance.agentId)) throw new Error('unsupported-client');
      const executable = await this.executableResolver(agentId, this.env);
      candidate = executable ? await inspectExecutable(executable, checkedAt) : null;
      if (!candidate) {
        message = '版本检查：服务 PATH 上未发现可执行候选。';
      } else if (agentId !== 'codex' && agentId !== 'claude-code') {
        message = '版本检查：该客户端没有已验证的版本检查命令。';
      } else {
        const isolated = await this.createIsolatedVersionEnvironment(agentId, instanceId);
        try {
          const output = await this.versionRunner({
            executable: candidate.path, args: ['--version'], cwd: isolated.cwd, env: isolated.env,
            timeoutMs: VERSION_CHECK_TIMEOUT_MS, maxOutputBytes: VERSION_CHECK_MAX_OUTPUT_BYTES,
          });
          const parsed = output.exitCode === 0 ? parseRecognizedVersion(agentId, output.stdout) : null;
          if (!parsed) {
            message = '版本检查：输出未匹配已识别的 CLI 版本签名。';
          } else {
            versionEvidence = { ...parsed, executable: candidate, platform: this.platform, checkedAt };
          }
        } catch {
          message = '版本检查：隔离版本命令失败、超时或超出输出上限。';
        } finally {
          await rm(isolated.directory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } catch {
      message = '版本检查：服务无法解析或检查 PATH 可执行候选。';
    }
    const confirmedCandidate = candidate ? await inspectExecutable(candidate.path, checkedAt) : null;
    const confirmedEvidence = versionEvidence && sameExecutable(candidate, confirmedCandidate) ? versionEvidence : null;
    if (versionEvidence && !confirmedEvidence) message = '版本检查：检查期间可执行文件发生变化，已丢弃存储的版本证据。';
    const latestInstance = this.store.getInstance(instanceId) ?? instance;
    const diagnostics = latestInstance.diagnostics.filter(item => !item.startsWith('版本检查：'));
    if (message) diagnostics.push(message);
    this.store.putInstance({
      ...latestInstance,
      executable: confirmedCandidate?.path ?? null,
      version: confirmedEvidence?.version ?? null,
      versionEvidence: confirmedEvidence,
      checkedAt,
      diagnostics,
    });
    return this.compatibilityReport();
  }

  private async clientCompatibility(agentName: string, original: AgentInstance, generatedAt: string): Promise<ClientCompatibilityReport> {
    const instance = original.discovery === 'demo'
      ? await this.clearDemoVersionObservation(original, generatedAt)
      : isAgentId(original.agentId) ? await this.refreshExecutableObservation(original, generatedAt) : original;
    const configurationState = await directoryExists(instance.configRoot) ? 'present' : 'missing';
    const candidate = instance.discovery === 'demo' || !isAgentId(instance.agentId) || !instance.executable ? null : await inspectExecutable(instance.executable, generatedAt);
    const versionEvidence = isAgentId(instance.agentId) && validVersionEvidence(instance.versionEvidence, instance.agentId)
      && sameExecutable(instance.versionEvidence.executable, candidate) ? instance.versionEvidence : null;
    const status = instance.discovery === 'demo' ? 'demo'
      : versionEvidence ? 'verified-client'
        : candidate ? 'executable-unverified'
          : configurationState === 'present' ? 'configuration-only' : 'not-found';
    const diagnostics = [
      ...instance.diagnostics,
      ...(status === 'verified-client' ? ['已识别精确的 CLI 版本输出签名；这不验证发行方身份、桌面应用安装或资源运行状态。'] : []),
      ...(status === 'executable-unverified' ? ['存在 PATH 可执行候选，但其 CLI 版本输出未识别。这不证明官方安装。'] : []),
      ...(status === 'configuration-only' ? ['配置根是目录，但 PATH 上未发现可执行候选。'] : []),
    ];
    if (instance.versionEvidence && !versionEvidence) {
      const latest = this.store.getInstance(instance.id) ?? instance;
      if (sameVersionEvidence(latest.versionEvidence, instance.versionEvidence)) {
        this.store.putInstance({ ...latest, version: null, versionEvidence: null });
      }
    }
    const refreshed = this.store.getInstance(instance.id) ?? instance;
    const refreshedEvidence = isAgentId(refreshed.agentId) && validVersionEvidence(refreshed.versionEvidence, refreshed.agentId)
      && sameExecutable(refreshed.versionEvidence.executable, candidate) ? refreshed.versionEvidence : null;
    return {
    id: stableId('compatibility', `${refreshed.agentId}\0${refreshed.id}`),
      agentId: refreshed.agentId as AgentId, agentName, instanceId: refreshed.id, instanceName: refreshed.name,
      configRoot: refreshed.configRoot, status: refreshed.discovery === 'demo' ? 'demo' : refreshedEvidence ? 'verified-client'
        : candidate ? 'executable-unverified' : configurationState === 'present' ? 'configuration-only' : 'not-found',
      configurationState, executableCandidate: candidate,
      versionEvidence: refreshedEvidence, checkedAt: refreshedEvidence?.checkedAt ?? refreshed.checkedAt ?? null,
      capabilities: isAgentId(refreshed.agentId) ? buildCapabilityEvidence({
        agentId: refreshed.agentId, versionEvidence: refreshedEvidence,
        optedInCodexWrite: refreshed.agentId === 'codex' && refreshed.discovery === 'manual' && refreshed.writable,
      }) : [],
      diagnostics: [...new Set(diagnostics)],
    };
  }

  private async refreshExecutableObservation(original: AgentInstance, checkedAt: string): Promise<AgentInstance> {
    if (!isAgentId(original.agentId)) return original;
    const agentId = original.agentId;
    let candidate: ExecutableIdentity | null = null;
    try {
      const executable = await this.executableResolver(agentId, this.env);
      candidate = executable ? await inspectExecutable(executable, checkedAt) : null;
    } catch { /* resolver failure invalidates any previously stored candidate observation */ }
    const latest = this.store.getInstance(original.id) ?? original;
    if (latest.agentId !== original.agentId || latest.discovery === 'demo') return latest;
    const oldEvidence = validVersionEvidence(latest.versionEvidence, agentId) ? latest.versionEvidence : null;
    const retainedEvidence = oldEvidence && sameExecutable(oldEvidence.executable, candidate) ? oldEvidence : null;
    const candidatePath = candidate?.path ?? null;
    const evidenceWasCleared = latest.versionEvidence !== undefined && latest.versionEvidence !== null && retainedEvidence === null;
    const legacyVersionWasCleared = latest.version !== null && retainedEvidence === null;
    const changed = latest.executable !== candidatePath || evidenceWasCleared || legacyVersionWasCleared
      || (retainedEvidence && latest.version !== retainedEvidence.version);
    if (!changed) return latest;
    const refreshed: AgentInstance = {
      ...latest,
      executable: candidatePath,
      version: retainedEvidence?.version ?? null,
      versionEvidence: retainedEvidence,
      checkedAt,
      diagnostics: latest.diagnostics.filter(item => !item.startsWith('版本检查：')),
    };
    this.store.putInstance(refreshed);
    return refreshed;
  }

  private async clearDemoVersionObservation(original: AgentInstance, checkedAt: string): Promise<AgentInstance> {
    if (original.executable === null && original.version === null && !original.versionEvidence) return original;
    const cleared: AgentInstance = { ...original, executable: null, version: null, versionEvidence: null, checkedAt };
    this.store.putInstance(cleared);
    return cleared;
  }

  private async currentExecutable(agentId: AgentId, checkedAt: string): Promise<ExecutableIdentity | null> {
    try {
      const candidate = await this.executableResolver(agentId, this.env);
      return candidate ? inspectExecutable(candidate, checkedAt) : null;
    } catch { return null; }
  }

  private defaultConfigRoot(agentId: AgentId): string {
    switch (agentId) {
      case 'codex': return path.resolve(this.env.CODEX_HOME || path.join(this.homeDir, '.codex'));
      case 'claude-code': return path.resolve(this.env.CLAUDE_CONFIG_DIR || path.join(this.homeDir, '.claude'));
      case 'zcode': return path.resolve(this.env.ZCODE_HOME || path.join(this.homeDir, '.zcode'));
      case 'deepseek-harness': return path.resolve(this.env.DSH_HOME || path.join(this.homeDir, '.dsh'));
    }
  }

  private async createIsolatedVersionEnvironment(agentId: AgentId, instanceId: string): Promise<{ directory: string; cwd: string; env: NodeJS.ProcessEnv }> {
    await mkdir(this.isolationRoot, { recursive: true });
    const directory = await mkdtemp(path.join(this.isolationRoot, `version-check-${stableId('instance', `${agentId}\0${instanceId}`)}-`));
    const home = path.join(directory, 'home');
    const cwd = path.join(directory, 'cwd');
    const appData = path.join(directory, 'appdata');
    const localAppData = path.join(directory, 'local-appdata');
    const configRoot = path.join(directory, 'client-config');
    const codexConfigRoot = path.join(configRoot, 'codex');
    const claudeConfigRoot = path.join(configRoot, 'claude');
    const zcodeConfigRoot = path.join(configRoot, 'zcode');
    const dshConfigRoot = path.join(configRoot, 'deepseek-harness');
    await Promise.all([home, cwd, appData, localAppData, codexConfigRoot, claudeConfigRoot, zcodeConfigRoot, dshConfigRoot].map(item => mkdir(item, { recursive: true })));
    const env: NodeJS.ProcessEnv = {
      PATH: this.env.PATH ?? this.env.Path ?? '',
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
      HOMEPATH: `\\${home.slice(path.parse(home).root.length).replace(/^[\\/]+/, '')}`,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: configRoot,
      CODEX_HOME: codexConfigRoot,
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
      ZCODE_HOME: zcodeConfigRoot,
      DSH_HOME: dshConfigRoot,
      TMP: directory,
      TEMP: directory,
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
      const value = this.env[key];
      if (value !== undefined) env[key] = value;
    }
    return { directory, cwd, env };
  }

  registerInstance(input: RegisterInstanceInput): AgentInstance {
    const adapter = this.adapter(input.agentId);
    if (!adapter) throw new ManagerError(400, 'UNSUPPORTED_AGENT', `${input.agentId} 没有已注册的适配器。`);
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
      version: existing?.versionEvidence?.version ?? null,
      executable: existing?.executable ?? null,
      ...(existing?.versionEvidence ? { versionEvidence: existing.versionEvidence } : { versionEvidence: null }),
      discovery,
      // Writing is intentionally limited to explicit user registration of a Codex root.
      writable: input.writable === true && input.agentId === 'codex',
      checkedAt: this.now().toISOString(),
      diagnostics: [...(existing?.diagnostics ?? []), ...(input.writable === true && input.agentId !== 'codex'
        ? ['该适配器本轮没有写入支持；登记为只读。']
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
      const discoveryContext = input.discoveryContext ?? { homeDir: this.homeDir, env: this.env };
      const discovered = await Promise.allSettled(this.adapters.map(adapter => adapter.discover(discoveryContext)));
      const previousInstances = this.store.catalog().instances;
      for (let index = 0; index < discovered.length; index += 1) {
        const result = discovered[index];
        const adapter = this.adapters[index];
        if (!result || !adapter || result.status !== 'fulfilled') continue;
        const seenIds = new Set<string>();
        for (const found of result.value) {
          const configRoot = path.resolve(found.configRoot);
          const existing = previousInstances.find(instance =>
            instance.agentId === adapter.id && canonical(instance.configRoot) === canonical(configRoot),
          );
          const id = existing?.id ?? found.id;
          seenIds.add(id);
          const executable = found.executable ? await inspectExecutable(found.executable, this.now().toISOString()) : null;
          const oldEvidence = existing && validVersionEvidence(existing.versionEvidence, adapter.id as AgentId)
            && sameExecutable(existing.versionEvidence.executable, executable) ? existing.versionEvidence : null;
          const diagnostics = [...new Set([...(existing?.diagnostics ?? []), ...found.diagnostics])]
            .filter(item => oldEvidence || !item.startsWith('版本检查：'));
          if (existing?.discovery === 'manual') {
            // Rediscovery refreshes identity but never revokes a deliberate write opt-in.
            this.store.putInstance({
              ...existing, version: oldEvidence?.version ?? null, versionEvidence: oldEvidence,
              executable: executable?.path ?? null, checkedAt: this.now().toISOString(), diagnostics,
            });
            continue;
          }
          this.store.putInstance({
            ...found,
            id,
            configRoot: existing?.configRoot ?? configRoot,
            agentId: adapter.id,
            discovery: 'auto',
            writable: false,
            executable: executable?.path ?? null,
            version: oldEvidence?.version ?? null,
            versionEvidence: oldEvidence,
            diagnostics,
          });
        }
        for (const old of previousInstances.filter(item => item.agentId === adapter.id && !seenIds.has(item.id))) {
          await this.refreshExecutableObservation(old, this.now().toISOString());
        }
      }
    }

    const project = input.projectId ? this.store.getProject(input.projectId) : null;
    if (input.projectId && !project) throw new ManagerError(404, 'PROJECT_NOT_FOUND', '所选项目未登记。');
    const catalog = this.store.catalog();
    const instances = input.instanceId
      ? catalog.instances.filter(instance => instance.id === input.instanceId)
      : catalog.instances;
    if (input.instanceId && instances.length === 0) throw new ManagerError(404, 'INSTANCE_NOT_FOUND', '所选 Agent 实例未登记。');

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
          readOnlyReason: writable ? null : binding.readOnlyReason ?? (instance.discovery === 'auto' ? '自动发现的实例固定只读。' : '该资源没有已验证的写入机制。'),
          runtime: binding.runtime ?? 'unknown',
          diagnostics: [...binding.diagnostics, ...report.diagnostics],
          updatedAt: this.now().toISOString(),
          };
        });
        const retained = this.store.catalog().bindings.filter(binding =>
          binding.instanceId === instance.id && (project
            ? binding.projectId !== null && binding.projectId !== project.id
            : binding.projectId !== null),
        );
        const merged = new Map<string, Binding>();
        for (const binding of retained) merged.set(binding.id, binding);
        for (const binding of scanned) merged.set(binding.id, binding);
        this.store.replaceBindings(instance.id, [...merged.values()]);
      } catch {
        // Preserve the last known index when an adapter cannot complete a scan.
        const prior = this.store.getInstance(instance.id);
        if (prior) this.store.putInstance({ ...prior, diagnostics: [...prior.diagnostics, '扫描失败；保留上一次的索引。'] });
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
        diagnostics: ['隔离演示文件；不触碰真实 Agent 配置。', '客户端版本兼容性为实验性，尚未验收。'],
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

async function directoryExists(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

function isAgentId(value: string): value is AgentId {
  return value === 'codex' || value === 'claude-code' || value === 'zcode' || value === 'deepseek-harness';
}

function validVersionEvidence(value: unknown, agentId: AgentId): value is ClientVersionEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ClientVersionEvidence>;
  const expectedSignature = agentId === 'codex' ? 'codex-cli-version' : agentId === 'claude-code' ? 'claude-code-version' : null;
  return expectedSignature !== null
    && candidate.signature === expectedSignature
    && typeof candidate.version === 'string'
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate.version)
    && typeof candidate.platform === 'string'
    && typeof candidate.checkedAt === 'string'
    && Boolean(candidate.executable && typeof candidate.executable.path === 'string'
      && typeof candidate.executable.realPath === 'string'
      && typeof candidate.executable.fileIdentity === 'string'
      && typeof candidate.executable.checkedAt === 'string');
}

function sameVersionEvidence(left: ClientVersionEvidence | null | undefined, right: ClientVersionEvidence | null | undefined): boolean {
  return Boolean(left && right && left.version === right.version && left.signature === right.signature
    && left.platform === right.platform && left.checkedAt === right.checkedAt
    && sameExecutable(left.executable, right.executable));
}

export function stableId(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
export { inspectExecutable, parseRecognizedVersion, resolvePathExecutable, runVersionCommand, sameExecutable } from './version-check.js';
export type { ExecutableResolver, VersionCheckRunner, VersionRunnerInput, VersionRunnerOutput } from './version-check.js';
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
