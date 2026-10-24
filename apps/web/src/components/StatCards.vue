<script setup lang="ts">
import { Box, Connection, Document, Files, InfoFilled } from '@element-plus/icons-vue';
import { useAppStore } from '../store';
import { useResourceRows } from '../composables/useResourceRows';

const store = useAppStore();
// Overview statistics always reflect the full registered catalog; the resource
// library's client/scope filters never leak into this page.
const { stats, hiddenCounts, policy } = useResourceRows({ global: true });
</script>

<template>
  <div class="stats"><article><div><span>已登记实例</span><i><Connection /></i></div><strong>{{ store.instances.length }}</strong><small>客户端与项目实例</small></article><article><div><span>唯一资源</span><i class="blue"><Box /></i></div><strong>{{ stats.all }}</strong><small>显示策略下去重后的资源实体{{ hiddenCounts.builtin || hiddenCounts.cacheOnly ? `（另隐藏内置 ${hiddenCounts.builtin} / 仅缓存 ${hiddenCounts.cacheOnly} 项）` : '' }}</small></article><article><div><span>Skill</span><i class="violet"><Document /></i></div><strong>{{ stats.skills }}</strong><small>含独立发现与插件附带 Skill</small></article><article><div><span>插件 / MCP</span><i class="amber"><Files /></i></div><strong>{{ stats.plugins + stats.mcps }}</strong><small>插件 {{ stats.plugins }} · MCP {{ stats.mcps }}</small></article><article><div><span>扫描提示</span><i class="rose"><InfoFilled /></i></div><strong>{{ stats.diagnostics }}</strong><small>适配器返回的诊断</small></article></div>
</template>
