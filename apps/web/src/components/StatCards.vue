<script setup lang="ts">
import { Box, Connection, Document, Files, InfoFilled } from '@element-plus/icons-vue';
import { useAppStore } from '../store';
import { useResourceRows } from '../composables/useResourceRows';

const store = useAppStore();
const { stats } = useResourceRows();
</script>

<template>
  <div class="stats"><article><div><span>已登记实例</span><i><Connection /></i></div><strong>{{ store.instances.length }}</strong><small>来自本机适配器目录</small></article><article><div><span>可见扩展</span><i class="blue"><Box /></i></div><strong>{{ stats.all }}</strong><small>当前筛选范围内</small></article><article><div><span>Skill</span><i class="violet"><Document /></i></div><strong>{{ stats.skills }}</strong><small>按三类元数据查看</small></article><article><div><span>插件 / MCP</span><i class="amber"><Files /></i></div><strong>{{ stats.plugins + stats.mcps }}</strong><small>插件 {{ stats.plugins }} · MCP {{ stats.mcps }}</small></article><article><div><span>扫描提示</span><i class="rose"><InfoFilled /></i></div><strong>{{ stats.diagnostics }}</strong><small>适配器返回的诊断</small></article></div>
</template>
