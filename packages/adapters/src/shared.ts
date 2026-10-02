import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type {
  AgentInstance,
  Binding,
  Project,
  ResourceKind,
  ScanContext,
  ScanReport,
  SkillScope,
  SourceKind,
} from '@agentdeck/contracts';

export const MAX_SCAN_ENTRIES = 300;
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_SKILL_BYTES = 96 * 1024;

export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

export function normalizePath(p: string): string { return path.resolve(p); }

export function expandPath(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith(`~${path.sep}`) || p.startsWith('~/')) return path.resolve(homeDir, p.slice(2));
  return path.resolve(p);
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function existsDirectory(dir: string): Promise<boolean> {
  try { return (await lstat(dir)).isDirectory(); } catch { return false; }
}

export async function existsRegularFile(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

export async function findExecutable(env: NodeJS.ProcessEnv, candidates: string[]): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? '';
  const suffixes = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const variants = path.extname(candidate) ? [candidate] : suffixes.map((suffix) => `${candidate}${suffix}`);
      for (const filename of variants) {
        const full = path.resolve(directory, filename);
        if (await existsRegularFile(full)) return full;
      }
    }
  }
  return null;
}

export async function boundedRead(file: string, maxBytes = MAX_CONFIG_BYTES): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('unreadable-or-too-large');
  const contents = await readFile(file);
  if (contents.byteLength > maxBytes) throw new Error('unreadable-or-too-large');
  return contents;
}

export async function boundedText(file: string, maxBytes = MAX_CONFIG_BYTES): Promise<string> {
  return (await boundedRead(file, maxBytes)).toString('utf8').replace(/^\uFEFF/, '');
}

export async function directEntries(dir: string): Promise<string[]> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return [];
    const items = await readdir(dir, { withFileTypes: true });
    return items.slice(0, MAX_SCAN_ENTRIES).filter((entry) => !entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name));
  } catch { return []; }
}

export async function directDirectories(dir: string): Promise<string[]> {
  const items: string[] = [];
  for (const item of await directEntries(dir)) {
    try { if ((await lstat(item)).isDirectory()) items.push(item); } catch { /* disappearing entry */ }
  }
  return items;
}

export async function readJsonc<T = unknown>(file: string): Promise<{ value?: T; invalid: boolean }> {
  try {
    const text = await boundedText(file);
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as T;
    return errors.length ? { invalid: true } : { value, invalid: false };
  } catch { return { invalid: true }; }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function safeDescription(kind: ResourceKind, noun: string): string {
  if (kind === 'skill') return 'Skill discovered from a bounded local directory scan.';
  if (kind === 'plugin') return 'Plugin metadata discovered from local configuration.';
  return `MCP server declared in ${noun}.`;
}

export function baseBinding(args: {
  context: ScanContext;
  kind: ResourceKind;
  name: string;
  scope: SkillScope;
  sourceKind: SourceKind;
  sourcePath: string;
  nativeKey: string;
  description?: string;
  enabled?: boolean | null;
  parentId?: string | null;
  writable?: boolean;
  readOnlyReason?: string | null;
  diagnostics?: string[];
  identityPath?: string;
  projectId?: string | null;
}): Binding {
  const sourcePath = normalizePath(args.sourcePath);
  const projectId = args.projectId === undefined ? (args.context.project?.id ?? null) : args.projectId;
  const id = stableId('binding', args.context.instance.id, projectId ?? 'user', args.kind, args.scope, args.identityPath ?? sourcePath, args.nativeKey);
  return {
    id,
    resourceId: stableId('resource', args.kind, args.identityPath ?? sourcePath, args.nativeKey),
    instanceId: args.context.instance.id,
    projectId,
    kind: args.kind,
    name: args.name,
    description: args.description ?? safeDescription(args.kind, path.basename(sourcePath)),
    scope: args.scope,
    sourceKind: args.sourceKind,
    compatibilityClass: args.kind === 'skill' ? 'unknown' : 'agent-specific',
    parentId: args.parentId ?? null,
    sourcePath,
    nativeKey: args.nativeKey,
    enabled: args.enabled ?? null,
    runtime: 'unknown',
    writable: args.writable ?? false,
    readOnlyReason: args.readOnlyReason ?? (args.writable ? null : 'This native entry is read-only in the current compatibility scope.'),
    diagnostics: args.diagnostics ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export function report(bindings: Binding[], diagnostics: string[]): ScanReport {
  return { bindings, diagnostics: [...new Set(diagnostics)] };
}

export function instance(args: {
  agentId: string;
  name: string;
  configRoot: string;
  executable: string | null;
  discovery?: AgentInstance['discovery'];
  diagnostics?: string[];
}): AgentInstance {
  const configRoot = normalizePath(args.configRoot);
  const id = stableId('instance', args.agentId, configRoot);
  return {
    id,
    agentId: args.agentId,
    name: args.name,
    configRoot,
    version: null,
    executable: args.executable,
    discovery: args.discovery ?? 'auto',
    writable: false,
    checkedAt: new Date().toISOString(),
    diagnostics: args.diagnostics ?? [],
  };
}

export async function canonicalPath(p: string): Promise<string> {
  try { return await realpath(p); } catch { return path.resolve(p); }
}

export async function safeMcpFile<T = unknown>(file: string, diagnostics: string[], label: string): Promise<T | null> {
  if (!(await existsRegularFile(file))) return null;
  const parsed = await readJsonc<T>(file);
  if (parsed.invalid) diagnostics.push(`${label} contains invalid or oversized JSONC; its entries were skipped.`);
  return parsed.value ?? null;
}

export async function safeTomlFile<T = unknown>(file: string, diagnostics: string[], label: string, parse: (s: string) => T): Promise<{ value: T | null; text: string | null }> {
  if (!(await existsRegularFile(file))) return { value: null, text: null };
  try {
    const text = await boundedText(file);
    return { value: parse(text), text };
  } catch {
    diagnostics.push(`${label} contains invalid or oversized TOML; its entries were skipped.`);
    return { value: null, text: null };
  }
}

export async function safeFileMtime(file: string): Promise<string> {
  try { return (await stat(file)).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

export function projectScope(project?: Project): SkillScope { return project ? 'project' : 'user-global'; }

export async function scanSkillRoot(args: {
  root: string;
  context: ScanContext;
  scope: SkillScope;
  sourceKind: SourceKind;
  parentId?: string | null;
  projectId?: string | null;
  diagnostics: string[];
}): Promise<Binding[]> {
  const bindings: Binding[] = [];
  if (!(await existsDirectory(args.root))) return bindings;
  for (const dir of await directDirectories(args.root)) {
    const name = path.basename(dir);
    // Use non-following file checks so a skill symlink never escapes the registered root.
    let manifest: string | null = null;
    for (const candidate of [path.join(dir, 'SKILL.md'), path.join(dir, 'skill.md')]) {
      if (await existsRegularFile(candidate)) { manifest = candidate; break; }
    }
    if (!manifest) continue;
    try { await boundedRead(manifest, MAX_SKILL_BYTES); }
    catch {
      args.diagnostics.push(`Skill "${name}" has an unreadable or oversized manifest and was skipped.`);
      continue;
    }
    bindings.push(baseBinding({
      context: args.context,
      kind: 'skill',
      name,
      scope: args.scope,
      sourceKind: args.sourceKind,
      sourcePath: dir,
      nativeKey: path.resolve(dir),
      identityPath: await canonicalPath(dir),
      ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
      ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      description: safeDescription('skill', name),
      readOnlyReason: args.parentId ? 'This Skill is bundled with its parent plugin.' : 'Skill toggles are not validated for this client; the discovered files are read-only.',
    }));
  }
  return bindings;
}
