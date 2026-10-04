import path from 'node:path';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import { editJsonEnabled } from '@agentdeck/change-engine';
import { boundedRead, existsRegularFile, isSafePathWithin, object, safeMcpFile } from './shared.js';

/** Addresses only observed switches in the existing user config; never writes while scanning. */
export async function markZCodeToggleTargets(context: ScanContext, bindings: Binding[], diagnostics: string[]) {
  const root = context.instance.configRoot;
  const file = path.join(root, 'cli/config.json');
  if (!(await isSafePathWithin(root, file)) || !(await existsRegularFile(file))) return;
  const config = object(await safeMcpFile(file, diagnostics, 'ZCode toggle config'));
  if (!config) return;
  let text: string;
  try { text = (await boundedRead(file, 1024 * 1024)).toString('utf8'); } catch { return; }
  const byId = new Map(bindings.map(b => [b.id, b]));
  for (const binding of bindings) {
    if (binding.projectId !== null) continue;
    if (binding.builtinSourcePath && binding.origin === 'filesystem') continue;
    let target: Extract<NonNullable<Binding['toggleTarget']>, { path: string[] }> | undefined;
    if (binding.kind === 'skill') {
      const parent = binding.parentId ? byId.get(binding.parentId) : undefined;
      if (binding.parentId && (!parent || parent.configurationSourcePath !== file || parent.enabled !== true)) continue;
      const boundary = binding.classification?.location?.rootPath ?? root;
      const manifest = path.join(binding.sourcePath, await existsRegularFile(path.join(binding.sourcePath, 'SKILL.md')) ? 'SKILL.md' : 'skill.md');
      if (!(await isSafePathWithin(boundary, manifest)) || !(await existsRegularFile(manifest))) continue;
      target = { agentId: 'zcode', path: ['skills', path.resolve(manifest).split(path.sep).join('/'), 'enable'], defaultEnabled: true };
      // Keep the exact existing key spelling, including Windows path separators.
      const keys = Object.keys(object(config.skills) ?? {}).filter(key => path.isAbsolute(key)
        && path.resolve(key).toLocaleLowerCase() === path.resolve(manifest).toLocaleLowerCase());
      if (keys.length > 1) continue;
      if (keys[0]) target.path[1] = keys[0];
    } else if (binding.kind === 'plugin' && !binding.parentId && binding.pluginId
      && (binding.origin === 'configuration' || binding.pluginIdentityVerified === true
        && (binding.configurationSourcePath === file || binding.classification?.installationEvidence))) {
      target = { agentId: 'zcode', path: ['plugins', 'enabledPlugins', binding.pluginId], defaultEnabled: false };
    } else if (binding.kind === 'mcp' && !binding.parentId && binding.sourcePath === file && binding.nativeKey === `mcp.servers.${binding.name}`) {
      const server = object(object(object(config.mcp)?.servers)?.[binding.name]);
      if (!server) continue;
      const flag = Object.hasOwn(server, 'enable') ? 'enable' : Object.hasOwn(server, 'enabled') ? 'enabled' : 'enable';
      target = { agentId: 'zcode', path: ['mcp', 'servers', binding.name, flag], defaultEnabled: true };
    }
    if (!target) continue;
    try { editJsonEnabled(text, binding.enabled ?? true, { kind: 'json', path: target.path, defaultEnabled: target.defaultEnabled }); }
    catch { binding.readOnlyReason = '开关配置无效、重复或目标结构未知，不能安全启停。'; continue; }
    binding.toggleTarget = target;
    binding.writable = context.instance.discovery !== 'demo' && context.instance.writable;
    binding.readOnlyReason = binding.writable ? null : '此实例已设为只读；启停仅修改目标开关，其他配置保留。';
  }
}
