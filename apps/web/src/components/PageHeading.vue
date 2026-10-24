<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { pages } from '../navigation';
import { useUiStore } from '../ui-store';

const ui = useUiStore();
const { page } = storeToRefs(ui);
const description = computed(() => page.value === 'resources'
  ? '集中管理资源筛选；扫描范围由操作本身确定，不受浏览筛选影响。'
  : page.value === 'instances' ? '登记配置根目录并查看适配器注册表提供的能力范围。'
    : page.value === 'projects' ? '手动登记项目根目录，为扫描提供明确边界。'
      : page.value === 'operations' ? '查看配置写入与恢复结果，并从成功操作恢复此修改。'
        : '总览本机客户端状态、资源规模与最近配置变更。');
</script>

<template>
  <div class="page-heading"><div><small class="eyebrow"><i></i> 本机环境</small><h1>{{ pages.find((item) => item.id === page)?.label }}</h1><p>{{ description }}</p></div>
    <div class="heading-actions"><slot name="actions" /></div>
  </div>
</template>
