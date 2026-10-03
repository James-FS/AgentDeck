import { describe, expect, it } from 'vitest';
import { assessRuntimeEvidence } from '../packages/core/src/runtime.ts';
import type { Binding, Catalog } from '../packages/contracts/src/index.ts';

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
    expect(report.observations.every(item => item.clientSessionId === null && item.evidenceSource === null && item.observedAt === null)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('isolated');
  });

  it('does not treat unknown configuration as a connection failure', () => {
    const report = assessRuntimeEvidence({ instances: [], projects: [], lastScanAt: null, bindings: [binding('mcp', { enabled: true, configurationEnabled: null })] }, new Date());
    expect(report.observations[0]?.configurationEnabled).toBeNull();
    expect(report.observations[0]?.mcpConnection).toBe('not-checked');
  });
});
