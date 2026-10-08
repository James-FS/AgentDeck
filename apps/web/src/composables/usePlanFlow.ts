import { computed, ref } from 'vue';
import type { Binding, ChangePlan, Operation } from '@agentdeck/contracts';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';
import { useOperations } from './useOperations';

const activePlan = ref<ChangePlan | null>(null);
const appliedOperation = ref<Operation | null>(null);
const restoreOf = ref<string | null>(null);

export function usePlanFlow() {
  const store = useAppStore();
  const ui = useUiStore();
  const { loadOperations, restoreBusy } = useOperations();

  const planBinding = computed(() => store.bindings.find((b) => b.id === activePlan.value?.bindingId));
  const planInstance = computed(() => store.instances.find((i) => i.id === activePlan.value?.instanceId));
  const affected = computed(() => planBinding.value ? store.bindings.filter((b) => b.instanceId === planBinding.value?.instanceId && b.id !== planBinding.value.id
    && (planBinding.value.kind === 'plugin' ? b.pluginId === planBinding.value.pluginId : b.sourcePath === planBinding.value.sourcePath)) : []);

  function canPlan(binding: Binding): boolean {
    const instance = store.instances.find((item) => item.id === binding.instanceId);
    if (instance && ['zcode', 'claude-code', 'deepseek-harness'].includes(instance.agentId)) return binding.toggleTarget?.agentId === instance.agentId && binding.writable && instance.writable && instance.discovery !== 'demo';
    if (binding.discoveryOnly) return false;
    return (binding.kind === 'mcp' || binding.controlScope === 'user-config-skill' || binding.controlScope === 'local-marketplace-plugin') && binding.parentId === null && instance?.agentId === 'codex'
      && instance.writable && binding.writable;
  }

  function refreshSelectedResource() {
    ui.selectedMcpMembers = ui.selectedMcpMembers.flatMap(b => store.bindings.find(current => current.id === b.id) ?? []);
    ui.selectedPublicMembers = ui.selectedPublicMembers.flatMap(b => store.bindings.find(current => current.id === b.id) ?? []);
    if (ui.selectedBinding) ui.selectedBinding = store.bindings.find(b => b.id === ui.selectedBinding?.id) ?? null;
  }

  function readOnlyReason(binding: Binding): string {
    if (binding.readOnlyReason) return binding.readOnlyReason;
    const instance = store.instances.find((item) => item.id === binding.instanceId);
    if (binding.parentId !== null) return '插件子资源由父插件控制，当前不提供独立开关。';
    if (binding.kind !== 'mcp') return '此来源尚无已验收的单项控制方式。';
    if (binding.mcpTransport !== 'stdio') return '该条目的传输类型未被本机原生往返案例覆盖；可用性仍受实例登记和资源级策略限制。';
    if (!instance || !['codex', 'zcode', 'claude-code', 'deepseek-harness'].includes(instance.agentId)) return '此客户端尚未支持资源启停。';
    if (!instance?.writable) return '此实例已设为只读。';
    return '适配器未确认此项配置可安全修改。';
  }

  async function toggleBinding(binding: Binding, enabled: boolean) {
    if (!canPlan(binding) || ui.actionBusy) return;
    ui.actionBusy = true;
    try {
      const plan = await api.createPlan({ bindingId: binding.id, enabled });
      const operation = await api.applyPlan(plan.id, plan.afterHash);
      if (operation.status !== 'succeeded') throw new Error('开关修改未完成');
      await Promise.all([store.refresh(), loadOperations()]);
      refreshSelectedResource();
      ElMessage.success(enabled ? '已启用；客户端可能需重启或新建对话' : '已禁用；客户端可能需重启或新建对话');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '启停失败'); await store.refresh().catch(() => undefined); }
    finally { ui.actionBusy = false; }
  }

  async function planToggle(binding: Binding, enabled: boolean) {
    if (!canPlan(binding)) return;
    ui.actionBusy = true;
    try { activePlan.value = await api.createPlan({ bindingId: binding.id, enabled }); appliedOperation.value = null; restoreOf.value = null; ui.drawer = 'plan'; }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法生成变更计划'); }
    finally { ui.actionBusy = false; }
  }

  async function applyPlan() {
    if (!activePlan.value || activePlan.value.status !== 'ready') return;
    ui.actionBusy = true;
    try {
      appliedOperation.value = await api.applyPlan(activePlan.value.id, activePlan.value.afterHash);
      if (appliedOperation.value.status === 'succeeded' && activePlan.value) activePlan.value.status = 'applied';
      await Promise.all([store.refresh(), loadOperations()]);
      ElMessage[appliedOperation.value.status === 'succeeded' ? 'success' : 'warning'](appliedOperation.value.status === 'succeeded' ? '操作完成，配置状态已刷新' : `操作结果：${appliedOperation.value.status}`);
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '应用计划失败'); }
    finally { ui.actionBusy = false; }
  }

  async function planRestore(operation: Operation) {
    if (operation.status !== 'succeeded') return;
    restoreBusy.value = operation.id;
    try { activePlan.value = await api.createRestorePlan(operation.id); appliedOperation.value = null; restoreOf.value = operation.id; ui.drawer = 'plan'; }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法生成恢复计划'); }
    finally { restoreBusy.value = ''; }
  }

  return { activePlan, appliedOperation, restoreOf, planBinding, planInstance, affected, canPlan, readOnlyReason, toggleBinding, planToggle, applyPlan, planRestore };
}
