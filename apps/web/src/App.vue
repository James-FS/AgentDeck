<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { Binding, CapabilityEvidence, ChangePlan, ClientCompatibilityReport, Operation, ResourceKind } from '@agentdeck/contracts';
import { ArrowRight, Box, Clock, Close, Connection, Document, Files, Folder, FolderAdd, House, InfoFilled, List, Plus, Refresh, Search, Setting, SwitchButton } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from './api';
import { useAppStore } from './store';
import { diskOnly, inventoryAgent, inventoryCategory, inventoryScope, matchesClassification } from './classification';
import { configurationState } from './configuration-state';
import { resourceRows, publicResourceIdentity, publicGroupState, type ResourceRow } from './resource-tree';

type Page = 'overview' | 'resources' | 'instances' | 'projects' | 'operations';
type SkillBinding = Binding & { sourceLabel?: string };
const store = useAppStore();
const page = ref<Page>('resources');
const kindFilter = ref<'all' | ResourceKind>('all');
const searchText = ref('');
const scopeFilter = ref<string[]>([]);
const ownerAgentFilter = ref<string[]>([]);
const categoryFilter = ref<string[]>([]);
const sourceFilter = ref<string[]>([]);
const configurationFilter = ref<string[]>([]);
const originFilter = ref<'all' | 'cache' | 'configuration' | 'filesystem' | ''>('all');
const expanded = ref(new Set<string>());
const drawer = ref<'instance' | 'project' | 'plan' | 'binding' | null>(null);
const actionBusy = ref(false);
const restoreBusy = ref('');
const eventStatus = ref<'connecting' | 'connected' | 'offline'>('connecting');
const operations = ref<Operation[]>([]);
const operationsError = ref('');
const activePlan = ref<ChangePlan | null>(null);
const selectedBinding = ref<Binding | null>(null);
const selectedPublicMembers = ref<Binding[]>([]);
const selectedConfigurationState = computed(() => selectedPublicMembers.value.length ? publicGroupState(selectedPublicMembers.value) : selectedBinding.value ? configurationState(selectedBinding.value) : null);
const versionCheckBusy = ref('');
const appliedOperation = ref<Operation | null>(null);
const restoreOf = ref<string | null>(null);
const instanceForm = reactive({ agentId: '', name: '', configRoot: '', writable: true });
const projectForm = reactive({ name: '', rootPath: '' });
let eventSource: EventSource | undefined;

const pages = [
  { id: 'overview' as const, label: '总览', icon: House },
  { id: 'resources' as const, label: '资源管理', icon: Box },
  { id: 'instances' as const, label: 'Agent 实例', icon: Connection },
  { id: 'projects' as const, label: '项目空间', icon: Folder },
  { id: 'operations' as const, label: '操作记录', icon: Clock },
];
const agentName = (id: string) => id==='public'?'公共来源':store.adapters.find((adapter) => adapter.id === id)?.name ?? id;
const resourceName = (binding: Binding) => binding.displayName || binding.name;
const selectedInstance = computed(() => store.instances.find((item) => item.id === store.selectedInstanceId));
const scoped = computed(() => store.bindings.filter((item) =>
  (!store.selectedInstanceId || item.instanceId === store.selectedInstanceId)
  && (!store.selectedProjectId || item.projectId === null || item.projectId === store.selectedProjectId)));
const stats = computed(() => ({
  all: countedResources.value.length,
  skills: countedResources.value.filter((b) => b.kind === 'skill').length,
  plugins: countedResources.value.filter((b) => b.kind === 'plugin').length,
  mcps: countedResources.value.filter((b) => b.kind === 'mcp').length,
  diagnostics: scoped.value.reduce((n, b) => n + b.diagnostics.length, 0) + store.instances.reduce((n, i) => n + i.diagnostics.length, 0),
}));
const countedResources = computed(() => {
  const seen = new Set<string>();
  return scoped.value.filter(binding => {
    const key = publicResourceIdentity(binding);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
const tabCounts = computed(() => ({ all: stats.value.all, skill: stats.value.skills, plugin: stats.value.plugins, mcp: stats.value.mcps }));
function matches(binding: Binding, includePluginChildren = false): boolean {
  if (configurationFilter.value.length && !configurationFilter.value.includes(configurationState(binding).tone)) return false;
  if (!matchesClassification(binding, scopeFilter.value, ownerAgentFilter.value, categoryFilter.value)) return false;
  const text = searchText.value.trim().toLocaleLowerCase();
  if (text && !`${binding.classification?.projectName ?? ''} ${binding.classification?.evidencePath ?? ''} ${binding.name} ${binding.displayName ?? ''} ${binding.discoveryPath ?? ''} ${binding.description} ${binding.nativeKey} ${binding.sourcePath} ${binding.pluginId ?? ''} ${binding.pluginVersion ?? ''} ${binding.marketplace ?? ''}`.toLocaleLowerCase().includes(text)) return false;
  if (originFilter.value && originFilter.value !== 'all' && binding.origin !== originFilter.value) return false;
  if (sourceFilter.value.length && !sourceFilter.value.includes(binding.sourceKind)) return false;
  if (!includePluginChildren && kindFilter.value !== 'all' && binding.kind !== kindFilter.value) return false;
  return true;
}
const visible = computed(() => resourceRows(scoped.value, matches, expanded.value, kindFilter.value));
function rowName(item: ResourceRow) { return item.versionRecord ? `${resourceName(item.binding)} · ${item.binding.origin === 'cache' ? `缓存 v${item.binding.pluginVersion ?? '未知'}` : '配置记录'}` : resourceName(item.binding); }
function rowDescription(item: ResourceRow) {
  if (item.publicGroup) return `公共资源 · ${item.publicGroup.members.length} 条发现记录 · ${publicDisabledLabel(item.publicGroup.members)}`;
  if (item.group) return `${item.group.versions.length} 个缓存版本 · ${item.group.configurations} 条配置记录 · 当前使用版本未确定`;
  if (item.binding.discoveryOnly) return `分组路径：${item.binding.discoveryPath} · ${item.binding.description}`;
  if (item.depth && !item.versionRecord) return `由 ${store.bindings.find(b=>b.id===item.binding.parentId)?.name ?? '插件'} 提供${item.binding.pluginVersion ? ` · 缓存 v${item.binding.pluginVersion}` : ''}`;
  return item.binding.description || item.binding.nativeKey || item.binding.sourcePath;
}
function openRow(item: ResourceRow) {
  if (item.group) togglePlugin(item.key);
  else { openBinding(item.binding); selectedPublicMembers.value = item.publicGroup?.members ?? []; }
}
function discoveryAgent(binding: Binding) { return agentName(store.instances.find(i => i.id === binding.instanceId)?.agentId ?? binding.classification?.discoveredByAgentId ?? 'unknown'); }
function publicDisabledLabel(members: Binding[]) {
  const disabled = [...new Set(members.filter(b => b.enabled === false).map(discoveryAgent))];
  return disabled.length ? `有禁用记录：${disabled.join('、')}` : '未发现明确禁用记录';
}
const planBinding = computed(() => store.bindings.find((b) => b.id === activePlan.value?.bindingId));
const planInstance = computed(() => store.instances.find((i) => i.id === activePlan.value?.instanceId));
const affected = computed(() => planBinding.value ? store.bindings.filter((b) => b.instanceId === planBinding.value?.instanceId && b.id !== planBinding.value.id
  && (planBinding.value.kind === 'plugin' ? b.pluginId === planBinding.value.pluginId : b.sourcePath === planBinding.value.sourcePath)) : []);
const selectedCapabilityEvidence = computed(() => selectedBinding.value ? capabilityEvidenceForBinding(selectedBinding.value) : []);
function canPlan(binding: Binding): boolean {
  const instance = store.instances.find((item) => item.id === binding.instanceId);
  if (instance && ['zcode','claude-code','deepseek-harness'].includes(instance.agentId)) return binding.toggleTarget?.agentId === instance.agentId && binding.writable && instance.writable && instance.discovery !== 'demo';
  if (binding.discoveryOnly) return false;
  return (binding.kind === 'mcp' || binding.controlScope === 'user-config-skill' || binding.controlScope === 'local-marketplace-plugin') && binding.parentId === null && instance?.agentId === 'codex'
    && instance.writable && binding.writable;
}
async function toggleBinding(binding: Binding, enabled: boolean) {
  if (!canPlan(binding) || actionBusy.value) return;
  actionBusy.value = true;
  try {
    const plan = await api.createPlan({ bindingId: binding.id, enabled });
    const operation = await api.applyPlan(plan.id, plan.afterHash);
    if (operation.status !== 'succeeded') throw new Error('开关修改未完成');
    await Promise.all([store.refresh(), loadOperations()]);
    refreshSelectedResource();
    ElMessage.success(enabled ? '已启用；客户端可能需重启或新建对话' : '已禁用；客户端可能需重启或新建对话');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '启停失败'); await store.refresh().catch(() => undefined); }
  finally { actionBusy.value = false; }
}
function refreshSelectedResource() {
  selectedPublicMembers.value = selectedPublicMembers.value.flatMap(b => store.bindings.find(current => current.id === b.id) ?? []);
  if (selectedBinding.value) selectedBinding.value = store.bindings.find(b => b.id === selectedBinding.value?.id) ?? null;
}
function readOnlyReason(binding: Binding): string {
  if (binding.readOnlyReason) return binding.readOnlyReason;
  const instance = store.instances.find((item) => item.id === binding.instanceId);
  if (binding.parentId !== null) return '插件子资源由父插件控制，当前不提供独立开关。';
  if (binding.kind !== 'mcp') return '此来源尚无已验收的单项控制方式。';
  if (binding.mcpTransport !== 'stdio') return '该条目的传输类型未被本机原生往返案例覆盖；可用性仍受实例登记和资源级策略限制。';
  if (!instance || !['codex','zcode','claude-code','deepseek-harness'].includes(instance.agentId)) return '此客户端尚未支持资源启停。';
  if (!instance?.writable) return '此实例已设为只读。';
  return '适配器未确认此项配置可安全修改。';
}
function categoryLabel(value: string) { return ({'user-global':'用户全局来源', project:'项目公共来源', 'agent-global':'Agent 全局资源', 'agent-project':'Agent 项目资源', unknown:'归类待确定'})[value] ?? '归类待确定'; }
function bindingCategoryLabel(binding: Binding) { const category = inventoryCategory(binding); return `${categoryLabel(category)}${category==='agent-global'||category==='agent-project'?` · ${agentName(inventoryAgent(binding))}`:''}`; }
function classificationLabel(binding: Binding) { return `${scopeLabel(inventoryScope(binding))} · ${inventoryAgent(binding)==='unknown'?'归属未知':agentName(inventoryAgent(binding))}`; }
function scopeLabel(value: string) { return ({ 'user-global': '用户全局', project: '项目级', 'project-directory': '项目子目录级', unknown: '使用范围未知', native: '原生特殊范围', session: '会话临时级（预留）' })[value] ?? '范围未判断'; }
function sourceLabel(value: string) { return ({ user: '用户自建 / 导入', repository: '项目仓库提供', plugin: '插件附带', builtin: 'Agent 内置', organization: '组织管理', 'account-sync': '账号同步', unknown: '来源未知' })[value] ?? '来源未知'; }
function originLabel(binding: Binding) {
  if (binding.cacheState === 'missing') return '配置登记 · 缓存缺失';
  if (binding.origin === 'cache') return `插件缓存存在${binding.pluginVersion ? ` · v${binding.pluginVersion}` : ''}${binding.marketplace ? ` · ${binding.marketplace}` : ''}`;
  if (binding.origin === 'configuration') return `${binding.projectId ? '项目配置' : '用户配置'}${binding.cacheState === 'unknown' ? ' · 缓存未知' : ''}`;
  if (binding.origin === 'filesystem') return binding.projectId ? '项目文件' : '本地文件';
  return binding.projectId ? '项目来源' : '';
}
function stateLabel(enabled: boolean | null | undefined) { return enabled === true ? '已启用' : enabled === false ? '已禁用' : '未确定'; }
function clientStatusLabel(status: ClientCompatibilityReport['status']) {
  return ({ 'verified-client': 'CLI 签名已识别', 'executable-unverified': '版本未知 · 有程序候选', 'configuration-only': '仅有配置目录', 'not-found': '未发现客户端', demo: '隔离演示' })[status];
}
function capabilityAreaLabel(area: CapabilityEvidence['area']) {
  return ({ 'static-scan': '静态扫描', 'fixture-validation': '夹具验证', 'native-config': '原生配置复读', runtime: '运行时观察' })[area];
}
function capabilityStatusLabel(evidence: CapabilityEvidence) {
  return ({ verified: '已验证', partial: '部分验证', unverified: '未验证', unsupported: '不支持' })[evidence.status];
}
function capabilityScopeLabel(evidence: CapabilityEvidence) {
  if (evidence.controlScope === 'standalone-user-mcp') return '用户级独立 MCP';
  return `${evidence.resourceKind ? ({ skill: 'Skill', plugin: '插件', mcp: 'MCP' })[evidence.resourceKind] : '所有资源'} · ${evidence.scope ? scopeLabel(evidence.scope) : '所有范围'}${evidence.sourceKind ? ` · ${sourceLabel(evidence.sourceKind)}` : ''}`;
}
function clientConfigStateLabel(report: ClientCompatibilityReport) { return report.configurationState === 'present' ? '配置目录存在' : '配置目录未发现'; }
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
function capabilityEvidenceForBinding(binding: Binding): CapabilityEvidence[] {
  const report = reportForInstance(binding.instanceId);
  if (!report) return [];
  return report.capabilities.filter((item) => item.area !== 'runtime' && item.resourceKind === binding.kind && item.scope === binding.scope
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
function timeLabel(value: string | null | undefined) {
  if (!value) return '尚未扫描';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
const adapterStatusPriority = ['verified-client', 'executable-unverified', 'configuration-only', 'demo', 'not-found'] as const;
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
function legacyCopy(value: string) {
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); ElMessage.success('摘要已复制'); }
  catch { ElMessage.error('复制失败，请手动选择复制'); }
  area.remove();
}
async function copyHash(value: string | null | undefined) {
  if (!value) return;
  try { await navigator.clipboard.writeText(value); ElMessage.success('摘要已复制'); }
  catch { legacyCopy(value); }
}
function togglePlugin(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next; }
function openInstanceForm() { instanceForm.agentId = store.adapters[0]?.id ?? ''; instanceForm.name = ''; instanceForm.configRoot = ''; instanceForm.writable = true; drawer.value = 'instance'; }
function openProjectForm() { projectForm.name = ''; projectForm.rootPath = ''; drawer.value = 'project'; }
function openBinding(binding: Binding) { selectedPublicMembers.value = []; selectedBinding.value = binding; drawer.value = 'binding'; }
function drawerVisibility(value: boolean) { if (!value) drawer.value = null; }
async function refresh() { try { await store.refresh(); } catch { /* the store keeps the connection error visible */ } }
async function saveInstance() {
  if (!instanceForm.agentId || !instanceForm.configRoot.trim()) return;
  actionBusy.value = true;
  try {
    const registered = await api.registerInstance({ agentId: instanceForm.agentId, name: instanceForm.name.trim() || undefined, configRoot: instanceForm.configRoot.trim(), writable: ['codex','zcode','claude-code','deepseek-harness'].includes(instanceForm.agentId) && instanceForm.writable });
    await api.scan({ instanceId: registered.id });
    await store.refresh(); ElMessage.success('Agent 实例已登记'); drawer.value = null;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败'); }
  finally { actionBusy.value = false; }
}
async function saveProject() {
  if (!projectForm.rootPath.trim()) return;
  actionBusy.value = true;
  try {
    await api.registerProject({ name: projectForm.name.trim() || undefined, rootPath: projectForm.rootPath.trim() });
    await store.refresh(); ElMessage.success('项目空间已登记'); drawer.value = null;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败'); }
  finally { actionBusy.value = false; }
}
async function scan(discover = false, discoverUserHome = false) {
  actionBusy.value = true;
  try {
    if (discoverUserHome) { store.selectedInstanceId = ''; store.selectedProjectId = ''; clearFilters(); }
    store.setCatalog(await api.scan({ discover, discoverUserHome, scanRegisteredProjects: !store.selectedProjectId, ...(store.selectedInstanceId ? { instanceId: store.selectedInstanceId } : {}), ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}) }));
    await store.refresh();
    ElMessage.success(discoverUserHome ? `本机只读扫描完成，索引共 ${store.bindings.length} 项资源` : discover ? '扫描与实例发现已完成' : '只读扫描已完成');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '扫描失败'); }
  finally { actionBusy.value = false; }
}
async function scanProject(projectId: string) {
  actionBusy.value = true;
  try {
    clearFilters();
    store.selectedInstanceId = '';
    store.selectedProjectId = projectId;
    store.setCatalog(await api.scan({ projectId }));
    await store.refresh();
    page.value = 'resources';
    ElMessage.success('项目只读扫描完成');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '项目扫描失败'); }
  finally { actionBusy.value = false; }
}
async function demo() {
  actionBusy.value = true;
  try { store.setCatalog(await api.initializeDemo()); await store.refresh(); ElMessage.success('隔离演示数据已准备'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法初始化演示数据'); }
  finally { actionBusy.value = false; }
}
async function planToggle(binding: Binding, enabled: boolean) {
  if (!canPlan(binding)) return;
  actionBusy.value = true;
  try { activePlan.value = await api.createPlan({ bindingId: binding.id, enabled }); appliedOperation.value = null; restoreOf.value = null; drawer.value = 'plan'; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法生成变更计划'); }
  finally { actionBusy.value = false; }
}
async function applyPlan() {
  if (!activePlan.value || activePlan.value.status !== 'ready') return;
  actionBusy.value = true;
  try {
    appliedOperation.value = await api.applyPlan(activePlan.value.id, activePlan.value.afterHash);
    if (appliedOperation.value.status === 'succeeded' && activePlan.value) activePlan.value.status = 'applied';
    await Promise.all([store.refresh(), loadOperations()]);
    ElMessage[appliedOperation.value.status === 'succeeded' ? 'success' : 'warning'](appliedOperation.value.status === 'succeeded' ? '操作完成，配置状态已刷新' : `操作结果：${appliedOperation.value.status}`);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '应用计划失败'); }
  finally { actionBusy.value = false; }
}
async function loadOperations() {
  operationsError.value = '';
  try { operations.value = await api.operations(); }
  catch (error) { operationsError.value = error instanceof Error ? error.message : '无法读取操作记录'; }
}
async function planRestore(operation: Operation) {
  if (operation.status !== 'succeeded') return;
  restoreBusy.value = operation.id;
  try { activePlan.value = await api.createRestorePlan(operation.id); appliedOperation.value = null; restoreOf.value = operation.id; drawer.value = 'plan'; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法生成恢复计划'); }
  finally { restoreBusy.value = ''; }
}
function goTo(next: Page) { page.value = next; if (next === 'operations' || next === 'overview') void loadOperations(); }
function clearFilters() { configurationFilter.value = []; kindFilter.value = 'all'; scopeFilter.value = []; ownerAgentFilter.value = []; categoryFilter.value = []; sourceFilter.value = []; originFilter.value = 'all'; searchText.value = ''; }
const activeFilterLabels: Record<string, Record<string, string>> = {
  scope: { 'user-global': '用户全局', project: '项目级', 'project-directory': '项目子目录级', unknown: '使用范围未知' },
  owner: { shared: '共享来源（有证据）', unknown: '归属未知' },
  origin: { cache: '插件缓存', configuration: '配置记录', filesystem: '本地文件' },
};
const activeFilterChips = computed(() => {
  const chips: Array<{ group: string; value: string; label: string }> = [];
  for (const value of configurationFilter.value) chips.push({ group: 'configurationState', value, label: value === 'on' ? '已启用' : value === 'off' ? '已禁用' : '未确定' });
  for (const value of scopeFilter.value) chips.push({ group: 'scope', value, label: activeFilterLabels.scope[value] ?? value });
  for (const value of ownerAgentFilter.value) chips.push({ group: 'owner', value, label: activeFilterLabels.owner[value] ?? agentName(value) });
  for (const value of categoryFilter.value) chips.push({ group: 'category', value, label: categoryLabel(value) });
  for (const value of sourceFilter.value) chips.push({ group: 'source', value, label: sourceLabel(value) });
  if (originFilter.value && originFilter.value !== 'all') chips.push({ group: 'origin', value: originFilter.value, label: activeFilterLabels.origin[originFilter.value] ?? originFilter.value });
  return chips;
});
function removeFilterChip(group: string, value: string) {
  if (group === 'configurationState') configurationFilter.value = configurationFilter.value.filter(item => item !== value);
  else if (group === 'scope') scopeFilter.value = scopeFilter.value.filter(item => item !== value);
  else if (group === 'owner') ownerAgentFilter.value = ownerAgentFilter.value.filter(item => item !== value);
  else if (group === 'category') categoryFilter.value = categoryFilter.value.filter(item => item !== value);
  else if (group === 'source') sourceFilter.value = sourceFilter.value.filter(item => item !== value);
  else if (group === 'origin') originFilter.value = '';
}
function openEvents() {
  if (eventSource) return;
  const source = new EventSource(api.eventsUrl(), { withCredentials: true });
  source.onopen = () => { eventStatus.value = 'connected'; };
  source.addEventListener('catalog.changed', () => { void refresh(); });
  source.addEventListener('operation.completed', () => { void refresh(); void loadOperations(); });
  source.onerror = () => { eventStatus.value = 'offline'; };
  eventStatus.value = 'connecting';
  eventSource = source;
}
async function connectAndOpen() {
  await store.connect();
  if (!store.sessionReady) return;
  await loadOperations();
  openEvents();
}
onMounted(() => { window.addEventListener('keydown', onGlobalKeydown); void connectAndOpen(); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKeydown); eventSource?.close(); });
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const search = document.querySelector<HTMLElement>('.panel-tools .el-input__inner');
  if (event.key === '/') {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')) return;
    if (!search || drawer.value !== null) return;
    event.preventDefault();
    search.focus();
    return;
  }
  if (event.key === 'Escape' && search && document.activeElement === search && searchText.value) searchText.value = '';
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><div><strong>AgentDeck</strong><small>本地扩展管理器</small></div></div>
      <div class="section-label">工作区</div>
      <nav aria-label="主导航"><button v-for="item in pages" :key="item.id" class="nav-item" :class="{active: page === item.id}" @click="goTo(item.id)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span><small v-if="item.id === 'operations' && operations.length">{{ operations.length }}</small></button></nav>
      <div class="divider"></div><div class="section-label clients-label"><span>客户端能力</span><i></i></div>
      <div v-if="store.adapters.length" class="clients"><div v-for="adapter in store.adapters" :key="adapter.id" class="client"><span>{{ adapter.name.slice(0,1) }}</span><b>{{ adapter.name }}</b><small>{{ store.instances.filter((i) => i.agentId === adapter.id).length }}</small></div></div><p v-else class="sidebar-note">连接服务后读取适配器注册表</p>
      <div class="sidebar-bottom"><span class="local-indicator"><i :class="store.sessionReady ? 'online' : ''"></i>{{ store.sessionReady ? '本机服务已连接' : '等待本机服务' }}</span><small>AgentDeck · 基础版</small></div>
    </aside>

    <main class="main">
      <header class="topbar"><div class="crumb"><span>AgentDeck</span><i>/</i><b>{{ pages.find((item) => item.id === page)?.label }}</b></div><div class="top-controls">
        <label><span>客户端</span><el-select v-model="store.selectedInstanceId" clearable placeholder="全部实例" :disabled="!store.sessionReady"><el-option v-for="i in store.instances" :key="i.id" :value="i.id" :label="`${agentName(i.agentId)} · ${i.name}`" /></el-select></label>
        <label><span>项目</span><el-select v-model="store.selectedProjectId" clearable placeholder="全部项目" :disabled="!store.sessionReady"><el-option v-for="p in store.projects" :key="p.id" :value="p.id" :label="p.name" /></el-select></label>
        <el-button class="refresh" circle :loading="store.busy" :disabled="!store.sessionReady" aria-label="刷新" @click="refresh"><el-icon><Refresh /></el-icon></el-button>
      </div></header>

      <section v-if="!store.sessionReady" class="connect-page">
        <div class="connect-art"><span class="ring ring-a"></span><span class="ring ring-b"></span><span class="connect-core"><el-icon><Connection /></el-icon></span><i class="spark a"></i><i class="spark b"></i></div>
        <small class="connect-kicker"><i></i> 需要本机会话</small><h1>连接你的本机工作区</h1>
        <p>AgentDeck 只访问本机服务。请从后台输出的本机链接打开网页；启动票据会在兑换后自动从地址栏移除。</p>
        <div v-if="store.sessionError" class="connect-error"><el-icon><InfoFilled /></el-icon>{{ store.sessionError }}</div>
        <el-button type="primary" :loading="store.busy" @click="connectAndOpen"><el-icon><Refresh /></el-icon>重新连接</el-button>
        <small class="connect-foot"><el-icon><InfoFilled /></el-icon>开发环境前端地址为 127.0.0.1:5173，后台 API 由本机 4780 端口代理提供。</small>
      </section>

      <section v-else class="content">
        <div class="page-heading"><div><small class="eyebrow"><i></i> 本机环境</small><h1>{{ pages.find((item) => item.id === page)?.label }}</h1><p>{{ page === 'resources' ? '查看本机配置发现的 Skill、插件和 MCP，状态来自当前注册适配器。' : page === 'instances' ? '登记配置根目录并查看适配器注册表提供的能力范围。' : page === 'projects' ? '手动登记项目根目录，为扫描提供明确边界。' : page === 'operations' ? '查看配置变更结果，并从成功操作创建恢复计划。' : '总览本机客户端状态、资源规模与最近配置变更。' }}</p></div>
          <div class="heading-actions"><template v-if="page === 'instances'"><el-button @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现客户端</el-button><el-button type="primary" @click="openInstanceForm"><el-icon><Plus /></el-icon>登记实例</el-button></template><el-button v-if="page === 'projects'" type="primary" @click="openProjectForm"><el-icon><FolderAdd /></el-icon>登记项目</el-button><template v-if="page === 'resources' || page === 'overview'"><el-button @click="scan(false)" :loading="actionBusy"><el-icon><Refresh /></el-icon>重新扫描已登记实例</el-button><el-button type="primary" @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现并扫描本机资源</el-button></template></div>
        </div>
        <div v-if="store.refreshError" class="inline-error"><el-icon><InfoFilled /></el-icon><span>{{ store.refreshError }}</span><el-button text @click="refresh">重试</el-button></div>

        <template v-if="page === 'overview' || page === 'resources'">
          <div class="stats"><article><div><span>已登记实例</span><i><Connection /></i></div><strong>{{ store.instances.length }}</strong><small>来自本机适配器目录</small></article><article><div><span>可见扩展</span><i class="blue"><Box /></i></div><strong>{{ stats.all }}</strong><small>当前筛选范围内</small></article><article><div><span>Skill</span><i class="violet"><Document /></i></div><strong>{{ stats.skills }}</strong><small>按三类元数据查看</small></article><article><div><span>插件 / MCP</span><i class="amber"><Files /></i></div><strong>{{ stats.plugins + stats.mcps }}</strong><small>插件 {{ stats.plugins }} · MCP {{ stats.mcps }}</small></article><article><div><span>扫描提示</span><i class="rose"><InfoFilled /></i></div><strong>{{ stats.diagnostics }}</strong><small>适配器返回的诊断</small></article></div>
          <template v-if="page === 'overview'">
            <div class="overview-grid">
              <section class="panel overview-panel">
                <div class="panel-heading"><div><h2>客户端状态</h2><small>按适配器汇总实例与资源规模；版本与能力证据见 Agent 实例页。</small></div><el-button size="small" @click="goTo('instances')">查看实例</el-button></div>
                <div class="client-summary">
                  <button v-for="adapter in store.adapters" :key="adapter.id" class="client-row" @click="goTo('instances')">
                    <i>{{ adapter.name.slice(0,1) }}</i>
                    <div><b>{{ adapter.name }}</b><small>{{ instanceCountFor(adapter.id) }} 个实例 · {{ resourceCountFor(adapter.id) }} 项资源</small></div>
                    <span class="summary-state status-chip" :class="adapterStateFor(adapter.id)">{{ clientStatusLabel(adapterStateFor(adapter.id)) }}</span>
                  </button>
                  <p v-if="!store.adapters.length" class="sidebar-note">连接服务后读取适配器注册表</p>
                </div>
              </section>
              <section class="panel overview-panel">
                <div class="panel-heading"><div><h2>最近操作</h2><small>成功操作可在操作记录中创建恢复计划。</small></div><el-button size="small" @click="goTo('operations')">查看全部</el-button></div>
                <div v-if="operations.length" class="recent-ops">
                  <div v-for="op in operations.slice(0,5)" :key="op.id" class="recent-op">
                    <span :class="['op-status', op.status]">{{ op.status==='succeeded'?'已完成':op.status==='conflict'?'检测到冲突':'失败' }}</span>
                    <div><b>{{ op.kind==='restore'?'恢复配置':'启停配置' }}</b><small>{{ op.targetPath }}</small></div>
                    <small class="recent-time">{{ timeLabel(op.createdAt) }}</small>
                  </div>
                </div>
                <div v-else class="empty slim"><i><el-icon><List/></el-icon></i><b>暂无配置操作</b><span>基础版支持独立 MCP，以及已验收的配置根 Skill 和本地市场插件开关。</span></div>
              </section>
            </div>
          </template>
          <section v-else class="panel fill-panel"><div class="panel-heading"><div><h2>本机资源</h2><small>{{ store.catalog?.lastScanAt ? `上次扫描 ${timeLabel(store.catalog.lastScanAt)}` : '尚无扫描记录' }}</small></div><div class="panel-tools"><el-input v-model="searchText" clearable placeholder="搜索名称或来源路径"><template #prefix><el-icon><Search /></el-icon></template></el-input><el-button class="refresh" circle aria-label="刷新资源" :loading="store.busy" @click="refresh"><el-icon><Refresh /></el-icon></el-button></div></div>
            <div class="panel-body-scroll">
            <div class="filter-row"><div class="tabs"><button v-for="tab in [{id:'all',label:'全部'},{id:'skill',label:'Skill'},{id:'plugin',label:'插件'},{id:'mcp',label:'MCP'}]" :key="tab.id" :class="{selected:kindFilter===tab.id}" :aria-label="tab.label" @click="kindFilter=tab.id as 'all'|'skill'|'plugin'|'mcp'">{{ tab.label }}<small>{{ tabCounts[tab.id] }}</small></button></div><div class="skill-filters">
              <el-select v-model="scopeFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="配置/使用范围" aria-label="作用范围"><el-option label="用户全局" value="user-global"/><el-option label="项目级" value="project"/><el-option label="项目子目录级" value="project-directory"/><el-option label="使用范围未知" value="unknown"/></el-select>
              <el-select v-model="ownerAgentFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="所属 Agent" aria-label="所属 Agent"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/><el-option label="公共来源（无 Agent 归属）" value="public"/><el-option label="共享来源（有证据）" value="shared"/><el-option label="归属未知" value="unknown"/></el-select>
              <el-select v-model="sourceFilter" data-testid="resource-source-filter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源来源"><el-option label="用户自建 / 导入" value="user"/><el-option label="项目仓库提供" value="repository"/><el-option label="插件附带" value="plugin"/><el-option label="Agent 内置" value="builtin"/><el-option label="组织管理" value="organization"/><el-option label="账号同步" value="account-sync"/><el-option label="来源未知" value="unknown"/></el-select>
              <el-select v-model="originFilter" data-testid="resource-origin-filter" clearable placeholder="配置或文件来源"><el-option label="全部来源类型" value="all"/><el-option label="插件缓存" value="cache"/><el-option label="配置记录" value="configuration"/><el-option label="本地文件" value="filesystem"/></el-select>
              <el-select v-model="categoryFilter" data-testid="resource-category-filter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源归类"><el-option label="用户全局来源" value="user-global"/><el-option label="项目公共来源" value="project"/><el-option label="Agent 全局资源" value="agent-global"/><el-option label="Agent 项目资源" value="agent-project"/><el-option label="归类待确定" value="unknown"/></el-select>
              <el-select v-model="configurationFilter" data-testid="configuration-state-filter" aria-label="配置状态筛选" multiple collapse-tags clearable placeholder="配置状态"><el-option label="已启用" value="on"/><el-option label="已禁用" value="off"/><el-option label="未确定" value="unknown"/></el-select>
            </div></div>
            <div v-if="activeFilterChips.length" class="active-filters" aria-label="已选筛选条件"><span class="active-filters-label">已选筛选</span><button v-for="chip in activeFilterChips" :key="chip.group + ':' + chip.value" class="filter-chip" :title="'移除条件：' + chip.label" @click="removeFilterChip(chip.group, chip.value)">{{ chip.label }}<el-icon><Close /></el-icon></button><button class="filter-chip clear-all" @click="clearFilters">清除全部</button></div>
            <div class="taxonomy-note"><el-icon><InfoFilled /></el-icon>资源归类区分用户来源与 Agent 全局/项目资源；未配置缓存可确定存放归属，使用范围仍未知。归属不表示内容专用或已加载。</div>
            <div v-if="visible.length" class="table-scroll"><table class="resource-table"><thead><tr><th scope="col">扩展资源</th><th scope="col">资源归类</th><th scope="col">范围</th><th scope="col">所属 Agent</th><th scope="col">来源</th><th scope="col">配置状态</th><th scope="col">启停</th><th scope="col"><span class="visually-hidden">诊断</span></th></tr></thead><tbody>
              <tr v-for="item in visible" :key="item.key" :class="{child:item.depth>0,parent:item.binding.kind==='plugin','plugin-group':!!item.group,'public-group':!!item.publicGroup}" @click="openRow(item)"><td>
                <div class="resource-cell" :style="{paddingLeft:`${item.depth*24}px`}">
                  <button v-if="item.group || item.binding.kind==='plugin'&&item.children" class="tree-toggle" :class="{expanded:expanded.has(item.key)}" :aria-expanded="expanded.has(item.key)" :aria-label="item.group ? expanded.has(item.key)?'收起插件版本':'展开插件版本':expanded.has(item.key)?'收起插件组件':'展开插件组件'" @click.stop="togglePlugin(item.key)"><el-icon><ArrowRight/></el-icon></button>
                  <span v-else-if="item.depth" class="tree-stem"></span><i class="kind-icon" :class="item.binding.kind"><el-icon><component :is="item.binding.kind==='skill'?Document:item.binding.kind==='plugin'?Box:Connection"/></el-icon></i>
                  <div class="resource-copy"><div class="resource-title"><button class="resource-detail-link" :title="rowName(item)" :aria-label="rowName(item)" @click.stop="openRow(item)">{{ resourceName(item.binding) }}</button>
                    <span v-if="item.publicGroup" class="version-badge">公共资源</span><span v-else-if="item.group" class="version-badge">版本分组</span>
                    <span v-else-if="item.binding.pluginVersion && item.binding.origin==='cache'" class="version-badge">缓存版本 v{{ item.binding.pluginVersion }}</span>
                    <span v-if="!item.group && (item.publicGroup ? item.publicGroup.members.every(diskOnly) : diskOnly(item.binding))" class="inventory-badge">仅磁盘发现</span>
                  </div><small :title="rowDescription(item)">{{ rowDescription(item) }}</small></div>
                  <small v-if="item.group || item.binding.kind==='plugin'&&item.children" class="child-count">{{ item.children }} {{ item.group?'条记录':'项' }}</small>
                </div>
              </td>
                <td class="classification-cell"><strong class="resource-category">{{ categoryLabel(inventoryCategory(item.binding)) }}</strong><code :title="item.group ? item.binding.pluginId : item.binding.sourcePath">{{ item.group ? item.binding.pluginId : item.binding.sourcePath }}</code><small :title="item.binding.classification?.reason">{{ item.group ? '展开查看各记录的原文路径与分类依据' : item.binding.classification?.reason ?? '旧索引无分类证据，请重新扫描' }}</small></td>
                <td class="scope-cell"><span class="tag scope" :title="item.binding.classification?.reason">{{ scopeLabel(inventoryScope(item.binding)) }}</span><small v-if="item.binding.classification?.projectName" :title="item.binding.classification.projectName">{{ item.binding.classification.projectName }}</small><small v-else-if="inventoryScope(item.binding)==='user-global'">不限定项目</small></td>
                <td class="agent-cell"><span>{{ inventoryAgent(item.binding)==='unknown'?'归属未知':agentName(inventoryAgent(item.binding)) }}</span><small v-if="item.binding.classification?.sharedSource" :title="item.binding.classification.sharedSource.agentIds.map(agentName).join('、')">共享来源 · {{ item.binding.classification.sharedSource.agentIds.map(agentName).join('、') }}</small></td>
                <td><span v-if="item.group">配置 / 缓存汇总</span><span v-else-if="item.binding.kind==='skill'" class="tag source">{{ (item.binding as SkillBinding).sourceLabel ?? sourceLabel(item.binding.sourceKind) }}</span><span v-else>{{ sourceLabel(item.binding.sourceKind) }}</span><small v-if="!item.group && originLabel(item.binding)" class="origin-detail">{{ originLabel(item.binding) }}</small></td>
                <td><span class="config-state" :class="(item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).tone" :title="(item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).reason"><i></i>{{ (item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).label }}</span></td>
                <td>
                  <template v-if="!item.publicGroup && canPlan(item.binding)">
                    <el-switch :model-value="item.binding.enabled===true" :disabled="actionBusy" :loading="actionBusy" :aria-label="`${resourceName(item.binding)}启停`" @click.stop @change="toggleBinding(item.binding,Boolean($event))"/>
                    <el-tooltip content="查看启停预览"><button class="plan-link" :disabled="actionBusy" :aria-label="item.binding.enabled===true?'计划停用':item.binding.enabled===false?'计划启用':'生成启用计划'" @click.stop="planToggle(item.binding,item.binding.enabled!==true)"><el-icon><InfoFilled/></el-icon></button></el-tooltip>
                  </template>
                  <el-tooltip v-else :content="readOnlyReason(item.binding)"><span class="readonly"><i class="cap-dot"></i><el-icon><Setting/></el-icon>只读</span></el-tooltip>
                </td>
                <td><el-tooltip v-if="item.binding.diagnostics.length" :content="item.binding.diagnostics.join('；')"><el-icon class="notice"><InfoFilled/></el-icon></el-tooltip></td></tr>
            </tbody></table></div>
            <div v-else-if="!store.bindings.length" class="empty"><i><el-icon><Box/></el-icon></i><b>还没有可显示的资源</b><span>{{ store.instances.length ? '已登记实例尚未发现资源，可重新扫描或发现本机客户端。' : '尚未接入本机配置。开发模式默认使用隔离目录；点击下方按钮只读扫描当前用户的客户端配置。' }}</span><div><el-button type="primary" :loading="actionBusy" @click="scan(true, true)"><el-icon><Search/></el-icon>扫描本机配置（只读）</el-button><el-button v-if="!store.instances.length&&!store.projects.length" :loading="actionBusy" @click="demo">载入隔离演示数据</el-button></div></div>
            <div v-else class="empty-filter"><el-icon><Search/></el-icon>当前筛选没有匹配项<el-button text @click="clearFilters">清除筛选</el-button></div>
            </div>
            <footer class="panel-footer"><span>显示 {{ visible.length }} 行 · 版本分组可展开 <template v-if="store.catalog?.lastScanAt">· 最近扫描 {{ timeLabel(store.catalog.lastScanAt) }}</template></span><span><i :class="eventStatus"></i>{{ eventStatus==='connected'?'实时事件已连接':eventStatus==='connecting'?'连接实时事件…':'事件通道离线' }}</span></footer>
          </section>
        </template>

        <section v-else-if="page==='instances'" class="panel records-panel"><div class="panel-heading"><div><h2>客户端兼容报告</h2><small>PATH 候选、配置目录、CLI 签名和逐资源能力证据分别展示；扫描本身不会启动客户端。</small></div></div>
          <div v-if="store.compatibility?.clients.length" class="instance-grid"><article v-for="report in store.compatibility.clients" :key="report.id" class="instance-card"><div class="instance-top"><i>{{ report.agentName.slice(0,1) }}</i><small class="status-chip" :class="report.status">{{ clientStatusLabel(report.status) }}</small></div><h3>{{ report.instanceName??`${report.agentName} · 未登记实例` }}</h3><span class="instance-client">{{ report.agentName }} · {{ report.instanceId ? (store.instances.find(i=>i.id===report.instanceId)?.discovery==='auto'?'自动发现':store.instances.find(i=>i.id===report.instanceId)?.discovery==='manual'?'手动登记':'隔离演示') : '仅显示未登记客户端状态' }}</span>
            <div class="path-block"><small>配置根目录 · {{ clientConfigStateLabel(report) }}</small><code :title="report.configRoot??''">{{ report.configRoot??'适配器未提供默认配置路径' }}</code></div>
            <div class="path-block"><small>PATH 程序候选</small><code :title="report.executableCandidate?.path??''">{{ report.executableCandidate?.path??'未发现候选' }}</code><small v-if="report.executableCandidate">候选身份检查 {{ timeLabel(report.executableCandidate.checkedAt) }}</small></div>
            <div class="policy"><small>CLI 版本证据</small><b>{{ report.versionEvidence ? `${report.versionEvidence.version} · ${report.versionEvidence.platform}` : report.status==='demo'?'演示数据没有主机版本证据':'版本未知 · 尚无可识别版本签名' }}</b><span>{{ report.versionEvidence?'只识别到 CLI 输出签名，不证明官方发行来源、桌面应用安装或资源正在运行。':report.agentId==='codex'||report.agentId==='claude-code'?'需手动触发 --version 检查；失败时不会保存原始输出。':'此客户端没有已验证的版本检查命令，只显示 PATH 候选。' }}</span></div>
            <div v-if="report.instanceId" class="policy"><small>本机控制策略</small><b>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'默认允许受支持资源启停':'只读' }}</b><span>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'仍需满足适配器资源级条件；兼容报告不会授予写权限。':'此实例被设为只读，或客户端尚不支持启停。' }}</span></div>
            <div class="report-actions"><el-button v-if="reportCanCheckVersion(report)" size="small" :loading="versionCheckBusy===report.instanceId" @click="checkVersion(report)">{{ versionCheckButtonLabel(report) }}</el-button><el-button v-if="!report.instanceId" size="small" @click="openInstanceForm">登记此客户端</el-button><span v-else>{{ store.bindings.filter(b=>b.instanceId===report.instanceId).length }} 项资源</span></div>
            <details class="matrix-details"><summary>能力矩阵 · {{ report.capabilities.filter(e=>e.area!=='runtime').length }} 项</summary><div class="capability-matrix"><article v-for="(evidence,index) in report.capabilities.filter(e=>e.area!=='runtime')" :key="`${report.id}-${index}`"><div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ evidence.resourceKind?({skill:'Skill',plugin:'插件',mcp:'MCP'})[evidence.resourceKind]:'通用' }}</b><small>{{ capabilityStatusLabel(evidence) }}</small></div><span>{{ capabilityScopeLabel(evidence) }}<template v-if="evidence.mcpTransport==='stdio'"> · STDIO</template><template v-else-if="evidence.mcpTransport==='http'"> · HTTP</template></span><p>{{ evidence.readable?'可读取':'不可读' }} · {{ evidence.writable?'受限可写':'只读' }} · {{ evidence.reason }}</p><small v-if="evidence.clientVersion">适用版本 {{ evidence.clientVersion }} · {{ evidence.platform }}</small><code v-if="evidence.evidenceReference">证据：{{ evidence.evidenceReference }}</code></article></div></details>
            <p v-if="report.diagnostics.length" class="diagnostics"><el-icon><InfoFilled/></el-icon>{{ report.diagnostics.join('；') }}</p>
          </article></div>
          <div v-else class="empty"><i><el-icon><Connection/></el-icon></i><b>兼容报告尚未加载</b><span>刷新本机服务后查看所有已登记实例和未发现客户端。</span><div><el-button type="primary" @click="refresh" :loading="store.busy">刷新报告</el-button></div></div>
          <div class="capabilities"><div class="cap-title"><el-icon><InfoFilled/></el-icon>证据边界<small>配置证据不代表资源已加载</small></div><div class="cap-row"><div><b>客户端身份</b><small>CLI 版本需要精确签名；PATH 候选不等同官方安装。</small></div><span>CLI 可识别 · 发行来源未知</span></div><div class="cap-row"><div><b>原生 Codex 配置</b><small>0.159.2 / Windows：独立 STDIO MCP、配置根独立 Skill、本地市场插件有隔离复读证据。</small></div><span>该证据不会改变手动写入授权。</span></div></div>
        </section>

        <section v-else-if="page==='projects'" class="panel records-panel"><div class="panel-heading"><div><h2>已登记项目</h2><small>仅扫描明确登记的项目根目录</small></div><el-button type="primary" @click="openProjectForm"><el-icon><FolderAdd/></el-icon>登记项目</el-button></div><div v-if="store.projects.length" class="project-list"><article v-for="p in store.projects" :key="p.id"><i><el-icon><Folder/></el-icon></i><div><b>{{ p.name }}</b><code :title="p.rootPath">{{ p.rootPath }}</code></div><span>{{ store.bindings.filter(b=>b.projectId===p.id).length }} 项项目资源</span><el-button :disabled="!store.sessionReady" :loading="actionBusy" @click="scanProject(p.id)">扫描项目</el-button></article></div><div v-else class="empty"><i><el-icon><Folder/></el-icon></i><b>还没有登记项目</b><span>项目范围资源扫描需要明确的项目根目录。</span><div><el-button type="primary" @click="openProjectForm">登记项目</el-button></div></div></section>

        <section v-else class="panel records-panel"><div class="panel-heading"><div><h2>变更历史</h2><small>成功操作可生成恢复计划；应用前服务端会再次检查摘要。</small></div><el-button @click="loadOperations"><el-icon><Refresh/></el-icon>刷新记录</el-button></div><div v-if="operationsError" class="inline-error"><el-icon><InfoFilled/></el-icon>{{ operationsError }}<el-button text @click="loadOperations">重试</el-button></div><div v-if="operations.length" class="table-scroll"><table class="operation-table"><thead><tr><th scope="col">操作</th><th scope="col">目标路径</th><th scope="col">结果</th><th scope="col">创建时间</th><th scope="col">恢复</th></tr></thead><tbody><tr v-for="op in operations" :key="op.id"><td><b>{{ op.kind==='restore'?'恢复配置':'启停配置' }}</b><small class="op-id">{{ op.id.slice(0,10) }}</small></td><td><code :title="op.targetPath">{{ op.targetPath }}</code></td><td><span :class="['op-status',op.status]">{{ op.status==='succeeded'?'已完成':op.status==='conflict'?'检测到冲突':'失败' }}</span><small v-if="op.error" class="op-error" :title="op.error">{{ op.error }}</small></td><td>{{ timeLabel(op.createdAt) }}</td><td><el-button v-if="op.status==='succeeded'&&op.backupId" size="small" :loading="restoreBusy===op.id" @click="planRestore(op)">创建恢复计划</el-button><span v-else class="muted-text">{{ op.status==='succeeded'?'未改动，无需恢复':'需成功操作后才能恢复' }}</span></td></tr></tbody></table></div><div v-else-if="!operationsError" class="empty"><i><el-icon><List/></el-icon></i><b>暂无配置操作</b><span>基础版支持独立 MCP，以及已验收的配置根 Skill 和本地市场插件开关。</span><div><el-button @click="goTo('resources')">查看资源</el-button></div></div></section>
      </section>
    </main>

    <el-drawer :model-value="drawer!==null" @update:model-value="drawerVisibility" :title="drawer==='instance'?'登记 Agent 实例':drawer==='project'?'登记项目空间':drawer==='binding'?'资源详情':'检查变更计划'" :size="drawer==='plan'?'min(660px,96vw)':'min(500px,96vw)'" destroy-on-close>
        <template v-if="drawer==='instance'"><div class="drawer-intro"><i><el-icon><Connection/></el-icon></i><div><b>添加本机配置来源</b><small>只读取你提交的目录，不猜测或改写其他路径。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveInstance"><el-form-item label="客户端" required><el-select v-model="instanceForm.agentId" placeholder="从适配器注册表选择" class="full"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/></el-select></el-form-item><el-form-item label="显示名称"><el-input v-model="instanceForm.name" placeholder="可选，例如：工作用配置"/></el-form-item><el-form-item label="配置根目录" required><el-input v-model="instanceForm.configRoot" placeholder="例如：C:\Users\you\.config\agent"/></el-form-item><div v-if="['codex','zcode','claude-code','deepseek-harness'].includes(instanceForm.agentId)" class="write-opt"><el-checkbox v-model="instanceForm.writable">允许资源启停（仅目标开关）</el-checkbox><p>仅修改已识别资源的开关值，其他设置和资源文件保持原样；保留备份与恢复。Codex 的部分开关仍需版本核对。</p></div><div v-else class="readonly-note"><el-icon><InfoFilled/></el-icon>当前客户端首轮为只读接入；登记不会开放写入操作。</div><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!instanceForm.agentId||!instanceForm.configRoot.trim()" @click="saveInstance">登记实例</el-button></div></el-form></template>
      <template v-else-if="drawer==='project'"><div class="drawer-intro"><i><el-icon><Folder/></el-icon></i><div><b>设置扫描边界</b><small>只扫描登记的项目路径，不进行全盘搜索。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveProject"><el-form-item label="项目名称"><el-input v-model="projectForm.name" placeholder="留空时由服务端生成显示名称"/></el-form-item><el-form-item label="项目根目录" required><el-input v-model="projectForm.rootPath" placeholder="例如：D:\work\my-project"/></el-form-item><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!projectForm.rootPath.trim()" @click="saveProject">登记项目</el-button></div></el-form></template>
      <template v-else-if="drawer==='plan'&&activePlan"><div class="plan-warning"><i><el-icon><Setting/></el-icon></i><div><b>{{ restoreOf?'配置恢复计划':'资源启停预览' }}</b><small>配置修改 · 支持范围见资源证据；应用后重启 Codex，当前会话状态未知</small></div><span>{{ appliedOperation?'已提交':activePlan.status==='ready'?'待核对':activePlan.status==='applied'?'已应用':'已过期' }}</span></div><section class="plan-section"><small>修改目标</small><div class="target"><i class="kind-icon mcp"><el-icon><Connection/></el-icon></i><div><b>{{ planBinding?resourceName(planBinding):'资源' }}</b><small>{{ planInstance?`${agentName(planInstance.agentId)} · ${planInstance.name}`:activePlan.instanceId }}</small></div></div><div class="plan-path"><small>配置文件</small><code>{{ activePlan.targetPath }}</code></div><div class="plan-path"><small>计划动作</small><b>{{ activePlan.action==='restore'?'恢复到操作前配置':activePlan.desiredEnabled?'启用资源配置':'停用资源配置' }}</b></div></section><section class="impact"><div><small>影响范围</small><b>{{ affected.length+1 }} 条关联绑定</b></div><p>本次只修改目标实例的用户配置。插件开关影响该身份全部版本和子组件；Skill 只改按路径覆盖，原文保持不变。关联条目会重新扫描，运行状态仍未知。</p><div class="impact-row current"><i></i><b>{{ planBinding?resourceName(planBinding):'当前绑定' }}</b><span>{{ planInstance?agentName(planInstance.agentId):'目标实例' }} · 本次计划</span></div><div v-for="b in affected" :key="b.id" class="impact-row"><i></i><b>{{ resourceName(b) }}</b><span>{{ store.instances.find(i=>i.id===b.instanceId)?.name??b.instanceId }} · 同源关联</span></div></section><section class="diff"><div><small>脱敏差异</small><span><el-icon><InfoFilled/></el-icon>不显示原始凭据</span></div><pre>{{ activePlan.diff||'适配器未返回差异文本。' }}</pre><div class="hashes"><span><small>写前摘要</small><code :title="activePlan.beforeHash">{{ activePlan.beforeHash }}</code><button class="hash-copy" type="button" @click="copyHash(activePlan.beforeHash)">复制</button></span><span><small>应用确认摘要（afterHash）</small><code :title="activePlan.afterHash">{{ activePlan.afterHash }}</code><button class="hash-copy" type="button" @click="copyHash(activePlan.afterHash)">复制</button></span></div></section><div class="plan-notes"><p><el-icon><InfoFilled/></el-icon>应用时提交 afterHash。若配置已变化、计划过期或目标身份无法确认，服务端应拒绝写入。</p><p><el-icon><Clock/></el-icon>计划有效期至 {{ timeLabel(activePlan.expiresAt) }}</p><p v-if="appliedOperation"><el-icon><InfoFilled/></el-icon>操作结果：{{ appliedOperation.status }}<template v-if="appliedOperation.error"> · {{ appliedOperation.error }}</template></p></div><div class="drawer-footer plan-actions"><el-button @click="drawer=null">{{ appliedOperation?'关闭':'稍后处理' }}</el-button><el-button v-if="activePlan.status==='ready'&&!appliedOperation" type="primary" :loading="actionBusy" @click="applyPlan">确认应用计划</el-button></div></template>
      <template v-else-if="drawer==='binding'&&selectedBinding">
        <div class="detail-header">
          <i class="kind-icon" :class="selectedBinding.kind"><el-icon><component :is="selectedBinding.kind==='skill'?Document:selectedBinding.kind==='plugin'?Box:Connection"/></el-icon></i>
          <div><b>{{ resourceName(selectedBinding) }}</b><small>{{ selectedBinding.description||selectedBinding.kind.toUpperCase() }}</small></div>
        </div>
        <div v-if="selectedPublicMembers.length" class="public-agent-states">
          <p>{{ publicDisabledLabel(selectedPublicMembers) }}。公共资源默认已启用，禁用仅针对对应 Agent；下方保留已扫描的配置记录。</p>
          <div v-for="binding in selectedPublicMembers" :key="binding.id" class="plan-path">
            <b>{{ discoveryAgent(binding) }} · {{ store.instances.find(i => i.id === binding.instanceId)?.name ?? binding.instanceId }}</b>
            <span class="config-state" :class="configurationState(binding).tone">{{ configurationState(binding).label }}</span>            <el-switch v-if="canPlan(binding)" :model-value="binding.enabled===true" :disabled="actionBusy" :aria-label="`${discoveryAgent(binding)}公共资源启停`" @change="toggleBinding(binding,Boolean($event))"/>
            <small>{{ configurationState(binding).reason }}</small>
            <code>{{ binding.configurationSourcePath ?? '未关联明确开关配置' }}</code>
            <code v-if="binding.configurationKey">{{ binding.configurationKey }}</code>
          </div>
        </div>
        <div class="detail-grid">
          <div><small>所属 Agent</small><b>{{ inventoryAgent(selectedBinding)==='unknown'?'归属未知':agentName(inventoryAgent(selectedBinding)) }}</b></div>
          <div><small>配置状态</small><b class="config-state" :class="selectedConfigurationState?.tone">{{ selectedConfigurationState?.label }}</b></div>
          <div class="wide"><small>配置状态依据与限制</small><b>{{ selectedConfigurationState?.reason }}</b></div>
          <div><small>索引来源</small><b>{{ originLabel(selectedBinding) || '来源类型未知' }}</b></div>
          <div><small>来源</small><b>{{ sourceLabel(selectedBinding.sourceKind) }}</b></div>
          <div><small>配置/使用范围</small><b>{{ classificationLabel(selectedBinding) }}</b></div>
          <div v-if="selectedBinding.classification?.discoveredByAgentId"><small>发现适配器（不代表客户端已加载）</small><b>{{ selectedPublicMembers.length ? [...new Set(selectedPublicMembers.map(discoveryAgent))].join("、") : agentName(selectedBinding.classification.discoveredByAgentId) }}</b></div><div class="wide"><small>资源归类</small><b>{{ bindingCategoryLabel(selectedBinding) }}</b></div>
          <div class="wide"><small>实际存放范围与依据</small><b>{{ categoryLabel(selectedBinding.classification?.location?.category ?? 'unknown') }} · {{ selectedBinding.classification?.location?.reason ?? '旧索引缺少存放证据，请重新扫描' }}</b><code>{{ selectedBinding.classification?.location?.rootPath ?? '根目录未确定' }}</code><code v-if="selectedBinding.classification?.location?.evidencePath">{{ selectedBinding.classification.location.evidencePath }}</code></div>
          <div v-if="selectedBinding.classification?.installationEvidence" class="wide"><small>安装登记证据</small><b>{{ selectedBinding.classification.installationEvidence.reason }}</b><code>{{ selectedBinding.classification.installationEvidence.path }}</code><small>安装记录范围：{{ scopeLabel(selectedBinding.classification.installationEvidence.scope) }}</small></div>
          <div class="wide"><small>分类依据</small><b>{{ selectedBinding.classification?.reason ?? '旧索引缺少分类证据，请重新扫描' }}</b><code>{{ selectedBinding.classification?.evidencePath ?? '无证据路径' }}</code></div>
          <div><small>归属关系</small><b>{{ selectedBinding.classification?.relationship==='configured'?'配置或安装登记已关联':diskOnly(selectedBinding)?'仅磁盘发现，未证明安装或加载':'未知' }}</b></div>
          <div class="wide"><small>项目与根目录</small><b>{{ selectedBinding.classification?.projectName ?? (inventoryScope(selectedBinding)==='user-global'?'不限定项目':'项目未确定') }}</b><code v-if="selectedBinding.classification?.projectRoot">{{ selectedBinding.classification.projectRoot }}</code></div>
          <div v-if="selectedBinding.classification?.sharedSource" class="wide"><small>共享来源证据</small><b>同一实际来源已在 {{ selectedBinding.classification.sharedSource.agentIds.map(agentName).join('、') }} 下发现；不证明内容兼容或当前加载。</b><code>{{ selectedBinding.classification.sharedSource.path }}</code><small>独立绑定：{{ selectedBinding.classification.sharedSource.bindingIds.join('、') }}</small></div>
          <div v-if="selectedBinding.kind==='mcp'"><small>MCP 传输</small><b>{{ selectedBinding.mcpTransport==='stdio'?'STDIO':selectedBinding.mcpTransport==='http'?'HTTP':'未知；不适用已验证的原生 STDIO 案例' }}</b></div>
          <div v-if="selectedBinding.discoveryOnly"><small>发现级别</small><b>仅磁盘发现 · 客户端可见性未验证</b></div><div v-if="selectedBinding.discoveryPath" class="wide"><small>分组路径</small><code>{{ selectedBinding.discoveryPath }}</code></div><div class="wide"><small>来源路径</small><code>{{ selectedBinding.sourcePath||'服务未提供路径' }}</code></div>
          <div class="wide"><small>原生配置键</small><code>{{ selectedBinding.nativeKey||'服务未提供键名' }}</code></div>
          <div v-if="selectedBinding.builtinSourcePath" class="wide"><small>Agent 内置来源证据</small><code>{{ selectedBinding.builtinSourcePath }}</code><p>客户端随包资源证明来源；启用状态单独依据配置，不证明当前会话加载。</p></div>
          <div v-if="selectedBinding.pluginId" class="wide"><small>完整插件身份</small><code>{{ selectedBinding.pluginId }}</code></div>
          <div v-if="selectedBinding.pluginVersion" class="wide"><small>缓存版本</small><b>{{ selectedBinding.pluginVersion }}<template v-if="selectedBinding.marketplace"> · {{ selectedBinding.marketplace }}</template></b></div>
          <div v-if="selectedBinding.cacheState" class="wide"><small>缓存状态</small><b>{{ selectedBinding.cacheState==='present'?'缓存存在':selectedBinding.cacheState==='missing'?'缓存缺失':'缓存状态未知' }}</b></div>
          <div v-if="selectedBinding.configurationEnabled!==undefined" class="wide"><small>{{ selectedBinding.configurationControl?.visibility?'可见性配置记录':selectedBinding.configurationControl?.mode==='parent'?'父插件配置状态':'关联配置状态' }}</small><b>{{ selectedBinding.configurationControl?.visibility ?? stateLabel(selectedBinding.configurationEnabled) }}</b></div>
          <div v-if="selectedBinding.configurationSourcePath" class="wide"><small>配置证据文件</small><code>{{ selectedBinding.configurationSourcePath }}</code></div>
          <div v-if="selectedBinding.configurationKey" class="wide"><small>配置关联键</small><code>{{ selectedBinding.configurationKey }}</code></div>
          <div v-if="selectedBinding.projectId" class="wide"><small>项目来源</small><b>{{ store.projects.find(p=>p.id===selectedBinding?.projectId)?.name??selectedBinding.projectId }} · {{ sourceLabel(selectedBinding.sourceKind) }}</b></div>
          <div v-if="selectedBinding.parentId" class="wide"><small>所属插件</small><b>{{ store.bindings.find(b=>b.id===selectedBinding?.parentId)?.name??selectedBinding.parentId }}</b></div>
          <div class="wide"><small>控制能力</small><b>{{ canPlan(selectedBinding)?'Codex 单项配置计划可用':`只读 · ${readOnlyReason(selectedBinding)}` }}</b></div>
          <div class="wide evidence-detail"><small>匹配此资源的能力证据</small><div v-if="selectedCapabilityEvidence.length" class="capability-matrix"><article v-for="(evidence,index) in selectedCapabilityEvidence" :key="`${selectedBinding.id}-${index}`"><div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ capabilityStatusLabel(evidence) }}<template v-if="evidence.mcpTransport"> · {{ evidence.mcpTransport==='stdio'?'STDIO':evidence.mcpTransport==='http'?'HTTP':'传输未知' }}</template></b><small>{{ evidence.readable?'可读取':'不可读' }} · {{ evidence.writable?'受限可写':'只读' }}</small></div><p>{{ evidence.reason }}</p><small v-if="evidence.clientVersion">版本 {{ evidence.clientVersion }} · {{ evidence.platform }}</small><code v-if="evidence.evidenceReference">证据：{{ evidence.evidenceReference }}</code></article></div><p v-else class="no-evidence">没有按资源类型、作用范围与来源匹配的兼容证据。</p></div>
          <div class="wide"><small>最近更新</small><b>{{ timeLabel(selectedBinding.updatedAt) }}</b></div>
        </div>
        <div v-if="selectedBinding.diagnostics.length" class="detail-diagnostics"><b>诊断信息</b><p v-for="message in selectedBinding.diagnostics" :key="message"><el-icon><InfoFilled/></el-icon>{{ message }}</p></div>
        <div v-else class="detail-diagnostics quiet"><el-icon><InfoFilled/></el-icon>此资源没有适配器诊断信息。</div>
      </template>
    </el-drawer>
  </div>
</template>
