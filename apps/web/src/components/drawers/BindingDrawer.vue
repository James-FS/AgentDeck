<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { Box, Connection, Document, InfoFilled } from '@element-plus/icons-vue';
import { configurationState } from '../../configuration-state';
import { diskOnly, inventoryAgent, inventoryScope } from '../../classification';
import { mcpGroupState, publicGroupState } from '../../resource-tree';
import {
  agentName, bindingCategoryLabel, capabilityAreaLabel, capabilityStatusLabel, categoryLabel, classificationLabel, discoveryAgent,
  originLabel, publicDisabledLabel, resourceName, scopeLabel, sourceLabel, stateLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { usePlanFlow } from '../../composables/usePlanFlow';
import { useCompatibility } from '../../composables/useCompatibility';

const store = useAppStore();
const ui = useUiStore();
const { selectedBinding, selectedPublicMembers, selectedMcpMembers, actionBusy } = storeToRefs(ui);
const { openBinding } = ui;
const { canPlan, readOnlyReason, toggleBinding } = usePlanFlow();
const { capabilityEvidenceForBinding } = useCompatibility();

const selectedConfigurationState = computed(() => selectedMcpMembers.value.length ? mcpGroupState(selectedMcpMembers.value) : selectedPublicMembers.value.length ? publicGroupState(selectedPublicMembers.value) : selectedBinding.value ? configurationState(selectedBinding.value) : null);
const selectedCapabilityEvidence = computed(() => selectedBinding.value ? capabilityEvidenceForBinding(selectedBinding.value) : []);
</script>

<template>
  <template v-if="selectedBinding">
    <div class="detail-header">
      <i class="kind-icon" :class="selectedBinding.kind"><el-icon><component :is="selectedBinding.kind==='skill'?Document:selectedBinding.kind==='plugin'?Box:Connection"/></el-icon></i>
      <div><b>{{ resourceName(selectedBinding) }}</b><small>{{ selectedBinding.description||selectedBinding.kind.toUpperCase() }}</small></div>
    </div>
    <div v-if="selectedPublicMembers.length" class="public-agent-states">
      <p>{{ publicDisabledLabel(selectedPublicMembers) }}。公共资源默认已启用，禁用仅针对对应 Agent；下方保留已扫描的配置记录。</p>
      <div v-for="binding in selectedPublicMembers" :key="binding.id" class="plan-path">
        <b>{{ discoveryAgent(binding) }} · {{ store.instances.find(i => i.id === binding.instanceId)?.name ?? binding.instanceId }}</b>
        <span class="config-state" :class="configurationState(binding).tone">{{ configurationState(binding).label }}</span>            <el-switch v-if="canPlan(binding)" :model-value="binding.enabled===true" :disabled="actionBusy" :aria-label="`${discoveryAgent(binding)}公共资源启停`" @change="toggleBinding(binding,Boolean($event))"/>
        <small>{{ configurationState(binding).reason }}</small>
        <code>{{ binding.configurationSourcePath ?? '未关联明确开关配置' }}</code>
        <code v-if="binding.configurationKey">{{ binding.configurationKey }}</code>
      </div>
    </div>
    <div v-if="selectedMcpMembers.length" class="mcp-agent-bindings public-agent-states">
      <p>同一服务的配置绑定分别保留。下方开关只修改所选绑定，不批量控制其他 Agent；同一入口不证明共用运行进程。</p>
      <small>共同服务来源</small><code>{{ selectedBinding.mcpService?.location }}</code>
      <p>{{ selectedBinding.mcpService?.reason }}</p>
      <div v-for="binding in selectedMcpMembers" :key="binding.id" class="plan-path">
        <button class="resource-detail-link" :aria-label="`${discoveryAgent(binding)}MCP绑定详情`" @click="openBinding(binding)">{{ discoveryAgent(binding) }} · {{ store.instances.find(i=>i.id===binding.instanceId)?.name ?? binding.instanceId }} · {{ binding.classification?.projectName ?? '不限定项目' }}</button>
        <b>{{ bindingCategoryLabel(binding) }} · {{ scopeLabel(inventoryScope(binding)) }}</b>
        <span class="config-state" :class="configurationState(binding).tone">{{ configurationState(binding).label }}</span>
        <el-switch v-if="canPlan(binding)" :model-value="binding.enabled===true" :disabled="actionBusy" :aria-label="`${discoveryAgent(binding)}MCP绑定启停`" @change="toggleBinding(binding,Boolean($event))"/>
        <small v-else>{{ readOnlyReason(binding) }}</small>
        <code>{{ binding.configurationSourcePath ?? binding.sourcePath }}</code><code>{{ binding.configurationKey ?? binding.nativeKey }}</code>
        <small>{{ binding.classification?.reason }}</small>
        <small v-if="binding.mcpService?.kind==='package'">{{ binding.mcpService.packageName }} · 版本：{{ binding.mcpService.packageVersion ?? '未确定' }} · {{ binding.mcpService.launchMode }}</small>
        <code v-if="binding.mcpService?.packageEvidencePath">{{ binding.mcpService.packageEvidencePath }}</code>
        <code v-if="binding.mcpService?.entryPath">{{ binding.mcpService.entryPath }}</code>
      </div>
    </div>
    <div v-if="!selectedMcpMembers.length" class="detail-grid">
      <div><small>所属 Agent</small><b>{{ inventoryAgent(selectedBinding)==='unknown'?'归属未知':agentName(inventoryAgent(selectedBinding)) }}</b></div>
      <div><small>配置状态</small><b class="config-state" :class="selectedConfigurationState?.tone">{{ selectedConfigurationState?.label }}</b></div>
      <div class="wide"><small>配置状态依据与限制</small><b>{{ selectedConfigurationState?.reason }}</b></div>
      <div><small>索引来源</small><b>{{ originLabel(selectedBinding) || '来源类型未知' }}</b></div>
      <div><small>来源</small><b>{{ sourceLabel(selectedBinding.sourceKind) }}</b></div>
      <div><small>配置/使用范围</small><b>{{ classificationLabel(selectedBinding) }}</b></div>
      <div v-if="selectedBinding.classification?.discoveredByAgentId"><small>发现适配器（不代表客户端已加载）</small><b>{{ selectedPublicMembers.length ? [...new Set(selectedPublicMembers.map(discoveryAgent))].join("、") : agentName(selectedBinding.classification.discoveredByAgentId) }}</b></div><div class="wide"><small>资源归类</small><b>{{ bindingCategoryLabel(selectedBinding) }}</b></div>
      <div class="wide"><small>实际存放范围与依据</small><b>{{ categoryLabel(selectedBinding.classification?.location?.category ?? 'unknown') }} · {{ selectedBinding.classification?.location?.reason ?? '旧索引缺少存放证据，请重新扫描' }}</b><code>{{ selectedBinding.classification?.location?.rootPath ?? '根目录未确定' }}</code><code v-if="selectedBinding.classification?.location?.evidencePath">{{ selectedBinding.classification.location.evidencePath }}</code></div>
      <div v-if="selectedBinding.classification?.installationEvidence" class="wide"><small>安装登记证据</small><b>{{ selectedBinding.classification.installationEvidence.reason }}</b><code>{{ selectedBinding.classification.installationEvidence.path }}</code><small>安装记录范围：{{ scopeLabel(selectedBinding.classification.installationEvidence.scope) }}</small></div>
      <div class="wide"><small>分类依据</small><b>{{ selectedBinding.classification?.reason ?? '旧索引缺少分类证据，请重新扫描' }}</b><code>{{ selectedBinding.classification?.evidencePath ?? '无证据路径' }}</code></div>
      <div><small>归属关系</small><b>{{ selectedBinding.classification?.relationship==='configured'?'配置或安装登记已关联':diskOnly(selectedBinding)?'仅磁盘发现，未证明安装或加载':'未知' }}</b></div>
      <div class="wide"><small>项目与根目录</small><b>{{ selectedBinding.classification?.projectName ?? (inventoryScope(selectedBinding)==='user-global'?'不限定项目':'项目未确定') }}</b><code v-if="selectedBinding.classification?.projectRoot">{{ selectedBinding.classification.projectRoot }}</code></div>
      <div v-if="selectedBinding.classification?.sharedSource" class="wide"><small>共享来源证据</small><b>同一实际来源已在 {{ selectedBinding.classification.sharedSource.agentIds.map(agentName).join('、') }} 下发现；不证明内容兼容或当前加载。</b><code>{{ selectedBinding.classification.sharedSource.path }}</code><small>独立绑定：{{ selectedBinding.classification.sharedSource.bindingIds.join('、') }}</small></div>
      <div v-if="selectedBinding.kind==='mcp'"><small>MCP 传输</small><b>{{ selectedBinding.mcpTransport==='stdio'?'STDIO':selectedBinding.mcpTransport==='http'?'HTTP':'未知；不适用已验证的原生 STDIO 案例' }}</b></div>
      <div v-if="selectedBinding.discoveryOnly"><small>发现级别</small><b>仅磁盘发现 · 客户端可见性未验证</b></div><div v-if="selectedBinding.discoveryPath" class="wide"><small>分组路径</small><code>{{ selectedBinding.discoveryPath }}</code></div><div class="wide"><small>来源路径</small><code>{{ selectedBinding.sourcePath||'服务未提供路径' }}</code></div>
      <div class="wide"><small>原生配置键</small><code>{{ selectedBinding.nativeKey||'服务未提供键名' }}</code></div>
      <div v-if="selectedBinding.mcpService" class="wide"><small>MCP 服务来源证据</small><code>{{ selectedBinding.mcpService.location }}</code><b>{{ selectedBinding.mcpService.reason }}</b><code>{{ selectedBinding.mcpService.evidencePath }}</code></div>
      <div v-if="selectedBinding.mcpService?.kind==='package'" class="wide"><small>MCP 包与启动方式</small><b>{{ selectedBinding.mcpService.packageName }} · 版本：{{ selectedBinding.mcpService.packageVersion ?? '未确定' }} · {{ selectedBinding.mcpService.launchMode }}</b><code>{{ selectedBinding.mcpService.packageEvidencePath }}</code><code>{{ selectedBinding.mcpService.entryPath }}</code></div>
      <div v-else-if="selectedBinding.kind==='mcp'" class="wide"><small>MCP 服务来源证据</small><b>未确定或旧索引缺少证据；重新扫描后核对。不会仅凭名称或配置目录合并。</b></div>
      <div v-if="selectedBinding.builtinSourcePath" class="wide"><small>Agent 内置来源证据</small><code>{{ selectedBinding.builtinSourcePath }}</code><p>客户端随包资源证明来源；启用状态单独依据配置，不证明当前会话加载。</p></div>
      <div v-if="selectedBinding.pluginId" class="wide"><small>完整插件身份</small><code>{{ selectedBinding.pluginId }}</code></div>
      <div v-if="selectedBinding.pluginVersion" class="wide"><small>缓存版本</small><b>{{ selectedBinding.pluginVersion }}<template v-if="selectedBinding.marketplace"> · {{ selectedBinding.marketplace }}</template></b></div>
      <div v-if="selectedBinding.cacheState" class="wide"><small>缓存状态</small><b>{{ selectedBinding.cacheState==='present'?'缓存存在':selectedBinding.cacheState==='missing'?'缓存缺失':'缓存状态未知' }}</b></div>
      <div v-if="selectedBinding.configurationEnabled!==undefined" class="wide"><small>{{ selectedBinding.configurationControl?.visibility?'可见性配置记录':selectedBinding.configurationControl?.mode==='parent'?'父插件配置状态':'关联配置状态' }}</small><b>{{ selectedBinding.configurationControl?.visibility ?? stateLabel(selectedBinding.configurationEnabled) }}</b></div>
      <div v-if="selectedBinding.configurationSourcePath" class="wide"><small>配置证据文件</small><code>{{ selectedBinding.configurationSourcePath }}</code></div>
      <div v-if="selectedBinding.configurationKey" class="wide"><small>配置关联键</small><code>{{ selectedBinding.configurationKey }}</code></div>
      <div v-if="selectedBinding.projectId" class="wide"><small>项目来源</small><b>{{ store.projects.find(p=>p.id===selectedBinding?.projectId)?.name??selectedBinding.projectId }} · {{ sourceLabel(selectedBinding.sourceKind) }}</b></div>
      <div v-if="selectedBinding.parentId" class="wide"><small>所属插件</small><b>{{ store.bindings.find(b=>b.id===selectedBinding?.parentId)?.name??selectedBinding.parentId }}</b></div>
      <div class="wide"><small>控制能力</small><b>{{ canPlan(selectedBinding)?'Codex 单项配置计划可用':`只读 · ${readOnlyReason(selectedBinding)}` }}</b></div>
      <div class="wide evidence-detail"><small>匹配此资源的能力证据</small><div v-if="selectedCapabilityEvidence.length" class="capability-matrix"><article v-for="(evidence,index) in selectedCapabilityEvidence" :key="`${selectedBinding.id}-${index}`"><div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ capabilityStatusLabel(evidence) }}<template v-if="evidence.mcpTransport"> · {{ evidence.mcpTransport==='stdio'?'STDIO':evidence.mcpTransport==='http'?'HTTP':'传输未知' }}</template></b><small>{{ evidence.readable?'可读取':'不可读' }} · {{ evidence.writable?'受限可写':'只读' }}</small></div><p>{{ evidence.reason }}</p><small v-if="evidence.clientVersion">版本 {{ evidence.clientVersion }} · {{ evidence.platform }}</small><code v-if="evidence.evidenceReference">证据：{{ evidence.evidenceReference }}</code></article></div><p v-else class="no-evidence">没有按资源类型、作用范围与来源匹配的兼容证据。</p></div>
      <div class="wide"><small>最近更新</small><b>{{ timeLabel(selectedBinding.updatedAt) }}</b></div>
    </div>
    <div v-if="selectedBinding.diagnostics.length" class="detail-diagnostics"><b>诊断信息</b><p v-for="message in selectedBinding.diagnostics" :key="message"><el-icon><InfoFilled/></el-icon>{{ message }}</p></div>
    <div v-else class="detail-diagnostics quiet"><el-icon><InfoFilled/></el-icon>此资源没有适配器诊断信息。</div>
  </template>
</template>
