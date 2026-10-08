<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { pages } from '../navigation';
import { useUiStore } from '../ui-store';

const ui = useUiStore();
const { page } = storeToRefs(ui);
const description = computed(() => page.value === 'resources'
  ? '查看本机配置发现的 Skill、插件和 MCP，状态来自当前注册适配器。'
  : page.value === 'instances' ? '登记配置根目录并查看适配器注册表提供的能力范围。'
    : page.value === 'projects' ? '手动登记项目根目录，为扫描提供明确边界。'
      : page.value === 'operations' ? '查看配置变更结果，并从成功操作创建恢复计划。'
        : '总览本机客户端状态、资源规模与最近配置变更。');
</script>

<template>
  <div class="page-heading"><div><small class="eyebrow"><i></i> 本机环境</small><h1>{{ pages.find((item) => item.id === page)?.label }}</h1><p>{{ description }}</p></div>
    <div class="heading-actions"><slot name="actions" /></div>
  </div>
</template>
