import { defineStore } from 'pinia';
import type { Binding, ResourceKind } from '@agentdeck/contracts';
import { configurationState } from './configuration-state';
import { agentName, sourceLabel } from './labels';
import type { Page } from './navigation';
// Runtime use only (inside getters); the module cycle with store.ts is safe
// because both sides only call each other's stores inside functions.
import { useAppStore } from './store';

export type DrawerKind = 'instance' | 'project' | 'plan' | 'binding' | null;
export type LibraryProjectScope = 'all' | 'global-only' | 'project';

/**
 * Map a saved filter onto the current library scope fields. Old named filters have
 * no projectScope field: a saved projectId mapped to the old "project context"
 * which included user-global records (includeGlobal reads as true); no project
 * meant the full scope. A "project" scope without a project id falls back to all.
 */
export function savedFilterScope(filters: { projectId?: string | null; projectScope?: LibraryProjectScope; includeGlobal?: boolean }): { scope: LibraryProjectScope; includeGlobal: boolean } {
  const requested = filters.projectScope ?? (filters.projectId ? 'project' : 'all');
  return { scope: requested === 'project' && !filters.projectId ? 'all' : requested, includeGlobal: filters.includeGlobal ?? true };
}

export const legacyFilterLabels = { scope: '使用范围', owner: '所属 Agent', origin: '来源类型', category: '资源归类' } as const;
export type LegacyFilterField = keyof typeof legacyFilterLabels;

/**
 * The reduced library keeps only the client / project scope / source / state
 * filters. Legacy saved-view conditions that cannot be expressed any more are
 * reported for an explicit notice instead of silently running or expanding.
 * The exact legacy combination "user-global scope only, no specific project"
 * converts cleanly to the current "global-only" scope and is not reported.
 */
export function legacyScopeToProjectScope(scope: string[] | undefined, projectId: string | null | undefined): 'global-only' | null {
  return scope?.length === 1 && scope[0] === 'user-global' && !projectId ? 'global-only' : null;
}

export function droppedLegacyConditions(filters: { scope?: string[]; owner?: string[]; category?: string[]; origin?: string; projectId?: string | null; projectScope?: LibraryProjectScope }): LegacyFilterField[] {
  const dropped: LegacyFilterField[] = [];
  const scopePresent = Boolean(filters.scope?.length);
  const convertible = !filters.projectScope && legacyScopeToProjectScope(filters.scope, filters.projectId) !== null;
  if (scopePresent && !convertible) dropped.push('scope');
  if (filters.owner?.length) dropped.push('owner');
  if (filters.category?.length) dropped.push('category');
  if (filters.origin && filters.origin !== 'all') dropped.push('origin');
  return dropped;
}

// Cross-page UI state: navigation, drawers, resource selection and the resource
// library's browsing filters. The library client/scope fields belong to the
// resources page only: scans, overview, sources, changes and the availability
// form must not read them as a global working context. Catalog data itself lives
// in useAppStore; the built-in / cache-only display switches are persisted
// resource preferences (useAppStore.resourcePreferences.display).
export const useUiStore = defineStore('agentdeck-ui', {
  state: () => ({
    page: 'resources' as Page,
    drawer: null as DrawerKind,
    actionBusy: false,
    selectedBinding: null as Binding | null,
    selectedPublicMembers: [] as Binding[],
    selectedMcpMembers: [] as Binding[],
    kindFilter: 'all' as 'all' | ResourceKind,
    searchText: '',
    contentBindingIds: [] as string[],
    contentFindingKeys: [] as string[],
    scopeFilter: [] as string[],
    ownerAgentFilter: [] as string[],
    categoryFilter: [] as string[],
    sourceFilter: [] as string[],
    configurationFilter: [] as string[],
    originFilter: 'all' as 'all' | 'cache' | 'configuration' | 'filesystem' | '',
    favoritesOnly: false,
    // Library context: associated client and project scope. Empty id = all clients.
    libraryInstanceId: '',
    libraryProjectScope: 'all' as LibraryProjectScope,
    libraryProjectId: '',
    libraryIncludeGlobal: true,
  }),
  getters: {
    /**
     * Record-level matching without the type filter: type filtering happens on
     * entities. Only the four retained filters participate at runtime; the legacy
     * scope/owner/category/origin state stays neutral and never excludes records.
     */
    matchesRecord: (state) => (binding: Binding): boolean => {
      if (state.configurationFilter.length && !state.configurationFilter.includes(configurationState(binding).tone)) return false;
      const text = state.searchText.trim().toLocaleLowerCase();
      if (text && !state.contentBindingIds.includes(binding.id) && !`${binding.mcpService?.location ?? ''} ${binding.classification?.projectName ?? ''} ${binding.classification?.evidencePath ?? ''} ${binding.name} ${binding.displayName ?? ''} ${binding.discoveryPath ?? ''} ${binding.description} ${binding.nativeKey} ${binding.sourcePath} ${binding.pluginId ?? ''} ${binding.pluginVersion ?? ''} ${binding.marketplace ?? ''}`.toLocaleLowerCase().includes(text)) return false;
      if (state.sourceFilter.length && !state.sourceFilter.includes(binding.sourceKind)) return false;
      return true;
    },
    activeFilterChips: function (state): Array<{ group: string; value: string; label: string }> {
      const chips: Array<{ group: string; value: string; label: string }> = [];
      const store = useAppStore();
      if (state.libraryInstanceId) {
        const instance = store.instances.find(item => item.id === state.libraryInstanceId);
        chips.push({ group: 'client', value: state.libraryInstanceId, label: `客户端：${instance ? `${agentName(instance.agentId)} · ${instance.name}` : state.libraryInstanceId}` });
      }
      if (state.libraryProjectScope === 'global-only') chips.push({ group: 'projectScope', value: 'global-only', label: '仅全局资源' });
      else if (state.libraryProjectScope === 'project') {
        const project = store.projects.find(item => item.id === state.libraryProjectId);
        chips.push({ group: 'projectScope', value: state.libraryProjectId, label: `项目：${project?.name ?? state.libraryProjectId}` });
        if (!state.libraryIncludeGlobal) chips.push({ group: 'includeGlobal', value: 'off', label: '不含全局资源' });
      }
      if (state.kindFilter !== 'all') chips.push({group:'kind',value:state.kindFilter,label:state.kindFilter});
      if (state.searchText) chips.push({group:'search',value:state.searchText,label:`搜索：${state.searchText}`});
      if (state.favoritesOnly) chips.push({group:'favorites',value:'true',label:'只看收藏'});
      for (const value of state.configurationFilter) chips.push({ group: 'configurationState', value, label: value === 'on' ? '已启用' : value === 'off' ? '已禁用' : '未确定' });
      for (const value of state.sourceFilter) chips.push({ group: 'source', value, label: value === 'independent' ? '独立来源' : sourceLabel(value) });
      return chips;
    },
  },
  actions: {
    openBinding(binding: Binding) { this.selectedMcpMembers = []; this.selectedPublicMembers = []; this.selectedBinding = binding; this.drawer = 'binding'; },
    openInstanceForm() { this.drawer = 'instance'; },
    openProjectForm() { this.drawer = 'project'; },
    drawerVisibility(value: boolean) { if (!value) this.drawer = null; },
    /** Reset the library context (client + project scope) only; keeps ordinary filters and display preferences. */
    clearLibraryContext() {
      this.libraryInstanceId = ''; this.libraryProjectScope = 'all'; this.libraryProjectId = ''; this.libraryIncludeGlobal = true;
    },
    /** Explicit "view independent sources" action: resets client and scope, selects the independent source kind. */
    viewIndependentSources() {
      this.clearFilters();
      this.clearLibraryContext();
      this.sourceFilter = ['independent'];
    },
    clearFilters() {
      // The built-in / cache-only display switches are persisted preferences and
      // intentionally survive clearing ordinary filters. The legacy scope/owner/
      // category/origin fields reset to neutral values so no hidden condition
      // survives a clear.
      this.configurationFilter = []; this.kindFilter = 'all'; this.scopeFilter = []; this.ownerAgentFilter = [];
      this.categoryFilter = []; this.sourceFilter = []; this.originFilter = 'all'; this.searchText = '';
      this.favoritesOnly = false;
      this.clearLibraryContext();
    },
    removeFilterChip(group: string, value: string) {
      if (group === 'client') this.libraryInstanceId = '';
      else if (group === 'projectScope') { this.libraryProjectScope = 'all'; this.libraryProjectId = ''; this.libraryIncludeGlobal = true; }
      else if (group === 'includeGlobal') this.libraryIncludeGlobal = true;
      else if (group === 'kind') this.kindFilter = 'all';
      else if (group === 'search') this.searchText = '';
      else if (group === 'favorites') this.favoritesOnly = false;
      else if (group === 'configurationState') this.configurationFilter = this.configurationFilter.filter(item => item !== value);
      else if (group === 'source') this.sourceFilter = this.sourceFilter.filter(item => item !== value);
    },
  },
});
