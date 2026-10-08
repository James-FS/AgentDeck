import { computed } from 'vue';
import { mcpResourceIdentity, publicResourceIdentity, resourceRows } from '../resource-tree';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';

export function useResourceRows() {
  const store = useAppStore();
  const ui = useUiStore();

  const scoped = computed(() => store.bindings.filter((item) =>
    (!store.selectedInstanceId || item.instanceId === store.selectedInstanceId)
    && (!store.selectedProjectId || item.projectId === null || item.projectId === store.selectedProjectId)));
  const countedResources = computed(() => {
    const seen = new Set<string>();
    return scoped.value.filter(binding => {
      const key = mcpResourceIdentity(binding) ?? publicResourceIdentity(binding);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  const stats = computed(() => ({
    all: countedResources.value.length,
    skills: countedResources.value.filter((b) => b.kind === 'skill').length,
    plugins: countedResources.value.filter((b) => b.kind === 'plugin').length,
    mcps: countedResources.value.filter((b) => b.kind === 'mcp').length,
    diagnostics: scoped.value.reduce((n, b) => n + b.diagnostics.length, 0) + store.instances.reduce((n, i) => n + i.diagnostics.length, 0),
  }));
  const tabCounts = computed(() => ({ all: stats.value.all, skill: stats.value.skills, plugin: stats.value.plugins, mcp: stats.value.mcps }));
  const visible = computed(() => resourceRows(scoped.value, (binding, includePluginChildren) => ui.matches(binding, includePluginChildren), ui.expanded, ui.kindFilter));

  return { scoped, countedResources, stats, tabCounts, visible };
}
