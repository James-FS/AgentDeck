import path from 'node:path';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import { editJsonEnabled } from '@agentdeck/change-engine';
import { boundedText, existsDirectory, existsRegularFile, isSafePathWithin, object, safeMcpFile } from './shared.js';

/** User settings only. Project overrides and plugin components keep independent provenance. */
export async function markClaudeToggleTargets(context: ScanContext, bindings: Binding[]) {
  const file = path.join(context.instance.configRoot, 'settings.json');
  if (!(await isSafePathWithin(context.instance.configRoot, file)) || !(await existsRegularFile(file))) return;
  let text: string;
  try { text = await boundedText(file); } catch { return; }
  const installedFile = path.join(context.instance.configRoot, 'plugins/installed_plugins.json');
  const installed = await isSafePathWithin(context.instance.configRoot, installedFile)
    ? object(await safeMcpFile(installedFile, [], 'Claude toggle installation records')) : null;
  const records = object(installed?.plugins);
  for (const binding of bindings) {
    if (binding.kind !== 'plugin' || binding.parentId || binding.projectId || !binding.pluginId
      || !/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(binding.pluginId) || binding.pluginId.endsWith('@synced')
      || binding.pluginIdentityVerified === false || binding.diagnostics.some(note => /身份冲突|名称.*冲突/.test(note))) continue;
    const configured = binding.configurationSourcePath === file;
    const userInstalled = binding.pluginIdentityVerified === true && binding.classification?.installationEvidence?.scope === 'user-global';
    // Some native LSP installations have no standalone manifest. Explicit user registration
    // still proves the switch identity, without proving cache availability or loading.
    let registeredUser = false;
    const entries = records?.[binding.pluginId];
    if (binding.origin === 'configuration' && binding.configurationSourcePath === installedFile && Array.isArray(entries)) {
      for (const entry of entries.slice(0, 300)) {
        const record = object(entry);
        if (record?.scope !== 'user' || typeof record.installPath !== 'string' || !path.isAbsolute(record.installPath)
          || binding.pluginVersion && record.version !== binding.pluginVersion) continue;
        if (await isSafePathWithin(context.instance.configRoot, record.installPath) && await existsDirectory(record.installPath)) { registeredUser = true; break; }
      }
    }
    if (!configured && !userInstalled && !registeredUser) continue;
    const target = { agentId: 'claude-code' as const, path: ['enabledPlugins', binding.pluginId], defaultEnabled: false };
    try { editJsonEnabled(text, binding.enabled ?? true, { kind: 'json', path: target.path, defaultEnabled: target.defaultEnabled }); }
    catch { binding.readOnlyReason = 'Claude 用户开关配置存在重复键、非法值或结构，不能安全启停。'; continue; }
    binding.toggleTarget = target;
    binding.writable = context.instance.discovery !== 'demo' && context.instance.writable;
    binding.readOnlyReason = binding.writable ? null : '此实例已设为只读。';
    binding.diagnostics.push('仅写用户 enabledPlugins 开关；项目/组织设置和依赖可能影响最终生效，未验证会话加载。');
  }
}
