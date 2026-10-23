import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';
import { scanNotice } from '../scan-state';

export function useScanActions() {
  const store = useAppStore();
  const ui = useUiStore();

  async function refresh() { try { await store.refresh(); } catch { /* the store keeps the connection error visible */ } }

  async function scan(discover = false, discoverUserHome = false) {
    ui.actionBusy = true;
    try {
      if (discoverUserHome) { store.selectedInstanceId = ''; store.selectedProjectId = ''; ui.clearFilters(); }
      const catalog = await api.scan({ discover, discoverUserHome, scanRegisteredProjects: !store.selectedProjectId, ...(store.selectedInstanceId ? { instanceId: store.selectedInstanceId } : {}), ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}) });
      store.setCatalog(catalog);
      await store.refresh();
      ElMessage(scanNotice(catalog));
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '扫描失败'); }
    finally { ui.actionBusy = false; }
  }

  async function scanProject(projectId: string) {
    ui.actionBusy = true;
    try {
      ui.clearFilters();
      store.selectedInstanceId = '';
      store.selectedProjectId = projectId;
      const catalog = await api.scan({ projectId });
      store.setCatalog(catalog);
      await store.refresh();
      ui.page = 'resources';
      ElMessage(scanNotice(catalog));
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '项目扫描失败'); }
    finally { ui.actionBusy = false; }
  }

  async function demo() {
    ui.actionBusy = true;
    try {
      const catalog = await api.initializeDemo();
      store.setCatalog(catalog);
      await store.refresh();
      const notice = scanNotice(catalog);
      ElMessage(notice.type === 'success' ? { type: 'success', message: '隔离演示数据已准备' } : notice);
    }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法初始化演示数据'); }
    finally { ui.actionBusy = false; }
  }

  return { refresh, scan, scanProject, demo };
}
