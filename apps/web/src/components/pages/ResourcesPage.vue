<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { Binding } from '@agentdeck/contracts';
import { ArrowRight, Box, Close, Connection, Document, InfoFilled, Refresh, Search, Setting } from '@element-plus/icons-vue';
import { configurationState } from '../../configuration-state';
import { diskOnly, inventoryAgent, inventoryCategory, inventoryScope } from '../../classification';
import {
  agentName, categoryLabel, discoveryAgent, originLabel, publicDisabledLabel, resourceName, scopeLabel, sourceLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { useResourceFilters } from '../../composables/useResourceFilters';
import { useResourceRows } from '../../composables/useResourceRows';
import { usePlanFlow } from '../../composables/usePlanFlow';
import { useScanActions } from '../../composables/useScanActions';
import { useEventStream } from '../../composables/useEventStream';
import { api, type SkillDetailsResponse } from '../../api';
import { deriveSkillAvailability, type SkillFileStatus } from '../../skill-availability';
const SkillMarkdown = defineAsyncComponent(() => import('../SkillMarkdown'));
import type { ResourceRow } from '../../resource-tree';
import StatCards from '../StatCards.vue';

type SkillBinding = Binding & { sourceLabel?: string };
const store = useAppStore();
const ui = useUiStore();
const { actionBusy } = storeToRefs(ui);
const {
  kindFilter, searchText, scopeFilter, ownerAgentFilter, categoryFilter, sourceFilter, configurationFilter, originFilter,
  expanded, activeFilterChips, removeFilterChip, clearFilters, togglePlugin,
} = useResourceFilters();
const { tabCounts, visible } = useResourceRows();
const { canPlan, toggleBinding, planToggle, readOnlyReason } = usePlanFlow();
const { refresh, scan, demo } = useScanActions();
const { eventStatus } = useEventStream();
const sourcePath = ref('');
const sourceMode = ref<'quick'|'deep'>('quick');
const followLinks = ref(false);
const sourceBusy = ref(false);
const sourceError = ref('');
const details = ref<SkillDetailsResponse | null>(null);
const detailsBusy = ref(false);
const detailsOpen = ref(false);
const detailsError = ref('');
const showRawMarkdown = ref(false);
const detailEvidence = ref<string[]>([]);
const skillMatches = ref<Array<{ key: string; bindingId?: string; sourceId?: string; findingPath?: string; name: string; snippet: string }>>([]);
const searchBusy = ref(false);
const searchError = ref('');
const searchReport = ref<{ offset: number; nextOffset: number | null; totalCandidates: number; examined: number; failures: number; truncated: boolean } | null>(null);
const availabilityFiles = ref<Record<string, SkillFileStatus>>({});
const independentChecks = ref<Array<{ sourceId: string; findingPath: string; name: string; status: 'present' | 'missing' | 'unreadable'; format: 'valid' | 'invalid' | 'unavailable'; reason: string; bound: false }>>([]);
const availabilityReport = ref<{ totalBindings: number; inspectedBindings: number; totalIndependent: number; inspectedIndependent: number; truncated: boolean } | null>(null);
const availabilityError = ref('');
const availabilityBusy = ref(false);
const selectedInstanceId = ref('');
const selectedProjectId = ref('');
const selectedWorkdir = ref('');
const effectiveInstanceId = computed(() => selectedInstanceId.value || store.instances[0]?.id || '');
const availabilityRows = computed(() => deriveSkillAvailability({ bindings: store.bindings, projects: store.projects,
  instanceId: effectiveInstanceId.value, projectId: selectedProjectId.value, workdir: selectedWorkdir.value, files: availabilityFiles.value }));
const independentFindings = computed(() => (store.catalog?.skillSources ?? []).flatMap(source =>
  (source.report?.findings ?? []).filter(finding => finding.status === 'recognized' || finding.status === 'candidate')
    .map(finding => ({ ...finding, sourcePath: source.path }))));
async function registerSource() {
  if (!sourcePath.value.trim()) return;
  sourceBusy.value = true; sourceError.value = '';
  try { await api.registerSkillSource({ path: sourcePath.value.trim(), mode: sourceMode.value, followLinks: followLinks.value }); sourcePath.value = ''; await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '登记扫描失败。'; }
  finally { sourceBusy.value = false; }
}
async function rescanSource(id: string) {
  sourceBusy.value = true; sourceError.value = '';
  try { await api.scanSkillSource(id); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '重扫失败。'; }
  finally { sourceBusy.value = false; }
}
async function removeSource(id: string) {
  try { await api.removeSkillSource(id); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '移除入口失败。'; }
}
async function scanFindingTarget(targetPath: string, links = false) {
  sourceBusy.value = true; sourceError.value = '';
  try { await api.registerSkillSource({ path: targetPath, mode: 'deep', followLinks: links }); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '无法进一步扫描所选目标。'; }
  finally { sourceBusy.value = false; }
}
async function showSkillDetails(input: { bindingId: string } | { sourceId: string; findingPath: string }) {
  detailsOpen.value = true; detailsBusy.value = true; detailsError.value = ''; details.value = null; showRawMarkdown.value = false;
  if ('bindingId' in input) {
    const binding = store.bindings.find(item => item.id === input.bindingId);
    const current = availabilityFiles.value[input.bindingId];
    detailEvidence.value = binding ? [
      `当前文件检查：${current?.disk ?? '尚未检查'} · 格式：${current?.format ?? '尚未检查'}${current?.checkedAt ? ` · ${timeLabel(current.checkedAt)}` : ''}`,
      `扫描时配置状态：${binding.enabled === null ? '未确认' : binding.enabled ? '启用' : '禁用'} · 扫描记录：${timeLabel(binding.updatedAt)}`,
      `客户端加载证据：未知（AgentDeck 当前不查询运行中会话）`,
      `控制能力：${binding.writable ? '受限写入能力；计划创建与应用时仍会复核' : '只读'} · ${binding.readOnlyReason ?? '无额外限制说明'}`,
    ] : [];
  } else {
    const finding = independentChecks.value.find(item => item.sourceId === input.sourceId && item.findingPath === input.findingPath);
    const scannedFinding = (store.catalog?.skillSources ?? []).find(source => source.id === input.sourceId)?.report?.findings.find(item => item.logicalPath === input.findingPath);
    detailEvidence.value = [
      `扫描发现：${scannedFinding?.status === 'recognized' ? '已识别' : scannedFinding?.status === 'candidate' ? '格式问题候选' : '未能从当前扫描报告确认'}`,
      `当前文件检查：${finding?.status ?? '尚未检查'} · 格式：${finding?.format ?? '尚未检查'}`,
      `资源状态：独立磁盘发现，未绑定到客户端；客户端加载状态未知。`,
      ...(finding ? [finding.reason] : []),
    ];
  }
  try { details.value = await api.skillDetails(input); }
  catch (error) { detailsError.value = error instanceof Error ? error.message : '无法读取 Skill 详情。'; }
  finally { detailsBusy.value = false; }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let searchController: AbortController | null = null;
let availabilityGeneration = 0;
let availabilityController: AbortController | null = null;
async function refreshAvailability() {
  const generation = ++availabilityGeneration;
  availabilityController?.abort(); availabilityController = null;
  if (!effectiveInstanceId.value) { availabilityFiles.value = {}; independentChecks.value = []; availabilityReport.value = null; return; }
  const controller = new AbortController(); availabilityController = controller;
  availabilityError.value = ''; availabilityBusy.value = true;
  try {
    const result = await api.skillAvailability(effectiveInstanceId.value, selectedProjectId.value, selectedWorkdir.value, controller.signal);
    if (generation !== availabilityGeneration) return;
    availabilityFiles.value = result.bindings; independentChecks.value = result.independent;
    availabilityReport.value = result;
  } catch (error) {
    if (controller.signal.aborted || generation !== availabilityGeneration) return;
    availabilityError.value = error instanceof Error ? error.message : '无法检查当前 Skill 状态。';
  } finally { if (generation === availabilityGeneration) availabilityBusy.value = false; }
}
async function runSearch(value: string, offset = 0, append = false) {
  const generation = searchGeneration;
  searchController?.abort();
  const controller = new AbortController(); searchController = controller;
  const priorExamined = append ? searchReport.value?.examined ?? 0 : 0;
  const priorFailures = append ? searchReport.value?.failures ?? 0 : 0;
  searchBusy.value = true; searchError.value = '';
  try {
    const result = await api.searchSkills(value, offset, controller.signal);
    if (generation !== searchGeneration) return;
    skillMatches.value = append ? [...skillMatches.value, ...result.matches] : result.matches;
    searchReport.value = { ...result, examined: priorExamined + result.examined, failures: priorFailures + result.failures };
  } catch (error) {
    if (controller.signal.aborted || generation !== searchGeneration) return;
    searchError.value = error instanceof Error ? error.message : 'Skill 搜索失败。';
  } finally { if (generation === searchGeneration) searchBusy.value = false; }
}
function loadMoreSkillMatches() {
  if (searchReport.value?.nextOffset !== null && searchReport.value?.nextOffset !== undefined) void runSearch(searchText.value.trim(), searchReport.value.nextOffset, true);
}
watch([searchText, () => store.catalog], ([value]) => {
  searchGeneration += 1; searchController?.abort();
  if (searchTimer) clearTimeout(searchTimer);
  skillMatches.value = []; searchReport.value = null; searchError.value = '';
  const query = String(value).trim();
  if (query.length < 2) return;
  const generation = searchGeneration;
  searchTimer = setTimeout(() => { if (generation === searchGeneration) void runSearch(query); }, 250);
});
watch([effectiveInstanceId, selectedProjectId, selectedWorkdir, () => store.catalog], () => { void refreshAvailability(); }, { immediate: true });
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  searchController?.abort(); availabilityController?.abort();
});

function rowName(item: ResourceRow) { return item.mcpBinding ? `${resourceName(item.binding)} · ${discoveryAgent(item.binding)} · 配置绑定` : item.versionRecord ? `${resourceName(item.binding)} · ${item.binding.origin === 'cache' ? `缓存 v${item.binding.pluginVersion ?? '未知'}` : '配置记录'}` : resourceName(item.binding); }
function availabilityLabel(status: string) {
  return ({ 'scope-mismatch': '范围不匹配', 'scope-unknown': '范围证据不足', 'file-missing': '当前文件缺失', 'file-unreadable': '当前文件无法读取', 'configuration-only': '仅配置记录',
    'format-invalid': '格式无效', disabled: '扫描时配置为禁用', 'name-conflict': '同名冲突，优先级未确认', 'potential-name-conflict': '潜在同名冲突，配置状态待确认', 'status-unknown': '文件状态未知',
    'configuration-unknown': '配置状态未知', 'estimated-visible': '规则推测可见，加载未验证' } as Record<string, string>)[status] ?? status;
}
function fileLabel(status: string | undefined) { return ({ present: '存在', missing: '缺失', unreadable: '无法读取', 'configuration-only': '仅配置记录', valid: '有效', invalid: '无效', unavailable: '不可检查', unknown: '未检查' } as Record<string, string>)[status ?? 'unknown'] ?? status; }
function rowDescription(item: ResourceRow) {
  if (item.mcpGroup) return `同一 MCP 服务 · 关联 ${new Set(item.mcpGroup.members.map(discoveryAgent)).size} 个 Agent · ${item.mcpGroup.members.length} 条绑定 · ${item.mcpGroup.variants === null ? '配置差异待复核（请重扫）' : item.mcpGroup.variants > 1 ? `配置不同（${item.mcpGroup.variants} 组）` : '配置相同'} · 当前匹配 ${item.mcpGroup.matchingMembers.length} 条`;
  if (item.mcpBinding) return `${discoveryAgent(item.binding)} · ${store.instances.find(i=>i.id===item.binding.instanceId)?.name ?? item.binding.instanceId} · ${item.binding.classification?.projectName ?? '不限定项目'} · ${item.binding.configurationSourcePath ?? item.binding.sourcePath}`;
  if (item.publicGroup) return `公共资源 · ${item.publicGroup.members.length} 条发现记录 · ${publicDisabledLabel(item.publicGroup.members)}`;
  if (item.group) return `${item.group.versions.length} 个缓存版本 · ${item.group.configurations} 条配置记录 · 当前使用版本未确定`;
  if (item.binding.discoveryOnly) return `分组路径：${item.binding.discoveryPath} · ${item.binding.description}`;
  if (item.depth && !item.versionRecord) return `由 ${store.bindings.find(b=>b.id===item.binding.parentId)?.name ?? '插件'} 提供${item.binding.pluginVersion ? ` · 缓存 v${item.binding.pluginVersion}` : ''}`;
  return item.binding.description || item.binding.nativeKey || item.binding.sourcePath;
}
function openRow(item: ResourceRow) {
  if (item.group || item.mcpGroup) togglePlugin(item.key);
  else { ui.openBinding(item.binding); ui.selectedPublicMembers = item.publicGroup?.members ?? []; }
}
function openMcpGroup(item: ResourceRow) { ui.openBinding(item.binding); ui.selectedMcpMembers = item.mcpGroup?.members ?? []; }
function groupValues(item: ResourceRow, label: (binding: Binding) => string) {
  return [...new Set((item.mcpGroup?.matchingMembers ?? [item.binding]).map(label))].join('、');
}
</script>

<template>
  <StatCards />
  <section class="panel fill-panel"><div class="panel-heading"><div><h2>本机资源</h2><small>{{ store.catalog?.lastScanAt ? `上次成功扫描 ${timeLabel(store.catalog.lastScanAt)}` : '尚无扫描记录' }}</small></div><div class="panel-tools"><el-input v-model="searchText" clearable placeholder="搜索名称或来源路径"><template #prefix><el-icon><Search /></el-icon></template></el-input><el-button class="refresh" circle aria-label="刷新资源" :loading="store.busy" @click="refresh"><el-icon><Refresh /></el-icon></el-button></div></div>
    <div class="panel-body-scroll">
      <section class="taxonomy-note source-entry" aria-label="自定义 Skill 资源入口"><div><strong>自定义 Skill 资源入口</strong><small>独立于客户端登记。磁盘发现不表示客户端已加载，也不会授予写入权限。</small></div><el-input v-model="sourcePath" placeholder="Skill 文件夹、集合目录或项目/插件资源目录" aria-label="自定义资源目录" @keyup.enter="registerSource"/><el-select v-model="sourceMode" aria-label="扫描深度"><el-option label="快速（直接子目录）" value="quick"/><el-option label="深度（最多 8 层）" value="deep"/></el-select><el-checkbox v-model="followLinks">只读跟随范围内符号链接 / junction</el-checkbox><el-button type="primary" :loading="sourceBusy" @click="registerSource">登记并扫描</el-button></section>
      <section class="taxonomy-note availability-panel" aria-label="项目中可用的 Skills"><strong>在此项目中可用的 Skills</strong><small>“扫描时配置状态”来自目录快照；“当前文件状态”会重查磁盘。任何结果都不证明客户端运行时已加载。</small><div class="availability-controls"><el-select v-model="selectedInstanceId" placeholder="选择客户端实例" aria-label="可用性客户端"><el-option v-for="instance in store.instances" :key="instance.id" :label="`${instance.name} · ${agentName(instance.agentId)}`" :value="instance.id"/></el-select><el-select v-model="selectedProjectId" clearable placeholder="选择项目" aria-label="可用性项目"><el-option v-for="project in store.projects" :key="project.id" :label="project.name" :value="project.id"/></el-select><el-input v-model="selectedWorkdir" placeholder="工作目录（可选）" aria-label="可用性工作目录"/><el-button :loading="availabilityBusy" @click="refreshAvailability">重查文件状态</el-button></div><p v-if="availabilityError" class="detail-issue">{{ availabilityError }}</p><small v-if="availabilityReport">当前文件检查 {{ availabilityReport.inspectedBindings }}/{{ availabilityReport.totalBindings }} 条绑定、{{ availabilityReport.inspectedIndependent }}/{{ availabilityReport.totalIndependent }} 条独立发现{{ availabilityReport.truncated ? '；结果有界截断，请缩小范围或分批扫描。' : '' }}</small><ul v-if="availabilityRows.length"><li v-for="row in availabilityRows" :key="row.binding.id"><b>{{ row.binding.displayName ?? row.binding.name }}</b><span>{{ availabilityLabel(row.status) }}</span><small>当前磁盘：{{ fileLabel(row.file.disk) }} · 当前格式：{{ fileLabel(row.file.format) }} · {{ row.file.reason }}</small><small>扫描时配置：{{ row.binding.enabled === null ? '未确认' : row.binding.enabled ? '启用' : '禁用' }} · {{ row.binding.configurationStateReason ?? '未发现原生加载证据' }} · 扫描记录 {{ timeLabel(row.binding.updatedAt) }}</small><small>控制能力：{{ row.binding.writable ? '有受限写入能力，应用时仍复核' : '只读' }} · 客户端运行时加载：未知。{{ row.reason }}</small></li></ul><small v-else>此客户端实例尚无已扫描的 Skill 绑定。独立磁盘发现不会自动作为已安装资源计入。</small><ul v-if="independentChecks.length"><li v-for="item in independentChecks" :key="item.sourceId + item.findingPath"><b>{{ item.name }}</b><span>独立发现 · 未绑定</span><small>当前磁盘：{{ fileLabel(item.status) }} · 当前格式：{{ fileLabel(item.format) }} · {{ item.reason }}</small></li></ul></section>
      <div v-if="sourceError" class="taxonomy-note">{{ sourceError }}</div>
      <section v-for="source in store.catalog?.skillSources ?? []" :key="source.id" class="taxonomy-note source-report">
        <div><strong>{{ source.path }}</strong><small>{{ source.report ? `${source.report.status==='complete'?'扫描完整':source.report.status==='partial'?'扫描部分完成':'扫描失败'} · ${source.mode==='quick'?'快速':'深度'}扫描，最大深度 ${source.report.limits.maxDepth} · 入口 ${source.report.rootPath} · 候选 ${source.report.candidateCount} · 识别 ${source.report.recognizedCount} · 跳过 ${source.report.skippedCount} · 访问 ${source.report.visitedDirectories}/${source.report.limits.maxDirectories} 个目录，每目录最多 ${source.report.limits.maxEntriesPerDirectory} 项 · manifest 上限 ${Math.round(source.report.limits.maxManifestBytes/1024/1024)} MiB，frontmatter ${Math.round(source.report.limits.maxFrontmatterBytes/1024)} KiB` : '尚未扫描' }}{{ source.report?.truncatedAt ? ` · 截断位置 ${source.report.truncatedAt}` : '' }}</small><small v-if="source.report?.truncatedAt && !source.report.continuationPath" class="continuation-note">该截断项不是可独立扫描的目录入口；请另行登记其中明确的子目录。</small></div>
        <div><el-button v-if="source.report?.continuationPath" text :loading="sourceBusy" @click="scanFindingTarget(source.report.continuationPath, false)">继续深扫截断目录</el-button><el-button text :loading="sourceBusy" @click="rescanSource(source.id)">重扫</el-button><el-button text @click="removeSource(source.id)">移除入口</el-button></div>
        <p v-for="message in source.report?.diagnostics ?? []" :key="message">{{ message }}</p>
        <details v-if="source.report?.findings.length"><summary>扫描明细（{{ source.report.findings.length }}）</summary><ul><li v-for="finding in source.report.findings" :key="finding.logicalPath"><code>{{ finding.logicalPath }}</code> · {{ finding.status==='recognized'?'已识别':finding.status==='candidate'?'格式问题候选':'已跳过' }} · {{ finding.reason }}<small v-if="finding.actualPath!==finding.logicalPath">实际路径：{{ finding.actualPath }}</small><el-button v-if="finding.status!=='skipped'" text size="small" @click="showSkillDetails({sourceId:source.id,findingPath:finding.logicalPath})">查看详情</el-button><el-button v-if="finding.status!=='skipped'" text size="small" :loading="sourceBusy" @click="scanFindingTarget(finding.logicalPath.replace(/[\\/]SKILL\.md$/i, ''), false)">进一步扫描此目录</el-button><el-button v-if="finding.status==='skipped' && finding.actualPath!==finding.logicalPath" text size="small" :loading="sourceBusy" @click="scanFindingTarget(finding.actualPath, true)">进一步扫描该目标</el-button></li></ul></details>
      </section>
      <section v-if="independentFindings.length" class="source-inventory" aria-label="独立磁盘 Skill 发现结果">
        <strong>独立磁盘 Skill · {{ independentFindings.length }} 项</strong>
        <ul><li v-for="finding in independentFindings" :key="finding.sourcePath + finding.logicalPath"><div><b>{{ finding.name }}</b><span :class="finding.status">{{ finding.status==='recognized'?'已识别':'格式问题候选' }}</span><small>{{ finding.reason }}</small><code>{{ finding.logicalPath }}</code></div><el-button text size="small" @click="showSkillDetails({sourceId:(store.catalog?.skillSources ?? []).find(s=>s.path===finding.sourcePath)?.id ?? '',findingPath:finding.logicalPath})">查看详情</el-button><el-button v-if="finding.status==='recognized'" text size="small" :loading="sourceBusy" @click="scanFindingTarget(finding.logicalPath.replace(/[\\/]SKILL\.md$/i, ''), false)">继续深扫此目录</el-button></li></ul>
        <small>这些是只读磁盘发现记录，未建立客户端绑定。</small>
      </section>
      <section v-if="searchText.trim().length >= 2" class="taxonomy-note skill-search-results" aria-label="Skill 内容搜索"><strong>Skill 内容命中</strong><small v-if="searchBusy">正在搜索说明、作者、依赖和正文…</small><small v-if="searchError" class="detail-issue">{{ searchError }}</small><small v-if="searchReport">已检查 {{ searchReport.examined }}/{{ searchReport.totalCandidates }} 条资源 · 未能检查 {{ searchReport.failures }} 条{{ searchReport.truncated ? ' · 当前页有界，继续加载可检查后续资源。' : '' }}</small><small v-if="!searchBusy && !skillMatches.length && searchReport && !searchReport.truncated">已检查范围内没有命中。</small><small v-else-if="!searchBusy && !skillMatches.length && searchReport?.truncated">当前页没有命中，仍有后续资源待检查。</small><ul><li v-for="hit in skillMatches" :key="hit.key"><b>{{ hit.name }}</b><span>{{ hit.snippet }}</span><el-button text size="small" @click="hit.bindingId ? showSkillDetails({bindingId:hit.bindingId}) : showSkillDetails({sourceId:hit.sourceId ?? '',findingPath:hit.findingPath ?? ''})">打开详情</el-button></li></ul><el-button v-if="searchReport?.nextOffset !== null && searchReport?.nextOffset !== undefined" :loading="searchBusy" @click="loadMoreSkillMatches">继续搜索后续资源</el-button></section>
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
        <tr v-for="item in visible" :key="item.key" :class="{child:item.depth>0,parent:item.binding.kind==='plugin','plugin-group':!!item.group,'public-group':!!item.publicGroup,'mcp-group':!!item.mcpGroup}" @click="openRow(item)"><td>
          <div class="resource-cell" :style="{paddingLeft:`${item.depth*24}px`}">
            <button v-if="item.mcpGroup || item.group || item.binding.kind==='plugin'&&item.children" class="tree-toggle" :class="{expanded:expanded.has(item.key)}" :aria-expanded="expanded.has(item.key)" :aria-label="item.mcpGroup ? expanded.has(item.key)?'收起 MCP 绑定':'展开 MCP 绑定' : item.group ? expanded.has(item.key)?'收起插件版本':'展开插件版本':expanded.has(item.key)?'收起插件组件':'展开插件组件'" @click.stop="togglePlugin(item.key)"><el-icon><ArrowRight/></el-icon></button>
            <span v-else-if="item.depth" class="tree-stem"></span><i class="kind-icon" :class="item.binding.kind"><el-icon><component :is="item.binding.kind==='skill'?Document:item.binding.kind==='plugin'?Box:Connection"/></el-icon></i>
            <div class="resource-copy"><div class="resource-title"><button class="resource-detail-link" :title="rowName(item)" :aria-label="rowName(item)" @click.stop="openRow(item)">{{ resourceName(item.binding) }}</button><button v-if="item.binding.kind==='skill'" class="plan-link" @click.stop="showSkillDetails({bindingId:item.binding.id})">Skill 详情</button>
              <span v-if="item.mcpGroup" class="version-badge">服务分组</span><span v-else-if="item.publicGroup" class="version-badge">公共资源</span><span v-else-if="item.group" class="version-badge">版本分组</span>
              <button v-if="item.mcpGroup" class="plan-link" :aria-label="`${resourceName(item.binding)}服务详情`" @click.stop="openMcpGroup(item)">服务详情</button>
              <span v-else-if="item.binding.pluginVersion && item.binding.origin==='cache'" class="version-badge">缓存版本 v{{ item.binding.pluginVersion }}</span>
              <span v-if="!item.group && (item.publicGroup ? item.publicGroup.members.every(diskOnly) : diskOnly(item.binding))" class="inventory-badge">仅磁盘发现</span>
            </div><small :title="rowDescription(item)">{{ rowDescription(item) }}</small></div>
            <small v-if="item.mcpGroup || item.group || item.binding.kind==='plugin'&&item.children" class="child-count">{{ item.children }} {{ item.mcpGroup?'条绑定':item.group?'条记录':'项' }}</small>
          </div>
        </td>
          <td class="classification-cell"><strong class="resource-category">{{ groupValues(item, b=>categoryLabel(inventoryCategory(b))) }}</strong><code :title="item.binding.mcpService?.location ?? item.binding.sourcePath">{{ item.mcpGroup ? item.binding.mcpService?.location : item.group ? item.binding.pluginId : item.binding.sourcePath }}</code><small>{{ item.mcpGroup ? '服务来源相同；配置归类保留在各绑定中' : item.group ? '展开查看各记录的原文路径与分类依据' : item.binding.classification?.reason ?? '旧索引无分类证据，请重新扫描' }}</small></td>
          <td class="scope-cell"><span class="tag scope">{{ groupValues(item,b=>scopeLabel(inventoryScope(b))) }}</span><small v-if="item.mcpGroup">{{ groupValues(item,b=>b.classification?.projectName ?? (b.projectId ? '项目未确定' : '不限定项目')) }}</small><small v-else-if="item.binding.classification?.projectName">{{ item.binding.classification.projectName }}</small><small v-else-if="inventoryScope(item.binding)==='user-global'">不限定项目</small></td>
          <td class="agent-cell"><span>{{ groupValues(item,b=>inventoryAgent(b)==='unknown'?'归属未知':agentName(inventoryAgent(b))) }}</span><small v-if="item.mcpGroup">各 Agent 配置分别保留</small><small v-else-if="item.binding.classification?.sharedSource" :title="item.binding.classification.sharedSource.agentIds.map(agentName).join('、')">共享来源 · {{ item.binding.classification.sharedSource.agentIds.map(agentName).join('、') }}</small></td>
          <td><span v-if="item.mcpGroup">{{ groupValues(item,b=>sourceLabel(b.sourceKind)) }}</span><span v-else-if="item.group">配置 / 缓存汇总</span><span v-else-if="item.binding.kind==='skill'" class="tag source">{{ (item.binding as SkillBinding).sourceLabel ?? sourceLabel(item.binding.sourceKind) }}</span><span v-else>{{ sourceLabel(item.binding.sourceKind) }}</span><small v-if="!item.group && !item.mcpGroup && originLabel(item.binding)" class="origin-detail">{{ originLabel(item.binding) }}</small></td>
          <td><span class="config-state" :class="(item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).tone" :title="(item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).reason"><i></i>{{ (item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).label }}</span></td>
          <td>
            <template v-if="!item.mcpGroup && !item.publicGroup && canPlan(item.binding)">
              <el-switch :model-value="item.binding.enabled===true" :disabled="actionBusy" :loading="actionBusy" :aria-label="`${resourceName(item.binding)}启停`" @click.stop @change="toggleBinding(item.binding,Boolean($event))"/>
              <el-tooltip content="查看启停预览"><button class="plan-link" :disabled="actionBusy" :aria-label="item.binding.enabled===true?'计划停用':item.binding.enabled===false?'计划启用':'生成启用计划'" @click.stop="planToggle(item.binding,item.binding.enabled!==true)"><el-icon><InfoFilled/></el-icon></button></el-tooltip>
            </template>
            <button v-else-if="item.mcpGroup" class="plan-link" @click.stop="togglePlugin(item.key)">展开各绑定启停</button>
            <el-tooltip v-else :content="readOnlyReason(item.binding)"><span class="readonly"><i class="cap-dot"></i><el-icon><Setting/></el-icon>只读</span></el-tooltip>
          </td>
          <td><el-tooltip v-if="item.binding.diagnostics.length" :content="item.binding.diagnostics.join('；')"><el-icon class="notice"><InfoFilled/></el-icon></el-tooltip></td></tr>
      </tbody></table></div>
      <div v-else-if="!store.bindings.length && !independentFindings.length" class="empty"><i><el-icon><Box/></el-icon></i><b>还没有可显示的资源</b><span>{{ store.instances.length ? '已登记实例尚未发现资源，可重新扫描或发现本机客户端。' : '尚未接入本机配置。开发模式默认使用隔离目录；点击下方按钮只读扫描当前用户的客户端配置。' }}</span><div><el-button type="primary" :loading="actionBusy" @click="scan(true, true)"><el-icon><Search/></el-icon>扫描本机配置（只读）</el-button><el-button v-if="!store.instances.length&&!store.projects.length" :loading="actionBusy" @click="demo">载入隔离演示数据</el-button></div></div>
      <div v-else-if="store.bindings.length" class="empty-filter"><el-icon><Search/></el-icon>当前筛选没有匹配项<el-button text @click="clearFilters">清除筛选</el-button></div>
    </div>
    <footer class="panel-footer"><span>显示 {{ visible.length }} 行 · 版本分组可展开 <template v-if="store.catalog?.lastScanAt">· 最近成功扫描 {{ timeLabel(store.catalog.lastScanAt) }}</template></span><span><i :class="eventStatus"></i>{{ eventStatus==='connected'?'实时事件已连接':eventStatus==='connecting'?'连接实时事件…':'事件通道离线' }}</span></footer>
  </section>
  <el-dialog v-model="detailsOpen" title="Skill 详情" width="min(900px, 92vw)" :close-on-click-modal="false" destroy-on-close>
    <el-skeleton v-if="detailsBusy && !details && !detailsError" :rows="6" animated />
    <div v-if="detailsError" class="taxonomy-note">{{ detailsError }}</div>
    <div v-else-if="details" class="skill-detail-body"><h3>{{ details.name }}</h3><p><b>描述：</b>{{ details.description ?? '未声明' }}</p><p><b>作者：</b>{{ details.author ?? '未声明' }} · <b>版本：</b>{{ details.version ?? '未声明' }} · <b>许可证：</b>{{ details.license ?? '未声明' }}</p><p><b>环境要求：</b>{{ details.environment ?? '未声明' }}</p><p><b>调用方式：</b>{{ details.invocation ?? '未声明' }}</p><p><b>工具依赖：</b>{{ details.dependencies.length ? details.dependencies.join('、') : '未声明' }}</p><p><b>支持文件：</b>{{ details.supports.length ? details.supports.join('、') : '未发现支持文件' }}</p><p class="detail-issue">manifest 格式：{{ details.formatStatus === 'valid' ? '有效' : '异常' }} · 客户端运行时加载：未知</p><p v-for="line in detailEvidence" :key="line" class="detail-evidence">{{ line }}</p><p v-for="issue in details.metadataIssues" :key="issue" class="detail-issue">{{ issue }}</p><div class="markdown-tools"><h4>Markdown 正文预览</h4><el-button text @click="showRawMarkdown=!showRawMarkdown">{{ showRawMarkdown ? '显示安全渲染' : '查看原文' }}</el-button></div><pre v-if="showRawMarkdown" class="markdown-source">{{ details.body || '（正文为空）' }}</pre><SkillMarkdown v-else id="skill-markdown-preview" :source="details.body" /></div>
    <template #footer><el-button @click="detailsOpen=false;details=null">关闭</el-button></template>
  </el-dialog>
</template>
