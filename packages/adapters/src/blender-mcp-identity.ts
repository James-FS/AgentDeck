import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Verified rename: blender-mcp 2.0.0 METADATA and shim delegate to mcp-for-blender.
 * This is package/project identity, never proof of an installed uvx version or shared process. */
export const blenderIdentity = 'python-package:pypi:mcp-for-blender';
export function blenderUvxPackage(command: string, args: string[], config: Record<string, unknown>) {
  if (command !== 'uvx' || args.length !== 1) return;
  const env = config.env;
  if (env && typeof env === 'object' && Object.keys(env).some(name => /^(UV_|PIP_)/i.test(name))) return;
  const match = /^(mcp-for-blender|blender-mcp)(?:==([0-9]+\.[0-9]+\.[0-9]+))?$/.exec(args[0]!);
  if (!match || match[1] === 'blender-mcp' && match[2] && Number(match[2].split('.')[0]) < 2) return;
  return { packageName: match[1]!, packageVersion: match[2] ?? null,
    launchMode: 'uvx 包声明（实际解析版本未验证）',
    reason: '默认 PyPI 的静态包声明；已核实 blender-mcp 2.0.0 是 mcp-for-blender 的兼容旧名。按同一包项目分组，未启动 uvx，不证明实际解析版本、安装或共用进程。' };
}
async function text(file: string) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > 65536) return null;
  return readFile(file, 'utf8');
}
/** Inspect only the site-packages beside an explicitly configured executable. */
export async function blenderInstalledPackage(entry: string) {
  if (path.basename(entry).toLowerCase() !== 'mcp-for-blender.exe' || path.basename(path.dirname(entry)).toLowerCase() !== 'scripts') return;
  const packages = path.join(path.dirname(path.dirname(entry)), 'Lib', 'site-packages');
  const entries = await readdir(packages, { withFileTypes: true }).catch(() => []);
  if (entries.length > 512) return;
  const candidates = entries.filter(item => item.isDirectory() && /^mcp_for_blender-[0-9.]+\.dist-info$/i.test(item.name));
  if (candidates.length !== 1) return;
  const root = path.join(packages, candidates[0]!.name), metadataPath = path.join(root, 'METADATA');
  const metadata = await text(metadataPath), points = await text(path.join(root, 'entry_points.txt'));
  if (!metadata || !points || !/^Name: mcp-for-blender\r?$/m.test(metadata)
    || !/^Project-URL: (?:Homepage|Source), https:\/\/github\.com\/ahujasid\/(?:blender-mcp|mcp-for-blender)\/?\r?$/m.test(metadata)
    || !/^mcp-for-blender\s*=\s*blender_mcp\.server:main\s*$/m.test(points)) return;
  const version = /^Version: ([0-9]+\.[0-9]+\.[0-9]+)\r?$/m.exec(metadata)?.[1];
  if (!version) return;
  return { packageName: 'mcp-for-blender', packageVersion: version, packageEvidencePath: metadataPath, entryPath: entry,
    launchMode: '直接执行已安装入口',
    reason: '配置入口相邻安装元数据及 console_scripts 映射证实为官方 mcp-for-blender 包；按同一包项目分组，版本和启动方式分别保留，不证明共用进程。' };
}
