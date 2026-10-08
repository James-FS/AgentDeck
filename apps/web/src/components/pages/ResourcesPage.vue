<script setup lang="ts">
import { storeToRefs } from 'pinia';
import type { Binding } from '@agentdeck/contracts';
import { ArrowRight, Box, Close, Connection, Document, InfoFilled, Refresh, Search, Setting } from '@element-plus/icons-vue';
import { configurationState } from '../../configuration-state';
import { diskOnly, inventoryAgent, inventoryCategory, inventoryScope } from '../../classification';
import {
  agentName, categoryLabel, discoveryAgent, originLabel, publicDisabledLabel, resourceName, scopeLabel, sourceLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { useResourceFilters } from '../../composables/useResourceFilters';
import { useResourceRows } from '../../composables/useResourceRows';
import { usePlanFlow } from '../../composables/usePlanFlow';
import { useScanActions } from '../../composables/useScanActions';
import { useEventStream } from '../../composables/useEventStream';
import type { ResourceRow } from '../../resource-tree';
import StatCards from '../StatCards.vue';

type SkillBinding = Binding & { sourceLabel?: string };
const store = useAppStore();
const ui = useUiStore();
const { actionBusy } = storeToRefs(ui);
const {
  kindFilter, searchText, scopeFilter, ownerAgentFilter, categoryFilter, sourceFilter, configurationFilter, originFilter,
  expanded, activeFilterChips, removeFilterChip, clearFilters, togglePlugin,
} = useResourceFilters();
const { tabCounts, visible } = useResourceRows();
const { canPlan, toggleBinding, planToggle, readOnlyReason } = usePlanFlow();
const { refresh, scan, demo } = useScanActions();
const { eventStatus } = useEventStream();

function rowName(item: ResourceRow) { return item.mcpBinding ? `${resourceName(item.binding)} · ${discoveryAgent(item.binding)} · 配置绑定` : item.versionRecord ? `${resourceName(item.binding)} · ${item.binding.origin === 'cache' ? `缓存 v${item.binding.pluginVersion ?? '未知'}` : '配置记录'}` : resourceName(item.binding); }
function rowDescription(item: ResourceRow) {
  if (item.mcpGroup) return `同一 MCP 服务 · 关联 ${new Set(item.mcpGroup.members.map(discoveryAgent)).size} 个 Agent · ${item.mcpGroup.members.length} 条绑定 · ${item.mcpGroup.variants === null ? '配置差异待复核（请重扫）' : item.mcpGroup.variants > 1 ? `配置不同（${item.mcpGroup.variants} 组）` : '配置相同'} · 当前匹配 ${item.mcpGroup.matchingMembers.length} 条`;
  if (item.mcpBinding) return `${discoveryAgent(item.binding)} · ${store.instances.find(i=>i.id===item.binding.instanceId)?.name ?? item.binding.instanceId} · ${item.binding.classification?.projectName ?? '不限定项目'} · ${item.binding.configurationSourcePath ?? item.binding.sourcePath}`;
  if (item.publicGroup) return `公共资源 · ${item.publicGroup.members.length} 条发现记录 · ${publicDisabledLabel(item.publicGroup.members)}`;
  if (item.group) return `${item.group.versions.length} 个缓存版本 · ${item.group.configurations} 条配置记录 · 当前使用版本未确定`;
  if (item.binding.discoveryOnly) return `分组路径：${item.binding.discoveryPath} · ${item.binding.description}`;
  if (item.depth && !item.versionRecord) return `由 ${store.bindings.find(b=>b.id===item.binding.parentId)?.name ?? '插件'} 提供${item.binding.pluginVersion ? ` · 缓存 v${item.binding.pluginVersion}` : ''}`;
  return item.binding.description || item.binding.nativeKey || item.binding.sourcePath;
}
function openRow(item: ResourceRow) {
  if (item.group || item.mcpGroup) togglePlugin(item.key);
  else { ui.openBinding(item.binding); ui.selectedPublicMembers = item.publicGroup?.members ?? []; }
}
function openMcpGroup(item: ResourceRow) { ui.openBinding(item.binding); ui.selectedMcpMembers = item.mcpGroup?.members ?? []; }
function groupValues(item: ResourceRow, label: (binding: Binding) => string) {
  return [...new Set((item.mcpGroup?.matchingMembers ?? [item.binding]).map(label))].join('、');
}
</script>

<template>
  <StatCards />
  <section class="panel fill-panel"><div class="panel-heading"><div><h2>本机资源</h2><small>{{ store.catalog?.lastScanAt ? `上次扫描 ${timeLabel(store.catalog.lastScanAt)}` : '尚无扫描记录' }}</small></div><div class="panel-tools"><el-input v-model="searchText" clearable placeholder="搜索名称或来源路径"><template #prefix><el-icon><Search /></el-icon></template></el-input><el-button class="refresh" circle aria-label="刷新资源" :loading="store.busy" @click="refresh"><el-icon><Refresh /></el-icon></el-button></div></div>
    <div class="panel-body-scroll">
      <div class="filter-row"><div class="tabs"><button v-for="tab in [{id:'all',label:'全部'},{id:'skill',label:'Skill'},{id:'plugin',label:'插件'},{id:'mcp',label:'MCP'}]" :key="tab.id" :class="{selected:kindFilter===tab.id}" :aria-label="tab.label" @click="kindFilter=tab.id as 'all'|'skill'|'plugin'|'mcp'">{{ tab.label }}<small>{{ tabCounts[tab.id] }}</small></button></div><div class="skill-filters">
        <el-select v-model="scopeFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="配置/使用范围" aria-label="作用范围"><el-option label="用户全局" value="user-global"/><el-option label="项目级" value="project"/><el-option label="项目子目录级" value="project-directory"/><el-option label="使用范围未知" value="unknown"/></el-select>
        <el-select v-model="ownerAgentFilter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="所属 Agent" aria-label="所属 Agent"><el-option v-for="a in store.adapters" :key="a.id" :value="a.id" :label="a.name"/><el-option label="公共来源（无 Agent 归属）" value="public"/><el-option label="共享来源（有证据）" value="shared"/><el-option label="归属未知" value="unknown"/></el-select>
        <el-select v-model="sourceFilter" data-testid="resource-source-filter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源来源"><el-option label="用户自建 / 导入" value="user"/><el-option label="项目仓库提供" value="repository"/><el-option label="插件附带" value="plugin"/><el-option label="Agent 内置" value="builtin"/><el-option label="组织管理" value="organization"/><el-option label="账号同步" value="account-sync"/><el-option label="来源未知" value="unknown"/></el-select>
        <el-select v-model="originFilter" data-testid="resource-origin-filter" clearable placeholder="配置或文件来源"><el-option label="全部来源类型" value="all"/><el-option label="插件缓存" value="cache"/><el-option label="配置记录" value="configuration"/><el-option label="本地文件" value="filesystem"/></el-select>
        <el-select v-model="categoryFilter" data-testid="resource-category-filter" multiple collapse-tags collapse-tags-tooltip clearable placeholder="资源归类"><el-option label="用户全局来源" value="user-global"/><el-option label="项目公共来源" value="project"/><el-option label="Agent 全局资源" value="agent-global"/><el-option label="Agent 项目资源" value="agent-project"/><el-option label="归类待确定" value="unknown"/></el-select>
        <el-select v-model="configurationFilter" data-testid="configuration-state-filter" aria-label="配置状态筛选" multiple collapse-tags clearable placeholder="配置状态"><el-option label="已启用" value="on"/><el-option label="已禁用" value="off"/><el-option label="未确定" value="unknown"/></el-select>
      </div></div>
      <div v-if="activeFilterChips.length" class="active-filters" aria-label="已选筛选条件"><span class="active-filters-label">已选筛选</span><button v-for="chip in activeFilterChips" :key="chip.group + ':' + chip.value" class="filter-chip" :title="'移除条件：' + chip.label" @click="removeFilterChip(chip.group, chip.value)">{{ chip.label }}<el-icon><Close /></el-icon></button><button class="filter-chip clear-all" @click="clearFilters">清除全部</button></div>
      <div class="taxonomy-note"><el-icon><InfoFilled /></el-icon>资源归类区分用户来源与 Agent 全局/项目资源；未配置缓存可确定存放归属，使用范围仍未知。归属不表示内容专用或已加载。</div>
      <div v-if="visible.length" class="table-scroll"><table class="resource-table"><thead><tr><th scope="col">扩展资源</th><th scope="col">资源归类</th><th scope="col">范围</th><th scope="col">所属 Agent</th><th scope="col">来源</th><th scope="col">配置状态</th><th scope="col">启停</th><th scope="col"><span class="visually-hidden">诊断</span></th></tr></thead><tbody>
        <tr v-for="item in visible" :key="item.key" :class="{child:item.depth>0,parent:item.binding.kind==='plugin','plugin-group':!!item.group,'public-group':!!item.publicGroup,'mcp-group':!!item.mcpGroup}" @click="openRow(item)"><td>
          <div class="resource-cell" :style="{paddingLeft:`${item.depth*24}px`}">
            <button v-if="item.mcpGroup || item.group || item.binding.kind==='plugin'&&item.children" class="tree-toggle" :class="{expanded:expanded.has(item.key)}" :aria-expanded="expanded.has(item.key)" :aria-label="item.mcpGroup ? expanded.has(item.key)?'收起 MCP 绑定':'展开 MCP 绑定' : item.group ? expanded.has(item.key)?'收起插件版本':'展开插件版本':expanded.has(item.key)?'收起插件组件':'展开插件组件'" @click.stop="togglePlugin(item.key)"><el-icon><ArrowRight/></el-icon></button>
            <span v-else-if="item.depth" class="tree-stem"></span><i class="kind-icon" :class="item.binding.kind"><el-icon><component :is="item.binding.kind==='skill'?Document:item.binding.kind==='plugin'?Box:Connection"/></el-icon></i>
            <div class="resource-copy"><div class="resource-title"><button class="resource-detail-link" :title="rowName(item)" :aria-label="rowName(item)" @click.stop="openRow(item)">{{ resourceName(item.binding) }}</button>
              <span v-if="item.mcpGroup" class="version-badge">服务分组</span><span v-else-if="item.publicGroup" class="version-badge">公共资源</span><span v-else-if="item.group" class="version-badge">版本分组</span>
              <button v-if="item.mcpGroup" class="plan-link" :aria-label="`${resourceName(item.binding)}服务详情`" @click.stop="openMcpGroup(item)">服务详情</button>
              <span v-else-if="item.binding.pluginVersion && item.binding.origin==='cache'" class="version-badge">缓存版本 v{{ item.binding.pluginVersion }}</span>
              <span v-if="!item.group && (item.publicGroup ? item.publicGroup.members.every(diskOnly) : diskOnly(item.binding))" class="inventory-badge">仅磁盘发现</span>
            </div><small :title="rowDescription(item)">{{ rowDescription(item) }}</small></div>
            <small v-if="item.mcpGroup || item.group || item.binding.kind==='plugin'&&item.children" class="child-count">{{ item.children }} {{ item.mcpGroup?'条绑定':item.group?'条记录':'项' }}</small>
          </div>
        </td>
          <td class="classification-cell"><strong class="resource-category">{{ groupValues(item, b=>categoryLabel(inventoryCategory(b))) }}</strong><code :title="item.binding.mcpService?.location ?? item.binding.sourcePath">{{ item.mcpGroup ? item.binding.mcpService?.location : item.group ? item.binding.pluginId : item.binding.sourcePath }}</code><small>{{ item.mcpGroup ? '服务来源相同；配置归类保留在各绑定中' : item.group ? '展开查看各记录的原文路径与分类依据' : item.binding.classification?.reason ?? '旧索引无分类证据，请重新扫描' }}</small></td>
          <td class="scope-cell"><span class="tag scope">{{ groupValues(item,b=>scopeLabel(inventoryScope(b))) }}</span><small v-if="item.mcpGroup">{{ groupValues(item,b=>b.classification?.projectName ?? (b.projectId ? '项目未确定' : '不限定项目')) }}</small><small v-else-if="item.binding.classification?.projectName">{{ item.binding.classification.projectName }}</small><small v-else-if="inventoryScope(item.binding)==='user-global'">不限定项目</small></td>
          <td class="agent-cell"><span>{{ groupValues(item,b=>inventoryAgent(b)==='unknown'?'归属未知':agentName(inventoryAgent(b))) }}</span><small v-if="item.mcpGroup">各 Agent 配置分别保留</small><small v-else-if="item.binding.classification?.sharedSource" :title="item.binding.classification.sharedSource.agentIds.map(agentName).join('、')">共享来源 · {{ item.binding.classification.sharedSource.agentIds.map(agentName).join('、') }}</small></td>
          <td><span v-if="item.mcpGroup">{{ groupValues(item,b=>sourceLabel(b.sourceKind)) }}</span><span v-else-if="item.group">配置 / 缓存汇总</span><span v-else-if="item.binding.kind==='skill'" class="tag source">{{ (item.binding as SkillBinding).sourceLabel ?? sourceLabel(item.binding.sourceKind) }}</span><span v-else>{{ sourceLabel(item.binding.sourceKind) }}</span><small v-if="!item.group && !item.mcpGroup && originLabel(item.binding)" class="origin-detail">{{ originLabel(item.binding) }}</small></td>
          <td><span class="config-state" :class="(item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).tone" :title="(item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).reason"><i></i>{{ (item.mcpGroup?.state ?? item.publicGroup?.state ?? item.group?.state ?? configurationState(item.binding)).label }}</span></td>
          <td>
            <template v-if="!item.mcpGroup && !item.publicGroup && canPlan(item.binding)">
              <el-switch :model-value="item.binding.enabled===true" :disabled="actionBusy" :loading="actionBusy" :aria-label="`${resourceName(item.binding)}启停`" @click.stop @change="toggleBinding(item.binding,Boolean($event))"/>
              <el-tooltip content="查看启停预览"><button class="plan-link" :disabled="actionBusy" :aria-label="item.binding.enabled===true?'计划停用':item.binding.enabled===false?'计划启用':'生成启用计划'" @click.stop="planToggle(item.binding,item.binding.enabled!==true)"><el-icon><InfoFilled/></el-icon></button></el-tooltip>
            </template>
            <button v-else-if="item.mcpGroup" class="plan-link" @click.stop="togglePlugin(item.key)">展开各绑定启停</button>
            <el-tooltip v-else :content="readOnlyReason(item.binding)"><span class="readonly"><i class="cap-dot"></i><el-icon><Setting/></el-icon>只读</span></el-tooltip>
          </td>
          <td><el-tooltip v-if="item.binding.diagnostics.length" :content="item.binding.diagnostics.join('；')"><el-icon class="notice"><InfoFilled/></el-icon></el-tooltip></td></tr>
      </tbody></table></div>
      <div v-else-if="!store.bindings.length" class="empty"><i><el-icon><Box/></el-icon></i><b>还没有可显示的资源</b><span>{{ store.instances.length ? '已登记实例尚未发现资源，可重新扫描或发现本机客户端。' : '尚未接入本机配置。开发模式默认使用隔离目录；点击下方按钮只读扫描当前用户的客户端配置。' }}</span><div><el-button type="primary" :loading="actionBusy" @click="scan(true, true)"><el-icon><Search/></el-icon>扫描本机配置（只读）</el-button><el-button v-if="!store.instances.length&&!store.projects.length" :loading="actionBusy" @click="demo">载入隔离演示数据</el-button></div></div>
      <div v-else class="empty-filter"><el-icon><Search/></el-icon>当前筛选没有匹配项<el-button text @click="clearFilters">清除筛选</el-button></div>
    </div>
    <footer class="panel-footer"><span>显示 {{ visible.length }} 行 · 版本分组可展开 <template v-if="store.catalog?.lastScanAt">· 最近扫描 {{ timeLabel(store.catalog.lastScanAt) }}</template></span><span><i :class="eventStatus"></i>{{ eventStatus==='connected'?'实时事件已连接':eventStatus==='connecting'?'连接实时事件…':'事件通道离线' }}</span></footer>
  </section>
</template>
