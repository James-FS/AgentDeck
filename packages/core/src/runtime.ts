import { createHash } from 'node:crypto';
import type { Binding, Catalog, RuntimeObservation, RuntimeReport } from '@agentdeck/contracts';

export const RUNTIME_EVIDENCE_MAX_AGE_MS = 30_000;
const FUTURE_CLOCK_SKEW_MS = 2_000;

export type McpConnectionState = Exclude<RuntimeObservation['mcpConnection'], 'not-checked' | 'not-applicable'>;

/** A provider must verify that this loaded thread belongs to the user's current client session. */
export interface VerifiedClientSession {
  source: 'codex-app-server-session';
  attribution: 'verified-current-client-session';
  instanceId: string;
  clientSessionId: string;
  threadId: string;
  /** Opaque identity unique to one app-server process lifetime; a PID alone is insufficient. */
  serverInstanceId: string;
  observedAt: string;
}

/** A status read from that same thread, with an exact fingerprint of the scanned Binding. */
export interface McpSessionEvidence {
  source: 'codex-app-server-session';
  instanceId: string;
  clientSessionId: string;
  threadId: string;
  serverInstanceId: string;
  bindingId: string;
  bindingFingerprint: string;
  observedAt: string;
  connection: McpConnectionState;
}

export interface RuntimeEvidenceSnapshot {
  sessions: VerifiedClientSession[];
  mcpConnections: McpSessionEvidence[];
}

/** Optional, explicitly configured provider. The shipped manager does not connect to a client. */
export interface RuntimeEvidenceProvider {
  readCurrentEvidence(catalog: Catalog): Promise<RuntimeEvidenceSnapshot | null>;
}

export function runtimeBindingFingerprint(binding: Binding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.id, binding.resourceId, binding.instanceId, binding.kind, binding.sourcePath,
    binding.nativeKey, binding.pluginId ?? null, binding.pluginVersion ?? null,
    binding.configurationSourcePath ?? null, binding.configurationKey ?? null,
    binding.enabled, binding.configurationEnabled ?? null, binding.updatedAt,
  ])).digest('hex');
}

function isFresh(value: string, nowMs: number): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    && time <= nowMs + FUTURE_CLOCK_SKEW_MS && nowMs - time <= RUNTIME_EVIDENCE_MAX_AGE_MS;
}

function verifiedSession(value: VerifiedClientSession, nowMs: number): boolean {
  return value != null && value.source === 'codex-app-server-session'
    && value.attribution === 'verified-current-client-session'
    && Boolean(value.instanceId && value.clientSessionId && value.threadId && value.serverInstanceId)
    && isFresh(value.observedAt, nowMs);
}

function mcpObservation(
  binding: Binding,
  catalog: Catalog,
  nowMs: number,
  evidence: RuntimeEvidenceSnapshot | null | undefined,
): Pick<RuntimeObservation, 'mcpConnection' | 'clientSessionId' | 'threadId' | 'evidenceSource' | 'observedAt' | 'reason'> | null {
  if (binding.kind !== 'mcp' || !evidence
    || !catalog.instances.some(instance => instance.id === binding.instanceId && instance.agentId === 'codex')
    || !Array.isArray(evidence.sessions) || !Array.isArray(evidence.mcpConnections)) return null;
  const sessions = evidence.sessions.filter(session => session.instanceId === binding.instanceId && verifiedSession(session, nowMs));
  // Multiple plausible current sessions make a binding-level status ambiguous.
  if (sessions.length !== 1) return null;
  const session = sessions[0]!;
  const matching = evidence.mcpConnections.filter(item => item != null && item.bindingId === binding.id
    && item.instanceId === binding.instanceId && item.clientSessionId === session.clientSessionId
    && item.threadId === session.threadId && item.serverInstanceId === session.serverInstanceId
    && item.source === session.source && item.bindingFingerprint === runtimeBindingFingerprint(binding)
    && isFresh(item.observedAt, nowMs)
    && ['not-started', 'starting', 'connected', 'authentication-required', 'failed', 'cancelled', 'disabled'].includes(item.connection));
  if (matching.length !== 1) return null;
  const item = matching[0]!;
  const reasons: Record<McpConnectionState, string> = {
    'not-started': '当前客户端会话中的 MCP 尚未启动。',
    starting: '当前客户端会话中的 MCP 正在启动。',
    connected: '当前客户端会话中的 MCP 已连接。',
    'authentication-required': '当前客户端会话中的 MCP 需要认证。',
    failed: '当前客户端会话中的 MCP 连接失败。',
    cancelled: '当前客户端会话中的 MCP 启动已取消。',
    disabled: '当前客户端会话中的 MCP 已停用。',
  };
  return {
    mcpConnection: item.connection,
    clientSessionId: session.clientSessionId,
    threadId: session.threadId,
    evidenceSource: session.source,
    observedAt: item.observedAt,
    reason: reasons[item.connection],
  };
}

/** No snapshot means no runtime observation. Invalid, stale, or ambiguous evidence fails closed. */
export function assessRuntimeEvidence(catalog: Catalog, now: Date, evidence?: RuntimeEvidenceSnapshot | null): RuntimeReport {
  const nowMs = now.getTime();
  return {
    assessedAt: now.toISOString(),
    observations: catalog.bindings.map(binding => {
      const mcp = mcpObservation(binding, catalog, nowMs, evidence);
      return {
        bindingId: binding.id,
        instanceId: binding.instanceId,
        kind: binding.kind,
        configurationEnabled: binding.configurationEnabled === undefined ? binding.enabled : binding.configurationEnabled,
        indexUpdatedAt: binding.updatedAt,
        sessionLoad: binding.kind === 'mcp' ? 'not-applicable' : 'not-checked',
        mcpConnection: mcp?.mcpConnection ?? (binding.kind === 'mcp' ? 'not-checked' : 'not-applicable'),
        clientSessionId: mcp?.clientSessionId ?? null,
        threadId: mcp?.threadId ?? null,
        evidenceSource: mcp?.evidenceSource ?? null,
        observedAt: mcp?.observedAt ?? null,
        reason: mcp?.reason ?? (binding.kind === 'mcp'
          ? evidence ? '尚无可归属到当前客户端会话的有效 MCP 状态证据；证据可能缺失、过期或身份不匹配。'
            : '未接入该客户端现有会话的 MCP 连接状态接口；配置、缓存和独立连接测试均不能证明当前会话已连接或失败。'
          : '未接入该客户端现有会话的资源加载状态接口；配置启用和文件或缓存存在不能证明当前会话已加载。'),
      };
    }),
  };
}
