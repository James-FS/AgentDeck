<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { Clock, Connection, InfoFilled, Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { agentName, resourceName, timeLabel } from '../../labels';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { usePlanFlow } from '../../composables/usePlanFlow';

const store = useAppStore();
const ui = useUiStore();
const { drawer, actionBusy } = storeToRefs(ui);
const { activePlan, appliedOperation, restoreOf, planBinding, planInstance, affected, applyPlan } = usePlanFlow();

function legacyCopy(value: string) {
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); ElMessage.success('摘要已复制'); }
  catch { ElMessage.error('复制失败，请手动选择复制'); }
  area.remove();
}
async function copyHash(value: string | null | undefined) {
  if (!value) return;
  try { await navigator.clipboard.writeText(value); ElMessage.success('摘要已复制'); }
  catch { legacyCopy(value); }
}
</script>

<template>
  <template v-if="activePlan"><div class="plan-warning"><i><el-icon><Setting/></el-icon></i><div><b>{{ restoreOf?'配置恢复计划':'资源启停预览' }}</b><small>配置修改 · 支持范围见资源证据；应用后重启 Codex，当前会话状态未知</small></div><span>{{ appliedOperation?'已提交':activePlan.status==='ready'?'待核对':activePlan.status==='applied'?'已应用':'已过期' }}</span></div><section class="plan-section"><small>修改目标</small><div class="target"><i class="kind-icon mcp"><el-icon><Connection/></el-icon></i><div><b>{{ planBinding?resourceName(planBinding):'资源' }}</b><small>{{ planInstance?`${agentName(planInstance.agentId)} · ${planInstance.name}`:activePlan.instanceId }}</small></div></div><div class="plan-path"><small>配置文件</small><code>{{ activePlan.targetPath }}</code></div><div class="plan-path"><small>计划动作</small><b>{{ activePlan.action==='restore'?'恢复到操作前配置':activePlan.desiredEnabled?'启用资源配置':'停用资源配置' }}</b></div></section><section class="impact"><div><small>影响范围</small><b>{{ affected.length+1 }} 条关联绑定</b></div><p>本次只修改目标实例的用户配置。插件开关影响该身份全部版本和子组件；Skill 只改按路径覆盖，原文保持不变。关联条目会重新扫描，运行状态仍未知。</p><div class="impact-row current"><i></i><b>{{ planBinding?resourceName(planBinding):'当前绑定' }}</b><span>{{ planInstance?agentName(planInstance.agentId):'目标实例' }} · 本次计划</span></div><div v-for="b in affected" :key="b.id" class="impact-row"><i></i><b>{{ resourceName(b) }}</b><span>{{ store.instances.find(i=>i.id===b.instanceId)?.name??b.instanceId }} · 同源关联</span></div></section><section class="diff"><div><small>脱敏差异</small><span><el-icon><InfoFilled/></el-icon>不显示原始凭据</span></div><pre>{{ activePlan.diff||'适配器未返回差异文本。' }}</pre><div class="hashes"><span><small>写前摘要</small><code :title="activePlan.beforeHash">{{ activePlan.beforeHash }}</code><button class="hash-copy" type="button" @click="copyHash(activePlan.beforeHash)">复制</button></span><span><small>应用确认摘要（afterHash）</small><code :title="activePlan.afterHash">{{ activePlan.afterHash }}</code><button class="hash-copy" type="button" @click="copyHash(activePlan.afterHash)">复制</button></span></div></section><div class="plan-notes"><p><el-icon><InfoFilled/></el-icon>应用时提交 afterHash。若配置已变化、计划过期或目标身份无法确认，服务端应拒绝写入。</p><p><el-icon><Clock/></el-icon>计划有效期至 {{ timeLabel(activePlan.expiresAt) }}</p><p v-if="appliedOperation"><el-icon><InfoFilled/></el-icon>操作结果：{{ appliedOperation.status }}<template v-if="appliedOperation.error"> · {{ appliedOperation.error }}</template></p></div><div class="drawer-footer plan-actions"><el-button @click="drawer=null">{{ appliedOperation?'关闭':'稍后处理' }}</el-button><el-button v-if="activePlan.status==='ready'&&!appliedOperation" type="primary" :loading="actionBusy" @click="applyPlan">确认应用计划</el-button></div></template>
</template>
