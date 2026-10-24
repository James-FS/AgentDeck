import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from '../apps/web/node_modules/pinia/dist/pinia.mjs';
import type { Binding, Catalog } from '../packages/contracts/src/index';
import { droppedLegacyConditions, legacyScopeToProjectScope, savedFilterScope, useUiStore } from '../apps/web/src/ui-store';
import { useAppStore } from '../apps/web/src/store';
import { useResourceRows } from '../apps/web/src/composables/useResourceRows';

vi.mock('../apps/web/src/api', () => ({ api: {
  resourcePreferences: vi.fn().mockResolvedValue({ favorites: [], savedFilters: [] }),
  saveResourcePreferences: vi.fn(async value => value),
}, ApiFailure: class extends Error {} }));

function skill(id: string, extra: Partial<Binding> = {}): Binding {
  const value: Binding = { id, instanceId: 'zcode', projectId: null, name: id, kind: 'skill', scope: 'user-global', sourceKind: 'user', compatibilityClass: 'unknown',
    parentId: null, sourcePath: `C:/fixture/${id}`, nativeKey: id, enabled: true, writable: false, readOnlyReason: 'readonly', diagnostics: [], updatedAt: '', ...extra };
  value.classification = { category: 'user-global', scope: 'user-global', agentId: 'zcode', discoveredByAgentId: 'zcode', relationship: 'configured',
    projectName: null, projectRoot: null, evidencePath: value.sourcePath, reason: 'fixture', contentCompatibility: 'unknown', sourceIdentity: `phys-${id}`,
    location: { category: 'user-global', rootPath: 'C:/fixture', evidencePath: value.sourcePath, reason: 'fixture' } };
  return value;
}

function mcp(id: string, extra: Partial<Binding> = {}): Binding {
  return skill(id, { kind: 'mcp', scope: 'native', ...extra });
}

function projectSkill(id: string, projectId: string, extra: Partial<Binding> = {}): Binding {
  return skill(id, { projectId, scope: 'project', ...extra });
}

/** Unknown scope: project-level classification but no recorded project id. */
function unknownScopeSkill(id: string, extra: Partial<Binding> = {}): Binding {
  const value = skill(id, { scope: 'project', ...extra });
  value.classification!.scope = 'unknown';
  value.classification!.category = 'unknown';
  return value;
}

const catalogWith = (bindings: Binding[]): Catalog =>
  ({ instances: [{ id: 'zcode', agentId: 'zcode', name: 'ZCode Demo', configRoot: 'C:/fixture', writable: true, discovery: 'auto', checkedAt: '', version: null, executable: null, diagnostics: [] }],
    projects: [{ id: 'proj-1', name: 'Browser project', rootPath: 'C:/work/proj' }], bindings, lastScanAt: null }) as unknown as Catalog;

function library() {
  const store = useAppStore();
  const ui = useUiStore();
  const rows = useResourceRows();
  return { store, ui, rows, visible: computed(() => rows.visible.value.map(entity => entity.name)) };
}

beforeEach(() => { setActivePinia(createPinia()); });

describe('library project scope semantics', () => {
  it('keeps every record under all-scope and narrows reliably for global-only', () => {
    const { store, ui, visible } = library();
    store.setCatalog(catalogWith([
      skill('global-skill'), projectSkill('proj-skill', 'proj-1'), mcp('user-mcp'), unknownScopeSkill('mystery'),
    ]));
    expect(visible.value).toEqual(['global-skill', 'proj-skill', 'user-mcp', 'mystery']);
    ui.libraryProjectScope = 'global-only';
    expect(visible.value).toEqual(['global-skill']);
    ui.libraryProjectScope = 'all';
    // A null projectId alone never counts as global; unknown scope stays only in all-scope.
    expect(visible.value).toContain('mystery');
  });

  it('shows a specific project with user-global records only while include-global is on', () => {
    const { store, ui, visible } = library();
    store.setCatalog(catalogWith([
      skill('global-skill'), projectSkill('proj-skill', 'proj-1'), projectSkill('other-skill', 'proj-other'), mcp('user-mcp'), unknownScopeSkill('mystery'),
    ]));
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = 'proj-1';
    expect(visible.value).toEqual(['global-skill', 'proj-skill']);
    ui.libraryIncludeGlobal = false;
    expect(visible.value).toEqual(['proj-skill']);
  });

  it('combines the client filter with the scope on the same record', () => {
    const { store, ui, visible } = library();
    store.setCatalog(catalogWith([
      skill('zcode-global'), projectSkill('zcode-proj', 'proj-1'),
      skill('other-global', { instanceId: 'codex' }), projectSkill('other-proj', 'proj-1', { instanceId: 'codex' }),
    ]));
    ui.libraryInstanceId = 'zcode';
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = 'proj-1';
    // One binding must satisfy both the client and the scope conditions.
    expect(visible.value).toEqual(['zcode-global', 'zcode-proj']);
  });
});

describe('independent sources stay unbound to library context', () => {
  it('lists findings only in all-clients + all-scope and exposes the exclusion state', () => {
    const { store, ui, rows, visible } = library();
    store.setCatalog(catalogWith([skill('global-skill')]));
    store.catalog = { ...store.catalog!, skillSources: [{ id: 'src', path: 'C:/lib', mode: 'quick', followLinks: false, watchEnabled: false, watchStatus: 'off', scannedAt: '',
      report: { status: 'complete', rootPath: 'C:/lib', candidateCount: 0, recognizedCount: 1, skippedCount: 0, visitedDirectories: 1, truncatedAt: null, continuationPath: null,
        limits: { maxDepth: 8, maxDirectories: 500, maxManifestBytes: 1, maxFrontmatterBytes: 1 }, diagnostics: [],
        findings: [{ logicalPath: 'C:/lib/probe', actualPath: 'C:/lib/probe', name: 'probe', description: '', status: 'recognized', reason: '' }] } }] } as unknown as Catalog;
    expect(rows.independentExcluded.value).toBe(false);
    expect(visible.value).toContain('probe');
    ui.libraryInstanceId = 'zcode';
    expect(rows.independentExcluded.value).toBe(true);
    expect(rows.independentFindings.value).toEqual([]);
    ui.libraryInstanceId = '';
    ui.libraryProjectScope = 'global-only';
    expect(rows.independentFindings.value).toEqual([]);
    // The explicit action resets the context and selects the independent source kind.
    ui.viewIndependentSources();
    expect(ui.libraryInstanceId).toBe('');
    expect(ui.libraryProjectScope).toBe('all');
    expect(ui.sourceFilter).toEqual(['independent']);
    expect(visible.value).toContain('probe');
  });
});

describe('filter state actions', () => {
  it('clears library context and ordinary filters while keeping display preferences untouched', async () => {
    const { store, ui } = library();
    store.setCatalog(catalogWith([skill('global-skill')]));
    ui.libraryInstanceId = 'zcode';
    ui.libraryProjectScope = 'global-only';
    ui.searchText = 'x';
    ui.favoritesOnly = true;
    ui.sourceFilter = ['user'];
    await store.mutatePreferences(current => ({ ...current, display: { showBuiltin: true, showCacheOnly: false } }));
    ui.clearFilters();
    expect(ui.libraryInstanceId).toBe('');
    expect(ui.libraryProjectScope).toBe('all');
    expect(ui.libraryIncludeGlobal).toBe(true);
    expect(ui.searchText).toBe('');
    expect(ui.favoritesOnly).toBe(false);
    expect(ui.sourceFilter).toEqual([]);
    expect(store.resourcePreferences.display).toEqual({ showBuiltin: true, showCacheOnly: false });
  });

  it('removes client and scope chips individually', () => {
    const { ui } = library();
    ui.libraryInstanceId = 'zcode';
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = 'proj-1';
    ui.libraryIncludeGlobal = false;
    ui.removeFilterChip('client', 'zcode');
    expect(ui.libraryInstanceId).toBe('');
    ui.removeFilterChip('projectScope', 'proj-1');
    expect(ui.libraryProjectScope).toBe('all');
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = 'proj-1';
    ui.libraryIncludeGlobal = false;
    ui.removeFilterChip('includeGlobal', 'off');
    expect(ui.libraryIncludeGlobal).toBe(true);
    expect(ui.libraryProjectScope).toBe('project');
  });

  it('maps old and new saved filter contexts without hidden conditions', () => {
    // Old record: projectId only — the old project context included user-global records.
    expect(savedFilterScope({ projectId: 'proj-1' })).toEqual({ scope: 'project', includeGlobal: true });
    // Old record without project: full scope.
    expect(savedFilterScope({})).toEqual({ scope: 'all', includeGlobal: true });
    // New records carry explicit fields.
    expect(savedFilterScope({ projectScope: 'global-only', includeGlobal: false })).toEqual({ scope: 'global-only', includeGlobal: false });
    expect(savedFilterScope({ projectId: 'proj-1', projectScope: 'project', includeGlobal: false })).toEqual({ scope: 'project', includeGlobal: false });
    // Corrupt record: project scope without a project id falls back to all.
    expect(savedFilterScope({ projectScope: 'project' })).toEqual({ scope: 'all', includeGlobal: true });
  });

  it('clears library context when the referenced records disappear from the catalog', () => {
    const { store, ui } = library();
    store.setCatalog(catalogWith([skill('global-skill')]));
    ui.libraryInstanceId = 'zcode';
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = 'proj-1';
    store.setCatalog({ instances: [], projects: [], bindings: [], lastScanAt: null } as unknown as Catalog);
    expect(ui.libraryInstanceId).toBe('');
    expect(ui.libraryProjectId).toBe('');
    expect(ui.libraryProjectScope).toBe('all');
  });
});

describe('legacy saved-view conditions after filter reduction', () => {
  it('keeps the four technical fields neutral: they never filter at runtime', () => {
    const { store, ui, visible } = library();
    store.setCatalog(catalogWith([skill('global-skill'), mcp('user-mcp')]));
    ui.scopeFilter = ['project'];
    ui.ownerAgentFilter = ['codex'];
    ui.categoryFilter = ['agent-global'];
    ui.originFilter = 'cache';
    // Only the record-level text filter applies; the four legacy fields are inert.
    expect(visible.value).toEqual(['global-skill', 'user-mcp']);
    ui.clearFilters();
    expect(ui.scopeFilter).toEqual([]);
    expect(ui.ownerAgentFilter).toEqual([]);
    expect(ui.categoryFilter).toEqual([]);
    expect(ui.originFilter).toBe('all');
  });

  it('converts only the exact user-global + no-project legacy view to global-only', () => {
    expect(legacyScopeToProjectScope(['user-global'], null)).toBe('global-only');
    expect(legacyScopeToProjectScope(['user-global'], 'proj-1')).toBeNull();
    expect(legacyScopeToProjectScope(['project'], null)).toBeNull();
    expect(legacyScopeToProjectScope(['user-global', 'project'], null)).toBeNull();
    expect(legacyScopeToProjectScope([], null)).toBeNull();
    expect(legacyScopeToProjectScope(undefined, null)).toBeNull();
  });

  it('reports exactly the legacy conditions that cannot be executed any more', () => {
    expect(droppedLegacyConditions({})).toEqual([]);
    expect(droppedLegacyConditions({ scope: [], owner: [], category: [], origin: 'all' })).toEqual([]);
    // The exact user-global + no-project combination converts instead of being dropped.
    expect(droppedLegacyConditions({ scope: ['user-global'], projectId: null })).toEqual([]);
    // Project-level or multi-value scope conditions cannot be expressed: dropped with notice.
    expect(droppedLegacyConditions({ scope: ['project'], projectId: 'proj-1' })).toEqual(['scope']);
    expect(droppedLegacyConditions({ scope: ['user-global'], projectId: 'proj-1' })).toEqual(['scope']);
    expect(droppedLegacyConditions({ owner: ['codex'] })).toEqual(['owner']);
    expect(droppedLegacyConditions({ category: ['agent-global'] })).toEqual(['category']);
    expect(droppedLegacyConditions({ origin: 'cache' })).toEqual(['origin']);
    // user-global without a project converts (not dropped); with a project it cannot.
    expect(droppedLegacyConditions({ scope: ['user-global'], owner: ['codex'], category: ['agent-global'], origin: 'cache' }))
      .toEqual(['owner', 'category', 'origin']);
    expect(droppedLegacyConditions({ scope: ['user-global'], projectId: 'proj-1', owner: ['codex'] }))
      .toEqual(['scope', 'owner']);
    // New-style records with explicit projectScope never carry legacy scope semantics.
    expect(droppedLegacyConditions({ scope: ['user-global'], projectScope: 'project', projectId: 'proj-1' })).toEqual(['scope']);
  });
});
