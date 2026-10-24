import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Binding } from '../packages/contracts/src/index';
import { api } from '../apps/web/src/api';
import { useAppStore } from '../apps/web/src/store';
import { useUiStore } from '../apps/web/src/ui-store';
import { useResourceRows } from '../apps/web/src/composables/useResourceRows';

vi.spyOn(api, 'saveResourcePreferences').mockImplementation(async value => value);

function skill(id: string, extra: Partial<Binding> = {}): Binding {
  const value: Binding = { id, instanceId: 'zcode', projectId: null, name: 'shared', kind: 'skill', scope: 'user-global', sourceKind: 'user',
    compatibilityClass: 'unknown', parentId: null, sourcePath: 'C:/fixture/skills/shared', nativeKey: id, enabled: true, writable: false,
    readOnlyReason: null, diagnostics: [], updatedAt: '', ...extra };
  value.classification = { category: 'user-global', scope: 'user-global', agentId: null, discoveredByAgentId: 'zcode', relationship: 'discovered',
    projectName: null, projectRoot: null, evidencePath: value.sourcePath, reason: 'fixture', contentCompatibility: 'unknown',
    sourceIdentity: `phys-${id}`, location: { category: 'user-global', rootPath: 'C:/fixture/skills', evidencePath: value.sourcePath, reason: 'fixture' } };
  return value;
}

describe('entity favorite aggregation', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('shows a favorite placed on a non-representative binding and clears every known reference on cancel', async () => {
    const store = useAppStore();
    const ui = useUiStore();
    const first = skill('first');
    const second = skill('second', { sourcePath: 'C:/fixture/skills/shared' });
    store.catalog = { instances: [], projects: [], bindings: [first, second], lastScanAt: null };
    const rows = useResourceRows();
    expect(rows.entities.value).toHaveLength(1);
    const entity = rows.entities.value[0]!;
    expect(rows.isFavoriteEntity(entity)).toBe(false);
    store.resourcePreferences = { favorites: [{ kind: 'binding', bindingId: 'second' }], savedFilters: [], display: { showBuiltin: false, showCacheOnly: false } };
    expect(rows.isFavoriteEntity(entity)).toBe(true);
    // Cancel clears every currently known associated reference, not just the representative one.
    await rows.toggleEntityFavorite(entity);
    expect(store.resourcePreferences.favorites).toHaveLength(0);
    expect(rows.isFavoriteEntity(entity)).toBe(false);
    await rows.toggleEntityFavorite(entity);
    expect(store.resourcePreferences.favorites).toEqual([{ kind: 'binding', bindingId: first.id }]);
    expect(ui).toBeDefined();
  });

  it('keeps hidden favorites discoverable without marking them stale', async () => {
    const store = useAppStore();
    const builtin = skill('builtin', { sourceKind: 'builtin', builtinSourcePath: 'C:/app/skills/shared', sourcePath: 'C:/fixture/skills/shared' });
    store.catalog = { instances: [], projects: [], bindings: [builtin], lastScanAt: null };
    store.resourcePreferences = { favorites: [{ kind: 'binding', bindingId: 'builtin' }], savedFilters: [], display: { showBuiltin: false, showCacheOnly: false } };
    const rows = useResourceRows();
    expect(rows.entities.value).toHaveLength(0);
    const hiddenKeys = new Set(rows.unfilteredCollection.value.entities.map(entity => entity.key)
      .filter(key => !rows.entities.value.some(entity => entity.key === key)));
    expect(hiddenKeys.size).toBe(1);
  });
});
