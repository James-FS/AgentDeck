import { computed } from 'vue';
import type { ResourceReference } from '@agentdeck/contracts';
import { deriveEntities, entityStatus, type EntityFinding, type ResourceEntity } from '../resource-entities';
import { defaultDisplayPolicy, type DisplayPolicy } from '../resource-visibility';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';

export function useResourceRows(options: { global?: boolean } = {}) {
  const store = useAppStore();
  const ui = useUiStore();
  // Global consumers (overview stats) ignore the library's client/scope filters;
  // the library itself reads them from the UI store's browsing state.
  const globalScope = options.global === true;
  const clientScoped = computed(() => globalScope
    ? store.bindings
    : store.bindings.filter(item => !ui.libraryInstanceId || item.instanceId === ui.libraryInstanceId));
  const scoped = computed(() => {
    if (globalScope) return clientScoped.value;
    // Project scope semantics: "all" keeps every record under the client filter;
    // "global-only" requires reliable user-global scope evidence — a null projectId
    // alone never counts as global. A specific project shows that project's records,
    // plus user-global records when "include global" stays checked.
    if (ui.libraryProjectScope === 'global-only') return clientScoped.value.filter(item => item.scope === 'user-global');
    if (ui.libraryProjectScope === 'project') {
      return clientScoped.value.filter(item =>
        (item.projectId !== null && item.projectId === ui.libraryProjectId)
        || (ui.libraryIncludeGlobal && item.scope === 'user-global'));
    }
    return clientScoped.value;
  });
  const scopedById = computed(() => new Map(scoped.value.map(binding => [binding.id, binding])));
  // Independent sources stay unbound and therefore only appear in the
  // all-clients + all-scope library; any narrower context excludes them.
  const independentExcluded = computed(() => !globalScope && (Boolean(ui.libraryInstanceId) || ui.libraryProjectScope !== 'all'));
  const independentFindings = computed<EntityFinding[]>(() => {
    if (independentExcluded.value) return [];
    const findings: EntityFinding[] = [];
    for (const source of store.catalog?.skillSources ?? []) {
      for (const finding of source.report?.findings ?? []) {
        if (finding.status !== 'recognized' && finding.status !== 'candidate') continue;
        findings.push({ sourceId: source.id, findingPath: finding.logicalPath, name: finding.name,
          description: finding.description, status: finding.status, reason: finding.reason,
          ...(finding.contentHash ? { contentHash: finding.contentHash } : {}), actualPath: finding.actualPath });
      }
    }
    return findings;
  });
  const policy = computed<DisplayPolicy>(() => store.resourcePreferences.display ?? defaultDisplayPolicy);
  const collection = computed(() => deriveEntities({
    bindings: scoped.value, findings: independentFindings.value, policy: policy.value,
  }));
  // Full aggregation with both display switches on, used to map search hits onto
  // policy-hidden entities and to count what each switch would reveal.
  const unfilteredCollection = computed(() => deriveEntities({
    bindings: scoped.value, findings: independentFindings.value, policy: { showBuiltin: true, showCacheOnly: true },
  }));
  async function setDisplayPolicy(patch: Partial<DisplayPolicy>): Promise<void> {
    await store.mutatePreferences(current => ({ ...current, display: { ...(current.display ?? defaultDisplayPolicy), ...patch } }));
  }
  // Unique resources in the current context under the display policy, before search,
  // favorites and ordinary filters. The same collection feeds type counts and pagination.
  const entities = computed(() => collection.value.entities);
  const hiddenCounts = computed(() => {
    let builtin = 0;
    let cacheOnly = 0;
    for (const entity of collection.value.entities) {
      // The two reasons can overlap on one entity (it then needs both switches);
      // each counter answers "what does enabling this switch reveal or still require".
      if (entity.builtin && !policy.value.showBuiltin) builtin += 1;
      if (entity.cacheOnly && !policy.value.showCacheOnly) cacheOnly += 1;
    }
    return { builtin, cacheOnly };
  });
  const stats = computed(() => {
    const visibleEntities = collection.value.entities;
    return {
      all: visibleEntities.length,
      skills: visibleEntities.filter(entity => entity.kind === 'skill').length,
      plugins: visibleEntities.filter(entity => entity.kind === 'plugin').length,
      mcps: visibleEntities.filter(entity => entity.kind === 'mcp').length,
      diagnostics: scoped.value.reduce((n, b) => n + b.diagnostics.length, 0) + store.instances.reduce((n, i) => n + i.diagnostics.length, 0),
    };
  });
  const tabCounts = computed(() => ({ all: stats.value.all, skill: stats.value.skills, plugin: stats.value.plugins, mcp: stats.value.mcps }));

  function entityFavoriteRefs(entity: ResourceEntity): ResourceReference[] {
    return [
      ...entity.visibleBindings.map((binding): ResourceReference => ({ kind: 'binding', bindingId: binding.id })),
      ...entity.findings.map((finding): ResourceReference => ({ kind: 'source', sourceId: finding.sourceId, findingPath: finding.findingPath })),
    ];
  }
  function isFavoriteEntity(entity: ResourceEntity): boolean {
    const refs = entity.visibleBindings.length || entity.findings.length ? entityFavoriteRefs(entity) : entity.bindings.map((binding): ResourceReference => ({ kind: 'binding', bindingId: binding.id }));
    return store.resourcePreferences.favorites.some(favorite =>
      refs.some(reference => JSON.stringify(reference) === JSON.stringify(favorite)));
  }
  async function toggleEntityFavorite(entity: ResourceEntity): Promise<void> {
    const refs = entityFavoriteRefs(entity);
    const favorited = refs.filter(reference => store.resourcePreferences.favorites.some(item => JSON.stringify(item) === JSON.stringify(reference)));
    if (favorited.length) {
      // Clear every currently known associated reference so the entity does not
      // immediately reappear as favorited through another binding.
      const remove = new Set(favorited.map(reference => JSON.stringify(reference)));
      await store.mutatePreferences(current => ({ ...current, favorites: current.favorites.filter(item => !remove.has(JSON.stringify(item))) }));
      return;
    }
    // Add one certain, stable real reference: a real binding when present, otherwise the finding reference.
    const reference: ResourceReference = entity.visibleBindings[0]
      ? { kind: 'binding', bindingId: entity.visibleBindings[0]!.id }
      : { kind: 'source', sourceId: entity.findings[0]!.sourceId, findingPath: entity.findings[0]!.findingPath };
    await store.mutatePreferences(current => ({ ...current, favorites: [...current.favorites, reference] }));
  }

  // Independent findings only answer the retained filters; the legacy scope/owner/
  // category/origin conditions left the runtime matching entirely.
  function findingMatchesRecord(finding: EntityFinding, opts: { text: boolean }): boolean {
    if (ui.sourceFilter.length && !ui.sourceFilter.includes('independent')) return false;
    if (ui.configurationFilter.length && !ui.configurationFilter.includes('unknown')) return false;
    if (!opts.text) return true;
    const contentHit = ui.contentFindingKeys.includes(`${finding.sourceId}\n${finding.findingPath}`);
    const query = ui.searchText.trim().toLocaleLowerCase();
    return !query || `${finding.name} ${finding.description ?? ''} ${finding.findingPath} ${finding.reason ?? ''}`.toLocaleLowerCase().includes(query) || contentHit;
  }

  const recordFiltersActive = computed(() => Boolean(ui.configurationFilter.length || ui.sourceFilter.length || ui.searchText.trim()));

  const visible = computed<ResourceEntity[]>(() => entities.value.filter(entity => {
    if (ui.kindFilter !== 'all' && entity.kind !== ui.kindFilter) return false;
    if (ui.favoritesOnly && !isFavoriteEntity(entity)) return false;
    if (!recordFiltersActive.value) return true;
    if (entity.visibleBindings.some(binding => ui.matchesRecord(binding))) return true;
    if (entity.findings.some(finding => findingMatchesRecord(finding, { text: true }))) return true;
    // Entities without any context-visible record still match through their findings only.
    return false;
  }));

  const associatedBindingCount = computed(() => visible.value.reduce((total, entity) => total + entity.visibleBindings.length, 0));

  // Hidden entities whose name/record text or content hits match the current search.
  // Drives the explicit "include hidden resources" search entry; hidden records are
  // never listed directly, only counted.
  const hiddenSearchHitCount = computed(() => {
    const query = ui.searchText.trim().toLocaleLowerCase();
    if (!query && !ui.contentBindingIds.length && !ui.contentFindingKeys.length) return 0;
    const visibleKeys = new Set(entities.value.map(entity => entity.key));
    let count = 0;
    for (const entity of unfilteredCollection.value.entities) {
      if (visibleKeys.has(entity.key)) continue;
      const textHit = query && (`${entity.name} ${entity.description}`.toLocaleLowerCase().includes(query)
        || entity.bindings.some(binding => ui.matchesRecord(binding))
        || entity.findings.some(finding => findingMatchesRecord(finding, { text: true })));
      if (textHit) count += 1;
    }
    return count;
  });

  function entityRepresentativeReference(entity: ResourceEntity): ResourceReference {
    return entity.visibleBindings[0]
      ? { kind: 'binding', bindingId: entity.visibleBindings[0]!.id }
      : { kind: 'source', sourceId: entity.findings[0]!.sourceId, findingPath: entity.findings[0]!.findingPath };
  }

  return {
    scoped, scopedById, independentFindings, independentExcluded, policy, entities, visible, stats, tabCounts, hiddenCounts,
    unfilteredCollection, setDisplayPolicy, hiddenSearchHitCount,
    associatedBindingCount, isFavoriteEntity, toggleEntityFavorite, entityFavoriteRefs,
    entityRepresentativeReference, entityStatus, findingMatchesRecord,
  };
}
