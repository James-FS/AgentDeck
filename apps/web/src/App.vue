<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { FolderAdd, InfoFilled, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { useAppStore } from './store';
import { useUiStore } from './ui-store';
import { useEventStream } from './composables/useEventStream';
import { useHotkeys } from './composables/useHotkeys';
import { useOperations } from './composables/useOperations';
import { usePlanFlow } from './composables/usePlanFlow';
import { useScanActions } from './composables/useScanActions';
import AppSidebar from './components/AppSidebar.vue';
import AppTopbar from './components/AppTopbar.vue';
import ConnectGate from './components/ConnectGate.vue';
import PageHeading from './components/PageHeading.vue';
import OverviewPage from './components/pages/OverviewPage.vue';
import ResourcesPage from './components/pages/ResourcesPage.vue';
import InstancesPage from './components/pages/InstancesPage.vue';
import ProjectsPage from './components/pages/ProjectsPage.vue';
import OperationsPage from './components/pages/OperationsPage.vue';
import InstanceFormDrawer from './components/drawers/InstanceFormDrawer.vue';
import ProjectFormDrawer from './components/drawers/ProjectFormDrawer.vue';
import PlanDrawer from './components/drawers/PlanDrawer.vue';
import BindingDrawer from './components/drawers/BindingDrawer.vue';

const store = useAppStore();
const ui = useUiStore();
const { page, drawer, actionBusy, selectedBinding } = storeToRefs(ui);
const { drawerVisibility, openInstanceForm, openProjectForm } = ui;
const { activePlan } = usePlanFlow();
const { refresh, scan } = useScanActions();
const { loadOperations } = useOperations();
const { openEvents, closeEvents } = useEventStream();
useHotkeys();

async function connectAndOpen() {
  await store.connect();
  if (!store.sessionReady) return;
  await loadOperations();
  openEvents();
}
onMounted(() => { void connectAndOpen(); });
onBeforeUnmount(() => { closeEvents(); });
</script>

<template>
  <div class="app-shell">
    <AppSidebar />

    <main class="main">
      <AppTopbar />

      <ConnectGate v-if="!store.sessionReady" @retry="connectAndOpen" />

      <section v-else class="content">
        <PageHeading>
          <template #actions><template v-if="page === 'instances'"><el-button @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现客户端</el-button><el-button type="primary" @click="openInstanceForm"><el-icon><Plus /></el-icon>登记实例</el-button></template><el-button v-if="page === 'projects'" type="primary" @click="openProjectForm"><el-icon><FolderAdd /></el-icon>登记项目</el-button><template v-if="page === 'resources' || page === 'overview'"><el-button @click="scan(false)" :loading="actionBusy"><el-icon><Refresh /></el-icon>重新扫描已登记实例</el-button><el-button type="primary" @click="scan(true, true)" :loading="actionBusy"><el-icon><Search /></el-icon>发现并扫描本机资源</el-button></template></template>
        </PageHeading>
        <div v-if="store.refreshError" class="inline-error"><el-icon><InfoFilled /></el-icon><span>{{ store.refreshError }}</span><el-button text @click="refresh">重试</el-button></div>

        <OverviewPage v-if="page === 'overview'" />
        <ResourcesPage v-else-if="page === 'resources'" />
        <InstancesPage v-else-if="page === 'instances'" />
        <ProjectsPage v-else-if="page === 'projects'" />
        <OperationsPage v-else />
      </section>
    </main>

    <el-drawer :model-value="drawer!==null" @update:model-value="drawerVisibility" :title="drawer==='instance'?'登记 Agent 实例':drawer==='project'?'登记项目空间':drawer==='binding'?'资源详情':'检查变更计划'" :size="drawer==='plan'?'min(660px,96vw)':'min(500px,96vw)'" destroy-on-close>
      <InstanceFormDrawer v-if="drawer==='instance'" />
      <ProjectFormDrawer v-else-if="drawer==='project'" />
      <PlanDrawer v-else-if="drawer==='plan'&&activePlan" />
      <BindingDrawer v-else-if="drawer==='binding'&&selectedBinding" />
    </el-drawer>
  </div>
</template>
