<script setup lang="ts">
import { InfoFilled, List, Refresh } from '@element-plus/icons-vue';
import { timeLabel } from '../../labels';
import { useOperations } from '../../composables/useOperations';
import { usePlanFlow } from '../../composables/usePlanFlow';

const { operations, operationsError, restoreBusy, loadOperations, goTo } = useOperations();
const { planRestore } = usePlanFlow();
</script>

<template>
  <section class="panel records-panel"><div class="panel-heading"><div><h2>变更历史</h2><small>成功操作可生成恢复计划；应用前服务端会再次检查摘要。</small></div><el-button @click="loadOperations"><el-icon><Refresh/></el-icon>刷新记录</el-button></div><div v-if="operationsError" class="inline-error"><el-icon><InfoFilled/></el-icon>{{ operationsError }}<el-button text @click="loadOperations">重试</el-button></div><div v-if="operations.length" class="table-scroll"><table class="operation-table"><thead><tr><th scope="col">操作</th><th scope="col">目标路径</th><th scope="col">结果</th><th scope="col">创建时间</th><th scope="col">恢复</th></tr></thead><tbody><tr v-for="op in operations" :key="op.id"><td><b>{{ op.kind==='restore'?'恢复配置':'启停配置' }}</b><small class="op-id">{{ op.id.slice(0,10) }}</small></td><td><code :title="op.targetPath">{{ op.targetPath }}</code></td><td><span :class="['op-status',op.status]">{{ op.status==='succeeded'?'已完成':op.status==='conflict'?'检测到冲突':'失败' }}</span><small v-if="op.error" class="op-error" :title="op.error">{{ op.error }}</small></td><td>{{ timeLabel(op.createdAt) }}</td><td><el-button v-if="op.status==='succeeded'&&op.backupId" size="small" :loading="restoreBusy===op.id" @click="planRestore(op)">创建恢复计划</el-button><span v-else class="muted-text">{{ op.status==='succeeded'?'未改动，无需恢复':'需成功操作后才能恢复' }}</span></td></tr></tbody></table></div><div v-else-if="!operationsError" class="empty"><i><el-icon><List/></el-icon></i><b>暂无配置操作</b><span>基础版支持独立 MCP，以及已验收的配置根 Skill 和本地市场插件开关。</span><div><el-button @click="goTo('resources')">查看资源</el-button></div></div></section>
</template>
