<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { Refresh } from '@element-plus/icons-vue';
import { agentName } from '../labels';
import { pages } from '../navigation';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';
import { useScanActions } from '../composables/useScanActions';

const store = useAppStore();
const ui = useUiStore();
const { page } = storeToRefs(ui);
const { refresh } = useScanActions();
</script>

<template>
  <header class="topbar"><div class="crumb"><span>AgentDeck</span><i>/</i><b>{{ pages.find((item) => item.id === page)?.label }}</b></div><div class="top-controls">
    <label><span>客户端</span><el-select v-model="store.selectedInstanceId" clearable placeholder="全部实例" :disabled="!store.sessionReady"><el-option v-for="i in store.instances" :key="i.id" :value="i.id" :label="`${agentName(i.agentId)} · ${i.name}`" /></el-select></label>
    <label><span>项目</span><el-select v-model="store.selectedProjectId" clearable placeholder="全部项目" :disabled="!store.sessionReady"><el-option v-for="p in store.projects" :key="p.id" :value="p.id" :label="p.name" /></el-select></label>
    <el-button class="refresh" circle :loading="store.busy" :disabled="!store.sessionReady" aria-label="刷新" @click="refresh"><el-icon><Refresh /></el-icon></el-button>
  </div></header>
</template>
