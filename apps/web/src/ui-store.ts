import { defineStore } from 'pinia';
import type { Binding, ResourceKind } from '@agentdeck/contracts';
import { matchesClassification } from './classification';
import { configurationState } from './configuration-state';
import { agentName, categoryLabel, sourceLabel } from './labels';
import type { Page } from './navigation';

export type DrawerKind = 'instance' | 'project' | 'plan' | 'binding' | null;

const activeFilterLabels: Record<string, Record<string, string>> = {
  scope: { 'user-global': '用户全局', project: '项目级', 'project-directory': '项目子目录级', unknown: '使用范围未知' },
  owner: { shared: '共享来源（有证据）', unknown: '归属未知' },
  origin: { cache: '插件缓存', configuration: '配置记录', filesystem: '本地文件' },
};

// Cross-page UI state: navigation, drawers, resource selection and the resource filters.
// Catalog data itself lives in useAppStore.
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
    scopeFilter: [] as string[],
    ownerAgentFilter: [] as string[],
    categoryFilter: [] as string[],
    sourceFilter: [] as string[],
    configurationFilter: [] as string[],
    originFilter: 'all' as 'all' | 'cache' | 'configuration' | 'filesystem' | '',
    expanded: new Set<string>(),
  }),
  getters: {
    matches: (state) => (binding: Binding, includePluginChildren = false): boolean => {
      if (state.configurationFilter.length && !state.configurationFilter.includes(configurationState(binding).tone)) return false;
      if (!matchesClassification(binding, state.scopeFilter, state.ownerAgentFilter, state.categoryFilter)) return false;
      const text = state.searchText.trim().toLocaleLowerCase();
      if (text && !`${binding.mcpService?.location ?? ''} ${binding.classification?.projectName ?? ''} ${binding.classification?.evidencePath ?? ''} ${binding.name} ${binding.displayName ?? ''} ${binding.discoveryPath ?? ''} ${binding.description} ${binding.nativeKey} ${binding.sourcePath} ${binding.pluginId ?? ''} ${binding.pluginVersion ?? ''} ${binding.marketplace ?? ''}`.toLocaleLowerCase().includes(text)) return false;
      if (state.originFilter && state.originFilter !== 'all' && binding.origin !== state.originFilter) return false;
      if (state.sourceFilter.length && !state.sourceFilter.includes(binding.sourceKind)) return false;
      if (!includePluginChildren && state.kindFilter !== 'all' && binding.kind !== state.kindFilter) return false;
      return true;
    },
    activeFilterChips: (state): Array<{ group: string; value: string; label: string }> => {
      const chips: Array<{ group: string; value: string; label: string }> = [];
      for (const value of state.configurationFilter) chips.push({ group: 'configurationState', value, label: value === 'on' ? '已启用' : value === 'off' ? '已禁用' : '未确定' });
      for (const value of state.scopeFilter) chips.push({ group: 'scope', value, label: activeFilterLabels.scope[value] ?? value });
      for (const value of state.ownerAgentFilter) chips.push({ group: 'owner', value, label: activeFilterLabels.owner[value] ?? agentName(value) });
      for (const value of state.categoryFilter) chips.push({ group: 'category', value, label: categoryLabel(value) });
      for (const value of state.sourceFilter) chips.push({ group: 'source', value, label: sourceLabel(value) });
      if (state.originFilter && state.originFilter !== 'all') chips.push({ group: 'origin', value: state.originFilter, label: activeFilterLabels.origin[state.originFilter] ?? state.originFilter });
      return chips;
    },
  },
  actions: {
    openBinding(binding: Binding) { this.selectedMcpMembers = []; this.selectedPublicMembers = []; this.selectedBinding = binding; this.drawer = 'binding'; },
    openInstanceForm() { this.drawer = 'instance'; },
    openProjectForm() { this.drawer = 'project'; },
    drawerVisibility(value: boolean) { if (!value) this.drawer = null; },
    togglePlugin(id: string) { const next = new Set(this.expanded); if (next.has(id)) next.delete(id); else next.add(id); this.expanded = next; },
    clearFilters() {
      this.configurationFilter = []; this.kindFilter = 'all'; this.scopeFilter = []; this.ownerAgentFilter = [];
      this.categoryFilter = []; this.sourceFilter = []; this.originFilter = 'all'; this.searchText = '';
    },
    removeFilterChip(group: string, value: string) {
      if (group === 'configurationState') this.configurationFilter = this.configurationFilter.filter(item => item !== value);
      else if (group === 'scope') this.scopeFilter = this.scopeFilter.filter(item => item !== value);
      else if (group === 'owner') this.ownerAgentFilter = this.ownerAgentFilter.filter(item => item !== value);
      else if (group === 'category') this.categoryFilter = this.categoryFilter.filter(item => item !== value);
      else if (group === 'source') this.sourceFilter = this.sourceFilter.filter(item => item !== value);
      else if (group === 'origin') this.originFilter = '';
    },
  },
});
