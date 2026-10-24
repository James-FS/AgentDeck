import { defineStore } from 'pinia';
import type { AdapterInfo, Catalog, CompatibilityReport, ResourcePreferences } from '@agentdeck/contracts';
import { withDefaultDisplayPolicy } from '@agentdeck/contracts';
import { api, ApiFailure } from './api';
import { createRefreshQueue } from './refresh-queue';
import { useUiStore } from './ui-store';

interface AppState {
  catalog: Catalog | null;
  adapters: AdapterInfo[];
  compatibility: CompatibilityReport | null;
  sessionReady: boolean;
  sessionError: string | null;
  busy: boolean;
  refreshError: string | null;
  resourcePreferences: ResourcePreferences;
}

let preferenceMutationQueue: Promise<void> = Promise.resolve();
let preferenceRevision = 0;
const refreshQueues = new WeakMap<object, ReturnType<typeof createRefreshQueue>>();
const compatibilityRevisions = new WeakMap<object, number>();
const catalogRevisions = new WeakMap<object, number>();

export const useAppStore = defineStore('agentdeck', {
  state: (): AppState => ({
    catalog: null,
    adapters: [],
    compatibility: null,
    sessionReady: false,
    sessionError: null,
    busy: false,
    refreshError: null,
    resourcePreferences: { favorites: [], savedFilters: [], display: { showBuiltin: false, showCacheOnly: false } },
  }),
  getters: {
    instances: (state) => state.catalog?.instances ?? [],
    projects: (state) => state.catalog?.projects ?? [],
    bindings: (state) => state.catalog?.bindings ?? [],
  },
  actions: {
    setCompatibility(report: CompatibilityReport) {
      compatibilityRevisions.set(this, (compatibilityRevisions.get(this) ?? 0) + 1);
      this.compatibility = report;
    },
    setCatalog(catalog: Catalog) {
      catalogRevisions.set(this, (catalogRevisions.get(this) ?? 0) + 1);
      this.catalog = catalog;
      // The library context is browsing state: when its referenced records disappear
      // from the catalog it resets to "all" instead of silently matching nothing.
      const ui = useUiStore();
      if (ui.libraryInstanceId && !catalog.instances.some((instance) => instance.id === ui.libraryInstanceId)) {
        ui.libraryInstanceId = '';
      }
      if (ui.libraryProjectId && !catalog.projects.some((project) => project.id === ui.libraryProjectId)) {
        ui.libraryProjectId = '';
        if (ui.libraryProjectScope === 'project') ui.libraryProjectScope = 'all';
      }
    },
    async connect() {
      this.busy = true;
      this.sessionError = null;
      try {
        const ticket = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
        if (ticket) {
          window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
          try {
            await api.bootstrap(ticket);
          } catch (error) {
            this.sessionError = error instanceof Error ? error.message : '启动票据兑换失败。';
            this.sessionReady = false;
            return;
          }
        }
        await api.session();
        this.sessionReady = true;
        await this.refresh(true);
      } catch (error) {
        this.sessionReady = false;
        this.sessionError = error instanceof Error ? error.message : '无法建立本机会话。';
      } finally {
        this.busy = false;
      }
    },
    refresh(full = false): Promise<void> {
      let queue = refreshQueues.get(this);
      if (!queue) {
        queue = createRefreshQueue(async includeMetadata => {
          this.refreshError = null;
          const preferencesAtStart = preferenceRevision;
          const compatibilityAtStart = compatibilityRevisions.get(this) ?? 0;
          const catalogAtStart = catalogRevisions.get(this) ?? 0;
          try {
            const [catalog, metadata] = await Promise.all([
              api.catalog(), includeMetadata ? Promise.all([api.adapters(), api.compatibility(), api.resourcePreferences()]) : Promise.resolve(null),
            ]);
            if (catalogAtStart === (catalogRevisions.get(this) ?? 0)) this.setCatalog(catalog);
            if (metadata) {
              this.adapters = metadata[0];
              if (compatibilityAtStart === (compatibilityRevisions.get(this) ?? 0)) this.setCompatibility(metadata[1]);
              if (preferencesAtStart === preferenceRevision) this.resourcePreferences = withDefaultDisplayPolicy(metadata[2]);
            }
          } catch (error) {
            this.refreshError = error instanceof ApiFailure ? error.message : error instanceof Error ? error.message : '刷新失败。';
            throw error;
          }
        });
        refreshQueues.set(this, queue);
      }
      return queue(full);
    },
    mutatePreferences(mutator: (current: ResourcePreferences) => ResourcePreferences): Promise<void> {
      preferenceRevision += 1;
      const revision = preferenceRevision;
      const update = preferenceMutationQueue.then(async () => {
        const next = mutator(this.resourcePreferences);
        this.resourcePreferences = next;
        const saved = await api.saveResourcePreferences(next);
        if (revision === preferenceRevision) this.resourcePreferences = saved;
      });
      preferenceMutationQueue = update.catch(() => undefined);
      return update;
    },
    savePreferences(value: ResourcePreferences): Promise<void> {
      return this.mutatePreferences(() => value);
    },
  },
});
