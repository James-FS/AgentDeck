import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';

export function useScanActions() {
  const store = useAppStore();
  const ui = useUiStore();

  async function refresh() { try { await store.refresh(); } catch { /* the store keeps the connection error visible */ } }

  async function scan(discover = false, discoverUserHome = false) {
    ui.actionBusy = true;
    try {
      if (discoverUserHome) { store.selectedInstanceId = ''; store.selectedProjectId = ''; ui.clearFilters(); }
      store.setCatalog(await api.scan({ discover, discoverUserHome, scanRegisteredProjects: !store.selectedProjectId, ...(store.selectedInstanceId ? { instanceId: store.selectedInstanceId } : {}), ...(store.selectedProjectId ? { projectId: store.selectedProjectId } : {}) }));
      await store.refresh();
      ElMessage.success(discoverUserHome ? `本机只读扫描完成，索引共 ${store.bindings.length} 项资源` : discover ? '扫描与实例发现已完成' : '只读扫描已完成');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '扫描失败'); }
    finally { ui.actionBusy = false; }
  }

  async function scanProject(projectId: string) {
    ui.actionBusy = true;
    try {
      ui.clearFilters();
      store.selectedInstanceId = '';
      store.selectedProjectId = projectId;
      store.setCatalog(await api.scan({ projectId }));
      await store.refresh();
      ui.page = 'resources';
      ElMessage.success('项目只读扫描完成');
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : '项目扫描失败'); }
    finally { ui.actionBusy = false; }
  }

  async function demo() {
    ui.actionBusy = true;
    try { store.setCatalog(await api.initializeDemo()); await store.refresh(); ElMessage.success('隔离演示数据已准备'); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法初始化演示数据'); }
    finally { ui.actionBusy = false; }
  }

  return { refresh, scan, scanProject, demo };
}
