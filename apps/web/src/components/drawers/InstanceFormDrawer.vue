<script setup lang="ts">
import { reactive } from 'vue';
import { storeToRefs } from 'pinia';
import { Connection, InfoFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';

const store = useAppStore();
const ui = useUiStore();
const { drawer, actionBusy } = storeToRefs(ui);
const instanceForm = reactive({ agentId: store.adapters[0]?.id ?? '', name: '', configRoot: '', writable: true });

async function saveInstance() {
  if (!instanceForm.agentId || !instanceForm.configRoot.trim()) return;
  actionBusy.value = true;
  try {
    const registered = await api.registerInstance({ agentId: instanceForm.agentId, name: instanceForm.name.trim() || undefined, configRoot: instanceForm.configRoot.trim(), writable: ['codex','zcode','claude-code','deepseek-harness'].includes(instanceForm.agentId) && instanceForm.writable });
    await api.scan({ instanceId: registered.id });
    await store.refresh(); ElMessage.success('Agent 实例已登记'); drawer.value = null;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '登记失败'); }
  finally { actionBusy.value = false; }
}
</script>

<template>
  <div class="drawer-intro"><i><el-icon><Connection/></el-icon></i><div><b>添加本机配置来源</b><small>只读取你提交的目录，不猜测或改写其他路径。</small></div></div><el-form label-position="top" class="drawer-form" @submit.prevent="saveInstance"><el-form-item label="客户端" required><el-select v-model="instanceForm.agentId" placeholder="从适配器注册表选择" class="full"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/></el-select></el-form-item><el-form-item label="显示名称"><el-input v-model="instanceForm.name" placeholder="可选，例如：工作用配置"/></el-form-item><el-form-item label="配置根目录" required><el-input v-model="instanceForm.configRoot" placeholder="例如：C:\Users\you\.config\agent"/></el-form-item><div v-if="['codex','zcode','claude-code','deepseek-harness'].includes(instanceForm.agentId)" class="write-opt"><el-checkbox v-model="instanceForm.writable">允许资源启停（仅目标开关）</el-checkbox><p>仅修改已识别资源的开关值，其他设置和资源文件保持原样；保留备份与恢复。Codex 的部分开关仍需版本核对。</p></div><div v-else class="readonly-note"><el-icon><InfoFilled/></el-icon>当前客户端首轮为只读接入；登记不会开放写入操作。</div><div class="drawer-footer"><el-button @click="drawer=null">取消</el-button><el-button type="primary" :loading="actionBusy" :disabled="!instanceForm.agentId||!instanceForm.configRoot.trim()" @click="saveInstance">登记实例</el-button></div></el-form>
</template>
