import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useUiStore } from '../ui-store';

// Thin accessor so components get reactive filter refs plus the shared matcher state
// without reaching into the UI store directly.

export function useResourceFilters() {
  const ui = useUiStore();
  const {
    kindFilter, searchText, scopeFilter, ownerAgentFilter, categoryFilter, sourceFilter, configurationFilter, originFilter, expanded,
  } = storeToRefs(ui);
  const activeFilterChips = computed(() => ui.activeFilterChips);
  return {
    kindFilter, searchText, scopeFilter, ownerAgentFilter, categoryFilter, sourceFilter, configurationFilter, originFilter, expanded,
    activeFilterChips,
    removeFilterChip: ui.removeFilterChip,
    clearFilters: ui.clearFilters,
    togglePlugin: ui.togglePlugin,
  };
}
