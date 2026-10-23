import { lstat, opendir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMap, parseDocument } from 'yaml';

export interface SkillDetails {
  name: string;
  description: string | null;
  author: string | null;
  version: string | null;
  license: string | null;
  environment: string | null;
  invocation: string | null;
  dependencies: string[];
  supports: string[];
  body: string;
  formatStatus: 'valid' | 'invalid';
  metadataIssues: string[];
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_AUX_BYTES = 128 * 1024;
const MAX_SUPPORT_FILES = 80;
const MAX_SUPPORT_DIRECTORIES = 100;
const MAX_SUPPORT_ENTRIES_PER_DIRECTORY = 2_000;
const MAX_SUPPORT_DEPTH = 3;
const MAX_BODY_CHARS = 1_000_000;

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return redactSecrets(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret)\b(\s*[:=]\s*)(["']?)[^\s"'`,;]{8,}\3/gi, '$1$2[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@');
}
function mapValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (isMap(value)) return value.toJSON() as Record<string, unknown>;
  return value as Record<string, unknown>;
}
function listStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.map(item => stringValue(item)).filter((item): item is string => item !== null).slice(0, 40);
}
function flattenMetadata(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  const visit = (item: unknown, prefix = '') => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry, prefix); return; }
    if (item && typeof item === 'object') {
      for (const [key, entry] of Object.entries(item)) visit(entry, prefix ? `${prefix}.${key}` : key);
    } else if (typeof item === 'string' && item.trim()) out.push(`${prefix}: ${item.trim()}`);
  };
  visit(value);
  return out.slice(0, 40);
}
function safeRelative(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`文件不是普通文件或超过 ${maxBytes} 字节。`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new Error(`文件超过 ${maxBytes} 字节。`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export async function readSkillDetails(skillDir: string, options: { includeSupports?: boolean; allowedRoot?: string } = {}): Promise<SkillDetails> {
  const directory = path.resolve(skillDir);
  const realDirectory = await realpath(directory);
  if (options.allowedRoot && !safeRelative(await realpath(options.allowedRoot), realDirectory)) throw new Error('Skill 实际路径超出已登记扫描范围。');
  if (!(await stat(realDirectory)).isDirectory()) throw new Error('Skill 路径不是目录。');
  const manifestPath = path.join(directory, 'SKILL.md');
  const lowerManifestPath = path.join(directory, 'skill.md');
  let actualManifest = manifestPath;
  try { await lstat(actualManifest); } catch { actualManifest = lowerManifestPath; }
  const manifestStat = await lstat(actualManifest);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error('SKILL.md 不是普通文件或超过 2 MiB。');
  const manifestReal = await realpath(actualManifest);
  if (!safeRelative(realDirectory, manifestReal)) throw new Error('SKILL.md 实际路径超出 Skill 目录边界。');
  const content = (await readBoundedText(actualManifest, MAX_MANIFEST_BYTES)).replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const issues: string[] = [];
  let meta: Record<string, unknown> = {};
  let body = content;
  let formatStatus: SkillDetails['formatStatus'] = 'invalid';
  if (match) {
    if (Buffer.byteLength(match[1]!, 'utf8') > 128 * 1024) {
      issues.push('frontmatter 超过 128 KiB，字段未解析。');
      body = content.slice(match[0].length);
    } else {
      const doc = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' });
      if (doc.errors.length || !isMap(doc.contents)) issues.push('frontmatter 格式异常；仍显示 Markdown 正文。');
      else {
        meta = mapValue(doc.contents); body = content.slice(match[0].length);
        formatStatus = typeof meta.name === 'string' && Boolean(meta.name.trim())
          && typeof meta.description === 'string' && Boolean(meta.description.trim()) ? 'valid' : 'invalid';
        if (formatStatus === 'invalid') issues.push('frontmatter 缺少有效的字符串 name 或 description。');
      }
    }
  } else issues.push('未发现有效 frontmatter；仍显示 Markdown 正文。');
  let aux: Record<string, unknown> = {};
  const auxPath = path.join(directory, 'agents', 'openai.yaml');
  try {
    const auxStat = await lstat(auxPath);
    const auxReal = await realpath(auxPath);
    if (!auxStat.isFile() || !safeRelative(realDirectory, auxReal) || auxStat.size > MAX_AUX_BYTES) throw new Error('agents/openai.yaml 越界、不是普通文件或超过 128 KiB。');
    const auxDoc = parseDocument(await readBoundedText(auxPath, MAX_AUX_BYTES), { uniqueKeys: true, schema: 'core' });
    if (auxDoc.errors.length || !isMap(auxDoc.contents)) issues.push('agents/openai.yaml 格式异常。');
    else aux = mapValue(auxDoc.contents);
  } catch (error) {
    if (error instanceof Error && error.message.includes('越界')) issues.push(error.message);
  }
  const metadata = mapValue(meta.metadata);
  const compatibility = stringValue(meta.compatibility) ?? stringValue(meta.environment) ?? stringValue(metadata.compatibility);
  const interfaceData = mapValue(aux.interface);
  const invocation = stringValue(aux.default_prompt) ?? stringValue(interfaceData.default_prompt) ?? stringValue(meta.invocation) ?? stringValue(meta['argument-hint']) ?? stringValue(metadata.invocation);
  const dependencies = [...new Set([
    ...listStrings(meta.dependencies), ...listStrings(meta['allowed-tools']), ...listStrings(metadata.dependencies),
    ...flattenMetadata(aux.dependencies), ...flattenMetadata(aux.tools),
  ])].slice(0, 50);
  const supports: string[] = [];
  const ignored = new Set(['.git', 'node_modules', '.venv', '.env', '.ssh', 'secrets', 'credentials']);
  let supportDirectories = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SUPPORT_DEPTH || supports.length >= MAX_SUPPORT_FILES || supportDirectories >= MAX_SUPPORT_DIRECTORIES) return;
    supportDirectories += 1;
    const entries = await opendir(dir);
    let visitedEntries = 0;
    for await (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_SUPPORT_ENTRIES_PER_DIRECTORY) { issues.push('支持文件清单达到每目录 2,000 项上限。'); break; }
      if (supports.length >= MAX_SUPPORT_FILES) break;
      if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase()) || /^(?:credentials?|secrets?)(?:[._-]|$)/i.test(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(filePath, depth + 1);
      else if (entry.isFile() && filePath !== actualManifest && !filePath.endsWith(`${path.sep}agents${path.sep}openai.yaml`)) {
        const relative = path.relative(directory, filePath);
        if (safeRelative(directory, path.resolve(filePath))) supports.push(relative);
      }
    }
  };
  if (options.includeSupports !== false) {
    try {
      await walk(directory, 0);
      if (supportDirectories >= MAX_SUPPORT_DIRECTORIES) issues.push('支持文件清单达到 100 个目录上限。');
      if (supports.length >= MAX_SUPPORT_FILES) issues.push('支持文件清单达到 80 个文件上限。');
    }
    catch { issues.push('支持文件清单读取不完整。'); }
  }
  const name = stringValue(meta.name) ?? path.basename(directory);
  const description = stringValue(meta.description) ?? stringValue(interfaceData.short_description);
  if (body.length > MAX_BODY_CHARS) { body = `${body.slice(0, MAX_BODY_CHARS)}\n\n[正文已按 1,000,000 字符上限截断]`; issues.push('Markdown 正文超过 1,000,000 字符，预览已截断。'); }
  return {
    name, description, author: stringValue(meta.author) ?? stringValue(metadata.author),
    version: stringValue(meta.version) ?? stringValue(metadata.version), license: stringValue(meta.license) ?? stringValue(metadata.license),
    environment: compatibility, invocation,
    dependencies: dependencies.map(redactSecrets), supports: supports.slice(0, MAX_SUPPORT_FILES), body: redactSecrets(body), formatStatus,
    metadataIssues: issues,
  };
}
