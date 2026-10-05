import { createHash, createHmac, randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Binding } from '@agentdeck/contracts';
import { blenderIdentity, blenderInstalledPackage, blenderUvxPackage } from './blender-mcp-identity.js';

// Never publish config values or unsalted hashes of credentials. Equality tokens are scan-session scoped.
const key = randomBytes(32);
const comparisonSession = randomBytes(12).toString('hex');
const opaque = (value: string) => createHmac('sha256', key).update(value).digest('hex');
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('bounded');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (Array.isArray(value) && value.length <= 200) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object' && Object.keys(value).length <= 200) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, canonical(item, depth + 1)]));
  }
  throw new Error('unknown');
}
/** Reads metadata only for a literal file explicitly referenced in a scanned declaration. No search/execution/network. */
export async function mcpServiceEvidence(config: Record<string, unknown>, evidencePath: string): Promise<Binding['mcpService']> {
  try {
    const values = Object.fromEntries(Object.entries(config).filter(([name]) => !['enabled', 'enable', 'disabled'].includes(name)));
    const serialized = JSON.stringify(canonical(values));
    if (serialized.length > 32768) return;
    const configurationIdentity = `${comparisonSession}:${opaque(serialized)}`;
    const common = { configurationIdentity, evidencePath };
    const url = typeof config.url === 'string' ? config.url : typeof config.serverUrl === 'string' ? config.serverUrl : null;
    if (url) {
      if (config.command) return;
      const endpoint = new URL(url);
      if (!['http:', 'https:'].includes(endpoint.protocol) || /\$\{|%[A-Za-z_]+%/.test(url)) return;
      // Credentials, query, fragment and potentially sensitive paths never enter the public display.
      return { ...common, identity: `endpoint:${opaque(endpoint.href)}`, kind: 'endpoint', location: `${endpoint.origin}/[路径已隐藏]`,
        reason: '配置明确引用同一完整 HTTP 地址；地址比较包含路径和查询但不公开，不能证明连接或共用进程。' };
    }
    if (typeof config.command !== 'string' || /\$\{|%[A-Za-z_]+%/.test(config.command)) return;
    const args = config.args;
    if (args !== undefined && (!Array.isArray(args) || !args.every(value => typeof value === 'string'))) return;
    const argv = (args ?? []) as string[];
    const command = path.basename(config.command).toLowerCase().replace(/\.exe$/, '');
    const declaredPackage = blenderUvxPackage(command, argv, config);
    if (declaredPackage) return { ...common, ...declaredPackage, identity: blenderIdentity,
      kind: 'package', location: 'PyPI · mcp-for-blender（兼容旧名 blender-mcp）' };
    // A launcher executable is shared by unrelated packages/scripts, not a service entry.
    // Do not infer package identity or execute its resolver from static arguments.
    if (['uvx', 'uv', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'pip', 'pipx',
      'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'docker'].includes(command)) return;
    let entry: string | undefined;
    if (['node', 'nodejs', 'python', 'python3', 'pythonw', 'py'].includes(command)) {
      let index = 0;
      while (['-u', '-B', '-E', '-I', '--no-warnings'].includes(argv[index] ?? '')) index++;
      entry = argv[index];
    } else if (path.isAbsolute(config.command) && /\.(?:exe|com)$/i.test(config.command)) entry = config.command;
    if (!entry || !path.isAbsolute(entry) || /\$\{|%[A-Za-z_]+%/.test(entry)) return;
    const actual = await realpath(entry).catch(() => null);
    if (!actual || !(await stat(actual)).isFile()) return;
    const installedPackage = await blenderInstalledPackage(actual);
    if (installedPackage) return { ...common, ...installedPackage, identity: blenderIdentity,
      kind: 'package', location: 'PyPI · mcp-for-blender（兼容旧名 blender-mcp）' };
    const canonicalPath = process.platform === 'win32' ? actual.toLowerCase() : actual;
    return { ...common, identity: `local:${createHash('sha256').update(canonicalPath).digest('hex')}`, kind: 'local-entry', location: actual,
      reason: '静态启动声明明确引用同一实际入口文件；参数、环境等差异单独标记，不证明共用运行进程，不改变配置范围或 Agent 归属。' };
  } catch { return; }
}
