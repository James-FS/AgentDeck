import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, AgentInstance } from '@agentdeck/contracts';
import { ManagerService } from '../packages/core/src/index';
import { scanSkillSource } from '../packages/core/src/skill-sources';
import { createAdapterRegistry, codexAdapter } from '../packages/adapters/src/index';
import { createStore, type AgentDeckStore } from '../packages/storage/src/index';
import { scanNotice } from '../apps/web/src/scan-state';
import { createTestDirectory, removeTestDirectory } from './helpers';

describe('persisted discovery context and scan outcomes', () => {
  let directory: string;
  let home: string;
  let store: AgentDeckStore;
  beforeEach(async () => {
    directory = await createTestDirectory('manager');
    home = path.join(directory, 'actual-home');
    store = createStore(path.join(directory, 'data'));
  });
  afterEach(async () => { store.close(); await removeTestDirectory(directory); });
  async function file(target: string, text: string) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  async function codexConfig() {
    const root = path.join(directory, 'custom', 'codex');
    await file(path.join(root, 'config.toml'), '[mcp_servers.probe]\ncommand = "never-run"\n');
    return root;
  }

  for (const agentId of ['codex', 'zcode', 'claude-code']) {
    it.each(['auto', 'manual'] as const)(`${agentId}: preserves the actual user home for %s registration, rediscovery and restart`, async mode => {
      const root = path.join(directory, 'custom', agentId);
      const entry = agentId === 'codex' ? 'config.toml' : agentId === 'zcode' ? 'cli/config.json' : 'settings.json';
      await file(path.join(root, entry), agentId === 'codex' ? '' : '{}');
      await file(path.join(home, '.agents/skills/home-probe/SKILL.md'), '---\nname: home-probe\ndescription: Fixture.\n---\n');
      await file(path.join(home, '.claude.json'), '{"mcpServers":{"home-probe":{"command":"never-run"}}}');
      const adapter = createAdapterRegistry().find(item => item.id === agentId)!;
      const env = { [agentId === 'codex' ? 'CODEX_HOME' : agentId === 'zcode' ? 'ZCODE_HOME' : 'CLAUDE_CONFIG_DIR']: root };
      const manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env });
      const manual = mode === 'manual' ? manager.registerInstance({ agentId, configRoot: root }) : null;
      if (manual) {
        expect((await manager.scan({ instanceId: manual.id })).bindings.some(item => item.name === 'home-probe')).toBe(true);
      }
      const discovered = await manager.scan({ discover: true });
      expect(discovered.instances).toHaveLength(1);
      expect(discovered.instances[0]?.userHomeDir).toBe(home);
      if (manual) expect(discovered.instances[0]?.id).toBe(manual.id);
      const binding = discovered.bindings.find(item => item.name === 'home-probe')!;
      expect(binding).toBeDefined();
      expect(binding.sourcePath.startsWith(home + path.sep)).toBe(true);

      store.close();
      store = createStore(path.join(directory, 'data'));
      const restarted = new ManagerService({ store, adapters: [adapter], homeDir: path.join(directory, 'other-home'), env: {} });
      const rescanned = await restarted.scan();
      expect(rescanned.bindings.find(item => item.id === binding.id)?.sourcePath).toBe(binding.sourcePath);
      expect(rescanned.instances[0]?.userHomeDir).toBe(home);
    });
  }

  it('migrates legacy instances using the configured scan home rather than a custom root parent', async () => {
    const root = await codexConfig();
    await file(path.join(home, '.agents/skills/legacy-probe/SKILL.md'), 'fixture');
    const manager = new ManagerService({ store, adapters: [codexAdapter], homeDir: home, env: {} });
    const legacy: AgentInstance = { ...manager.registerInstance({ agentId: 'codex', configRoot: root }) };
    delete legacy.userHomeDir;
    store.putInstance(legacy);
    const catalog = await manager.scan();
    expect(catalog.bindings.some(item => item.name === 'legacy-probe')).toBe(true);
    expect(store.getInstance(legacy.id)?.userHomeDir).toBe(home);
  });

  it('retains the index and last successful time on failure, persists a visible warning and clears it after success', async () => {
    const root = await codexConfig();
    let fail = false;
    let now = new Date('2026-10-22T01:00:00Z');
    const adapter: AgentAdapter = { ...codexAdapter, scan: async context => {
      if (fail) throw new Error('PRIVATE_SCAN_SENTINEL');
      return codexAdapter.scan(context);
    } };
    const manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {}, now: () => now });
    const instance = manager.registerInstance({ agentId: 'codex', configRoot: root });
    const before = await manager.scan();
    fail = true;
    now = new Date('2026-10-22T02:00:00Z');
    const after = await manager.scan();
    expect(after.bindings).toEqual(before.bindings);
    expect(after.lastScanAt).toBe(before.lastScanAt);
    expect(after.lastScan).toMatchObject({ status: 'failed', completedAt: now.toISOString(), succeeded: 0,
      failures: [{ instanceId: instance.id, stage: 'scan' }] });
    expect(JSON.stringify(after)).not.toContain('PRIVATE_SCAN_SENTINEL');
    expect(scanNotice(after)).toMatchObject({ type: 'error' });
    expect(scanNotice(after).message).toContain('当前资源状态可能已过期');
    store.close();
    store = createStore(path.join(directory, 'data'));
    expect(store.catalog().lastScan).toEqual(after.lastScan);
    fail = false;
    const restarted = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {}, now: () => now });
    const recovered = await restarted.scan();
    expect(recovered.lastScanAt).toBe(now.toISOString());
    expect(recovered.lastScan?.status).toBe('succeeded');
    expect(scanNotice(recovered).type).toBe('success');
    expect(recovered.instances[0]?.diagnostics).not.toContain('扫描失败；保留上一次的索引。');
  });

  it('persists binding scan deltas and ignores timestamp-only changes', async () => {
    const root = await codexConfig();
    const config = path.join(root, 'config.toml');
    await file(config, '[mcp_servers.probe]\ncommand = "never-run"\nenabled = true\n');
    let now = new Date('2026-10-23T01:00:00Z');
    const manager = new ManagerService({ store, adapters: [codexAdapter], homeDir: home, env: {}, now: () => now });
    manager.registerInstance({ agentId: 'codex', configRoot: root });
    const first = await manager.scan();
    const firstChange = first.bindingChanges?.at(-1);
    expect(firstChange).toMatchObject({ baseline: true, added: [], removed: [], statusChanged: [] });
    now = new Date('2026-10-23T01:01:00Z');
    const same = await manager.scan();
    expect(same.bindingChanges?.at(-1)).toMatchObject({ baseline: false, added: [], removed: [], statusChanged: [] });
    await file(config, '[mcp_servers.probe]\ncommand = "never-run"\nenabled = false\n');
    now = new Date('2026-10-23T01:02:00Z');
    const changed = await manager.scan();
    const binding = changed.bindings.find(item => item.name === 'probe')!;
    expect(changed.bindingChanges?.at(-1)?.statusChanged.map(item => item.id)).toContain(binding.id);
    expect(changed.bindingChanges?.length).toBe(3);
  });

  it('retains a complete client baseline through partial scans and reports removals with readable summaries', async () => {
    const root = path.join(directory, 'complete-client-baseline');
    const config = path.join(root, 'config.toml');
    await file(config, '[mcp_servers.alpha]\ncommand = "never-run"\n[mcp_servers.beta]\ncommand = "never-run"\n');
    let partial = false;
    const adapter: AgentAdapter = { ...codexAdapter, scan: async context => {
      const report = await codexAdapter.scan(context);
      return partial ? { ...report, bindings: report.bindings.filter(binding => binding.name === 'alpha'), diagnostics: [...report.diagnostics, 'isolated partial scan fixture'] } : report;
    } };
    let manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {} });
    manager.registerInstance({ agentId: 'codex', configRoot: root });
    const first = await manager.scan();
    const beta = first.bindings.find(binding => binding.name === 'beta')!;
    expect(first.bindingChanges?.at(-1)).toMatchObject({ baseline: true, projectId: null });
    partial = true;
    const incomplete = await manager.scan();
    expect(incomplete.bindings.some(binding => binding.id === beta.id)).toBe(true);
    expect(incomplete.bindingChanges?.at(-1)).toMatchObject({ partial: true, removed: [], totals: { removed: 0 } });
    store.close();
    store = createStore(path.join(directory, 'data'));
    partial = false;
    manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {} });
    await file(config, '[mcp_servers.alpha]\ncommand = "never-run"\n');
    const complete = await manager.scan();
    const changes = complete.bindingChanges?.at(-1);
    expect(changes?.totals).toMatchObject({ added: 0, removed: 1, statusChanged: 0 });
    expect(changes?.removed[0]).toMatchObject({ id: beta.id, name: 'beta', path: config, kind: 'mcp' });
  });

  it('does not commit an in-flight source scan across a listener generation change', async () => {
    const sourceRoot = path.join(directory, 'listener-generation');
    await file(path.join(sourceRoot, 'SKILL.md'), '---\nname: listener\ndescription: Generation test.\n---\nbody');
    let block = false;
    let announceStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new ManagerService({ store, adapters: [], homeDir: home, skillSourceScanner: async (source, options) => {
      if (block) { announceStarted(); await gate; }
      return scanSkillSource(source, options);
    } });
    const source = await manager.registerSkillSource({ path: sourceRoot });
    manager.updateSkillSource(source.id, { watchEnabled: true, watchStatus: 'watching' });
    block = true;
    const scanning = manager.scanRegisteredSkillSource(source.id);
    await started;
    manager.updateSkillSource(source.id, { watchEnabled: false, watchStatus: 'disabled' });
    release();
    const final = await scanning;
    expect(final.watchEnabled).toBe(false);
    expect(final.watchStatus).toBe('disabled');
  });

  it('aggregates a project failure even when a later project succeeds', async () => {
    const root = await codexConfig();
    const failedProjectRoot = path.join(directory, 'failed-project');
    const adapter: AgentAdapter = { ...codexAdapter, scan: async context => {
      if (context.project?.rootPath === failedProjectRoot) throw new Error('PRIVATE_PROJECT_SENTINEL');
      return codexAdapter.scan(context);
    } };
    const manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {} });
    const instance = manager.registerInstance({ agentId: 'codex', configRoot: root });
    const failed = manager.registerProject({ name: '失败项目', rootPath: failedProjectRoot });
    manager.registerProject({ rootPath: path.join(directory, 'succeeded-project') });
    const catalog = await manager.scan({ scanRegisteredProjects: true });
    expect(catalog.lastScanAt).toBeNull();
    expect(catalog.lastScan).toMatchObject({ status: 'partial', succeeded: 2,
      failures: [{ instanceId: instance.id, projectId: failed.id, stage: 'scan' }] });
    expect(scanNotice(catalog).type).toBe('warning');
    expect(scanNotice(catalog).message).toContain('失败项目');
  });

  it('reports discovery failures while keeping registered resources available', async () => {
    const root = await codexConfig();
    const adapter: AgentAdapter = { ...codexAdapter, discover: async () => { throw new Error('PRIVATE_DISCOVERY_SENTINEL'); } };
    const manager = new ManagerService({ store, adapters: [adapter], homeDir: home, env: {} });
    manager.registerInstance({ agentId: 'codex', configRoot: root });
    const catalog = await manager.scan({ discover: true });
    expect(catalog.bindings.some(item => item.name === 'probe')).toBe(true);
    expect(catalog.lastScan).toMatchObject({ status: 'partial', succeeded: 1,
      failures: [{ agentId: 'codex', instanceId: null, stage: 'discovery' }] });
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_DISCOVERY_SENTINEL');
  });
});
