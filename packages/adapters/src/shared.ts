import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { isMap, isScalar, parseDocument } from 'yaml';
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
const MAX_SKILL_FRONTMATTER_BYTES = 8 * 1024;
const MAX_SKILL_DIRECTORY_DEPTH = 3;
const MAX_SKILL_DIRECTORY_VISITS = 600;

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

/**
 * Confirms an existing candidate is lexically and physically below root and
 * that none of its child path components is a symlink or Windows junction.
 * The registered root itself is the trust anchor; descendants are not.
 */
export async function isSafePathWithin(root: string, candidate: string): Promise<boolean> {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate)) return false;
  try {
    const rootInfo = await lstat(absoluteRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    const canonicalRoot = await realpath(absoluteRoot);
    const relative = path.relative(absoluteRoot, absoluteCandidate);
    let current = absoluteRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      if (current !== absoluteCandidate && !info.isDirectory()) return false;
      const canonicalCurrent = await realpath(current);
      if (!isWithin(canonicalRoot, canonicalCurrent)) return false;
    }
    return true;
  } catch { return false; }
}

/** Resolve a manifest-declared local path without allowing absolute or parent traversal. */
export function declaredPath(root: string, declaration: string): string | null {
  if (!declaration || declaration.includes('\0') || path.isAbsolute(declaration) || /^[A-Za-z]:[\\/]/.test(declaration)) return null;
  const candidate = path.resolve(root, declaration);
  return isWithin(root, candidate) ? candidate : null;
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

export async function directEntries(dir: string, diagnostics?: string[], label = 'Scan directory'): Promise<string[]> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    const items = (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (items.length > MAX_SCAN_ENTRIES) diagnostics?.push(`${label} exceeded its bounded directory-entry limit.`);
    return items.slice(0, MAX_SCAN_ENTRIES).filter((entry) => !entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name));
  } catch { return []; }
}

export async function directDirectories(dir: string, diagnostics?: string[], label?: string): Promise<string[]> {
  const items: string[] = [];
  for (const item of await directEntries(dir, diagnostics, label)) {
    try {
      const info = await lstat(item);
      if (info.isDirectory() && !info.isSymbolicLink()) items.push(item);
    } catch { /* disappearing entry */ }
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

  export function mcpTransport(value: unknown): NonNullable<Binding['mcpTransport']> {
  const server = object(value);
  const hasCommand = typeof server?.command === 'string';
  const hasUrl = typeof server?.url === 'string';
  if (hasCommand && hasUrl) return 'unknown';
    if (hasCommand) return server?.type === undefined || server.type === 'stdio' ? 'stdio' : 'unknown';
    if (hasUrl) return server?.type === undefined || server.type === 'http' || server.type === 'sse' ? 'http' : 'unknown';
  return 'unknown';
}

export function safeDescription(kind: ResourceKind, noun: string): string {
  if (kind === 'skill') return 'Skill 来自有限本地目录扫描。';
  if (kind === 'plugin') return '插件元数据来自本地配置发现。';
  return `声明于 ${noun} 的 MCP 服务器。`;
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
  displayName?: string;
  discoveryOnly?: boolean;
  discoveryPath?: string;
  enabled?: boolean | null;
  parentId?: string | null;
  writable?: boolean;
  readOnlyReason?: string | null;
  diagnostics?: string[];
  identityPath?: string;
  projectId?: string | null;
  origin?: Binding['origin'];
  pluginId?: string;
  pluginVersion?: string;
  marketplace?: string;
  configurationSourcePath?: string;
  configurationKey?: string;
  configurationEnabled?: boolean | null;
  cacheState?: Binding['cacheState'];
  mcpTransport?: Binding['mcpTransport'];
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
    ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
    ...(args.discoveryOnly === undefined ? {} : { discoveryOnly: args.discoveryOnly }),
    ...(args.discoveryPath === undefined ? {} : { discoveryPath: args.discoveryPath }),
    scope: args.scope,
    sourceKind: args.sourceKind,
    compatibilityClass: args.kind === 'skill' ? 'unknown' : 'agent-specific',
    parentId: args.parentId ?? null,
    sourcePath,
    nativeKey: args.nativeKey,
    enabled: args.enabled ?? null,
    runtime: 'unknown',
    writable: args.writable ?? false,
    readOnlyReason: args.readOnlyReason ?? (args.writable ? null : '该原生条目在当前兼容范围内只读。'),
    diagnostics: args.diagnostics ?? [],
    updatedAt: new Date().toISOString(),
    ...(args.origin === undefined ? {} : { origin: args.origin }),
    ...(args.pluginId === undefined ? {} : { pluginId: args.pluginId }),
    ...(args.pluginVersion === undefined ? {} : { pluginVersion: args.pluginVersion }),
    ...(args.marketplace === undefined ? {} : { marketplace: args.marketplace }),
    ...(args.configurationSourcePath === undefined ? {} : { configurationSourcePath: normalizePath(args.configurationSourcePath) }),
    ...(args.configurationKey === undefined ? {} : { configurationKey: args.configurationKey }),
    ...(args.configurationEnabled === undefined ? {} : { configurationEnabled: args.configurationEnabled }),
    ...(args.cacheState === undefined ? {} : { cacheState: args.cacheState }),
    ...(args.mcpTransport === undefined ? {} : { mcpTransport: args.mcpTransport }),
  };
}

export function report(bindings: Binding[], diagnostics: string[]): ScanReport {
  return { bindings: [...new Map(bindings.map(binding => [binding.id, binding])).values()], diagnostics: [...new Set(diagnostics)] };
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
  if (parsed.invalid) diagnostics.push(`写前检查失败：${label} 包含非法或超限的 JSONC，其条目已跳过。`);
  return parsed.value ?? null;
}

export async function safeTomlFile<T = unknown>(file: string, diagnostics: string[], label: string, parse: (s: string) => T): Promise<{ value: T | null; text: string | null }> {
  if (!(await existsRegularFile(file))) return { value: null, text: null };
  try {
    const text = await boundedText(file);
    return { value: parse(text), text };
  } catch {
    diagnostics.push(`写前检查失败：${label} 包含非法或超限的 TOML，其条目已跳过。`);
    return { value: null, text: null };
  }
}

export async function safeFileMtime(file: string): Promise<string> {
  try { return (await stat(file)).mtime.toISOString(); } catch { return new Date().toISOString(); }
}

export function projectScope(project?: Project): SkillScope { return project ? 'project' : 'user-global'; }

interface SkillDisplayMetadata { name: string | null; description: string | null }

function displayScalar(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function readSkillDisplayMetadata(contents: Buffer): SkillDisplayMetadata {
  const text = contents.toString('utf8').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || Buffer.byteLength(match[1]!, 'utf8') > MAX_SKILL_FRONTMATTER_BYTES) return { name: null, description: null };
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' });
    if (document.errors.length || !isMap(document.contents)) return { name: null, description: null };
    const name = document.contents.get('name', true);
    const description = document.contents.get('description', true);
    return {
      name: isScalar(name) ? displayScalar(name.value, 120) : null,
      description: isScalar(description) ? displayScalar(description.value, 500) : null,
    };
  } catch { return { name: null, description: null }; }
}

async function skillManifest(directory: string): Promise<string | null> {
  for (const filename of ['SKILL.md', 'skill.md']) {
    const candidate = path.join(directory, filename);
    if (await existsRegularFile(candidate)) return candidate;
  }
  return null;
}

export async function scanSkillRoot(args: {
  root: string;
  context: ScanContext;
  scope: SkillScope;
  sourceKind: SourceKind;
  parentId?: string | null;
  projectId?: string | null;
  diagnostics: string[];
  origin?: Binding['origin'];
  pluginId?: string;
  pluginVersion?: string;
  marketplace?: string;
  configurationSourcePath?: string;
  configurationKey?: string;
  configurationEnabled?: boolean | null;
  cacheState?: Binding['cacheState'];
}): Promise<Binding[]> {
  const bindings: Binding[] = [];
  if (!(await existsDirectory(args.root))) return bindings;
  let visited = 0;
  const walk = async (root: string, depth: number): Promise<void> => {
    if (visited >= MAX_SKILL_DIRECTORY_VISITS) return;
    for (const info of await directDirectories(root, args.diagnostics, 'Skill root')) {
      if (visited >= MAX_SKILL_DIRECTORY_VISITS) break;
      visited += 1;
      const name = path.basename(info);
      if (name.startsWith('.') || !(await isSafePathWithin(args.root, info))) continue;
      const manifest = await skillManifest(info);
      if (!manifest) {
        if (depth < MAX_SKILL_DIRECTORY_DEPTH) await walk(info, depth + 1);
        continue;
      }
      let metadata: SkillDisplayMetadata;
      try { metadata = readSkillDisplayMetadata(await boundedRead(manifest, MAX_SKILL_BYTES)); }
      catch {
        args.diagnostics.push(`Skill "${name}" 的 manifest 不可读或超限，已跳过。`);
        continue;
      }
      const nested = depth > 1;
      bindings.push(baseBinding({
        context: args.context,
        kind: 'skill',
        name,
        scope: args.scope,
        sourceKind: args.sourceKind,
        sourcePath: info,
        nativeKey: path.resolve(info),
        identityPath: await canonicalPath(info),
        enabled: nested ? null : args.configurationEnabled ?? null,
        ...(metadata.name ? { displayName: metadata.name } : {}),
        ...(nested ? { discoveryOnly: true, discoveryPath: path.relative(args.root, info).split(path.sep).join('/') } : {}),
        ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.origin === undefined ? {} : { origin: args.origin }),
        ...(args.pluginId === undefined ? {} : { pluginId: args.pluginId }),
        ...(args.pluginVersion === undefined ? {} : { pluginVersion: args.pluginVersion }),
        ...(args.marketplace === undefined ? {} : { marketplace: args.marketplace }),
        ...(args.configurationSourcePath === undefined ? {} : { configurationSourcePath: args.configurationSourcePath }),
        ...(args.configurationKey === undefined ? {} : { configurationKey: args.configurationKey }),
        ...(args.configurationEnabled === undefined ? {} : { configurationEnabled: nested ? null : args.configurationEnabled }),
        ...(args.cacheState === undefined ? {} : { cacheState: args.cacheState }),
        description: metadata.description ?? safeDescription('skill', name),
        diagnostics: nested ? ['分组目录中的 Skill 仅为磁盘发现；当前客户端版本是否加载该路径尚未验证。'] : [],
        readOnlyReason: nested ? '分组目录的客户端可见性与开关语义尚未验证；仅作只读盘点。'
          : args.parentId ? '该 Skill 随父插件附带。' : '该客户端的 Skill 开关尚未验证；发现的文件保持只读。',
      }));
    }
  };
  await walk(args.root, 1);
  if (visited >= MAX_SKILL_DIRECTORY_VISITS) args.diagnostics.push('Skill 分组目录扫描达到总目录数上限。');
  return bindings;
}

export async function scanSingleSkill(args: {
  directory: string;
  context: ScanContext;
  parentId: string;
  pluginId?: string;
  pluginVersion?: string;
  marketplace?: string;
  configurationSourcePath?: string;
  configurationKey?: string;
  configurationEnabled?: boolean | null;
  origin?: Binding['origin'];
  cacheState?: Binding['cacheState'];
  diagnostics: string[];
}): Promise<Binding[]> {
  for (const filename of ['SKILL.md', 'skill.md']) {
    const manifest = path.join(args.directory, filename);
    if (!(await existsRegularFile(manifest))) continue;
    let metadata: SkillDisplayMetadata;
    try { metadata = readSkillDisplayMetadata(await boundedRead(manifest, MAX_SKILL_BYTES)); }
    catch {
      args.diagnostics.push('某个插件声明的 Skill manifest 不可读或超限，已跳过。');
      return [];
    }
    return [baseBinding({
      context: args.context, kind: 'skill', name: path.basename(args.directory), scope: 'native',
      ...(metadata.name ? { displayName: metadata.name } : {}),
      description: metadata.description ?? safeDescription('skill', path.basename(args.directory)),
      sourceKind: 'plugin', sourcePath: args.directory, nativeKey: path.resolve(args.directory),
      identityPath: await canonicalPath(args.directory), parentId: args.parentId, projectId: null,
      origin: args.origin ?? 'cache', ...(args.pluginId === undefined ? {} : { pluginId: args.pluginId }),
      ...(args.pluginVersion === undefined ? {} : { pluginVersion: args.pluginVersion }),
      ...(args.marketplace === undefined ? {} : { marketplace: args.marketplace }),
      ...(args.configurationSourcePath === undefined ? {} : { configurationSourcePath: args.configurationSourcePath }),
      ...(args.configurationKey === undefined ? {} : { configurationKey: args.configurationKey }),
      ...(args.configurationEnabled === undefined ? {} : { configurationEnabled: args.configurationEnabled }),
      cacheState: args.cacheState ?? (args.origin === 'filesystem' ? 'unknown' : 'present'), enabled: args.configurationEnabled ?? null,
      readOnlyReason: '该 Skill 随插件缓存附带，不能独立修改。',
    })];
  }
  return [];
}
