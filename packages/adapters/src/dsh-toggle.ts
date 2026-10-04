import path from 'node:path';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import { editDshEnabled } from '@agentdeck/change-engine';
import { isSafePathWithin } from './shared.js';

// Matches native dsh-plugin-manager's management-required set. Never disable its infrastructure.
const protectedModules = new Set(['dsh-plugin-manager', 'cordis-plugin-loader', 'cordis-plugin-include',
  'dsh-api-gateway', 'dsh-host-webserver', 'dsh-client-modules', 'dsh-client-ui-settings-plugin-inventory',
  'dsh-client-ui-plugin-manager', 'dsh-host-plugin-inventory', 'dsh-typert-registry', 'dsh-api-remotes',
  'cordis-plugin-timer', 'dsh-client-connection', 'dsh-host-frontend-static', 'dsh-tools', 'dsh-hmr']
  .map(name => `@deepseek-ai/${name}`));

export async function markDshToggleTarget(context: ScanContext, binding: Binding, text: string, id: string | null, name: string | null) {
  if (binding.projectId || !id || !name || binding.kind !== 'plugin' || binding.sourceKind !== 'user') return;
  if (protectedModules.has(name)) { binding.readOnlyReason = 'DSH 管理器必需组件保持只读。'; return; }
  const relative = path.relative(context.instance.configRoot, binding.sourcePath).split(path.sep).join('/');
  if (!/^(?:profiles\/[^/]+\/)?cordis\.patch\.ya?ml$/.test(relative)
    || !(await isSafePathWithin(context.instance.configRoot, binding.sourcePath))) return;
  const target = { agentId: 'deepseek-harness' as const, kind: 'dsh-yaml' as const, configPath: binding.sourcePath, id, name };
  try { editDshEnabled(text, binding.enabled ?? true, target); }
  catch { binding.readOnlyReason = 'DSH 行有动态值、重复身份、插入层或开关结构不受支持，不能安全启停。'; return; }
  binding.toggleTarget = target;
  binding.writable = context.instance.discovery !== 'demo' && context.instance.writable;
  binding.readOnlyReason = binding.writable ? null : '此实例已设为只读。';
  binding.diagnostics.push('仅保存此用户 patch 行的 disabled 开关；其他配置层及当前会话生效状态未验证。');
}
