<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { Refresh } from '@element-plus/icons-vue';
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
    <el-button class="refresh" circle :loading="store.busy" :disabled="!store.sessionReady" aria-label="刷新当前页面数据" title="刷新当前页面数据" @click="refresh"><el-icon><Refresh /></el-icon></el-button>
  </div></header>
</template>
