import { describe, expect, it } from 'vitest';
import { baseBinding, report } from '../packages/adapters/src/shared';
import { configurationState } from '../apps/web/src/configuration-state';
import { type Binding, type ScanContext } from '../packages/contracts/src/index';

const context: ScanContext = { instance: { id: 'fixture', agentId: 'codex', name: 'fixture', configRoot: 'work/tests/missing-state-root',
  version: null, executable: null, discovery: 'manual', writable: false, checkedAt: '', diagnostics: [] } };
function binding(kind: Binding['kind'], extra: Partial<Binding> = {}): Binding {
  return { ...baseBinding({ context, kind, name: 'fixture', scope: 'native', sourceKind: 'user', sourcePath: 'work/tests/missing-state-root/resource', nativeKey: kind }), ...extra };
}

describe('three configuration states', () => {
  it('uses the same three labels for all resource kinds and switch mechanisms', () => {
    for (const kind of ['skill', 'mcp', 'plugin'] as const) {
      expect(configurationState(binding(kind, { enabled: true })).label).toBe('已启用');
      expect(configurationState(binding(kind, { enabled: false })).label).toBe('已禁用');
      expect(configurationState(binding(kind)).label).toBe('未确定');
    }
  });
  it('defaults owned Agent directory resources to enabled without changing ownership or write permission', async () => {
    for (const kind of ['skill', 'mcp', 'plugin'] as const) {
      const resource = binding(kind, { discoveryOnly: true });
      const original = JSON.stringify(resource.classification);
      await report([resource], []);
      expect(resource.enabled).toBe(true);
      expect(resource.configurationStateReason).toContain('默认已启用');
      expect(JSON.stringify(resource.classification)).toBe(original);
      expect(resource.writable).toBe(false);
    }
  });
  it('preserves explicit disabling and invalid configuration values', async () => {
    const disabled = binding('skill', { enabled: false, configurationSourcePath: 'work/tests/config.toml', configurationKey: 'skills.config[path=fixture]' });
    const invalid = binding('mcp', { configurationKey: 'mcp.invalid', configurationEnabled: null });
    await report([disabled, invalid], []);
    expect(disabled.enabled).toBe(false);
    expect(invalid.enabled).toBe(null);
  });
  it('does not default public or unknown ownership, missing parents or conflicting overrides', async () => {
    const publicResource = binding('skill');
    publicResource.classification!.agentId = null;
    publicResource.classification!.location!.category = 'user-global';
    const unknown = binding('mcp');
    unknown.classification!.location!.category = 'unknown';
    const orphan = binding('skill', { parentId: 'missing' });
    await report([publicResource, unknown, orphan], []);
    expect([publicResource.enabled, unknown.enabled, orphan.enabled]).toEqual([null, null, null]);
  });
  it('inherits explicit parent disabling without claiming runtime use', async () => {
    const parent = binding('plugin', { enabled: false });
    const child = binding('skill', { enabled: true, parentId: parent.id });
    await report([parent, child], []);
    expect(configurationState(child).label).toBe('已禁用');
    expect(child.configurationStateReason).toContain('父插件');
  });
  it('does not enable unconfigured plugin caches or their components from directory presence', async () => {
    const parent = binding('plugin', { origin: 'cache' });
    const skill = binding('skill', { origin: 'cache', parentId: parent.id });
    const mcp = binding('mcp', { origin: 'cache', parentId: parent.id });
    await report([parent, skill, mcp], []);
    for (const resource of [parent, skill, mcp]) {
      expect(resource.enabled).toBeNull();
      expect(resource.configurationStateReason).toContain('仅发现插件缓存');
    }
  });
  it('defaults public .agents bindings on while isolating explicit disabling to one Agent', async () => {
    const values = [binding('skill'), binding('skill', { enabled: false, instanceId: 'other-agent', configurationKey: 'skills/path.enable', configurationEnabled: false })];
    for (const resource of values) {
      resource.classification!.category = 'user-global';
      resource.classification!.agentId = null;
      resource.classification!.location = { category: 'user-global', rootPath: 'C:/Users/fixture/.agents/skills', evidencePath: resource.sourcePath, reason: 'fixture' };
    }
    await report(values, []);
    expect(values.map(b => b.enabled)).toEqual([true, false]);
    expect(values[0]!.configurationStateReason).toContain('用户指定');
    expect(values[1]!.configurationStateReason).toContain('仅影响此绑定');
  });
});
