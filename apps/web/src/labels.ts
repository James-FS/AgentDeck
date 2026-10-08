import type { Binding, CapabilityEvidence, ClientCompatibilityReport } from '@agentdeck/contracts';
import { inventoryAgent, inventoryCategory, inventoryScope } from './classification';
import { useAppStore } from './store';

// Store-backed display helpers read the app store at call time, so they work in any
// component render context once Pinia is installed.

export function agentName(id: string) { return id === 'public' ? '公共来源' : useAppStore().adapters.find((adapter) => adapter.id === id)?.name ?? id; }
export function resourceName(binding: Binding) { return binding.displayName || binding.name; }
export function discoveryAgent(binding: Binding) { return agentName(useAppStore().instances.find(i => i.id === binding.instanceId)?.agentId ?? binding.classification?.discoveredByAgentId ?? 'unknown'); }
export function publicDisabledLabel(members: Binding[]) {
  const disabled = [...new Set(members.filter(b => b.enabled === false).map(discoveryAgent))];
  return disabled.length ? `有禁用记录：${disabled.join('、')}` : '未发现明确禁用记录';
}
export function categoryLabel(value: string) { return ({ 'user-global': '用户全局来源', project: '项目公共来源', 'agent-global': 'Agent 全局资源', 'agent-project': 'Agent 项目资源', unknown: '归类待确定' })[value] ?? '归类待确定'; }
export function bindingCategoryLabel(binding: Binding) { const category = inventoryCategory(binding); return `${categoryLabel(category)}${category === 'agent-global' || category === 'agent-project' ? ` · ${agentName(inventoryAgent(binding))}` : ''}`; }
export function classificationLabel(binding: Binding) { return `${scopeLabel(inventoryScope(binding))} · ${inventoryAgent(binding) === 'unknown' ? '归属未知' : agentName(inventoryAgent(binding))}`; }
export function scopeLabel(value: string) { return ({ 'user-global': '用户全局', project: '项目级', 'project-directory': '项目子目录级', unknown: '使用范围未知', native: '原生特殊范围', session: '会话临时级（预留）' })[value] ?? '范围未判断'; }
export function sourceLabel(value: string) { return ({ user: '用户自建 / 导入', repository: '项目仓库提供', plugin: '插件附带', builtin: 'Agent 内置', organization: '组织管理', 'account-sync': '账号同步', unknown: '来源未知' })[value] ?? '来源未知'; }
export function originLabel(binding: Binding) {
  if (binding.cacheState === 'missing') return '配置登记 · 缓存缺失';
  if (binding.origin === 'cache') return `插件缓存存在${binding.pluginVersion ? ` · v${binding.pluginVersion}` : ''}${binding.marketplace ? ` · ${binding.marketplace}` : ''}`;
  if (binding.origin === 'configuration') return `${binding.projectId ? '项目配置' : '用户配置'}${binding.cacheState === 'unknown' ? ' · 缓存未知' : ''}`;
  if (binding.origin === 'filesystem') return binding.projectId ? '项目文件' : '本地文件';
  return binding.projectId ? '项目来源' : '';
}
export function stateLabel(enabled: boolean | null | undefined) { return enabled === true ? '已启用' : enabled === false ? '已禁用' : '未确定'; }
export function clientStatusLabel(status: ClientCompatibilityReport['status']) {
  return ({ 'verified-client': 'CLI 签名已识别', 'executable-unverified': '版本未知 · 有程序候选', 'configuration-only': '仅有配置目录', 'not-found': '未发现客户端', demo: '隔离演示' })[status];
}
export function capabilityAreaLabel(area: CapabilityEvidence['area']) {
  return ({ 'static-scan': '静态扫描', 'fixture-validation': '夹具验证', 'native-config': '原生配置复读' })[area];
}
export function capabilityStatusLabel(evidence: CapabilityEvidence) {
  return ({ verified: '已验证', partial: '部分验证', unverified: '未验证', unsupported: '不支持' })[evidence.status];
}
export function capabilityScopeLabel(evidence: CapabilityEvidence) {
  if (evidence.controlScope === 'standalone-user-mcp') return '用户级独立 MCP';
  return `${evidence.resourceKind ? ({ skill: 'Skill', plugin: '插件', mcp: 'MCP' })[evidence.resourceKind] : '所有资源'} · ${evidence.scope ? scopeLabel(evidence.scope) : '所有范围'}${evidence.sourceKind ? ` · ${sourceLabel(evidence.sourceKind)}` : ''}`;
}
export function clientConfigStateLabel(report: ClientCompatibilityReport) { return report.configurationState === 'present' ? '配置目录存在' : '配置目录未发现'; }
export function timeLabel(value: string | null | undefined) {
  if (!value) return '尚未扫描';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
