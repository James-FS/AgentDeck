import type { Binding } from '@agentdeck/contracts';

export function configurationState(binding: Binding): { label: string; tone: 'on' | 'off' | 'unknown'; reason: string } {
  const tone = binding.enabled === true ? 'on' : binding.enabled === false ? 'off' : 'unknown';
  return { label: tone === 'on' ? '已启用' : tone === 'off' ? '已禁用' : '未确定', tone,
    reason: binding.configurationStateReason ?? binding.configurationControl?.reason ?? '来自扫描结果的静态配置状态；旧索引请重新扫描，不代表会话加载、连接成功或实际调用。' };
}
