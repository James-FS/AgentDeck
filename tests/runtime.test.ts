import { describe, expect, it } from 'vitest';
import { assessRuntimeEvidence, runtimeBindingFingerprint, type RuntimeEvidenceSnapshot } from '../packages/core/src/runtime.ts';
import { ManagerService, type ManagerStore } from '../packages/core/src/index.ts';
import type { Binding, Catalog } from '../packages/contracts/src/index.ts';

const codexInstance: Catalog['instances'][number] = {
  id: 'codex-1', agentId: 'codex', name: 'Isolated Codex', configRoot: 'isolated',
  version: null, executable: null, discovery: 'demo', writable: false,
  checkedAt: '2026-10-03T00:00:00.000Z', diagnostics: [],
};

function binding(kind: Binding['kind'], overrides: Partial<Binding> = {}): Binding {
  return {
    id: `${kind}-1`, resourceId: `${kind}-resource`, instanceId: 'codex-1', projectId: null,
    kind, name: kind, description: '', scope: 'native', sourceKind: 'user', parentId: null,
    sourcePath: 'isolated', nativeKey: kind, compatibilityClass: 'unknown', enabled: true,
    runtime: 'active', writable: false, readOnlyReason: null, diagnostics: [],
    updatedAt: '2026-10-03T00:00:00.000Z', ...overrides,
  };
}

describe('runtime evidence assessment', () => {
  it('does not turn configuration, cache, or legacy runtime flags into client-session evidence', () => {
    const catalog: Catalog = {
      instances: [], projects: [], lastScanAt: null,
      bindings: [
        binding('skill', { enabled: true, runtime: 'active' }),
        binding('plugin', { enabled: false, cacheState: 'present', runtime: 'inactive' }),
        binding('mcp', { enabled: true, runtime: 'pending', configurationEnabled: true }),
      ],
    };
    const report = assessRuntimeEvidence(catalog, new Date('2026-10-03T01:00:00.000Z'));
    expect(report.assessedAt).toBe('2026-10-03T01:00:00.000Z');
    expect(report.observations.map(item => item.configurationEnabled)).toEqual([true, false, true]);
    expect(report.observations.map(item => item.sessionLoad)).toEqual(['not-checked', 'not-checked', 'not-applicable']);
    expect(report.observations.map(item => item.mcpConnection)).toEqual(['not-applicable', 'not-applicable', 'not-checked']);
    expect(report.observations.every(item => item.clientSessionId === null && item.threadId === null && item.evidenceSource === null && item.observedAt === null)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('isolated');
  });

  it('does not treat unknown configuration as a connection failure', () => {
    const report = assessRuntimeEvidence({ instances: [], projects: [], lastScanAt: null, bindings: [binding('mcp', { enabled: true, configurationEnabled: null })] }, new Date());
    expect(report.observations[0]?.configurationEnabled).toBeNull();
    expect(report.observations[0]?.mcpConnection).toBe('not-checked');
  });

  const observedAt = '2026-10-03T01:00:00.000Z';
  const now = new Date('2026-10-03T01:00:05.000Z');
  function evidenceFor(row: Binding, connection: RuntimeEvidenceSnapshot['mcpConnections'][number]['connection'] = 'connected'): RuntimeEvidenceSnapshot {
    return {
      sessions: [{
        source: 'codex-app-server-session', attribution: 'verified-current-client-session',
        instanceId: row.instanceId, clientSessionId: 'session-root', threadId: 'loaded-thread',
        serverInstanceId: 'server-lifetime-1', observedAt,
      }],
      mcpConnections: [{
        source: 'codex-app-server-session', instanceId: row.instanceId,
        clientSessionId: 'session-root', threadId: 'loaded-thread', serverInstanceId: 'server-lifetime-1',
        bindingId: row.id, bindingFingerprint: runtimeBindingFingerprint(row), observedAt, connection,
      }],
    };
  }

  it('accepts only exact, fresh MCP evidence from one verified current session', () => {
    const mcp = binding('mcp');
    const skill = binding('skill');
    const catalog: Catalog = { instances: [codexInstance], projects: [], lastScanAt: null, bindings: [mcp, skill] };
    const report = assessRuntimeEvidence(catalog, now, evidenceFor(mcp));
    expect(report.observations[0]).toMatchObject({
      mcpConnection: 'connected', clientSessionId: 'session-root', threadId: 'loaded-thread',
      evidenceSource: 'codex-app-server-session', observedAt,
    });
    expect(report.observations[1]).toMatchObject({
      sessionLoad: 'not-checked', mcpConnection: 'not-applicable', clientSessionId: null, observedAt: null,
    });
    const needsAuth = assessRuntimeEvidence(catalog, now, evidenceFor(mcp, 'authentication-required'));
    expect(needsAuth.observations[0]?.mcpConnection).toBe('authentication-required');
    expect(needsAuth.observations[0]?.reason).toContain('需要认证');
    const failed = assessRuntimeEvidence(catalog, now, evidenceFor(mcp, 'failed'));
    expect(failed.observations[0]?.mcpConnection).toBe('failed');
  });

  it('rejects stale, mismatched, ambiguous, or independent-session evidence', () => {
    const mcp = binding('mcp');
    const catalog: Catalog = { instances: [codexInstance], projects: [], lastScanAt: null, bindings: [mcp] };
    const mutations: Array<(snapshot: RuntimeEvidenceSnapshot) => void> = [
      item => { item.sessions[0]!.observedAt = '2026-10-03T00:59:20.000Z'; },
      item => { item.mcpConnections[0]!.observedAt = '2026-10-03T01:01:00.000Z'; },
      item => { item.mcpConnections[0]!.bindingFingerprint = 'stale-scan'; },
      item => { item.mcpConnections[0]!.threadId = 'different-thread'; },
      item => { item.mcpConnections[0]!.clientSessionId = 'different-session'; },
      item => { item.mcpConnections[0]!.serverInstanceId = 'restarted-server'; },
      item => { item.sessions[0]!.attribution = 'unverified' as 'verified-current-client-session'; },
      item => { item.sessions.push({ ...item.sessions[0]!, threadId: 'another-current-thread' }); },
      item => { item.mcpConnections.push({ ...item.mcpConnections[0]! }); },
    ];
    for (const mutate of mutations) {
      const snapshot = evidenceFor(mcp);
      mutate(snapshot);
      const result = assessRuntimeEvidence(catalog, now, snapshot).observations[0]!;
      expect(result.mcpConnection).toBe('not-checked');
      expect(result.clientSessionId).toBeNull();
      expect(result.observedAt).toBeNull();
    }
    const oldScan = binding('mcp', { updatedAt: '2026-10-03T00:01:00.000Z' });
    expect(assessRuntimeEvidence({ ...catalog, bindings: [oldScan] }, now, evidenceFor(mcp)).observations[0]?.mcpConnection).toBe('not-checked');
    expect(assessRuntimeEvidence({ ...catalog, instances: [] }, now, evidenceFor(mcp)).observations[0]?.mcpConnection).toBe('not-checked');
    expect(assessRuntimeEvidence({ ...catalog, instances: [{ ...codexInstance, agentId: 'claude-code' }] }, now, evidenceFor(mcp)).observations[0]?.mcpConnection).toBe('not-checked');
  });

  it('keeps the production provider optional and fails closed on provider errors', async () => {
    const mcp = binding('mcp');
    const catalog: Catalog = { instances: [codexInstance], projects: [], lastScanAt: null, bindings: [mcp] };
    const store = { catalog: () => catalog } as ManagerStore;
    const manager = new ManagerService({ store, adapters: [], homeDir: 'isolated', now: () => now });
    expect((await manager.runtimeReport()).observations[0]?.mcpConnection).toBe('not-checked');
    const injected = new ManagerService({
      store, adapters: [], homeDir: 'isolated', now: () => now,
      runtimeEvidenceProvider: { readCurrentEvidence: async () => evidenceFor(mcp) },
    });
    expect((await injected.runtimeReport()).observations[0]?.mcpConnection).toBe('connected');
    const broken = new ManagerService({
      store, adapters: [], homeDir: 'isolated', now: () => now,
      runtimeEvidenceProvider: { readCurrentEvidence: async () => { throw new Error('PRIVATE_SESSION_CONTENT'); } },
    });
    const report = await broken.runtimeReport();
    expect(report.observations[0]?.mcpConnection).toBe('not-checked');
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SESSION_CONTENT');
  });
});
