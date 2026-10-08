import { ref } from 'vue';
import type { Binding, ClientCompatibilityReport } from '@agentdeck/contracts';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAppStore } from '../store';

const versionCheckBusy = ref('');
const adapterStatusPriority = ['verified-client', 'executable-unverified', 'configuration-only', 'demo', 'not-found'] as const;

export function useCompatibility() {
  const store = useAppStore();

  function instanceCountFor(agentId: string) { return store.instances.filter((item) => item.agentId === agentId).length; }
  function resourceCountFor(agentId: string) {
    const ids = new Set(store.instances.filter((item) => item.agentId === agentId).map((item) => item.id));
    return store.bindings.filter((item) => ids.has(item.instanceId)).length;
  }
  function adapterStateFor(agentId: string): ClientCompatibilityReport['status'] {
    const ids = new Set(store.instances.filter((item) => item.agentId === agentId).map((item) => item.id));
    const statuses = (store.compatibility?.clients ?? [])
      .filter((report) => report.instanceId !== null && ids.has(report.instanceId))
      .map((report) => report.status);
    return adapterStatusPriority.find((status) => statuses.includes(status)) ?? 'not-found';
  }
  function reportForInstance(instanceId: string): ClientCompatibilityReport | undefined {
    return store.compatibility?.clients.find((report) => report.instanceId === instanceId);
  }
  function reportCanCheckVersion(report: ClientCompatibilityReport) {
    return report.instanceId !== null && report.status !== 'demo' && ['codex', 'claude-code', 'zcode', 'deepseek-harness'].includes(report.agentId);
  }
  function versionCheckButtonLabel(report: ClientCompatibilityReport) {
    return report.agentId === 'codex' || report.agentId === 'claude-code' ? '检查 CLI 版本' : '刷新程序候选';
  }
  async function checkVersion(report: ClientCompatibilityReport) {
    if (!report.instanceId || !reportCanCheckVersion(report)) return;
    versionCheckBusy.value = report.instanceId;
    try {
      const updated = await api.checkVersion(report.instanceId);
      store.compatibility = updated;
      const row = updated.clients.find((client) => client.id === report.id);
      await store.refresh();
      ElMessage.success(row?.versionEvidence ? `已识别 CLI 版本 ${row.versionEvidence.version}` : row?.executableCandidate ? '已刷新程序候选；当前未识别版本签名' : '未发现可用的 PATH 程序候选');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '版本检查失败'); }
    finally { versionCheckBusy.value = ''; }
  }
  function capabilityEvidenceForBinding(binding: Binding) {
    const report = reportForInstance(binding.instanceId);
    if (!report) return [];
    return report.capabilities.filter((item) => item.resourceKind === binding.kind && item.scope === binding.scope
      && item.sourceKind === binding.sourceKind
      && (!item.controlScope || item.controlScope === binding.controlScope || (item.controlScope === 'standalone-user-mcp' && binding.kind === 'mcp' && binding.parentId === null && binding.projectId === null && binding.scope === 'native' && binding.sourceKind === 'user')))
      .map((item) => item.mcpTransport && item.mcpTransport !== (binding.mcpTransport ?? 'unknown') ? {
        ...item,
        status: 'unverified' as const,
        readable: false,
        writable: false,
        reason: `相关案例仅覆盖 ${item.mcpTransport.toUpperCase()} 传输；当前资源为 ${binding.mcpTransport ?? '未知'}，此行为未验证。`,
      } : item);
  }

  return {
    versionCheckBusy, instanceCountFor, resourceCountFor, adapterStateFor,
    reportForInstance, reportCanCheckVersion, versionCheckButtonLabel, checkVersion, capabilityEvidenceForBinding,
  };
}
