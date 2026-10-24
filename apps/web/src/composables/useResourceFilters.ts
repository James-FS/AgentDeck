import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useUiStore } from '../ui-store';

// Thin accessor so components get reactive filter refs plus the shared matcher state
// without reaching into the UI store directly. The reduced library exposes only the
// four retained filters; the legacy scope/owner/category/origin state stays in the
// store as neutral fields for old saved-view compatibility and is not exposed here.

export function useResourceFilters() {
  const ui = useUiStore();
  const {
    kindFilter, searchText, sourceFilter, configurationFilter, favoritesOnly,
    libraryInstanceId, libraryProjectScope, libraryProjectId, libraryIncludeGlobal,
  } = storeToRefs(ui);
  const activeFilterChips = computed(() => ui.activeFilterChips);
  return {
    kindFilter, searchText, sourceFilter, configurationFilter, favoritesOnly,
    libraryInstanceId, libraryProjectScope, libraryProjectId, libraryIncludeGlobal,
    activeFilterChips,
    removeFilterChip: ui.removeFilterChip,
    clearFilters: ui.clearFilters,
    clearLibraryContext: ui.clearLibraryContext,
    viewIndependentSources: ui.viewIndependentSources,
  };
}
