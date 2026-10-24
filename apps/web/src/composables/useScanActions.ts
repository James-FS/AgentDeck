import { ElMessage } from 'element-plus';
import { api } from '../api';
import { scanNotice } from '../scan-state';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';
import type { Catalog } from '@agentdeck/contracts';

export function useScanActions() {
  const store = useAppStore();
  const ui = useUiStore();

  async function refresh() { try { await store.refresh(true); } catch { /* the store keeps the connection error visible */ } }

  async function applyCatalog(catalog: Catalog, message = '扫描完成') {
    store.setCatalog(catalog);
    await store.refresh(true);
    const notice = scanNotice(catalog);
    ElMessage(notice.type === 'success' ? { type: 'success', message } : notice);
  }

  // Scan ranges are fixed by the action itself; browse filters, the availability
  // form and any page selection never narrow or extend them.
  async function scanClients() {
    ui.actionBusy = true;
    try { await applyCatalog(await api.scan({ scanRegisteredProjects: false }), '客户端扫描完成'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '扫描失败'); }
    finally { ui.actionBusy = false; }
  }

  async function discoverClients() {
    ui.actionBusy = true;
    try { await applyCatalog(await api.scan({ discover: true, discoverUserHome: true, scanRegisteredProjects: false }), '本机客户端发现完成'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '发现客户端失败'); }
    finally { ui.actionBusy = false; }
  }

  // Targeted project scan: only the explicit project id is sent. The current page,
  // filters and scroll position stay; the project row shows the outcome and an
  // explicit "view resources" action instead of an automatic navigation.
  async function scanProject(projectId: string): Promise<{ ok: boolean; notice: string }> {
    ui.actionBusy = true;
    try {
      const catalog = await api.scan({ projectId });
      store.setCatalog(catalog);
      await store.refresh(true);
      const notice = scanNotice(catalog);
      if (notice.type === 'success') ElMessage({ type: 'success', message: '项目扫描完成' });
      else ElMessage(notice);
      return { ok: true, notice: notice.message };
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目扫描失败';
      ElMessage.error(message);
      return { ok: false, notice: message };
    } finally { ui.actionBusy = false; }
  }

  function viewProjectResources(projectId: string) {
    // Explicit navigation only: set the library to this project with global
    // records included, clear conflicting ordinary filters, keep display
    // preferences, and leave the current page context otherwise untouched.
    ui.clearFilters();
    ui.libraryInstanceId = '';
    ui.libraryProjectScope = 'project';
    ui.libraryProjectId = projectId;
    ui.libraryIncludeGlobal = true;
    ui.page = 'resources';
  }

  async function demo() {
    ui.actionBusy = true;
    try {
      const catalog = await api.initializeDemo();
      store.setCatalog(catalog);
      await store.refresh(true);
      const notice = scanNotice(catalog);
      ElMessage(notice.type === 'success' ? { type: 'success', message: '隔离演示数据已准备' } : notice);
    }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法初始化演示数据'); }
    finally { ui.actionBusy = false; }
  }

  return { refresh, scanClients, discoverClients, scanProject, viewProjectResources, demo };
}
