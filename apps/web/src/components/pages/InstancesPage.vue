<script setup lang="ts">
import { Connection, InfoFilled } from '@element-plus/icons-vue';
import {
  capabilityAreaLabel, capabilityScopeLabel, capabilityStatusLabel, clientConfigStateLabel, clientStatusLabel, timeLabel,
} from '../../labels';
import { useAppStore } from '../../store';
import { useUiStore } from '../../ui-store';
import { useCompatibility } from '../../composables/useCompatibility';
import { useScanActions } from '../../composables/useScanActions';

const store = useAppStore();
const ui = useUiStore();
const { openInstanceForm } = ui;
const { checkVersion, reportCanCheckVersion, versionCheckBusy, versionCheckButtonLabel } = useCompatibility();
const { refresh } = useScanActions();
</script>

<template>
  <section class="panel records-panel"><div class="panel-heading"><div><h2>客户端兼容报告</h2><small>PATH 候选、配置目录、CLI 签名和逐资源能力证据分别展示；扫描本身不会启动客户端。</small></div></div>
    <div v-if="store.compatibility?.clients.length" class="instance-grid"><article v-for="report in store.compatibility.clients" :key="report.id" class="instance-card"><div class="instance-top"><i>{{ report.agentName.slice(0,1) }}</i><small class="status-chip" :class="report.status">{{ clientStatusLabel(report.status) }}</small></div><h3>{{ report.instanceName??`${report.agentName} · 未登记实例` }}</h3><span class="instance-client">{{ report.agentName }} · {{ report.instanceId ? (store.instances.find(i=>i.id===report.instanceId)?.discovery==='auto'?'自动发现':store.instances.find(i=>i.id===report.instanceId)?.discovery==='manual'?'手动登记':'隔离演示') : '仅显示未登记客户端状态' }}</span>
      <div class="path-block"><small>配置根目录 · {{ clientConfigStateLabel(report) }}</small><code :title="report.configRoot??''">{{ report.configRoot??'适配器未提供默认配置路径' }}</code></div>
      <div class="path-block"><small>PATH 程序候选</small><code :title="report.executableCandidate?.path??''">{{ report.executableCandidate?.path??'未发现候选' }}</code><small v-if="report.executableCandidate">候选身份检查 {{ timeLabel(report.executableCandidate.checkedAt) }}</small></div>
      <div class="policy"><small>CLI 版本证据</small><b>{{ report.versionEvidence ? `${report.versionEvidence.version} · ${report.versionEvidence.platform}` : report.status==='demo'?'演示数据没有主机版本证据':'版本未知 · 尚无可识别版本签名' }}</b><span>{{ report.versionEvidence?'只识别到 CLI 输出签名，不证明官方发行来源、桌面应用安装或资源正在运行。':report.agentId==='codex'||report.agentId==='claude-code'?'需手动触发 --version 检查；失败时不会保存原始输出。':'此客户端没有已验证的版本检查命令，只显示 PATH 候选。' }}</span></div>
      <div v-if="report.instanceId" class="policy"><small>本机控制策略</small><b>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'默认允许受支持资源启停':'只读' }}</b><span>{{ store.instances.find(i=>i.id===report.instanceId)?.writable?'仍需满足适配器资源级条件；兼容报告不会授予写权限。':'此实例被设为只读，或客户端尚不支持启停。' }}</span></div>
      <div class="report-actions"><el-button v-if="reportCanCheckVersion(report)" size="small" :loading="versionCheckBusy===report.instanceId" @click="checkVersion(report)">{{ versionCheckButtonLabel(report) }}</el-button><el-button v-if="!report.instanceId" size="small" @click="openInstanceForm">登记此客户端</el-button><span v-else>{{ store.bindings.filter(b=>b.instanceId===report.instanceId).length }} 项资源</span></div>
      <details class="matrix-details"><summary>能力矩阵 · {{ report.capabilities.length }} 项</summary><div class="capability-matrix"><article v-for="(evidence,index) in report.capabilities" :key="`${report.id}-${index}`"><div class="evidence-head"><b>{{ capabilityAreaLabel(evidence.area) }} · {{ evidence.resourceKind?({skill:'Skill',plugin:'插件',mcp:'MCP'})[evidence.resourceKind]:'通用' }}</b><small>{{ capabilityStatusLabel(evidence) }}</small></div><span>{{ capabilityScopeLabel(evidence) }}<template v-if="evidence.mcpTransport==='stdio'"> · STDIO</template><template v-else-if="evidence.mcpTransport==='http'"> · HTTP</template></span><p>{{ evidence.readable?'可读取':'不可读' }} · {{ evidence.writable?'受限可写':'只读' }} · {{ evidence.reason }}</p><small v-if="evidence.clientVersion">适用版本 {{ evidence.clientVersion }} · {{ evidence.platform }}</small><code v-if="evidence.evidenceReference">证据：{{ evidence.evidenceReference }}</code></article></div></details>
      <p v-if="report.diagnostics.length" class="diagnostics"><el-icon><InfoFilled/></el-icon>{{ report.diagnostics.join('；') }}</p>
    </article></div>
    <div v-else class="empty"><i><el-icon><Connection/></el-icon></i><b>兼容报告尚未加载</b><span>刷新本机服务后查看所有已登记实例和未发现客户端。</span><div><el-button type="primary" @click="refresh" :loading="store.busy">刷新报告</el-button></div></div>
    <div class="capabilities"><div class="cap-title"><el-icon><InfoFilled/></el-icon>证据边界<small>配置证据不代表资源已加载</small></div><div class="cap-row"><div><b>客户端身份</b><small>CLI 版本需要精确签名；PATH 候选不等同官方安装。</small></div><span>CLI 可识别 · 发行来源未知</span></div><div class="cap-row"><div><b>原生 Codex 配置</b><small>0.159.2 / Windows：独立 STDIO MCP、配置根独立 Skill、本地市场插件有隔离复读证据。</small></div><span>该证据不会改变手动写入授权。</span></div></div>
  </section>
</template>
