<script setup lang="ts">
import { computed } from 'vue';
import { InfoFilled } from '@element-plus/icons-vue';
import type { Binding } from '@agentdeck/contracts';
import type { ResourceEntity } from '../../resource-entities';
import { entityStatus } from '../../resource-entities';
import { configurationState } from '../../configuration-state';
import { diskOnly, inventoryAgent } from '../../classification';
import {
  agentName, capabilityAreaLabel, capabilityStatusLabel, discoveryAgent, originLabel, resourceName, scopeLabel, sourceLabel, stateLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { usePlanFlow } from '../../composables/usePlanFlow';
import { useCompatibility } from '../../composables/useCompatibility';
import { useResourceRows } from '../../composables/useResourceRows';

const props = defineProps<{ entity: ResourceEntity }>();
defineEmits<{ (event: 'open-finding', sourceId: string, findingPath: string): void }>();

const store = useAppStore();
const { canPlan, readOnlyReason, toggleBinding, planToggle } = usePlanFlow();
const { capabilityEvidenceForBinding } = useCompatibility();
const { policy, setDisplayPolicy } = useResourceRows();

// Keep the dialog reactive to catalog refreshes: switches and states must read the
// latest binding records, not the snapshot captured when the entity was opened.
const live = computed<ResourceEntity>(() => {
  const refresh = (binding: Binding) => store.bindings.find(current => current.id === binding.id) ?? binding;
  const hiddenIds = new Set(props.entity.hiddenBindings.map(binding => binding.id));
  const visibleBindings = props.entity.visibleBindings.map(refresh).filter(binding => !hiddenIds.has(binding.id));
  return { ...props.entity, bindings: props.entity.bindings.map(refresh), visibleBindings,
    hiddenBindings: props.entity.hiddenBindings.map(refresh) };
});
const entity = computed(() => live.value);
const status = computed(() => entityStatus(entity.value));
const kindLabel = computed(() => entity.value.kind === 'plugin' ? '插件' : 'MCP 服务');
const stateTone = (binding: NonNullable<typeof props.entity.bindings[number]>) => configurationState(binding).tone;

const capabilityEvidence = computed(() => {
  const binding = entity.value.visibleBindings[0];
  return binding ? capabilityEvidenceForBinding(binding) : [];
});
</script>

<template>
  <div v-if="entity" class="skill-detail-body">
    <h3>{{ entity.name }} <small class="kind-note">{{ kindLabel }}{{ entity.fromPlugin ? ` · 来自插件 ${entity.fromPlugin}` : '' }}</small></h3>
    <p class="detail-path"><b>代表路径：</b><code>{{ entity.visibleBindings[0]?.mcpService?.location ?? entity.visibleBindings[0]?.sourcePath ?? entity.findings[0]?.findingPath ?? '未确定' }}</code></p>
    <p><b>状态：</b><span class="config-state" :class="status.tone"><i></i>{{ status.label }}</span> <small>{{ status.reason }}</small></p>
    <p v-if="entity.sameNameKeys.length"><b>同名关系：</b><small>另有 {{ entity.sameNameKeys.length }} 个同名资源位于不同目录；同名不等于同一资源，可分别查看详情或加入对比。</small></p>
    <p v-if="entity.sameManifestKeys.length"><b>说明文件相同：</b><small>与 {{ entity.sameManifestKeys.length }} 个资源的 SKILL.md 内容一致；这不代表支持文件或整个包一致。</small></p>

    <section v-if="entity.kind === 'mcp'" class="detail-section">
      <h4>MCP 服务证据</h4>
      <p v-if="entity.mcp?.location"><code>{{ entity.mcp.location }}</code></p>
      <p><small>{{ entity.mcp?.variants === null ? '配置差异待复核（请重扫）；不同扫描会话之间不比较。' : entity.mcp?.variants === 1 ? '各绑定的配置内容相同。' : entity.mcp?.variants ? `各绑定配置不同（${entity.mcp.variants} 组）；私密配置差异仅在本地比较，不公开内容。` : '服务证据来自扫描结果；不证明共用运行进程。' }}</small></p>
    </section>

    <section class="detail-section">
      <h4>关联配置与版本记录（当前范围 {{ entity.visibleBindings.length }} 条）</h4>
      <div v-for="binding in entity.visibleBindings" :key="binding.id" class="plan-path entity-binding">
        <div class="entity-binding-head">
          <b>{{ discoveryAgent(binding) }} · {{ store.instances.find(i => i.id === binding.instanceId)?.name ?? binding.instanceId }}{{ binding.classification?.projectName ? ` · 项目 ${binding.classification.projectName}` : ' · 不限定项目' }}</b>
          <span class="config-state" :class="stateTone(binding)" :title="configurationState(binding).reason"><i></i>{{ configurationState(binding).label }}</span>
          <span v-if="binding.origin === 'cache'" class="version-badge">缓存版本 v{{ binding.pluginVersion ?? '未知' }}</span>
          <span v-else-if="binding.origin === 'configuration'" class="version-badge">配置记录</span>
          <span v-if="diskOnly(binding)" class="inventory-badge">仅磁盘发现</span>
        </div>
        <small>{{ originLabel(binding) || '来源类型未知' }} · {{ sourceLabel(binding.sourceKind) }} · {{ scopeLabel(binding.scope) }} · 归属 {{ inventoryAgent(binding) === 'unknown' ? '未知' : agentName(inventoryAgent(binding)) }}</small>
        <small>{{ configurationState(binding).reason }}</small>
        <div class="entity-binding-actions">
          <template v-if="canPlan(binding)">
            <el-switch :model-value="binding.enabled === true" :disabled="false" :aria-label="`${resourceName(binding)}启停`" @change="toggleBinding(binding, Boolean($event))" />
            <el-button text size="small" data-testid="preview-toggle" @click="planToggle(binding, binding.enabled !== true)">预览修改</el-button>
            <small>单项配置开关可用；应用时仍复核写入许可与配置摘要。</small>
          </template>
          <span v-else class="readonly" tabindex="0" :aria-label="'只读：' + readOnlyReason(binding)"><i class="cap-dot"></i>只读 · {{ readOnlyReason(binding) }}</span>
        </div>
        <code v-if="binding.configurationSourcePath">配置文件：{{ binding.configurationSourcePath }}</code>
        <code v-if="binding.configurationKey">配置键：{{ binding.configurationKey }}</code>
        <code>路径：{{ binding.sourcePath }}</code>
        <small v-if="binding.mcpService?.kind === 'package'">{{ binding.mcpService.packageName }} · 版本：{{ binding.mcpService.packageVersion ?? '未确定' }} · {{ binding.mcpService.launchMode }}</small>
        <code v-if="binding.mcpService?.packageEvidencePath">包证据：{{ binding.mcpService.packageEvidencePath }}</code>
        <code v-if="binding.mcpService?.entryPath">入口：{{ binding.mcpService.entryPath }}</code>
        <small>分类依据：{{ binding.classification?.reason ?? '旧索引缺少分类证据，请重新扫描' }}</small>
        <small v-if="binding.classification?.installationEvidence">安装登记证据：{{ binding.classification.installationEvidence.reason }} · {{ binding.classification.installationEvidence.path }}</small>
        <code v-if="binding.pluginVersion">缓存版本：{{ binding.pluginVersion }}<template v-if="binding.marketplace"> · {{ binding.marketplace }}</template><template v-if="binding.cacheState === 'missing'"> · 缓存缺失</template></code>
        <code v-if="binding.pluginId">插件身份：{{ binding.pluginId }}<template v-if="binding.pluginVersion"> · v{{ binding.pluginVersion }}</template><template v-if="binding.marketplace"> · {{ binding.marketplace }}</template></code>
        <code v-if="binding.parentId && !entity.plugin">所属插件：{{ binding.parentId }}</code>
        <small v-if="binding.configurationStateReason && binding.configurationEnabled !== undefined && binding.configurationEnabled !== null">关联配置状态：{{ stateLabel(binding.configurationEnabled) }}</small>
      </div>
      <p v-if="!entity.visibleBindings.length" class="detail-issue">当前范围没有可显示的关联记录。</p>
      <p v-if="entity.hiddenBindings.length" class="detail-issue">
        另有 {{ entity.hiddenBindings.length }} 条记录被显示策略隐藏（仅缓存 / 内置）。
        <el-button v-if="!policy.showCacheOnly" text size="small" @click="setDisplayPolicy({ showCacheOnly: true })">显示仅缓存记录</el-button>
        <el-button v-if="entity.builtin && !policy.showBuiltin" text size="small" @click="setDisplayPolicy({ showBuiltin: true })">显示内置资源</el-button>
      </p>
    </section>

    <section v-if="entity.plugin" class="detail-section">
      <h4>版本与缓存</h4>
      <p><small>{{ entity.plugin.configurations }} 条配置记录 · {{ entity.plugin.cacheRecords }} 条缓存记录 · 发现缓存版本 {{ entity.plugin.versions.length ? entity.plugin.versions.join('、') : '无' }}。当前使用版本缺少证据时保持未确认；历史缓存版本不宣称为已安装或正在使用。</small></p>
      <p v-if="entity.plugin.pluginId"><small>插件身份：<code>{{ entity.plugin.pluginId }}</code><template v-if="entity.plugin.marketplace"> · 市场 {{ entity.plugin.marketplace }}</template></small></p>
      <div v-if="entity.plugin.components.length">
        <small>内容清单（各自作为独立类型实体列出）：</small>
        <ul><li v-for="component in entity.plugin.components" :key="component.key">{{ component.kind === 'skill' ? 'Skill' : 'MCP' }}：{{ component.name }}</li></ul>
      </div>
    </section>

    <section v-if="entity.findings.length" class="detail-section">
      <h4>独立发现入口（{{ entity.findings.length }}）</h4>
      <div v-for="finding in entity.findings" :key="finding.sourceId + finding.findingPath" class="plan-path">
        <button class="resource-detail-link" @click="$emit('open-finding', finding.sourceId, finding.findingPath)">{{ finding.name }}</button>
        <small>{{ finding.status === 'recognized' ? '已识别' : '格式异常候选' }}{{ finding.reason ? ` · ${finding.reason}` : '' }}</small>
        <code>{{ finding.findingPath }}</code>
      </div>
      <p><small>独立发现保持未绑定、只读；不代表客户端已安装或加载。</small></p>
    </section>

    <section v-if="capabilityEvidence.length" class="detail-section">
      <h4>能力证据</h4>
      <div class="capability-matrix"><article v-for="(evidence, index) in capabilityEvidence" :key="index">
        <div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ capabilityStatusLabel(evidence) }}</b><small>{{ evidence.readable ? '可读取' : '不可读' }} · {{ evidence.writable ? '受限可写' : '只读' }}</small></div>
        <p>{{ evidence.reason }}</p>
      </article></div>
    </section>

    <section v-if="entity.bindings.some(binding => binding.diagnostics.length)" class="detail-diagnostics">
      <b>诊断信息</b>
      <template v-for="binding in entity.bindings" :key="binding.id">
        <p v-for="message in binding.diagnostics" :key="binding.id + message"><el-icon><InfoFilled /></el-icon>{{ discoveryAgent(binding) }}：{{ message }}</p>
      </template>
    </section>
    <section v-else class="detail-diagnostics quiet"><el-icon><InfoFilled /></el-icon>此资源没有适配器诊断信息。</section>
    <p class="detail-evidence">记录更新时间：{{ entity.bindings.map(binding => timeLabel(binding.updatedAt)).join('、') || '独立发现无绑定记录' }}</p>
  </div>
</template>
