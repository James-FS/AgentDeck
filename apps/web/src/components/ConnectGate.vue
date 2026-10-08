<script setup lang="ts">
import { Connection, InfoFilled, Refresh } from '@element-plus/icons-vue';
import { useAppStore } from '../store';

const emit = defineEmits<{ retry: [] }>();
const store = useAppStore();
function connectAndOpen() { emit('retry'); }
</script>

<template>
  <section class="connect-page">
    <div class="connect-art"><span class="ring ring-a"></span><span class="ring ring-b"></span><span class="connect-core"><el-icon><Connection /></el-icon></span><i class="spark a"></i><i class="spark b"></i></div>
    <small class="connect-kicker"><i></i> 需要本机会话</small><h1>连接你的本机工作区</h1>
    <p>AgentDeck 只访问本机服务。请从后台输出的本机链接打开网页；启动票据会在兑换后自动从地址栏移除。</p>
    <div v-if="store.sessionError" class="connect-error"><el-icon><InfoFilled /></el-icon>{{ store.sessionError }}</div>
    <el-button type="primary" :loading="store.busy" @click="connectAndOpen"><el-icon><Refresh /></el-icon>重新连接</el-button>
    <small class="connect-foot"><el-icon><InfoFilled /></el-icon>开发环境前端地址为 127.0.0.1:5173，后台 API 由本机 4780 端口代理提供。</small>
  </section>
</template>
