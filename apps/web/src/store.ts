import { defineStore } from 'pinia';
import type { AdapterInfo, Catalog, CompatibilityReport } from '@agentdeck/contracts';
import { api, ApiFailure } from './api';

interface AppState {
  catalog: Catalog | null;
  adapters: AdapterInfo[];
  compatibility: CompatibilityReport | null;
  sessionReady: boolean;
  sessionError: string | null;
  busy: boolean;
  refreshError: string | null;
  selectedInstanceId: string;
  selectedProjectId: string;
}

export const useAppStore = defineStore('agentdeck', {
  state: (): AppState => ({
    catalog: null,
    adapters: [],
    compatibility: null,
    sessionReady: false,
    sessionError: null,
    busy: false,
    refreshError: null,
    selectedInstanceId: '',
    selectedProjectId: '',
  }),
  getters: {
    instances: (state) => state.catalog?.instances ?? [],
    projects: (state) => state.catalog?.projects ?? [],
    bindings: (state) => state.catalog?.bindings ?? [],
  },
  actions: {
    setCatalog(catalog: Catalog) {
      this.catalog = catalog;
      if (this.selectedInstanceId && !catalog.instances.some((instance) => instance.id === this.selectedInstanceId)) {
        this.selectedInstanceId = '';
      }
      if (this.selectedProjectId && !catalog.projects.some((project) => project.id === this.selectedProjectId)) {
        this.selectedProjectId = '';
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
        await this.refresh();
      } catch (error) {
        this.sessionReady = false;
        this.sessionError = error instanceof Error ? error.message : '无法建立本机会话。';
      } finally {
        this.busy = false;
      }
    },
    async refresh() {
      this.refreshError = null;
      try {
        const [catalog, adapters, compatibility] = await Promise.all([api.catalog(), api.adapters(), api.compatibility()]);
        this.setCatalog(catalog);
        this.adapters = adapters;
        this.compatibility = compatibility;
      } catch (error) {
        this.refreshError = error instanceof ApiFailure ? error.message : error instanceof Error ? error.message : '刷新失败。';
        throw error;
      }
    },
  },
});
