<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { Binding, CapabilityEvidence, ChangePlan, ClientCompatibilityReport, Operation, ResourceKind } from '@agentdeck/contracts';
import { ArrowRight, Box, Clock, Connection, Document, Files, Folder, FolderAdd, House, InfoFilled, List, Plus, Refresh, Search, Setting, SwitchButton } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from './api';
import { useAppStore } from './store';

type Page = 'overview' | 'resources' | 'instances' | 'projects' | 'operations';
type SkillBinding = Binding & { applicableAgentIds?: string[]; compatibilitySummary?: string; scopeLabel?: string; sourceLabel?: string };
const store = useAppStore();
const page = ref<Page>('resources');
const kindFilter = ref<'all' | ResourceKind>('all');
const searchText = ref('');
const scopeFilter = ref<string[]>([]);
const compatibilityFilter = ref<string[]>([]);
const applicableAgentFilter = ref<string[]>([]);
const sourceFilter = ref<string[]>([]);
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
const versionCheckBusy = ref('');
const appliedOperation = ref<Operation | null>(null);
const restoreOf = ref<string | null>(null);
const instanceForm = reactive({ agentId: '', name: '', configRoot: '', writable: false });
const projectForm = reactive({ name: '', rootPath: '' });
let eventSource: EventSource | undefined;

const pages = [
  { id: 'overview' as const, label: '总览', icon: House },
  { id: 'resources' as const, label: '资源管理', icon: Box },
  { id: 'instances' as const, label: 'Agent 实例', icon: Connection },
  { id: 'projects' as const, label: '项目空间', icon: Folder },
  { id: 'operations' as const, label: '操作记录', icon: Clock },
];
const agentName = (id: string) => store.adapters.find((adapter) => adapter.id === id)?.name ?? id;
const selectedInstance = computed(() => store.instances.find((item) => item.id === store.selectedInstanceId));
const scoped = computed(() => store.bindings.filter((item) =>
  (!store.selectedInstanceId || item.instanceId === store.selectedInstanceId)
  && (!store.selectedProjectId || item.projectId === null || item.projectId === store.selectedProjectId)));
const skillAgentsKnown = computed(() => {
  const skills = scoped.value.filter((binding) => binding.kind === 'skill');
  return skills.length > 0 && skills.every((binding) => Array.isArray((binding as SkillBinding).applicableAgentIds));
});
const stats = computed(() => ({
  all: scoped.value.length,
  skills: scoped.value.filter((b) => b.kind === 'skill').length,
  plugins: scoped.value.filter((b) => b.kind === 'plugin').length,
  mcps: scoped.value.filter((b) => b.kind === 'mcp').length,
  diagnostics: scoped.value.reduce((n, b) => n + b.diagnostics.length, 0) + store.instances.reduce((n, i) => n + i.diagnostics.length, 0),
}));
function matches(binding: Binding, includePluginChildren = false): boolean {
  const text = searchText.value.trim().toLocaleLowerCase();
  if (text && !`${binding.name} ${binding.description} ${binding.nativeKey} ${binding.sourcePath} ${binding.pluginId ?? ''} ${binding.pluginVersion ?? ''} ${binding.marketplace ?? ''}`.toLocaleLowerCase().includes(text)) return false;
  if (originFilter.value && originFilter.value !== 'all' && binding.origin !== originFilter.value) return false;
  if (sourceFilter.value.length && !sourceFilter.value.includes(binding.sourceKind)) return false;
  if (!includePluginChildren && kindFilter.value !== 'all' && binding.kind !== kindFilter.value) return false;
  if (binding.kind === 'skill' && (kindFilter.value === 'all' || kindFilter.value === 'skill')) {
    const row = binding as SkillBinding;
    if (scopeFilter.value.length && !scopeFilter.value.includes(binding.scope)) return false;
    if (compatibilityFilter.value.length && !compatibilityFilter.value.includes(binding.compatibilityClass)) return false;
    if (applicableAgentFilter.value.length && !applicableAgentFilter.value.some((id) => (row.applicableAgentIds ?? []).includes(id))) return false;
  }
  return true;
}
const visible = computed(() => {
  const result: Array<{ binding: Binding; depth: number; children: number }> = [];
  for (const binding of scoped.value.filter((b) => b.parentId === null)) {
    const childBindings = scoped.value.filter((child) => child.parentId === binding.id);
    const matchingChildren = childBindings.filter((child) => matches(child, kindFilter.value === 'plugin'));
    if (!matches(binding) && !(binding.kind === 'plugin' && matchingChildren.length > 0)) continue;
    const children = childBindings.length;
    result.push({ binding, depth: 0, children });
    if (binding.kind === 'plugin' && expanded.value.has(binding.id)) {
      for (const child of matchingChildren) result.push({ binding: child, depth: 1, children: 0 });
    }
  }
  return result;
});
const planBinding = computed(() => store.bindings.find((b) => b.id === activePlan.value?.bindingId));
const planInstance = computed(() => store.instances.find((i) => i.id === activePlan.value?.instanceId));
const affected = computed(() => planBinding.value ? store.bindings.filter((b) => b.instanceId === planBinding.value?.instanceId && b.id !== planBinding.value.id
  && (planBinding.value.kind === 'plugin' ? b.pluginId === planBinding.value.pluginId : b.sourcePath === planBinding.value.sourcePath)) : []);
const selectedCapabilityEvidence = computed(() => selectedBinding.value ? capabilityEvidenceForBinding(selectedBinding.value) : []);
function canPlan(binding: Binding): boolean {
  const instance = store.instances.find((item) => item.id === binding.instanceId);
  return (binding.kind === 'mcp' || binding.controlScope === 'user-config-skill' || binding.controlScope === 'local-marketplace-plugin') && binding.parentId === null && instance?.agentId === 'codex'
    && instance.writable && binding.writable && (instance.discovery === 'manual' || instance.discovery === 'demo');
}
function readOnlyReason(binding: Binding): string {
  if (binding.readOnlyReason) return binding.readOnlyReason;
  const instance = store.instances.find((item) => item.id === binding.instanceId);
  if (binding.parentId !== null) return '插件子资源由父插件控制，当前不提供独立开关。';
  if (binding.kind !== 'mcp') return '此来源尚无已验收的单项控制方式。';
  if (binding.mcpTransport !== 'stdio') return '该条目的传输类型未被本机原生往返案例覆盖；可用性仍受实例登记和资源级策略限制。';
  if (instance?.discovery === 'auto') return '自动发现的实例固定为只读。';
  if (instance?.agentId !== 'codex') return '当前首轮写入能力仅支持 Codex 独立 MCP。';
  if (!instance?.writable) return '登记实例时未允许实验性配置修改。';
  return '适配器未确认此项配置可安全修改。';
}
function scopeLabel(value: string) { return ({ 'user-global': '用户全局', project: '项目级', 'project-directory': '项目子目录级', native: '原生特殊范围', session: '会话临时级（预留）' })[value] ?? '范围未判断'; }
function sourceLabel(value: string) { return ({ user: '用户自建 / 导入', repository: '项目仓库提供', plugin: '插件附带', builtin: 'Agent 内置', organization: '组织管理', 'account-sync': '账号同步', unknown: '来源未知' })[value] ?? '来源未知'; }
function originLabel(binding: Binding) {
  if (binding.cacheState === 'missing') return '配置登记 · 缓存缺失';
  if (binding.origin === 'cache') return `插件缓存存在${binding.pluginVersion ? ` · v${binding.pluginVersion}` : ''}${binding.marketplace ? ` · ${binding.marketplace}` : ''}`;
  if (binding.origin === 'configuration') return `${binding.projectId ? '项目配置' : '用户配置'}${binding.cacheState === 'unknown' ? ' · 缓存未知' : ''}`;
  if (binding.origin === 'filesystem') return binding.projectId ? '项目文件' : '本地文件';
  return binding.projectId ? '项目来源' : '';
}
function stateLabel(enabled: boolean | null | undefined) { return enabled === true ? '配置已启用' : enabled === false ? '配置已停用' : '配置状态未知'; }
function clientStatusLabel(report: ClientCompatibilityReport) {
  return ({ 'verified-client': 'CLI 签名已识别', 'executable-unverified': '版本未知 · 有程序候选', 'configuration-only': '仅有配置目录', 'not-found': '未发现客户端', demo: '隔离演示' })[report.status];
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
function compatibilityLabel(binding: Binding) {
  const row = binding as SkillBinding;
  return row.compatibilitySummary ?? ({ portable: '跨 Agent 通用声明', 'agent-specific': 'Agent 专用', conditional: '部分兼容', unknown: '尚未判断' })[binding.compatibilityClass] ?? '尚未判断';
}
function applicableLabel(binding: Binding) {
  const ids = (binding as SkillBinding).applicableAgentIds;
  return !Array.isArray(ids) ? 'API 尚未提供逐客户端适用证据' : ids.length ? ids.map(agentName).join('、') : '未声明适用客户端';
}
function timeLabel(value: string | null | undefined) {
  if (!value) return '尚未扫描';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function runtimeLabel(value: Binding['runtime']) { return ({ unknown: '运行状态未知', pending: '等待生效', active: '运行中', inactive: '未运行' })[value] ?? '运行状态未知'; }
function togglePlugin(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next; }
function openInstanceForm() { instanceForm.agentId = store.adapters[0]?.id ?? ''; instanceForm.name = ''; instanceForm.configRoot = ''; instanceForm.writable = false; drawer.value = 'instance'; }
function openProjectForm() { projectForm.name = ''; projectForm.rootPath = ''; drawer.value = 'project'; }
function openBinding(binding: Binding) { selectedBinding.value = binding; drawer.value = 'binding'; }
function drawerVisibility(value: boolean) { if (!value) drawer.value = null; }
async function refresh() { try { await store.refresh(); } catch { /* the store keeps the connection error visible */ } }
async function saveInstance() {
  if (!instanceForm.agentId || !instanceForm.configRoot.trim()) return;
  actionBusy.value = true;
  try {
    const registered = await api.registerInstance({ agentId: instanceForm.agentId, name: instanceForm.name.trim() || undefined, configRoot: instanceForm.configRoot.trim(), writable: instanceForm.agentId === 'codex' && instanceForm.writable });
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
    store.setCatalog(await api.scan({ discover, discoverUserHome, ...(store.selectedInstanceId ? { instanceId: store.selectedInstanceId } : {}), ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}) }));
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
function goTo(next: Page) { page.value = next; if (next === 'operations') void loadOperations(); }
function clearFilters() { kindFilter.value = 'all'; scopeFilter.value = []; compatibilityFilter.value = []; applicableAgentFilter.value = []; sourceFilter.value = []; originFilter.value = 'all'; searchText.value = ''; }
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
onMounted(() => { void connectAndOpen(); });
onBeforeUnmount(() => eventSource?.close());
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><div><strong>AgentDeck</strong><small>本地扩展管理器</small></div></div>
      <div class="section-label">工作区</div>
      <nav aria-label="主导航"><button v-for="item in pages" :key="item.id" class="nav-item" :class="{active: page === item.id}" @click="goTo(item.id)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span><small v-if="item.id === 'operations' && operations.length">{{ operations.length }}</small></button></nav>
      <div class="divider"></div><div class="section-label clients-label"><span>客户端能力</span><i></i></div>
      <div v-if="store.adapters.length" class="clients"><div v-for="adapter in store.adapters" :key="adapter.id" class="client"><span>{{ adapter.name.slice(0,1) }}</span><b>{{ adapter.name }}</b><small>{{ store.instances.filter((i) => i.agentId === adapter.id).length }}</small></div></div><p v-else class="sidebar-note">连接服务后读取适配器注册表</p>
      <div class="sidebar-bottom"><span class="local-indicator"><i :class="store.sessionReady ? 'online' : ''"></i>{{ store.sessionReady ? '本机服务已连接' : '等待本机服务' }}</span><small>AgentDeck · 首轮预览</small></div>
    </aside>

    <main class="main">
      <header class="topbar"><div class="crumb"><span>AgentDeck</span><i>/</i><b>{{ pages.find((item) => item.id === page)?.label }}</b></div><div class="top-controls">
        <label><span>客户端</span><el-select v-model="store.selectedInstanceId" clearable placeholder="全部实例" :disabled="!store.sessionReady"><el-option v-for="i in store.instances" :key="i.id" :value="i.id" :label="`${agentName(i.agentId)} · ${i.name}`" /></el-select></label>
        <label><span>项目</span><el-select v-model="store.selectedProjectId" clearable placeholder="全部项目" :disabled="!store.sessionReady"><el-option v-for="p in store.projects" :key="p.id" :value="p.id" :label="p.name" /></el-select></label>
        <el-button class="refresh" circle :loading="store.busy" :disabled="!store.sessionReady" aria-label="刷新" @click="refresh"><el-icon><Refresh /></el-icon></el-button>
      </div></header>

      <section v-if="!store.sessionReady" class="connect-page">
        <div class="connect-art"><span class="ring ring-a"></span><span class="ring ring-b"></span><span class="connect-core"><el-icon><Connection /></el-icon></span><i class="spark a"></i><i class="spark b"></i></div>
        <small class="connect-kicker"><i></i> LOCAL SESSION REQUIRED</small><h1>连接你的本机工作区</h1>
        <p>AgentDeck 只访问本机服务。请从后台输出的本机链接打开网页；启动票据会在兑换后自动从地址栏移除。</p>
        <div v-if="store.sessionError" class="connect-error"><el-icon><InfoFilled /></el-icon>{{ store.sessionError }}</div>
        <el-button type="primary" :loading="store.busy" @click="connectAndOpen"><el-icon><Refresh /></el-icon>重新连接</el-button>
        <small class="connect-foot"><el-icon><InfoFilled /></el-icon>开发环境前端地址为 127.0.0.1:5173，后台 API 由本机 4780 端口代理提供。</small>
      </section>

      <section v-else class="content">
        <div class="page-heading"><div><small class="eyebrow"><i></i> LOCAL ENVIRONMENT</small><h1>{{ pages.find((item) => item.id === page)?.label }}</h1><p>{{ page === 'resources' ? '查看本机配置发现的 Skill、插件和 MCP，状态来自当前注册适配器。' : page === 'instances' ? '登记配置根目录并查看适配器注册表提供的能力范围。' : page === 'projects' ? '手动登记项目根目录，为扫描提供明确边界。' : page === 'operations' ? '查看配置变更结果，并从成功操作创建恢复计划。' : '本机 Agent 配置资源与扫描状态。' }}</p></div>
          <div class="heading-actions"><template v-if="page === 'instances'"><el-button @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现客户端</el-button><el-button type="primary" @click="openInstanceForm"><el-icon><Plus /></el-icon>登记实例</el-button></template><el-button v-if="page === 'projects'" type="primary" @click="openProjectForm"><el-icon><FolderAdd /></el-icon>登记项目</el-button><template v-if="page === 'resources' || page === 'overview'"><el-button @click="scan(false)" :loading="actionBusy"><el-icon><Refresh /></el-icon>重新扫描已登记实例</el-button><el-button type="primary" @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现并扫描本机资源</el-button></template></div>
        </div>
        <div v-if="store.refreshError" class="inline-error"><el-icon><InfoFilled /></el-icon><span>{{ store.refreshError }}</span><el-button text @click="refresh">重试</el-button></div>

        <template v-if="page === 'overview' || page === 'resources'">
          <div class="stats"><article><div><span>已登记实例</span><i><Connection /></i></div><strong>{{ store.instances.length.toString().padStart(2,'0') }}</strong><small>来自本机适配器目录</small></article><article><div><span>可见扩展</span><i class="blue"><Box /></i></div><strong>{{ stats.all.toString().padStart(2,'0') }}</strong><small>当前筛选范围内</small></article><article><div><span>Skill</span><i class="violet"><Document /></i></div><strong>{{ stats.skills.toString().padStart(2,'0') }}</strong><small>按三类元数据查看</small></article><article><div><span>插件 / MCP</span><i class="amber"><Files /></i></div><strong>{{ (stats.plugins + stats.mcps).toString().padStart(2,'0') }}</strong><small>插件 {{ stats.plugins }} · MCP {{ stats.mcps }}</small></article><article><div><span>扫描提示</span><i class="rose"><InfoFilled /></i></div><strong>{{ stats.diagnostics.toString().padStart(2,'0') }}</strong><small>适配器返回的诊断</small></article></div>
          <section class="panel"><div class="panel-heading"><div><h2>{{ page === 'overview' ? '资源概况' : '本机资源' }}</h2><small>{{ store.catalog?.lastScanAt ? `上次扫描 ${timeLabel(store.catalog.lastScanAt)}` : '尚无扫描记录' }}</small></div><div class="panel-tools"><el-input v-model="searchText" clearable placeholder="搜索名称或来源路径"><template #prefix><el-icon><Search /></el-icon></template></el-input><el-button class="refresh" aria-label="刷新资源" :loading="store.busy" @click="refresh"><el-icon><Refresh /></el-icon></el-button></div></div>
            <div class="filter-row"><div class="tabs"><button v-for="tab in [{id:'all',label:'全部'},{id:'skill',label:'Skill'},{id:'plugin',label:'插件'},{id:'mcp',label:'MCP'}]" :key="tab.id" :class="{selected:kindFilter===tab.id}" @click="kindFilter=tab.id as 'all'|'skill'|'plugin'|'mcp'">{{ tab.label }}<small v-if="tab.id==='all'">{{ scoped.length }}</small></button></div><div class="skill-filters" :class="{ muted: kindFilter==='plugin'||kindFilter==='mcp' }">
              <el-select v-model="scopeFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="作用范围" :disabled="kindFilter==='plugin'||kindFilter==='mcp'"><el-option label="用户全局" value="user-global"/><el-option label="项目级" value="project"/><el-option label="项目子目录级" value="project-directory"/><el-option label="原生特殊范围" value="native"/></el-select>
              <el-select v-model="compatibilityFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="客户端适用性" :disabled="kindFilter==='plugin'||kindFilter==='mcp'"><el-option label="跨 Agent 通用声明" value="portable"/><el-option label="Agent 专用" value="agent-specific"/><el-option label="部分兼容" value="conditional"/><el-option label="尚未判断" value="unknown"/></el-select>
              <el-select v-model="applicableAgentFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="适用 Agent" :disabled="kindFilter==='plugin'||kindFilter==='mcp'||!skillAgentsKnown"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/></el-select>
              <el-select v-model="sourceFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源来源"><el-option label="用户自建 / 导入" value="user"/><el-option label="项目仓库提供" value="repository"/><el-option label="插件附带" value="plugin"/><el-option label="Agent 内置" value="builtin"/><el-option label="组织管理" value="organization"/><el-option label="账号同步" value="account-sync"/><el-option label="来源未知" value="unknown"/></el-select>
              <el-select v-model="originFilter" clearable placeholder="配置或文件来源"><el-option label="全部来源类型" value="all"/><el-option label="插件缓存" value="cache"/><el-option label="配置记录" value="configuration"/><el-option label="本地文件" value="filesystem"/></el-select>
            </div></div>
            <div v-if="!skillAgentsKnown && kindFilter!=='plugin' && kindFilter!=='mcp'" class="taxonomy-note"><el-icon><InfoFilled /></el-icon>尚无各 Agent 的兼容性检测结果，暂不能按适用 Agent 筛选。</div>
            <div v-if="visible.length" class="table-scroll"><table><thead><tr><th>扩展资源</th><th>作用范围</th><th>客户端适用性</th><th>来源</th><th>配置状态</th><th>运行状态</th><th>控制能力</th><th></th></tr></thead><tbody>
              <tr v-for="item in visible" :key="item.binding.id" :class="{child:item.depth>0,parent:item.binding.kind==='plugin'}"><td><div class="resource-cell" :style="{paddingLeft:`${item.depth*24}px`}"><button v-if="item.binding.kind==='plugin'&&item.children" class="tree-toggle" :class="{expanded:expanded.has(item.binding.id)}" :aria-expanded="expanded.has(item.binding.id)" :aria-label="expanded.has(item.binding.id)?'收起插件组件':'展开插件组件'" @click="togglePlugin(item.binding.id)">›</button><span v-else-if="item.depth" class="tree-stem"></span><i class="kind-icon" :class="item.binding.kind"><el-icon><component :is="item.binding.kind==='skill'?Document:item.binding.kind==='plugin'?Box:Connection"/></el-icon></i><div class="resource-copy"><button class="resource-detail-link" @click="openBinding(item.binding)">{{ item.binding.name }}</button><small>{{ item.depth ? `由 ${store.bindings.find(b=>b.id===item.binding.parentId)?.name??'插件'} 提供` : item.binding.description || item.binding.nativeKey || item.binding.sourcePath }}</small></div><small v-if="item.binding.kind==='plugin'&&item.children" class="child-count">{{ item.children }} 项</small></div></td>
                <td><span v-if="item.binding.kind==='skill'" class="tag scope">{{ (item.binding as SkillBinding).scopeLabel ?? scopeLabel(item.binding.scope) }}</span><span v-else>{{ scopeLabel(item.binding.scope) }}</span></td>
                <td><span v-if="item.binding.kind==='skill'" class="compat"><i :class="item.binding.compatibilityClass"></i>{{ compatibilityLabel(item.binding) }}<el-tooltip v-if="!Array.isArray((item.binding as SkillBinding).applicableAgentIds)" content="本轮契约没有逐 Agent 适用报告，不能据此判断目标客户端。"><el-icon><InfoFilled /></el-icon></el-tooltip><small v-else>{{ applicableLabel(item.binding) }}</small></span><span v-else class="muted-text">—</span></td>
                <td><span v-if="item.binding.kind==='skill'" class="tag source">{{ (item.binding as SkillBinding).sourceLabel ?? sourceLabel(item.binding.sourceKind) }}</span><span v-else>{{ sourceLabel(item.binding.sourceKind) }}</span><small v-if="originLabel(item.binding)" class="origin-detail">{{ originLabel(item.binding) }}</small></td>
                <td><span class="config-state" :class="item.binding.enabled===true?'on':item.binding.enabled===false?'off':'unknown'"><i></i>{{ item.binding.enabled===true?'已启用':item.binding.enabled===false?'已停用':'未知' }}</span></td>
                <td><span class="runtime-state" :class="item.binding.runtime">{{ runtimeLabel(item.binding.runtime) }}</span></td>
                <td><el-tooltip v-if="canPlan(item.binding)" :content="`实验性计划：${readOnlyReason(item.binding)}`"><button class="plan-link" :disabled="actionBusy" @click="planToggle(item.binding,item.binding.enabled!==true)">{{ item.binding.enabled===true?'计划停用':item.binding.enabled===false?'计划启用':'生成启用计划' }}<el-icon><ArrowRight/></el-icon></button></el-tooltip><el-tooltip v-else :content="readOnlyReason(item.binding)"><span class="readonly"><el-icon><Setting/></el-icon>只读</span></el-tooltip></td>
                <td><el-tooltip v-if="item.binding.diagnostics.length" :content="item.binding.diagnostics.join('；')"><el-icon class="notice"><InfoFilled/></el-icon></el-tooltip></td></tr>
            </tbody></table></div>
            <div v-else-if="!store.bindings.length" class="empty"><i><el-icon><Box/></el-icon></i><b>还没有可显示的资源</b><span>{{ store.instances.length ? '已登记实例尚未发现资源，可重新扫描或发现本机客户端。' : '尚未接入本机配置。开发模式默认使用隔离目录；点击下方按钮只读扫描当前用户的客户端配置。' }}</span><div><el-button type="primary" :loading="actionBusy" @click="scan(true, true)"><el-icon><Search/></el-icon>扫描本机配置（只读）</el-button><el-button v-if="!store.instances.length&&!store.projects.length" :loading="actionBusy" @click="demo">载入隔离演示数据</el-button></div></div>
            <div v-else class="empty-filter"><el-icon><Search/></el-icon>当前筛选没有匹配项<el-button text @click="clearFilters">清除筛选</el-button></div>
            <footer class="panel-footer"><span>显示 {{ visible.length }} 项 <template v-if="store.catalog?.lastScanAt">· 最近扫描 {{ timeLabel(store.catalog.lastScanAt) }}</template></span><span><i :class="eventStatus"></i>{{ eventStatus==='connected'?'实时事件已连接':eventStatus==='connecting'?'连接实时事件…':'事件通道离线' }}</span></footer>
          </section>
        </template>

        <section v-else-if="page==='instances'" class="panel records-panel"><div class="panel-heading"><div><h2>客户端兼容报告</h2><small>PATH 候选、配置目录、CLI 签名和逐资源能力证据分别展示；扫描本身不会启动客户端。</small></div><el-button type="primary" @click="openInstanceForm"><el-icon><Plus/></el-icon>登记实例</el-button></div>
          <div v-if="store.compatibility?.clients.length" class="instance-grid"><article v-for="report in store.compatibility.clients" :key="report.id" class="instance-card"><div class="instance-top"><i>{{ report.agentName.slice(0,1) }}</i><small :class="report.status">{{ clientStatusLabel(report) }}</small></div><h3>{{ report.instanceName??`${report.agentName} · 未登记实例` }}</h3><span class="instance-client">{{ report.agentName }} · {{ report.instanceId ? (store.instances.find(i=>i.id===report.instanceId)?.discovery==='auto'?'自动发现':store.instances.find(i=>i.id===report.instanceId)?.discovery==='manual'?'手动登记':'隔离演示') : '仅显示未登记客户端状态' }}</span>
            <div class="path-block"><small>配置根目录 · {{ clientConfigStateLabel(report) }}</small><code>{{ report.configRoot??'适配器未提供默认配置路径' }}</code></div>
            <div class="path-block"><small>PATH 程序候选</small><code>{{ report.executableCandidate?.path??'未发现候选' }}</code><small v-if="report.executableCandidate">候选身份检查 {{ timeLabel(report.executableCandidate.checkedAt) }}</small></div>
            <div class="policy"><small>CLI 版本证据</small><b>{{ report.versionEvidence ? `${report.versionEvidence.version} · ${report.versionEvidence.platform}` : report.status==='demo'?'演示数据没有主机版本证据':'版本未知 · 尚无可识别版本签名' }}</b><span>{{ report.versionEvidence?'只识别到 CLI 输出签名，不证明官方发行来源、桌面应用安装或资源正在运行。':report.agentId==='codex'||report.agentId==='claude-code'?'需手动触发 --version 检查；失败时不会保存原始输出。':'此客户端没有已验证的版本检查命令，只显示 PATH 候选。' }}</span></div>
            <div v-if="report.instanceId" class="policy"><small>本机控制策略</small><b>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'用户登记为实验性可写目标':'只读' }}</b><span>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'仍需满足适配器资源级条件；兼容报告不会授予写权限。':'自动发现或未显式允许的实例保持只读。' }}</span></div>
            <div class="report-actions"><el-button v-if="reportCanCheckVersion(report)" size="small" :loading="versionCheckBusy===report.instanceId" @click="checkVersion(report)">{{ versionCheckButtonLabel(report) }}</el-button><el-button v-if="!report.instanceId" size="small" @click="openInstanceForm">登记此客户端</el-button><span v-else>{{ store.bindings.filter(b=>b.instanceId===report.instanceId).length }} 项资源</span></div>
            <details class="matrix-details"><summary>能力矩阵 · {{ report.capabilities.length }} 项</summary><div class="capability-matrix"><article v-for="(evidence,index) in report.capabilities" :key="`${report.id}-${index}`"><div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ evidence.resourceKind?({skill:'Skill',plugin:'插件',mcp:'MCP'})[evidence.resourceKind]:'通用' }}</b><small>{{ capabilityStatusLabel(evidence) }}</small></div><span>{{ capabilityScopeLabel(evidence) }}<template v-if="evidence.mcpTransport==='stdio'"> · STDIO</template><template v-else-if="evidence.mcpTransport==='http'"> · HTTP</template></span><p>{{ evidence.readable?'可读取':'不可读' }} · {{ evidence.writable?'受限可写':'只读' }} · {{ evidence.reason }}</p><small v-if="evidence.clientVersion">适用版本 {{ evidence.clientVersion }} · {{ evidence.platform }}</small><code v-if="evidence.evidenceReference">证据：{{ evidence.evidenceReference }}</code></article></div></details>
            <p v-if="report.diagnostics.length" class="diagnostics"><el-icon><InfoFilled/></el-icon>{{ report.diagnostics.join('；') }}</p>
          </article></div>
          <div v-else class="empty"><i><el-icon><Connection/></el-icon></i><b>兼容报告尚未加载</b><span>刷新本机服务后查看所有已登记实例和未发现客户端。</span><div><el-button type="primary" @click="refresh" :loading="store.busy">刷新报告</el-button></div></div>
          <div class="capabilities"><div class="cap-title"><el-icon><InfoFilled/></el-icon>证据边界<small>运行状态不会由静态配置推断</small></div><div class="cap-row"><div><b>客户端身份</b><small>CLI 版本需要精确签名；PATH 候选不等同官方安装。</small></div><span>CLI 可识别 · 发行来源未知 · 运行时未观察</span></div><div class="cap-row"><div><b>原生 Codex 配置</b><small>0.159.2 / Windows：独立 STDIO MCP、配置根独立 Skill、本地市场插件有隔离复读证据。</small></div><span>该证据不会改变手动写入授权。</span></div><div class="cap-row"><div><b>运行时资源状态</b><small>本机服务不启动客户端、MCP 或插件。</small></div><span>未验证</span></div></div>
        </section>

        <section v-else-if="page==='projects'" class="panel records-panel"><div class="panel-heading"><div><h2>已登记项目</h2><small>仅扫描明确登记的项目根目录</small></div><el-button type="primary" @click="openProjectForm"><el-icon><FolderAdd/></el-icon>登记项目</el-button></div><div v-if="store.projects.length" class="project-list"><article v-for="p in store.projects" :key="p.id"><i><el-icon><Folder/></el-icon></i><div><b>{{ p.name }}</b><code>{{ p.rootPath }}</code></div><span>{{ store.bindings.filter(b=>b.projectId===p.id).length }} 项项目资源</span><el-button :disabled="!store.sessionReady" :loading="actionBusy" @click="scanProject(p.id)">扫描项目</el-button></article></div><div v-else class="empty"><i><el-icon><Folder/></el-icon></i><b>还没有登记项目</b><span>项目范围资源扫描需要明确的项目根目录。</span><div><el-button type="primary" @click="openProjectForm">登记项目</el-button></div></div></section>

        <section v-else class="panel records-panel"><div class="panel-heading"><div><h2>变更历史</h2><small>成功操作可生成恢复计划；应用前服务端会再次检查摘要。</small></div><el-button @click="loadOperations"><el-icon><Refresh/></el-icon>刷新记录</el-button></div><div v-if="operationsError" class="inline-error"><el-icon><InfoFilled/></el-icon>{{ operationsError }}<el-button text @click="loadOperations">重试</el-button></div><div v-if="operations.length" class="table-scroll"><table class="operation-table"><thead><tr><th>操作</th><th>目标路径</th><th>结果</th><th>创建时间</th><th>恢复</th></tr></thead><tbody><tr v-for="op in operations" :key="op.id"><td><b>{{ op.kind==='restore'?'恢复配置':'启停配置' }}</b><small class="op-id">{{ op.id.slice(0,10) }}</small></td><td><code>{{ op.targetPath }}</code></td><td><span :class="['op-status',op.status]">{{ op.status==='succeeded'?'已完成':op.status==='conflict'?'检测到冲突':'失败' }}</span><small v-if="op.error" class="op-error">{{ op.error }}</small></td><td>{{ timeLabel(op.createdAt) }}</td><td><el-button v-if="op.status==='succeeded'&&op.backupId" size="small" :loading="restoreBusy===op.id" @click="planRestore(op)">创建恢复计划</el-button><span v-else class="muted-text">{{ op.status==='succeeded'?'未改动，无需恢复':'需成功操作后才能恢复' }}</span></td></tr></tbody></table></div><div v-else-if="!operationsError" class="empty"><i><el-icon><List/></el-icon></i><b>暂无配置操作</b><span>基础版支持独立 MCP，以及已验收的配置根 Skill 和本地市场插件开关。</span><div><el-button @click="goTo('resources')">查看资源</el-button></div></div></section>
      </section>
    </main>

    <el-drawer :model-value="drawer!==null" @update:model-value="drawerVisibility" :title="drawer==='instance'?'登记 Agent 实例':drawer==='project'?'登记项目空间':drawer==='binding'?'资源详情':'检查变更计划'" :size="drawer==='plan'?'min(660px,96vw)':'min(500px,96vw)'" destroy-on-close>
        <template v-if="drawer==='instance'"><div class="drawer-intro"><i><el-icon><Connection/></el-icon></i><div><b>添加本机配置来源</b><small>只读取你提交的目录，不猜测或改写其他路径。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveInstance"><el-form-item label="客户端" required><el-select v-model="instanceForm.agentId" placeholder="从适配器注册表选择" class="full"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/></el-select></el-form-item><el-form-item label="显示名称"><el-input v-model="instanceForm.name" placeholder="可选，例如：工作用配置"/></el-form-item><el-form-item label="配置根目录" required><el-input v-model="instanceForm.configRoot" placeholder="例如：C:\Users\you\.config\agent"/></el-form-item><div v-if="instanceForm.agentId==='codex'" class="write-opt"><el-checkbox v-model="instanceForm.writable">允许 Codex 配置修改（仅支持的单项资源）</el-checkbox><p>手动登记并通过资源级校验后才开放计划。Skill 和本地市场插件仅支持已检查的 Codex 0.159.2 / Windows；独立 MCP 保留实验性 HTTP/未知传输。只改用户配置，运行状态未知。</p></div><div v-else class="readonly-note"><el-icon><InfoFilled/></el-icon>当前客户端首轮为只读接入；登记不会开放写入操作。</div><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!instanceForm.agentId||!instanceForm.configRoot.trim()" @click="saveInstance">登记实例</el-button></div></el-form></template>
      <template v-else-if="drawer==='project'"><div class="drawer-intro"><i><el-icon><Folder/></el-icon></i><div><b>设置扫描边界</b><small>只扫描登记的项目路径，不进行全盘搜索。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveProject"><el-form-item label="项目名称"><el-input v-model="projectForm.name" placeholder="留空时由服务端生成显示名称"/></el-form-item><el-form-item label="项目根目录" required><el-input v-model="projectForm.rootPath" placeholder="例如：D:\work\my-project"/></el-form-item><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!projectForm.rootPath.trim()" @click="saveProject">登记项目</el-button></div></el-form></template>
      <template v-else-if="drawer==='plan'&&activePlan"><div class="plan-warning"><i><el-icon><Setting/></el-icon></i><div><b>{{ restoreOf?'配置恢复计划':'Codex 资源配置计划' }}</b><small>配置修改 · 支持范围见资源证据；应用后重启 Codex，当前会话状态未知</small></div><span>{{ appliedOperation?'已提交':activePlan.status==='ready'?'待核对':activePlan.status==='applied'?'已应用':'已过期' }}</span></div><section class="plan-section"><small>修改目标</small><div class="target"><i class="kind-icon mcp"><el-icon><Connection/></el-icon></i><div><b>{{ planBinding?.name??'资源' }}</b><small>{{ planInstance?`${agentName(planInstance.agentId)} · ${planInstance.name}`:activePlan.instanceId }}</small></div></div><div class="plan-path"><small>配置文件</small><code>{{ activePlan.targetPath }}</code></div><div class="plan-path"><small>计划动作</small><b>{{ activePlan.action==='restore'?'恢复到操作前配置':activePlan.desiredEnabled?'启用资源配置':'停用资源配置' }}</b></div></section><section class="impact"><div><small>影响范围</small><b>{{ affected.length+1 }} 条关联绑定</b></div><p>本次只修改目标实例的用户配置。插件开关影响该身份全部版本和子组件；Skill 只改按路径覆盖，原文保持不变。关联条目会重新扫描，运行状态仍未知。</p><div class="impact-row current"><i></i><b>{{ planBinding?.name??'当前绑定' }}</b><span>{{ planInstance?agentName(planInstance.agentId):'目标实例' }} · 本次计划</span></div><div v-for="b in affected" :key="b.id" class="impact-row"><i></i><b>{{ b.name }}</b><span>{{ store.instances.find(i=>i.id===b.instanceId)?.name??b.instanceId }} · 同源关联</span></div></section><section class="diff"><div><small>脱敏差异</small><span><el-icon><InfoFilled/></el-icon>不显示原始凭据</span></div><pre>{{ activePlan.diff||'适配器未返回差异文本。' }}</pre><div class="hashes"><span><small>写前摘要</small><code>{{ activePlan.beforeHash }}</code></span><span><small>应用确认摘要（afterHash）</small><code>{{ activePlan.afterHash }}</code></span></div></section><div class="plan-notes"><p><el-icon><InfoFilled/></el-icon>应用时提交 afterHash。若配置已变化、计划过期或目标身份无法确认，服务端应拒绝写入。</p><p><el-icon><Clock/></el-icon>计划有效期至 {{ timeLabel(activePlan.expiresAt) }}</p><p v-if="appliedOperation"><el-icon><InfoFilled/></el-icon>操作结果：{{ appliedOperation.status }}<template v-if="appliedOperation.error"> · {{ appliedOperation.error }}</template></p></div><div class="drawer-footer plan-actions"><el-button @click="drawer=null">{{ appliedOperation?'关闭':'稍后处理' }}</el-button><el-button v-if="activePlan.status==='ready'&&!appliedOperation" type="primary" :loading="actionBusy" @click="applyPlan">确认应用计划</el-button></div></template>
      <template v-else-if="drawer==='binding'&&selectedBinding">
        <div class="detail-header">
          <i class="kind-icon" :class="selectedBinding.kind"><el-icon><component :is="selectedBinding.kind==='skill'?Document:selectedBinding.kind==='plugin'?Box:Connection"/></el-icon></i>
          <div><b>{{ selectedBinding.name }}</b><small>{{ selectedBinding.description||selectedBinding.kind.toUpperCase() }}</small></div>
        </div>
        <div class="detail-grid">
          <div><small>所属客户端</small><b>{{ agentName(store.instances.find(i=>i.id===selectedBinding?.instanceId)?.agentId??'') }}</b></div>
          <div><small>配置状态</small><b>{{ stateLabel(selectedBinding.enabled) }}</b></div>
          <div><small>索引来源</small><b>{{ originLabel(selectedBinding) || '来源类型未知' }}</b></div>
          <div><small>运行状态</small><b>{{ runtimeLabel(selectedBinding.runtime) }}</b></div>
          <div><small>来源</small><b>{{ sourceLabel(selectedBinding.sourceKind) }}</b></div>
          <div><small>作用范围</small><b>{{ scopeLabel(selectedBinding.scope) }}</b></div>
          <div v-if="selectedBinding.kind==='mcp'"><small>MCP 传输</small><b>{{ selectedBinding.mcpTransport==='stdio'?'STDIO':selectedBinding.mcpTransport==='http'?'HTTP':'未知；不适用已验证的原生 STDIO 案例' }}</b></div>
          <div><small>兼容分类</small><b>{{ compatibilityLabel(selectedBinding) }}</b></div>
          <div class="wide"><small>适用 Agent 证据</small><b>{{ selectedBinding.kind==='skill'?applicableLabel(selectedBinding):'该资源类型不属于 Skill 适用性分类' }}</b></div>
          <div class="wide"><small>来源路径</small><code>{{ selectedBinding.sourcePath||'服务未提供路径' }}</code></div>
          <div class="wide"><small>原生配置键</small><code>{{ selectedBinding.nativeKey||'服务未提供键名' }}</code></div>
          <div v-if="selectedBinding.pluginId" class="wide"><small>完整插件身份</small><code>{{ selectedBinding.pluginId }}</code></div>
          <div v-if="selectedBinding.pluginVersion" class="wide"><small>缓存版本</small><b>{{ selectedBinding.pluginVersion }}<template v-if="selectedBinding.marketplace"> · {{ selectedBinding.marketplace }}</template></b></div>
          <div v-if="selectedBinding.cacheState" class="wide"><small>缓存状态</small><b>{{ selectedBinding.cacheState==='present'?'缓存存在':selectedBinding.cacheState==='missing'?'缓存缺失':'缓存状态未知' }}</b></div>
          <div v-if="selectedBinding.configurationEnabled!==undefined" class="wide"><small>关联配置状态</small><b>{{ stateLabel(selectedBinding.configurationEnabled) }}</b></div>
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

<style>
.resource-detail-link{max-width:230px;overflow:hidden;padding:0;border:0;background:transparent;color:#495b51;font-size:9px;font-weight:700;text-align:left;text-overflow:ellipsis;white-space:nowrap}.resource-detail-link:hover{color:#247451;text-decoration:underline;text-underline-offset:2px}
.tree-toggle.expanded{transform:rotate(90deg)}
.detail-header{display:flex;align-items:center;gap:10px;padding:1px 0 16px;border-bottom:1px solid #e9eeeb}.detail-header>div{display:flex;min-width:0;flex-direction:column;gap:5px}.detail-header b{color:#45594c;font-size:11px}.detail-header small{color:#929e97;font-size:8px;overflow-wrap:anywhere}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;margin-top:9px}.detail-grid>div{display:flex;min-width:0;flex-direction:column;gap:6px;padding:12px 2px;border-bottom:1px solid #edf1ee}.detail-grid>div.wide{grid-column:1/-1}.detail-grid small{color:#9aa69f;font-size:7px}.detail-grid b{color:#617168;font-size:8px;font-weight:600;line-height:1.55;overflow-wrap:anywhere}.detail-grid code{color:#65766d;font:7px/1.6 'DM Mono',monospace;overflow-wrap:anywhere}.detail-diagnostics{margin-top:16px;padding:12px;border:1px solid #efe8d8;border-radius:6px;background:#fdfbf6;color:#897651;font-size:8px}.detail-diagnostics>b{font-size:8px}.detail-diagnostics p{display:flex;gap:6px;align-items:flex-start;margin:8px 0 0;line-height:1.6}.detail-diagnostics p .el-icon{margin-top:1px;flex:0 0 auto}.detail-diagnostics.quiet{display:flex;align-items:center;gap:6px;border-color:#e9eeeb;background:#f7f9f7;color:#95a199}
.origin-detail{display:block;margin-top:3px;color:#86968c;font-size:7px;line-height:1.5;overflow-wrap:anywhere}.project-list article>.el-button{margin-left:auto;flex:0 0 auto}
.instance-top>small.verified-client{background:#edf5ef;color:#4c876a}.instance-top>small.executable-unverified{background:#f8f3e8;color:#9a8055}.instance-top>small.configuration-only,.instance-top>small.not-found{background:#f2f4f2;color:#89968e}.instance-top>small.demo{background:#f2eff8;color:#79719a}.report-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding-top:9px;border-top:1px solid #edf1ee;color:#99a49e;font-size:7px}.report-actions .el-button{height:27px;border-color:#e3ebe6;color:#557263;font-size:8px}.matrix-details{margin-top:12px;border-top:1px solid #edf1ee}.matrix-details>summary{padding:10px 1px;color:#5e7668;font-size:8px;font-weight:700;cursor:pointer;list-style:none}.matrix-details>summary::-webkit-details-marker{display:none}.matrix-details>summary:after{content:'＋';float:right;color:#91a098}.matrix-details[open]>summary:after{content:'−'}.capability-matrix{display:flex;flex-direction:column;gap:6px}.capability-matrix article{display:flex;flex-direction:column;gap:5px;padding:9px;border:1px solid #eaf0ec;border-radius:6px;background:#fff}.evidence-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.evidence-head b{color:#5d7065;font-size:7px;line-height:1.5}.evidence-head small{color:#8a9a90;font-size:7px;white-space:nowrap}.capability-matrix article>span,.capability-matrix article>small,.capability-matrix article>code{color:#8e9c94;font-size:7px;line-height:1.5;overflow-wrap:anywhere}.capability-matrix article>p{margin:0;color:#89978f;font-size:7px;line-height:1.6}.detail-grid .evidence-detail{gap:8px}.detail-grid .evidence-detail>.capability-matrix{width:100%}.no-evidence{margin:0;color:#98a39d;font-size:7px;line-height:1.6}
</style>
