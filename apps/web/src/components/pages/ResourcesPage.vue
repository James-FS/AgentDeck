<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { ElMessage } from 'element-plus';
import type { Binding, ResourcePreferences } from '@agentdeck/contracts';
import { Box, CaretBottom, Close, Connection, Document, InfoFilled, Search } from '@element-plus/icons-vue';
import { configurationState } from '../../configuration-state';
import { diskOnly, inventoryAgent } from '../../classification';
import { publicResourceFlag, skillEntityIdentity } from '../../resource-entities';
import {
  agentName, originLabel, sourceLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { savedFilterScope, droppedLegacyConditions, legacyFilterLabels, legacyScopeToProjectScope, useUiStore } from '../../ui-store';
import { useResourceFilters } from '../../composables/useResourceFilters';
import { useResourceRows } from '../../composables/useResourceRows';
import { usePlanFlow } from '../../composables/usePlanFlow';
import { useScanActions } from '../../composables/useScanActions';
import { useEventStream } from '../../composables/useEventStream';
import { api, type SkillDetailsResponse } from '../../api';
import { deriveSkillAvailability, type SkillFileStatus } from '../../skill-availability';
import type { ResourceEntity } from '../../resource-entities';
const SkillMarkdown = defineAsyncComponent(() => import('../SkillMarkdown'));
const BindingDrawer = defineAsyncComponent(() => import('../drawers/BindingDrawer.vue'));
const EntityDetail = defineAsyncComponent(() => import('../drawers/EntityDetail.vue'));
import { boundedLineDiff } from '../../line-diff';

const store = useAppStore();
const ui = useUiStore();
const { actionBusy } = storeToRefs(ui);
const {
  kindFilter, searchText, sourceFilter, configurationFilter,
  favoritesOnly, activeFilterChips, removeFilterChip, clearFilters,
  libraryInstanceId, libraryProjectScope, libraryProjectId, libraryIncludeGlobal, viewIndependentSources,
} = useResourceFilters();
const {
  policy, entities, visible, tabCounts, hiddenCounts, unfilteredCollection, associatedBindingCount, hiddenSearchHitCount,
  independentExcluded, isFavoriteEntity, toggleEntityFavorite, entityRepresentativeReference, entityStatus, setDisplayPolicy,
} = useResourceRows();
const { canPlan, toggleBinding, planToggle } = usePlanFlow();
const { discoverClients, demo } = useScanActions();
const { eventStatus } = useEventStream();
const resourceTab = ref('library');
const headingElement = ref<HTMLElement | null>(null);
const filterElement = ref<HTMLElement | null>(null);
const headingHeight = ref(72);
const filterHeight = ref(56);
const resizeObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    if (entry.target === headingElement.value) headingHeight.value = entry.target.getBoundingClientRect().height;
    if (entry.target === filterElement.value) filterHeight.value = entry.target.getBoundingClientRect().height;
  }
});
watch([headingElement, filterElement], elements => { resizeObserver.disconnect(); for (const element of elements) if (element) resizeObserver.observe(element); });
const sourcePath = ref('');
const sourceMode = ref<'quick'|'deep'>('quick');
const followLinks = ref(false);
const sourceBusy = ref(false);
const sourceError = ref('');
const details = ref<SkillDetailsResponse | null>(null);
const detailResourceRef = ref<{ kind: 'binding'; bindingId: string } | { kind: 'source'; sourceId: string; findingPath: string } | null>(null);
const detailEntity = ref<ResourceEntity | null>(null);
const entityDetailOpen = ref(false);
const compareSelection = ref<Array<{ kind: 'binding'; bindingId: string } | { kind: 'source'; sourceId: string; findingPath: string }>>([]);
const compareResult = ref<Awaited<ReturnType<typeof api.compareSkills>> | null>(null);
const compareOpen = ref(false);
const compareBusy = ref(false);
const compareError = ref('');
let detailsGeneration = 0;
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
// The availability form owns its own client/project/workdir state. It is seeded
// once from an explicit library selection, then never writes back to the
// library; results are only (re)computed when the user clicks the check button.
const availabilityInstanceId = ref('');
const availabilityProjectId = ref('');
const availabilityWorkdir = ref('');
const availabilityStale = ref(false);
const availabilityChecked = ref(false);
let availabilitySeeded = false;
const availabilityRows = computed(() => deriveSkillAvailability({ bindings: store.bindings, projects: store.projects,
  instanceId: availabilityInstanceId.value, projectId: availabilityProjectId.value, workdir: availabilityWorkdir.value, files: availabilityFiles.value }));
const independentSkillRecordCount = computed(() => (store.catalog?.skillSources ?? []).reduce((total, source) =>
  total + (source.report?.findings ?? []).filter(finding => finding.status === 'recognized' || finding.status === 'candidate').length, 0));
const comparisonLines = computed(() => boundedLineDiff(compareResult.value?.leftBody ?? '', compareResult.value?.rightBody ?? ''));
const differenceIndex = ref(0);
function moveDifference(step: number) {
  const changes = comparisonLines.value.flatMap((line, index) => line.changed ? [index] : []);
  if (!changes.length) return;
  differenceIndex.value = (differenceIndex.value + step + changes.length) % changes.length;
  document.getElementById(`diff-line-${changes[differenceIndex.value]}`)?.scrollIntoView({ block: 'center' });
}
function referenceName(reference: NonNullable<typeof detailResourceRef.value>) {
  return reference.kind === 'binding' ? store.bindings.find(item => item.id === reference.bindingId)?.name ?? '资源已失效'
    : (store.catalog?.skillSources ?? []).find(source => source.id === reference.sourceId)?.report?.findings.find(item => item.logicalPath === reference.findingPath)?.name ?? '资源已失效';
}
function contentHit(reference: NonNullable<typeof detailResourceRef.value>) {
  return skillMatches.value.find(hit => reference.kind === 'binding' ? hit.bindingId === reference.bindingId : hit.sourceId === reference.sourceId && hit.findingPath === reference.findingPath);
}
const resourcePage = ref(1);
const pageSize = 50;
const pagedEntities = computed(() => visible.value.slice((resourcePage.value-1)*pageSize, resourcePage.value*pageSize));
watch(visible, total => { resourcePage.value = Math.min(resourcePage.value, Math.max(1,Math.ceil(total.length/pageSize))); });
watch([searchText,kindFilter,sourceFilter,configurationFilter,favoritesOnly,libraryInstanceId,libraryProjectScope,libraryProjectId,libraryIncludeGlobal], () => {resourcePage.value=1;}, {deep:true});
watch(skillMatches, matches => {
  ui.contentBindingIds = matches.flatMap(hit => hit.bindingId ? [hit.bindingId] : []);
  ui.contentFindingKeys = matches.flatMap(hit => hit.sourceId && hit.findingPath ? [`${hit.sourceId}\n${hit.findingPath}`] : []);
}, {flush:'sync'});
const savedFilterId = ref('');
// One select drives two state fields: "all"/"global-only" carry no project id;
// choosing a project sets scope "project" plus that id.
const projectScopeSelection = computed({
  get: () => libraryProjectScope.value === 'project' ? libraryProjectId.value : libraryProjectScope.value,
  set: (value: string) => {
    if (value === 'all' || value === 'global-only') { libraryProjectScope.value = value; libraryProjectId.value = ''; }
    else { libraryProjectScope.value = 'project'; libraryProjectId.value = value; }
  },
});
// The current-view marker follows the saved conditions only; manual adjustments
// clear it so a view is never silently overwritten by later edits.
let applyingSavedView = false;
watch([kindFilter, searchText, sourceFilter, configurationFilter, favoritesOnly, libraryInstanceId, libraryProjectScope, libraryProjectId, libraryIncludeGlobal], () => {
  if (!applyingSavedView) savedFilterId.value = '';
}, { flush: 'sync' });
// Short state mark next to the display-options entry so an open menu is not needed
// to see which extra content is currently shown.
const displayOptionsMark = computed(() => {
  const enabled = [policy.value.showBuiltin ? '内置' : '', policy.value.showCacheOnly ? '缓存' : ''].filter(Boolean);
  return enabled.length ? ` · ${enabled.join('、')}` : '';
});
const staleFavoriteCount = computed(() => store.resourcePreferences.favorites.filter(item =>
  item.kind === 'binding' ? !store.bindings.some(binding => binding.id === item.bindingId)
    : !(store.catalog?.skillSources ?? []).some(source => source.id === item.sourceId && source.report?.findings.some(finding => finding.logicalPath === item.findingPath))).length);
function toggleCompare(reference: { kind: 'binding'; bindingId: string } | { kind: 'source'; sourceId: string; findingPath: string }) {
  if (compareSelection.value.some(item => JSON.stringify(item) === JSON.stringify(reference))) {
    compareSelection.value = compareSelection.value.filter(item => JSON.stringify(item) !== JSON.stringify(reference)); return;
  }
  compareSelection.value = [...compareSelection.value.slice(-1), reference];
}
async function runSkillCompare() {
  if (compareSelection.value.length !== 2) return;
  compareResult.value = null; differenceIndex.value = 0; compareBusy.value = true; compareError.value = ''; compareOpen.value = true;
  try { compareResult.value = await api.compareSkills(compareSelection.value[0]!, compareSelection.value[1]!); }
  catch (error) { compareError.value = error instanceof Error ? error.message : '无法安全比较所选 Skill。'; }
  finally { compareBusy.value = false; }
}
async function saveCurrentFilter() {
  const name = window.prompt('为当前筛选命名');
  if (!name?.trim()) return;
  // The reduced library only executes the retained filters and display policy;
  // legacy contract fields are written as neutral values.
  const filters: ResourcePreferences['savedFilters'][number]['filters'] = { kind: kindFilter.value, search: searchText.value.slice(0, 200),
    scope: [], owner: [], category: [], origin: 'all',
    source: [...sourceFilter.value], configuration: configurationFilter.value.filter((item): item is 'on' | 'off' | 'unknown' => item === 'on' || item === 'off' || item === 'unknown'),
    instanceId: libraryInstanceId.value || null,
    projectId: libraryProjectScope.value === 'project' ? libraryProjectId.value : null,
    projectScope: libraryProjectScope.value, includeGlobal: libraryIncludeGlobal.value,
    favoritesOnly: favoritesOnly.value,
    showBuiltin: policy.value.showBuiltin, showCacheOnly: policy.value.showCacheOnly };
  try {
    const saved = { id: crypto.randomUUID(), name: name.trim().slice(0, 60), filters };
    await store.mutatePreferences(current => ({ ...current, savedFilters: [...current.savedFilters, saved].slice(-30) }));
    savedFilterId.value = saved.id;
  } catch (error) { sourceError.value = error instanceof Error ? error.message : '无法保存筛选。'; }
}
function applySavedFilter(id: string) {
  const saved = store.resourcePreferences.savedFilters.find(item => item.id === id);
  if (!saved) return;
  const filters = saved.filters;
  // Legacy views may carry conditions the reduced library no longer executes.
  // The exact "user-global only, no project" view converts to "global-only";
  // everything else is reported once instead of silently running or widening.
  const dropped = droppedLegacyConditions(filters);
  let scope = savedFilterScope(filters).scope;
  if (filters.scope?.length && !filters.projectScope) {
    const converted = legacyScopeToProjectScope(filters.scope, filters.projectId);
    if (converted) scope = converted;
    else if (!dropped.includes('scope')) dropped.push('scope');
  }
  const invalidInstance = Boolean(filters.instanceId && !store.instances.some(instance => instance.id === filters.instanceId));
  const invalidProject = Boolean(filters.projectId && !store.projects.some(project => project.id === filters.projectId));
  applyingSavedView = true;
  kindFilter.value = filters.kind; searchText.value = filters.search;
  sourceFilter.value = [...filters.source]; configurationFilter.value = [...filters.configuration];
  favoritesOnly.value = filters.favoritesOnly;
  libraryInstanceId.value = invalidInstance ? '' : filters.instanceId ?? '';
  libraryProjectId.value = invalidProject ? '' : filters.projectId ?? '';
  libraryProjectScope.value = invalidProject && scope === 'project' ? 'all' : scope;
  libraryIncludeGlobal.value = filters.includeGlobal ?? true;
  // Old named filters without saved switches read as both off.
  void setDisplayPolicy({ showBuiltin: filters.showBuiltin ?? false, showCacheOnly: filters.showCacheOnly ?? false });
  applyingSavedView = false;
  savedFilterId.value = saved.id;
  sourceError.value = invalidInstance || invalidProject ? '保存视图引用的实例或项目已失效；已清除失效上下文，其余条件仍已应用。'
    : dropped.length ? `此视图含已取消的筛选条件（${[...new Set(dropped)].map(field => legacyFilterLabels[field]).join('、')}），已应用其余条件，可重新保存。` : '';
}
async function deleteSavedFilter(id: string) {
  try {
    await store.mutatePreferences(current => ({ ...current, savedFilters: current.savedFilters.filter(item => item.id !== id) }));
    if (savedFilterId.value === id) savedFilterId.value = '';
  }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '无法删除已保存筛选。'; }
}
// Explicitly filtering by the built-in source turns the display switch on and keeps
// the control in sync; removing the source condition does not turn it back off.
watch(sourceFilter, values => { if (values.includes('builtin') && !policy.value.showBuiltin) void setDisplayPolicy({ showBuiltin: true }); });
async function registerSource() {
  if (!sourcePath.value.trim()) return;
  sourceBusy.value = true; sourceError.value = '';
  try { await api.registerSkillSource({ path: sourcePath.value.trim(), mode: sourceMode.value, followLinks: followLinks.value }); sourcePath.value = ''; await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '登记扫描失败。'; }
  finally { sourceBusy.value = false; }
}
async function rescanSource(id: string, force = false) {
  sourceBusy.value = true; sourceError.value = '';
  try { await api.scanSkillSource(id, force); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '重扫失败。'; }
  finally { sourceBusy.value = false; }
}
async function toggleSourceWatch(id: string, enabled: boolean) {
  try { await api.watchSkillSource(id, enabled); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '无法更新目录监听状态。'; }
}
async function copyResourcePath(value: string) {
  try { await navigator.clipboard.writeText(value); ElMessage.success({message:'路径已复制。', grouping:true}); }
  catch { window.prompt('剪贴板不可用，请手动复制此路径：', value); }
}
async function openResourceDirectory(reference: { kind: 'binding'; bindingId: string } | { kind: 'source'; sourceId: string; findingPath: string }) {
  try { await api.openResourceDirectory(reference); }
  catch (error) {
    const message = error instanceof Error ? error.message : '无法打开资源目录。';
    sourceError.value = message;
    if (detailsOpen.value) detailsError.value = message;
  }
}
function currentDetailPath(): string {
  const reference = detailResourceRef.value;
  if (!reference) return '';
  return reference.kind === 'binding' ? store.bindings.find(item => item.id === reference.bindingId)?.sourcePath ?? '' : reference.findingPath;
}
async function removeSource(id: string) {
  try { await api.removeSkillSource(id); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '取消登记失败；目录和文件不会被删除。'; }
}
async function scanFindingTarget(targetPath: string, links = false) {
  sourceBusy.value = true; sourceError.value = '';
  try { await api.registerSkillSource({ path: targetPath, mode: 'deep', followLinks: links }); await store.refresh(); }
  catch (error) { sourceError.value = error instanceof Error ? error.message : '无法进一步扫描所选目标。'; }
  finally { sourceBusy.value = false; }
}
async function showSkillDetails(input: { bindingId: string } | { sourceId: string; findingPath: string }) {
  const generation = ++detailsGeneration;
  detailResourceRef.value = 'bindingId' in input ? { kind: 'binding', bindingId: input.bindingId }
    : { kind: 'source', sourceId: input.sourceId, findingPath: input.findingPath };
  detailsOpen.value = true; detailsBusy.value = true; detailsError.value = ''; details.value = null; showRawMarkdown.value = false;
  if ('bindingId' in input) {
    const binding = store.bindings.find(item => item.id === input.bindingId);
    ui.selectedBinding = binding ?? null; ui.selectedMcpMembers = []; ui.selectedPublicMembers = [];
    const identity = binding && skillEntityIdentity(binding);
    ui.selectedPublicMembers = binding && identity && publicResourceFlag(binding)
      ? store.bindings.filter(item => skillEntityIdentity(item) === identity) : [];
    const current = availabilityFiles.value[input.bindingId];
    detailEvidence.value = binding ? [
      `当前文件检查：${current?.disk ?? '尚未检查'} · 格式：${current?.format ?? '尚未检查'}${current?.checkedAt ? ` · ${timeLabel(current.checkedAt)}` : ''}`,
      `扫描时配置状态：${binding.enabled === null ? '未确认' : binding.enabled ? '启用' : '禁用'} · 扫描记录：${timeLabel(binding.updatedAt)}`,
      `客户端加载证据：未知（AgentDeck 当前不查询运行中会话）`,
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
  try { const result = await api.skillDetails(input); if (generation === detailsGeneration) details.value = result; }
  catch (error) { if (generation === detailsGeneration) detailsError.value = error instanceof Error ? error.message : '无法读取 Skill 详情。'; }
  finally { if (generation === detailsGeneration) detailsBusy.value = false; }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let searchController: AbortController | null = null;
let availabilityGeneration = 0;
let availabilityController: AbortController | null = null;
async function refreshAvailability() {
  // Only the explicit check button calls this; a stale marker plus generation and
  // controller isolation keep an old response from posing as the current result.
  if (!availabilityInstanceId.value) return;
  const controller = new AbortController(); availabilityController = controller;
  const generation = ++availabilityGeneration;
  availabilityError.value = ''; availabilityBusy.value = true; availabilityStale.value = false;
  try {
    const result = await api.skillAvailability(availabilityInstanceId.value, availabilityProjectId.value, availabilityWorkdir.value, controller.signal);
    if (generation !== availabilityGeneration) return;
    availabilityFiles.value = result.bindings; independentChecks.value = result.independent;
    availabilityReport.value = result; availabilityChecked.value = true;
  } catch (error) {
    if (controller.signal.aborted || generation !== availabilityGeneration) return;
    availabilityError.value = error instanceof Error ? error.message : '无法检查当前 Skill 状态。';
  } finally { if (generation === availabilityGeneration) availabilityBusy.value = false; }
}
async function runSearch(value: string, offset = 0, append = false) {
  const generation = ++searchGeneration;
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
watch([searchText, () => store.catalog, libraryInstanceId, libraryProjectId], ([value]) => {
  searchGeneration += 1; searchController?.abort();
  if (searchTimer) clearTimeout(searchTimer);
  skillMatches.value = []; searchReport.value = null; searchError.value = '';
  const query = String(value).trim();
  searchBusy.value = false;
  if (query.length < 2) return;
  const generation = searchGeneration;
  searchTimer = setTimeout(() => { if (generation === searchGeneration) void runSearch(query); }, 250);
});
// Editing any availability input cancels or isolates the running request and marks
// the previous result stale; nothing is requested until the button is clicked.
watch([availabilityInstanceId, availabilityProjectId, availabilityWorkdir], () => {
  availabilityGeneration += 1; availabilityController?.abort(); availabilityController = null;
  availabilityBusy.value = false;
  if (availabilityChecked.value) availabilityStale.value = true;
}, { flush: 'sync' });
// One-way seed: the first entry into the availability tab carries over an
// explicit library client/project selection; later tab switches keep the form.
watch(resourceTab, tab => {
  if (tab !== 'availability' || availabilitySeeded) return;
  availabilitySeeded = true;
  if (!availabilityInstanceId.value && ui.libraryInstanceId) availabilityInstanceId.value = ui.libraryInstanceId;
  if (!availabilityProjectId.value && ui.libraryProjectScope === 'project') availabilityProjectId.value = ui.libraryProjectId;
});
onBeforeUnmount(() => {
  resizeObserver.disconnect();
  if (searchTimer) clearTimeout(searchTimer);
  searchGeneration++; availabilityGeneration++;
  searchController?.abort(); availabilityController?.abort();
});

// Entity helpers for the flattened library table.
function openEntity(entity: ResourceEntity) {
  detailEntity.value = entity;
  if (entity.kind === 'skill') {
    const representative = entity.visibleBindings[0] ?? entity.bindings[0];
    if (representative) void showSkillDetails({ bindingId: representative.id });
    else if (entity.findings[0]) void showSkillDetails({ sourceId: entity.findings[0].sourceId, findingPath: entity.findings[0].findingPath });
    return;
  }
  entityDetailOpen.value = true;
}
function openFinding(sourceId: string, findingPath: string) { entityDetailOpen.value = false; void showSkillDetails({ sourceId, findingPath }); }
function entityDescription(entity: ResourceEntity) {
  if (entity.kind === 'plugin') return `${entity.plugin!.configurations} 条配置记录 · ${entity.plugin!.cacheRecords} 条缓存记录${entity.plugin!.versions.length ? ` · 缓存版本 ${entity.plugin!.versions.join('、')}` : ''} · 当前使用版本未确认`;
  if (entity.kind === 'mcp') return `同一 MCP 服务 · ${entity.bindings.length} 条绑定 · ${entity.mcp?.variants === null ? '配置差异待复核（请重扫）' : entity.mcp?.variants === 1 ? '各绑定配置相同' : entity.mcp?.variants ? `配置不同（${entity.mcp.variants} 组）` : '服务证据来自扫描'} · 不代表共用运行进程`;
  if (entity.independentOnly) return entity.findings[0]?.reason || entity.description || '独立磁盘发现，未绑定到客户端。';
  if (entity.fromPlugin) return `来自插件 ${entity.fromPlugin}${entity.description ? ` · ${entity.description}` : ''}`;
  if (entity.bindings.length > 1 && entity.findings.length) return `独立发现与客户端绑定指向同一物理 Skill · ${entity.bindings.length} 条绑定 · ${entity.findings.length} 个独立入口`;
  return entity.description || entity.bindings[0]?.nativeKey || entity.bindings[0]?.sourcePath || '';
}
function entityAgents(entity: ResourceEntity) {
  const values = [...new Set(entity.visibleBindings.map(binding => inventoryAgent(binding) === 'unknown' ? '归属未知' : agentName(inventoryAgent(binding))))];
  return values.length ? values.join('、') : '未绑定';
}
function entityProjects(entity: ResourceEntity) {
  const values = [...new Set(entity.visibleBindings.map(binding => binding.classification?.projectName ?? (binding.projectId ? '项目未确定' : '不限定项目')))];
  return values.length ? values.join('、') : '未绑定';
}
function entitySourceLabel(entity: ResourceEntity) {
  const values = [...new Set(entity.visibleBindings.map(binding => sourceLabel(binding.sourceKind)))];
  return values.length ? values.join('、') : '独立来源';
}
function entityOriginSummary(entity: ResourceEntity) {
  return [...new Set(entity.visibleBindings.map(binding => originLabel(binding)).filter(Boolean))].join(' · ');
}
function entityPath(entity: ResourceEntity) {
  return entity.visibleBindings[0]?.mcpService?.location ?? entity.visibleBindings[0]?.sourcePath ?? entity.findings[0]?.findingPath ?? '';
}
function entityOpenReference(entity: ResourceEntity): { kind: 'binding'; bindingId: string } | { kind: 'source'; sourceId: string; findingPath: string } | null {
  if (entity.visibleBindings[0]) return { kind: 'binding', bindingId: entity.visibleBindings[0].id };
  if (entity.findings[0]) return { kind: 'source', sourceId: entity.findings[0].sourceId, findingPath: entity.findings[0].findingPath };
  return null;
}
function entityContentHit(entity: ResourceEntity) {
  for (const binding of entity.visibleBindings) {
    const hit = skillMatches.value.find(item => item.bindingId === binding.id);
    if (hit) return hit.snippet;
  }
  for (const finding of entity.findings) {
    const hit = skillMatches.value.find(item => item.sourceId === finding.sourceId && item.findingPath === finding.findingPath);
    if (hit) return hit.snippet;
  }
  return '';
}
function entityDiagnostics(entity: ResourceEntity) {
  const messages = entity.bindings.flatMap(binding => binding.diagnostics);
  return messages.length ? messages.join('；') : '';
}
// Direct switch only when every plannable binding resolves to the same native
// control address (e.g. a configuration record and its cache copies of the same
// plugin); distinct targets keep per-binding switches in the detail dialog.
function controlAddress(binding: Binding): string {
  const target = binding.toggleTarget;
  if (target?.agentId === 'deepseek-harness') return `dsh:${target.configPath}:${target.id}`;
  if (target) return `${target.agentId}:${target.path.join('.')}`;
  return `${binding.configurationSourcePath ?? ''}:${binding.configurationKey ?? ''}`;
}
function entitySingleControl(entity: ResourceEntity): Binding | null {
  const controls = entity.visibleBindings.filter(binding => canPlan(binding));
  if (!controls.length) return null;
  const addresses = new Set(controls.map(controlAddress));
  return addresses.size === 1 ? controls[0]! : null;
}
const hiddenEntityKeys = computed(() => {
  const visibleKeys = new Set(entities.value.map(entity => entity.key));
  return new Set(unfilteredCollection.value.entities.filter(entity => !visibleKeys.has(entity.key)).map(entity => entity.key));
});
const hiddenFavoriteCount = computed(() => {
  if (!hiddenEntityKeys.value.size) return 0;
  const hidden = unfilteredCollection.value.entities.filter(entity => hiddenEntityKeys.value.has(entity.key) && isFavoriteEntity(entity));
  return hidden.length;
});
function availabilityLabel(status: string) {
  return ({ 'scope-mismatch': '范围不匹配', 'scope-unknown': '范围证据不足', 'file-missing': '当前文件缺失', 'file-unreadable': '当前文件无法读取', 'configuration-only': '仅配置记录',
    'format-invalid': '格式无效', disabled: '扫描时配置为禁用', 'name-conflict': '同名冲突，优先级未确认', 'potential-name-conflict': '潜在同名冲突，配置状态待确认', 'status-unknown': '文件状态未知',
    'configuration-unknown': '配置状态未知', 'estimated-visible': '规则推测可见，加载未验证' } as Record<string, string>)[status] ?? status;
}
function fileLabel(status: string | undefined) { return ({ present: '存在', missing: '缺失', unreadable: '无法读取', 'configuration-only': '仅配置记录', valid: '有效', invalid: '无效', unavailable: '不可检查', unknown: '未检查' } as Record<string, string>)[status ?? 'unknown'] ?? status; }
</script>

<template>
  <nav class="resource-tabs" aria-label="资源视图"><button v-for="tab in [{id:'library',label:'资源库'},{id:'sources',label:'来源与扫描'},{id:'availability',label:'项目可用性'},{id:'changes',label:'扫描变化'}]" :key="tab.id" :aria-current="resourceTab===tab.id?'page':undefined" :class="{selected:resourceTab===tab.id}" @click="resourceTab=tab.id">{{ tab.label }}</button></nav>
  <div v-if="compareSelection.length" class="compare-selection" aria-label="对比选择"><b>已选 {{ compareSelection.length }}/2</b><button v-for="(reference,index) in compareSelection" :key="index" @click="toggleCompare(reference)" :aria-label="`移除对比 ${referenceName(reference)}`">{{ referenceName(reference) }} ×</button><el-button @click="compareSelection=[]">清空</el-button><el-button :disabled="compareSelection.length!==2" type="primary" @click="runSkillCompare">对比已选 Skill</el-button></div>
  <section class="panel fill-panel" :style="{'--heading-height':`${headingHeight}px`,'--filter-height':`${filterHeight}px`}"><div ref="headingElement" class="panel-heading"><div><h2>本机资源</h2><small>{{ store.catalog?.lastScanAt ? `上次成功扫描 ${timeLabel(store.catalog.lastScanAt)}` : '尚无扫描记录' }}</small></div><div class="panel-tools"><el-popover trigger="click" width="320" popper-class="help-popper"><template #reference><el-button text data-testid="library-help" aria-label="资源说明">资源说明</el-button></template><div class="library-help"><p>资源库按 <b>唯一资源实体</b> 展示：同一物理 Skill、插件身份或 MCP 服务聚为一行；缓存版本、配置记录与发现入口在该资源的详情中逐条列出。</p><p>默认隐藏可靠内置与纯缓存资源，可用“显示选项”开启；磁盘发现、配置启用不证明客户端运行时已加载，启停与加载状态以详情说明为准。</p></div></el-popover></div></div>
    <div class="panel-body-scroll">
      <section v-if="resourceTab==='sources'" class="taxonomy-note source-entry" aria-label="添加 Skill 目录"><div><strong>添加 Skill 目录</strong><small>独立于客户端登记，取消登记不会删除目录和文件。磁盘发现不表示客户端已加载，也不会授予写入权限。</small></div><el-input v-model="sourcePath" placeholder="Skill 文件夹、集合目录或项目/插件资源目录" aria-label="Skill 目录路径" @keyup.enter="registerSource"/><details><summary>扫描高级选项</summary><el-select v-model="sourceMode" aria-label="扫描深度"><el-option label="快速（直接子目录）" value="quick"/><el-option label="深度（最多 8 层）" value="deep"/></el-select><el-checkbox v-model="followLinks">只读跟随范围内符号链接 / junction</el-checkbox></details><el-button type="primary" :loading="sourceBusy" @click="registerSource">添加并扫描</el-button></section>
      <section v-if="resourceTab==='availability'" class="taxonomy-note availability-panel" aria-label="项目中可用的 Skills"><strong>项目中可用的 Skills</strong><p>选择客户端实例、项目和工作目录后点击“检查可用性”。工作目录留空时使用项目根目录。结果不会证明客户端运行时已加载。</p><div class="availability-controls"><el-select v-model="availabilityInstanceId" clearable placeholder="选择客户端实例（必选）" aria-label="可用性客户端" :disabled="!store.instances.length"><el-option v-for="i in store.instances" :key="i.id" :value="i.id" :label="`${agentName(i.agentId)} · ${i.name}`"/></el-select><el-select v-model="availabilityProjectId" clearable placeholder="全部项目（可选）" aria-label="可用性项目" :disabled="!store.projects.length"><el-option v-for="p in store.projects" :key="p.id" :value="p.id" :label="p.name"/></el-select><el-input v-model="availabilityWorkdir" :placeholder="`工作目录（默认：${store.projects.find(p=>p.id===availabilityProjectId)?.rootPath ?? '项目根目录'}）`" aria-label="可用性工作目录"/><el-button type="primary" :loading="availabilityBusy" :disabled="!availabilityInstanceId" @click="refreshAvailability">检查可用性</el-button></div><p v-if="!availabilityInstanceId" class="detail-issue">请选择客户端实例；可用性检查必须明确客户端。</p><p v-if="availabilityStale" class="detail-issue" data-testid="availability-stale">输入已修改，下方结果已过期；请重新检查。</p><p v-if="availabilityError" class="detail-issue">{{ availabilityError }}</p><small v-if="availabilityReport">当前文件检查 {{ availabilityReport.inspectedBindings }}/{{ availabilityReport.totalBindings }} 条绑定、{{ availabilityReport.inspectedIndependent }}/{{ availabilityReport.totalIndependent }} 条独立发现{{ availabilityReport.truncated ? '；结果有界截断，请缩小范围或分批扫描。' : '' }}</small><ul v-if="availabilityChecked && availabilityRows.length"><li v-for="row in availabilityRows" :key="row.binding.id"><b>{{ row.binding.displayName ?? row.binding.name }}</b><span>{{ availabilityLabel(row.status) }}</span><details><summary>证据与状态详情</summary><small>当前磁盘：{{ fileLabel(row.file.disk) }} · 当前格式：{{ fileLabel(row.file.format) }} · {{ row.file.reason }}</small><small>扫描时配置：{{ row.binding.enabled === null ? '未确认' : row.binding.enabled ? '启用' : '禁用' }} · {{ row.binding.configurationStateReason ?? '未发现原生加载证据' }} · 扫描记录 {{ timeLabel(row.binding.updatedAt) }}</small><small>控制能力：{{ row.binding.writable ? '有受限写入能力，应用时仍复核' : '只读' }} · 客户端运行时加载：未知。{{ row.reason }}</small></details></li></ul><small v-else-if="availabilityChecked">此客户端实例尚无已扫描的 Skill 绑定。独立磁盘发现不会自动作为已安装资源计入。</small><ul v-if="independentChecks.length"><li v-for="item in independentChecks" :key="item.sourceId + item.findingPath"><b>{{ item.name }}</b><span>独立发现 · 未绑定</span><small>当前磁盘：{{ fileLabel(item.status) }} · 当前格式：{{ fileLabel(item.format) }} · {{ item.reason }}</small></li></ul></section>
      <p v-if="resourceTab==='changes' && !store.catalog?.bindingChanges?.length && !(store.catalog?.skillSources ?? []).some(source=>source.changes)" class="taxonomy-note">暂无扫描变化；首次完整扫描建立基线。</p><div v-if="sourceError" class="taxonomy-note">{{ sourceError }}</div>
      <section v-if="resourceTab==='changes' && store.catalog?.bindingChanges?.length" class="taxonomy-note"><strong>最近客户端扫描变化</strong><ul><li v-for="change in [...store.catalog.bindingChanges].slice(-5).reverse()" :key="change.id"><span>{{ store.instances.find(instance=>instance.id===change.instanceId)?.name ?? change.instanceId }}<template v-if="change.projectId"> · 项目 {{ store.projects.find(project=>project.id===change.projectId)?.name ?? change.projectId }}</template> · {{ timeLabel(change.scannedAt) }}</span><small>{{ change.baseline?'已建立完整扫描基线':`新增 ${change.totals.added} · 移除 ${change.totals.removed} · 配置变化 ${change.totals.statusChanged}` }}{{ change.partial?' · 部分扫描，已保留未覆盖旧索引':'' }}{{ change.truncated?' · 详情已截断':'' }}</small><details v-if="!change.baseline && (change.added.length || change.removed.length || change.statusChanged.length)"><summary>查看变化明细</summary><p v-for="item in change.added" :key="`add-${item.id}`">新增 {{ item.kind }}：{{ item.name }} · {{ item.path }}</p><p v-for="item in change.removed" :key="`remove-${item.id}`">移除 {{ item.kind }}：{{ item.name }} · {{ item.path }}</p><p v-for="item in change.statusChanged" :key="`status-${item.id}`">状态变化 {{ item.kind }}：{{ item.name }}（{{ item.before }} → {{ item.after }}）· {{ item.path }}</p></details></li></ul></section>
      <section v-if="resourceTab==='changes' && (store.catalog?.skillSources ?? []).some(source=>source.changes)" class="taxonomy-note"><strong>自定义来源扫描变化</strong><ul><li v-for="source in (store.catalog?.skillSources ?? []).filter(source=>source.changes)" :key="source.id"><span><code>{{ source.path }}</code> · {{ timeLabel(source.scannedAt) }}</span><small>{{ source.changes!.baseline ? '已建立变化基线' : `最近变化：新增 ${source.changes!.added.length}、移除 ${source.changes!.removed.length}、修改 ${source.changes!.modified.length}` }}{{ source.changes!.truncated ? '（列表有截断）' : '' }}</small><el-button text size="small" @click="resourceTab='sources'">查看来源</el-button></li></ul><p><small>这里只汇总扫描结果；重扫、监听等来源操作在“来源与扫描”页签进行。</small></p></section>
      <section v-for="source in resourceTab==='sources' ? store.catalog?.skillSources ?? [] : []" :key="source.id" class="taxonomy-note source-report">
        <div class="source-head">
          <div>
            <strong>{{ source.path }}</strong>
            <small>扫描时间：{{ timeLabel(source.scannedAt) }} · {{ source.report ? `${source.report.findings.filter(finding => finding.status !== 'skipped').length} 项资源 · ${source.report.status==='complete'?'扫描完整':source.report.status==='partial'?'扫描部分完成':'扫描失败'}` : '尚未扫描' }} · {{ source.mode==='quick'?'快速':'深度' }}扫描</small>
            <small>自动更新：{{ source.watchStatus==='watching'?'已开启（仅此目录）':source.watchStatus==='unsupported'?'平台不支持':source.watchStatus==='root-changed'?'目录已变化':source.watchStatus==='error'?'监听错误':'已关闭（仅自定义目录可监听）' }}<template v-if="source.watchError"> · {{ source.watchError }}</template></small>
            <small v-if="source.report?.truncatedAt && !source.report.continuationPath" class="continuation-note">该截断项不是可独立扫描的目录入口；请另行登记其中明确的子目录。</small>
          </div>
          <div class="source-actions">
            <el-switch :model-value="source.watchEnabled" :disabled="source.watchStatus==='unsupported'" :aria-label="`${source.path} 自动更新`" @change="toggleSourceWatch(source.id, Boolean($event))" />
            <el-button text :loading="sourceBusy" @click="rescanSource(source.id)">重新扫描</el-button>
            <el-button v-if="source.report?.continuationPath" text :loading="sourceBusy" @click="scanFindingTarget(source.report.continuationPath, false)">继续扫描</el-button>
            <el-dropdown trigger="click"><button class="row-menu icon-btn" :aria-label="`${source.path}更多操作`">⋯</button><template #dropdown><el-dropdown-menu><el-dropdown-item v-if="source.mode==='quick'" @click="scanFindingTarget(source.path,source.followLinks)">改用深度扫描</el-dropdown-item><el-dropdown-item @click="rescanSource(source.id,true)">强制完整扫描</el-dropdown-item><el-dropdown-item @click="copyResourcePath(source.path)">复制路径</el-dropdown-item><el-dropdown-item title="取消登记不删除目录和文件" @click="removeSource(source.id)">取消登记（不删除文件）</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
          </div>
        </div>
        <details v-if="source.report"><summary>扫描报告详情（深度、限额、缓存复用与诊断）</summary><small>入口 {{ source.report.rootPath }} · 最大深度 {{ source.report.limits.maxDepth }} · 候选 {{ source.report.candidateCount }} · 识别 {{ source.report.recognizedCount }} · 跳过 {{ source.report.skippedCount }} · 访问 {{ source.report.visitedDirectories }}/{{ source.report.limits.maxDirectories }} 个目录 · manifest {{ Math.round(source.report.limits.maxManifestBytes/1024/1024) }} MiB · frontmatter {{ Math.round(source.report.limits.maxFrontmatterBytes/1024) }} KiB{{ source.report.truncatedAt ? ` · 截断位置 ${source.report.truncatedAt}` : '' }}</small><small>解析缓存：本次复用 {{ source.report.cache?.reused ?? 0 }} / 读取 {{ source.report.cache?.read ?? '旧索引' }}；缓存仅在本服务进程内有效。</small><p v-for="message in source.report.diagnostics ?? []" :key="message">{{ message }}</p></details>
        <details v-if="source.changes && !source.changes.baseline"><summary>变化明细（最多 100 条）</summary><p v-for="value in source.changes.added" :key="`added-${value}`">新增：{{ value }}</p><p v-for="value in source.changes.removed" :key="`removed-${value}`">移除：{{ value }}</p><p v-for="value in source.changes.modified" :key="`modified-${value}`">manifest 内容变化：{{ value }}</p></details>
        <p v-if="source.report?.status==='failed'" class="detail-issue">来源失效或无法读取：请核对路径与权限后重扫；新位置需要显式登记。</p><p v-if="source.report?.truncatedAt" class="detail-issue">目录未覆盖：本次达到扫描边界；可使用有效续扫入口，或登记更具体目录，强制扫描仍有上限。</p>
        <details v-if="source.report?.findings.length"><summary>扫描明细（{{ source.report.findings.length }}）</summary><ul><li v-for="finding in source.report.findings" :key="finding.logicalPath"><code>{{ finding.logicalPath }}</code> · {{ finding.status==='recognized'?'已识别':finding.status==='candidate'?'格式异常':'被跳过' }} · {{ finding.reason }}<small v-if="finding.status==='candidate'">请检查 SKILL.md 格式后重扫；AgentDeck 不修改文件。</small><small v-if="finding.logicalPath!==finding.actualPath">链接边界：仅显式登记范围内按选项跟随，范围外需单独登记。</small><small v-if="finding.actualPath!==finding.logicalPath">实际路径：{{ finding.actualPath }}</small><el-button v-if="finding.status!=='skipped'" text size="small" @click="copyResourcePath(finding.actualPath)">复制路径</el-button><el-button v-if="finding.status==='recognized'" text size="small" @click="openResourceDirectory({kind:'source',sourceId:source.id,findingPath:finding.logicalPath})">打开目录</el-button><el-button v-if="finding.status!=='skipped'" text size="small" @click="showSkillDetails({sourceId:source.id,findingPath:finding.logicalPath})">查看详情</el-button><el-button v-if="finding.status!=='skipped'" text size="small" :loading="sourceBusy" @click="scanFindingTarget(finding.logicalPath.replace(/[\\/]SKILL\.md$/i, ''), false)">进一步扫描此目录</el-button><el-button v-if="finding.status==='skipped' && finding.actualPath!==finding.logicalPath" text size="small" :loading="sourceBusy" @click="scanFindingTarget(finding.actualPath, true)">进一步扫描该目标</el-button></li></ul></details>
      </section>
      <template v-if="resourceTab==='library'">
      <section v-if="searchText.trim().length >= 2" class="taxonomy-note skill-search-results" aria-label="Skill 内容搜索"><strong>统一搜索</strong><small v-if="searchBusy">正在搜索说明、作者、依赖和正文…</small><small v-if="searchError" class="detail-issue">{{ searchError }}</small><small v-if="searchReport">已检查 {{ searchReport.examined }}/{{ searchReport.totalCandidates }} 条资源 · 未能检查 {{ searchReport.failures }} 条{{ searchReport.truncated ? ' · 当前页有界，继续加载可检查后续资源。' : '' }}</small><small v-if="!searchBusy && !skillMatches.length && searchReport && !searchReport.truncated">已检查范围内没有命中。</small><small v-else-if="!searchBusy && !skillMatches.length && searchReport?.truncated">当前范围尚未查完，仍有后续候选。</small><el-button v-if="searchReport?.nextOffset !== null && searchReport?.nextOffset !== undefined" :loading="searchBusy" @click="loadMoreSkillMatches">继续搜索后续资源</el-button><el-button v-if="hiddenSearchHitCount" data-testid="include-hidden-search" @click="setDisplayPolicy({ showBuiltin: true, showCacheOnly: true })">包含隐藏资源搜索（{{ hiddenSearchHitCount }} 项被隐藏）</el-button></section>
      <div v-if="staleFavoriteCount" class="taxonomy-note" data-testid="stale-favorites"><el-icon><InfoFilled /></el-icon>有 {{ staleFavoriteCount }} 个收藏引用已失效，资源不再存在或未被当前扫描发现；它们不会自动改指其他资源。</div>
      <div v-if="hiddenFavoriteCount && favoritesOnly" class="taxonomy-note" data-testid="hidden-favorites"><el-icon><InfoFilled /></el-icon>有 {{ hiddenFavoriteCount }} 个收藏资源被显示选项隐藏；它们并没有失效。<button v-if="hiddenCounts.builtin && !policy.showBuiltin" class="plan-link" @click="setDisplayPolicy({ showBuiltin: true })">显示内置</button><button v-if="hiddenCounts.cacheOnly && !policy.showCacheOnly" class="plan-link" @click="setDisplayPolicy({ showCacheOnly: true })">显示仅缓存</button></div>
      <div v-if="independentExcluded" class="taxonomy-note independent-note" data-testid="independent-excluded"><el-icon><InfoFilled /></el-icon>独立来源未绑定客户端，仅在“全部客户端 + 全部范围”下显示；当前范围排除了它们。<el-button text data-testid="view-independent" @click="viewIndependentSources">查看独立来源</el-button></div>
      <div ref="filterElement" class="filter-row">
        <div class="toolbar-line toolbar-main">
          <div class="tabs"><button v-for="tab in [{id:'all',label:'全部'},{id:'skill',label:'Skill'},{id:'plugin',label:'插件'},{id:'mcp',label:'MCP'}]" :key="tab.id" :class="{selected:kindFilter===tab.id}" :aria-label="tab.label" @click="kindFilter=tab.id as 'all'|'skill'|'plugin'|'mcp'">{{ tab.label }}<small>{{ tabCounts[tab.id] }}</small></button></div>
          <div class="toolbar-tools">
            <el-input v-model="searchText" clearable placeholder="搜索名称、路径、描述或正文" aria-label="搜索资源" class="search-input"><template #prefix><el-icon><Search /></el-icon></template></el-input>
            <el-checkbox v-model="favoritesOnly" class="favorites-toggle">只看收藏</el-checkbox>
            <el-popover trigger="click" width="280" popper-class="saved-views-popper"><template #reference><el-button data-testid="saved-views" :aria-label="`已保存视图（${store.resourcePreferences.savedFilters.length}）`">已保存视图<el-icon class="el-icon--right"><CaretBottom /></el-icon></el-button></template>
              <div class="saved-views-menu" role="menu" aria-label="已保存视图菜单">
                <button class="saved-view-save" @click="saveCurrentFilter">保存当前视图</button>
                <p v-if="!store.resourcePreferences.savedFilters.length" class="saved-views-empty">还没有已保存视图；调整条件后点击上方按钮保存。</p>
                <div v-for="item in store.resourcePreferences.savedFilters" :key="item.id" class="saved-view-row">
                  <button class="saved-view-apply" :class="{current: savedFilterId===item.id}" @click="applySavedFilter(item.id)">{{ item.name }}{{ savedFilterId===item.id ? '（当前）' : '' }}</button>
                  <button class="saved-view-delete" :aria-label="`删除视图 ${item.name}`" title="删除此视图" @click="deleteSavedFilter(item.id)">×</button>
                </div>
              </div>
            </el-popover>
          </div>
        </div>
        <div class="toolbar-line skill-filters">
          <el-select v-model="libraryInstanceId" data-testid="library-client-filter" clearable placeholder="关联客户端：全部" aria-label="关联客户端" :disabled="!store.instances.length"><el-option v-for="i in store.instances" :key="i.id" :value="i.id" :label="`${agentName(i.agentId)} · ${i.name}`"/></el-select>
          <el-select v-model="projectScopeSelection" data-testid="library-project-scope" aria-label="项目范围" :disabled="!store.projects.length && libraryProjectScope==='all'" class="project-scope-select"><el-option label="全部范围" value="all"/><el-option label="仅全局" value="global-only"/><el-option v-for="p in store.projects" :key="p.id" :label="`项目：${p.name}`" :value="p.id"/></el-select>
          <el-checkbox v-if="libraryProjectScope!=='all' && libraryProjectScope!=='global-only'" v-model="libraryIncludeGlobal" data-testid="include-global-switch">包含全局资源</el-checkbox>
          <el-select v-model="sourceFilter" data-testid="resource-source-filter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源来源"><el-option label="独立来源" value="independent"/><el-option label="用户自建 / 导入" value="user"/><el-option label="项目仓库提供" value="repository"/><el-option label="插件附带" value="plugin"/><el-option label="Agent 内置" value="builtin"/><el-option label="组织管理" value="organization"/><el-option label="账号同步" value="account-sync"/><el-option label="来源未知" value="unknown"/></el-select>
          <el-select v-model="configurationFilter" data-testid="configuration-state-filter" aria-label="配置状态" multiple collapse-tags clearable placeholder="配置状态"><el-option label="已启用" value="on"/><el-option label="已禁用" value="off"/><el-option label="未确定" value="unknown"/></el-select>
          <el-popover trigger="click" width="260" popper-class="display-options-popper"><template #reference><el-button data-testid="display-options" :aria-label="`显示选项${displayOptionsMark || '（内置与仅缓存默认隐藏）'}`">显示选项{{ displayOptionsMark }}<el-icon class="el-icon--right"><CaretBottom /></el-icon></el-button></template>
            <div class="display-options-menu" data-testid="display-policy" role="menu" aria-label="显示选项菜单">
              <el-checkbox data-testid="show-builtin-switch" :model-value="policy.showBuiltin" @change="setDisplayPolicy({ showBuiltin: Boolean($event) })">显示 Agent 内置资源</el-checkbox>
              <el-checkbox data-testid="show-cache-only-switch" :model-value="policy.showCacheOnly" @change="setDisplayPolicy({ showCacheOnly: Boolean($event) })">显示仅缓存资源</el-checkbox>
              <small v-if="hiddenCounts.builtin || hiddenCounts.cacheOnly">当前范围隐藏：内置 {{ hiddenCounts.builtin }} 项、仅缓存 {{ hiddenCounts.cacheOnly }} 项（两类可能重叠）。</small>
              <small v-else>当前范围没有因这两项偏好隐藏的资源。</small>
            </div>
          </el-popover>
        </div>
      </div>
      <div v-if="activeFilterChips.length" class="active-filters" aria-label="已选筛选条件"><span class="active-filters-label">已选筛选</span><button v-for="chip in activeFilterChips" :key="chip.group + ':' + chip.value" class="filter-chip" :title="'移除条件：' + chip.label" @click="removeFilterChip(chip.group, chip.value)">{{ chip.label }}<el-icon><Close /></el-icon></button><button class="filter-chip clear-all" @click="clearFilters">清除筛选</button></div>
      <div v-if="visible.length" class="table-scroll"><table class="resource-table"><thead><tr><th scope="col">资源</th><th scope="col">来源</th><th scope="col">关联 Agent / 项目</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>
        <tr v-for="entity in pagedEntities" :key="entity.key" :class="[`entity-${entity.kind}`,{ 'entity-row': true }]" @click="openEntity(entity)"><td>
          <div class="resource-cell">
            <i class="kind-icon" :class="entity.kind"><el-icon><component :is="entity.kind==='skill'?Document:entity.kind==='plugin'?Box:Connection"/></el-icon></i>
            <div class="resource-copy"><div class="resource-title"><button class="resource-detail-link" :title="entity.name" @click.stop="openEntity(entity)">{{ entity.name }}</button><button class="plan-link" :aria-label="isFavoriteEntity(entity)?'取消收藏':'收藏资源'" @click.stop="toggleEntityFavorite(entity)">{{ isFavoriteEntity(entity)?'★':'☆' }}</button>
              <span v-if="entity.independentOnly" class="version-badge">独立来源</span><span v-else-if="entity.publicResource" class="version-badge">公共资源</span>
              <span v-if="entity.fromPlugin" class="version-badge">来自插件 {{ entity.fromPlugin }}</span>
              <span v-if="entity.builtin" class="version-badge">Agent 内置</span>
              <span v-if="entity.cacheOnly" class="version-badge">仅缓存</span>
              <span v-if="!entity.independentOnly && entity.visibleBindings.length && entity.visibleBindings.every(diskOnly)" class="inventory-badge">仅磁盘发现</span>
              <span v-if="entity.sameNameKeys.length" class="version-badge" :title="`另有 ${entity.sameNameKeys.length} 个同名资源位于不同目录`">同名副本</span>
            </div><small :title="entityDescription(entity)">{{ entityDescription(entity) }}</small><small v-if="entityContentHit(entity)" class="search-snippet">元数据/正文命中：{{ entityContentHit(entity) }}</small></div>
          </div>
        </td>
          <td class="classification-cell"><span class="tag source">{{ entitySourceLabel(entity) }}</span><small v-if="entityOriginSummary(entity)" class="origin-detail">{{ entityOriginSummary(entity) }}</small></td>
          <td class="agent-cell"><span>{{ entityAgents(entity) }}</span><small>{{ entityProjects(entity) }}</small></td>
          <td><span class="config-state" :class="entityStatus(entity).tone" :title="entityStatus(entity).reason"><i></i>{{ entityStatus(entity).label }}</span><el-tooltip v-if="entityDiagnostics(entity)" :content="entityDiagnostics(entity)"><el-icon class="notice"><InfoFilled/></el-icon></el-tooltip></td>
          <td @click.stop><span class="actions-group">
            <template v-if="entitySingleControl(entity)">
              <el-switch :model-value="entitySingleControl(entity)!.enabled===true" :disabled="actionBusy" :loading="actionBusy" :aria-label="`${entity.name}启停`" @change="toggleBinding(entitySingleControl(entity)!,Boolean($event))"/>
              <el-button text class="preview-button" :disabled="actionBusy" data-testid="preview-toggle" @click="planToggle(entitySingleControl(entity)!,entitySingleControl(entity)!.enabled!==true)">预览修改</el-button>
            </template>
            <button v-else class="plan-link manage-bindings" @click="openEntity(entity)">{{ entity.visibleBindings.length>1 ? `管理配置（${entity.visibleBindings.length}）` : entity.kind==='skill' ? '查看详情' : '查看关联配置' }}</button>
            <el-dropdown v-if="entityOpenReference(entity)" trigger="click"><button class="row-menu icon-btn" :aria-label="`${entity.name}更多操作`">⋯</button><template #dropdown><el-dropdown-menu><el-dropdown-item v-if="entity.kind==='skill'" @click="toggleCompare(entityRepresentativeReference(entity))">加入对比</el-dropdown-item><el-dropdown-item @click="copyResourcePath(entityPath(entity))">复制路径</el-dropdown-item><el-dropdown-item @click="openResourceDirectory(entityOpenReference(entity)!)">打开目录</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
          </span></td></tr>
      </tbody></table></div>
      <div v-else-if="!store.bindings.length && !independentSkillRecordCount" class="empty"><i><el-icon><Box/></el-icon></i><b>还没有可显示的资源</b><span>{{ store.instances.length ? '已登记实例尚未发现资源，可重新扫描或发现本机客户端。' : '尚未接入本机配置。开发模式默认使用隔离目录；点击下方按钮发现本机客户端并只读扫描用户级配置。' }}</span><div><el-button type="primary" :loading="actionBusy" @click="discoverClients"><el-icon><Search/></el-icon>发现客户端</el-button><el-button @click="resourceTab='sources'">添加 Skill 目录</el-button><el-button v-if="!store.instances.length&&!store.projects.length" :loading="actionBusy" @click="demo">载入隔离演示数据</el-button></div></div>
      <div v-else class="empty-filter"><el-icon><Search/></el-icon>当前筛选或显示策略没有匹配项<el-button text @click="clearFilters">清除筛选</el-button><el-button v-if="hiddenCounts.builtin || hiddenCounts.cacheOnly" text @click="setDisplayPolicy({ showBuiltin: true, showCacheOnly: true })">显示内置与仅缓存资源</el-button></div>
<el-pagination v-if="visible.length>pageSize" v-model:current-page="resourcePage" :page-size="pageSize" :total="visible.length" layout="prev, pager, next, total" aria-label="资源记录分页" />
      </template>
    </div>
    <footer class="panel-footer"><span>当前筛选匹配 {{ visible.length }} 个资源 · 关联 {{ associatedBindingCount }} 条配置绑定 · 目录绑定 {{ store.bindings.length }} 条 / 独立 {{ independentSkillRecordCount }} 条资源记录 <template v-if="store.catalog?.lastScanAt">· 最近成功扫描 {{ timeLabel(store.catalog.lastScanAt) }}</template></span><span><i :class="eventStatus"></i>{{ eventStatus==='connected'?'实时事件已连接':eventStatus==='connecting'?'连接实时事件…':'事件通道离线' }}</span></footer>
  </section>
  <el-dialog v-model="compareOpen" title="Skill 对比" width="min(1100px, 94vw)" :close-on-click-modal="false" destroy-on-close><el-skeleton v-if="compareBusy" :rows="5" animated/><p v-if="compareError" class="detail-issue">{{ compareError }}</p><template v-if="compareResult"><p>同一物理 manifest：{{ compareResult.samePhysicalSource?'是':'否' }} · 名称相同：{{ compareResult.sameName?'是':'否' }} · manifest 内容相同：{{ compareResult.manifestIdentical?'是':'否' }} · 正文相同：{{ compareResult.bodyEqual?'是':'否' }}</p><p class="detail-issue">manifest 相同只比较 SKILL.md 内容，不代表整个 Skill 包相同。{{ compareResult.bodyTruncated?'正文比较在 20,000 字符处截断。':'' }}</p><p>{{ compareResult.left.name }} ↔ {{ compareResult.right.name }} · {{ comparisonLines.filter(line=>line.changed).length }} 行差异（按行位置比较）<el-button @click="moveDifference(-1)">上一处差异</el-button><el-button @click="moveDifference(1)">下一处差异</el-button></p><small>作者/版本：{{ compareResult.left.author ?? '未声明' }} / {{ compareResult.right.author ?? '未声明' }} ↔ {{ compareResult.left.description }} / {{ compareResult.right.description }} · {{ compareResult.left.path }} / {{ compareResult.right.path }}</small><p v-if="comparisonLines.length>=2000">行显示最多 2,000 行，剩余内容未展示。</p><div class="line-diff"><div v-for="(line,index) in comparisonLines" :id="`diff-line-${index}`" :key="index" :class="{changed:line.changed}"><span>{{ index+1 }}</span><pre>{{ line.left }}</pre><pre>{{ line.right }}</pre></div></div></template><template #footer><el-button @click="compareOpen=false">关闭</el-button></template></el-dialog>
  <el-dialog v-model="detailsOpen" title="Skill 详情" width="min(900px, 92vw)" :close-on-click-modal="false" destroy-on-close>
    <el-skeleton v-if="detailsBusy && !details && !detailsError" :rows="6" animated />
    <div v-if="detailsError" class="taxonomy-note">{{ detailsError }}</div>
    <div v-else-if="details" class="skill-detail-body"><h3>{{ details.name }}</h3><p class="detail-path"><b>路径：</b><code>{{ currentDetailPath() }}</code></p><p><b>描述：</b>{{ details.description ?? '未声明' }}</p><p><b>作者：</b>{{ details.author ?? '未声明' }} · <b>版本：</b>{{ details.version ?? '未声明' }} · <b>许可证：</b>{{ details.license ?? '未声明' }}</p><p><b>环境要求：</b>{{ details.environment ?? '未声明' }}</p><p><b>调用方式：</b>{{ details.invocation ?? '未声明' }}</p><p><b>工具依赖：</b>{{ details.dependencies.length ? details.dependencies.join('、') : '未声明' }}</p><p><b>支持文件：</b>{{ details.supports.length ? details.supports.join('、') : '未发现支持文件' }}</p><p class="detail-issue">manifest 格式：{{ details.formatStatus === 'valid' ? '有效' : '异常' }} · 客户端运行时加载：未知</p><p v-for="line in detailEvidence" :key="line" class="detail-evidence">{{ line }}</p><p v-for="issue in details.metadataIssues" :key="issue" class="detail-issue">{{ issue }}</p><div class="markdown-tools"><h4>Markdown 正文预览</h4><el-button text @click="showRawMarkdown=!showRawMarkdown">{{ showRawMarkdown ? '显示安全渲染' : '查看原文' }}</el-button></div><pre v-if="showRawMarkdown" class="markdown-source">{{ details.body || '（正文为空）' }}</pre><SkillMarkdown v-else id="skill-markdown-preview" :source="details.body" /></div>
    <section v-if="detailResourceRef?.kind==='binding'" class="binding-evidence"><h4>配置、权限与来源证据</h4><BindingDrawer /></section>
    <section v-if="detailEntity && (detailEntity.bindings.length>1 || detailEntity.findings.length)" class="binding-evidence"><h4>同一资源的其他关联记录</h4><div v-for="binding in detailEntity.bindings.filter(item=>item.id!==(detailResourceRef?.kind==='binding'?detailResourceRef.bindingId:''))" :key="binding.id" class="plan-path"><b>{{ binding.kind.toUpperCase() }} · {{ binding.displayName ?? binding.name }}</b><span class="config-state" :class="configurationState(binding).tone">{{ configurationState(binding).label }}</span><code>{{ binding.sourcePath }}</code><small>{{ agentName(binding.classification?.discoveredByAgentId ?? 'unknown') }} 发现 · {{ originLabel(binding) || '来源类型未知' }}</small></div><div v-for="finding in detailEntity.findings" :key="finding.sourceId + finding.findingPath" class="plan-path"><b>独立发现 · {{ finding.name }}</b><small>{{ finding.status==='recognized'?'已识别':'格式异常候选' }}</small><code>{{ finding.findingPath }}</code></div><p><small>聚合仅为展示；每条绑定与发现入口仍分别定位，操作不合并。</small></p></section>
    <template #footer><el-button v-if="detailResourceRef" @click="copyResourcePath(currentDetailPath())">复制路径</el-button><el-button v-if="detailResourceRef" @click="openResourceDirectory(detailResourceRef)">打开目录</el-button><el-button @click="detailsOpen=false;details=null;detailResourceRef=null;detailEntity=null">关闭</el-button></template>
  </el-dialog>
  <el-dialog v-model="entityDetailOpen" :title="detailEntity?.kind==='plugin' ? '插件详情' : 'MCP 服务详情'" width="min(900px, 92vw)" :close-on-click-modal="false" destroy-on-close>
    <EntityDetail v-if="detailEntity && (detailEntity.kind==='plugin' || detailEntity.kind==='mcp')" :entity="detailEntity" @open-finding="openFinding" />
    <template #footer><el-button @click="entityDetailOpen=false;detailEntity=null">关闭</el-button></template>
  </el-dialog>
</template>
