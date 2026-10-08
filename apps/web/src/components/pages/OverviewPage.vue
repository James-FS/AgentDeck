<script setup lang="ts">
import { List } from '@element-plus/icons-vue';
import { clientStatusLabel, timeLabel } from '../../labels';
import { useAppStore } from '../../store';
import { useOperations } from '../../composables/useOperations';
import { useCompatibility } from '../../composables/useCompatibility';
import StatCards from '../StatCards.vue';

const store = useAppStore();
const { operations, goTo } = useOperations();
const { instanceCountFor, resourceCountFor, adapterStateFor } = useCompatibility();
</script>

<template>
  <StatCards />
  <div class="overview-grid">
    <section class="panel overview-panel">
      <div class="panel-heading"><div><h2>客户端状态</h2><small>按适配器汇总实例与资源规模；版本与能力证据见 Agent 实例页。</small></div><el-button size="small" @click="goTo('instances')">查看实例</el-button></div>
      <div class="client-summary">
        <button v-for="adapter in store.adapters" :key="adapter.id" class="client-row" @click="goTo('instances')">
          <i>{{ adapter.name.slice(0,1) }}</i>
          <div><b>{{ adapter.name }}</b><small>{{ instanceCountFor(adapter.id) }} 个实例 · {{ resourceCountFor(adapter.id) }} 项资源</small></div>
          <span class="summary-state status-chip" :class="adapterStateFor(adapter.id)">{{ clientStatusLabel(adapterStateFor(adapter.id)) }}</span>
        </button>
        <p v-if="!store.adapters.length" class="sidebar-note">连接服务后读取适配器注册表</p>
      </div>
    </section>
    <section class="panel overview-panel">
      <div class="panel-heading"><div><h2>最近操作</h2><small>成功操作可在操作记录中创建恢复计划。</small></div><el-button size="small" @click="goTo('operations')">查看全部</el-button></div>
      <div v-if="operations.length" class="recent-ops">
        <div v-for="op in operations.slice(0,5)" :key="op.id" class="recent-op">
          <span :class="['op-status', op.status]">{{ op.status==='succeeded'?'已完成':op.status==='conflict'?'检测到冲突':'失败' }}</span>
          <div><b>{{ op.kind==='restore'?'恢复配置':'启停配置' }}</b><small>{{ op.targetPath }}</small></div>
          <small class="recent-time">{{ timeLabel(op.createdAt) }}</small>
        </div>
      </div>
      <div v-else class="empty slim"><i><el-icon><List/></el-icon></i><b>暂无配置操作</b><span>基础版支持独立 MCP，以及已验收的配置根 Skill 和本地市场插件开关。</span></div>
    </section>
  </div>
</template>
