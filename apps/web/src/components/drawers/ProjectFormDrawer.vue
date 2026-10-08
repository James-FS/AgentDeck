<script setup lang="ts">
import { reactive } from 'vue';
import { storeToRefs } from 'pinia';
import { Folder } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';

const store = useAppStore();
const ui = useUiStore();
const { drawer, actionBusy } = storeToRefs(ui);
const projectForm = reactive({ name: '', rootPath: '' });

async function saveProject() {
  if (!projectForm.rootPath.trim()) return;
  actionBusy.value = true;
  try {
    await api.registerProject({ name: projectForm.name.trim() || undefined, rootPath: projectForm.rootPath.trim() });
    await store.refresh(); ElMessage.success('项目空间已登记'); drawer.value = null;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败'); }
  finally { actionBusy.value = false; }
}
</script>

<template>
  <div class="drawer-intro"><i><el-icon><Folder/></el-icon></i><div><b>设置扫描边界</b><small>只扫描登记的项目路径，不进行全盘搜索。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveProject"><el-form-item label="项目名称"><el-input v-model="projectForm.name" placeholder="留空时由服务端生成显示名称"/></el-form-item><el-form-item label="项目根目录" required><el-input v-model="projectForm.rootPath" placeholder="例如：D:\work\my-project"/></el-form-item><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!projectForm.rootPath.trim()" @click="saveProject">登记项目</el-button></div></el-form>
</template>
