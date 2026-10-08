<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useAppStore } from '../store';
import { useUiStore } from '../ui-store';
import { pages } from '../navigation';
import { useOperations } from '../composables/useOperations';

const store = useAppStore();
const ui = useUiStore();
const { page } = storeToRefs(ui);
const { operations, goTo } = useOperations();
</script>

<template>
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><div><strong>AgentDeck</strong><small>本地扩展管理器</small></div></div>
    <div class="section-label">工作区</div>
    <nav aria-label="主导航"><button v-for="item in pages" :key="item.id" class="nav-item" :class="{active: page === item.id}" @click="goTo(item.id)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span><small v-if="item.id === 'operations' && operations.length">{{ operations.length }}</small></button></nav>
    <div class="divider"></div><div class="section-label clients-label"><span>客户端能力</span><i></i></div>
    <div v-if="store.adapters.length" class="clients"><div v-for="adapter in store.adapters" :key="adapter.id" class="client"><span>{{ adapter.name.slice(0,1) }}</span><b>{{ adapter.name }}</b><small>{{ store.instances.filter((i) => i.agentId === adapter.id).length }}</small></div></div><p v-else class="sidebar-note">连接服务后读取适配器注册表</p>
    <div class="sidebar-bottom"><span class="local-indicator"><i :class="store.sessionReady ? 'online' : ''"></i>{{ store.sessionReady ? '本机服务已连接' : '等待本机服务' }}</span><small>AgentDeck · 基础版</small></div>
  </aside>
</template>
