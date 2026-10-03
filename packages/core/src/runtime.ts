import type { Catalog, RuntimeReport } from '@agentdeck/contracts';

/** Only reports session evidence when it can be attributed to an existing client session. */
export function assessRuntimeEvidence(catalog: Catalog, now: Date): RuntimeReport {
  return {
    assessedAt: now.toISOString(),
    observations: catalog.bindings.map(binding => ({
      bindingId: binding.id,
      instanceId: binding.instanceId,
      kind: binding.kind,
      configurationEnabled: binding.configurationEnabled === undefined ? binding.enabled : binding.configurationEnabled,
      indexUpdatedAt: binding.updatedAt,
      sessionLoad: binding.kind === 'mcp' ? 'not-applicable' : 'not-checked',
      mcpConnection: binding.kind === 'mcp' ? 'not-checked' : 'not-applicable',
      clientSessionId: null,
      evidenceSource: null,
      observedAt: null,
      reason: binding.kind === 'mcp'
        ? '未接入该客户端现有会话的 MCP 连接状态接口；配置、缓存和独立连接测试均不能证明当前会话已连接或失败。'
        : '未接入该客户端现有会话的资源加载状态接口；配置启用和文件或缓存存在不能证明当前会话已加载。',
    })),
  };
}
