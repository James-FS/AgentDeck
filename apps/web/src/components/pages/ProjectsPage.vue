<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { Folder, FolderAdd } from '@element-plus/icons-vue';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { useScanActions } from '../../composables/useScanActions';

const store = useAppStore();
const ui = useUiStore();
const { actionBusy } = storeToRefs(ui);
const { openProjectForm } = ui;
const { scanProject } = useScanActions();
</script>

<template>
  <section class="panel records-panel"><div class="panel-heading"><div><h2>已登记项目</h2><small>仅扫描明确登记的项目根目录</small></div><el-button type="primary" @click="openProjectForm"><el-icon><FolderAdd/></el-icon>登记项目</el-button></div><div v-if="store.projects.length" class="project-list"><article v-for="p in store.projects" :key="p.id"><i><el-icon><Folder/></el-icon></i><div><b>{{ p.name }}</b><code :title="p.rootPath">{{ p.rootPath }}</code></div><span>{{ store.bindings.filter(b=>b.projectId===p.id).length }} 项项目资源</span><el-button :disabled="!store.sessionReady" :loading="actionBusy" @click="scanProject(p.id)">扫描项目</el-button></article></div><div v-else class="empty"><i><el-icon><Folder/></el-icon></i><b>还没有登记项目</b><span>项目范围资源扫描需要明确的项目根目录。</span><div><el-button type="primary" @click="openProjectForm">登记项目</el-button></div></div></section>
</template>
