import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseBinding, report } from '../packages/adapters/src/shared';
import { createAdapterRegistry } from '../packages/adapters/src/index';
import { classifyCatalog } from '../packages/core/src/classification';
import { ManagerService } from '../packages/core/src/index';
import { createStore } from '../packages/storage/src/index';
import { diskOnly, inventoryCategory, matchesClassification } from '../apps/web/src/classification';
import type { AgentInstance, Binding, Catalog } from '../packages/contracts/src/index';
import { ResourceClassificationSchema } from '../packages/contracts/src/index';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers';
import { addPluginCacheFixture } from './plugin-fixtures';

describe('inventory classification evidence', () => {
  let directory: string;
  let home: string;
  let project: { id: string; name: string; rootPath: string };
  const suffix: Record<string, string> = { codex: '.codex', 'claude-code': '.claude', zcode: '.zcode', 'deepseek-harness': '.dsh' };
  beforeEach(async () => {
    directory = await createTestDirectory('classification');
    const fixture = await copyCatalogFixture(directory);
    home = fixture.home;
    project = { id: 'registered', name: '已登记项目', rootPath: fixture.project };
    await mkdir(path.join(project.rootPath, '.zcode', 'cli'), { recursive: true });
    await writeFile(path.join(project.rootPath, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { same: { command: 'never-run' } } } }));
    await mkdir(path.join(project.rootPath, '.dsh', 'profiles', 'local'), { recursive: true });
    await writeFile(path.join(project.rootPath, '.dsh', 'profiles', 'local', 'cordis.patch.yaml'), '- id: project-plugin\n  name: harmless\n  disabled: false\n');
  });
  afterEach(async () => removeTestDirectory(directory));
  function instance(agentId: string): AgentInstance {
    return { id: agentId, agentId, name: agentId, configRoot: path.join(home, suffix[agentId]!),
      version: null, executable: null, discovery: 'manual', writable: false, checkedAt: '', diagnostics: [] };
  }
  it('classifies all four scanners, keeps duplicate bindings, and leaves sources unchanged', async () => {
    const before = await fileTreeDigests(directory);
    for (const adapter of createAdapterRegistry()) {
      const result = await adapter.scan({ instance: instance(adapter.id), project });
      expect(new Set(result.bindings.map(b => b.id)).size).toBe(result.bindings.length);
      expect(result.bindings.some(b => b.classification?.scope === 'user-global'), adapter.id).toBe(true);
      expect(result.bindings.some(b => b.classification?.scope === 'project'), adapter.id).toBe(true);
      for (const binding of result.bindings) {
        const publicSource = ['user-global', 'project'].includes(binding.classification?.category ?? '');
        expect(binding.classification?.agentId).toBe(publicSource ? null : adapter.id);
        expect(binding.classification?.discoveredByAgentId).toBe(adapter.id);
        expect(binding.compatibilityClass).toBe('unknown');
        expect(binding.classification?.contentCompatibility).toBe('unknown');
        if (binding.projectId) {
          expect(binding.classification?.projectName).toBe(project.name);
          expect(binding.classification?.projectRoot).toBe(project.rootPath);
        }
        if (binding.parentId) {
          const parent = result.bindings.find(b => b.id === binding.parentId)!;
          expect(binding.classification?.scope).toBe(parent.classification?.scope);
        }
        expect(matchesClassification(binding, [binding.classification!.scope], [publicSource ? 'public' : adapter.id])).toBe(true);
        expect(matchesClassification(binding, [], ['unknown'])).toBe(false);
      }
    }
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('keeps cache-only scope unknown, inherits plugin scope, and never infers content compatibility', async () => {
    const context = { instance: instance('codex') };
    const parent = baseBinding({ context, kind: 'plugin', name: 'same', scope: 'native', sourceKind: 'plugin',
      sourcePath: path.join(home, 'cache.json'), nativeKey: 'cache', origin: 'cache' });
    const child = baseBinding({ context, kind: 'skill', name: 'same', scope: 'native', sourceKind: 'plugin',
      sourcePath: path.join(home, 'skill'), nativeKey: 'child', origin: 'cache', parentId: parent.id });
    await report([parent, child], []);
    expect(parent.classification?.scope).toBe('unknown');
    expect(child.classification?.scope).toBe('unknown');
    expect(diskOnly(parent)).toBe(true);
    expect(matchesClassification(parent, ['unknown'], ['codex'])).toBe(true);
    expect(matchesClassification(parent, ['user-global'], ['codex'])).toBe(false);
  });
  it('marks shared sources only for the same physical source under distinct Agents', async () => {
    const file = path.join(home, '.codex', 'config.toml');
    const rows = ['codex', 'claude-code'].map(agentId => baseBinding({ context: { instance: instance(agentId) },
      kind: 'mcp', name: 'same', scope: 'native', sourceKind: 'user', sourcePath: file, nativeKey: 'mcp.same', origin: 'configuration' }));
    const separate = baseBinding({ context: { instance: instance('zcode') }, kind: 'mcp', name: 'same', scope: 'native',
      sourceKind: 'user', sourcePath: path.join(home, '.zcode', 'cli', 'config.json'), nativeKey: 'mcp.same', origin: 'configuration' });
    const differentKey = baseBinding({ context: { instance: instance('zcode') }, kind: 'mcp', name: 'other', scope: 'native',
      sourceKind: 'user', sourcePath: file, nativeKey: 'mcp.other', origin: 'configuration' });
    await report([...rows, separate, differentKey], []);
    const catalog: Catalog = { instances: [], projects: [], bindings: [...rows, separate, differentKey], lastScanAt: null };
    const classified = classifyCatalog(catalog);
    expect(classified.bindings).toHaveLength(4);
    expect(classified.bindings[0]!.classification?.sharedSource?.agentIds).toEqual(['claude-code', 'codex']);
    expect(classified.bindings[2]!.classification?.sharedSource).toBeUndefined();
    expect(classified.bindings[3]!.classification?.sharedSource).toBeUndefined();
    expect(matchesClassification(classified.bindings[0]!, [], ['shared'])).toBe(true);
    expect(classifyCatalog({ ...classified, bindings: [classified.bindings[0]!] }).bindings[0]!.classification?.sharedSource).toBeUndefined();
  });
  it('does not invent classification for old indexes or unknown Agent ownership', () => {
    const legacy = { scope: 'native', instanceId: 'old' } as Binding;
    expect(matchesClassification(legacy, ['unknown'], ['unknown'])).toBe(true);
    expect(matchesClassification(legacy, ['user-global'], ['codex'])).toBe(false);
    expect(classifyCatalog({ instances: [], projects: [], bindings: [legacy], lastScanAt: null }).bindings[0]?.classification).toBeUndefined();
  });
  it('uses exact Claude user installation records and keeps missing scope unknown', async () => {
    const cache = path.join(home, '.claude', 'plugins', 'cache', 'test-market', 'test-plugin', '1.0.0');
    await mkdir(path.join(cache, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(cache, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', mcpServers: { test: { command: 'never-run' } } }));
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    await writeFile(registry, JSON.stringify({ plugins: { 'test-plugin@test-market': [{ scope: 'user', version: '1.0.0', installPath: cache }],
      'unknown@test-market': [{ version: '9.0.0' }] } }));
    const result = await createAdapterRegistry().find(a => a.id === 'claude-code')!.scan({ instance: instance('claude-code') });
    const cached = result.bindings.filter(b => b.pluginId === 'test-plugin@test-market');
    expect(cached.length).toBeGreaterThan(1);
    expect(cached.every(b => b.classification?.scope === 'user-global')).toBe(true);
    expect(cached.every(b => b.classification?.evidencePath === registry)).toBe(true);
    expect(result.bindings.find(b => b.pluginId === 'unknown@test-market')?.classification?.scope).toBe('unknown');
  });
  it('separates user libraries, Agent inventory location and unknown use scope without claiming sharing', async () => {
    const library = path.join(home, '.agents', 'skills', 'library-skill');
    await mkdir(library, { recursive: true });
    await writeFile(path.join(library, 'SKILL.md'), '---\nname: library-skill\n---\nfixture');
    const projectLibrary = path.join(project.rootPath, '.agents', 'skills', 'project-library');
    await mkdir(projectLibrary, { recursive: true });
    await writeFile(path.join(projectLibrary, 'SKILL.md'), 'fixture');
    await addPluginCacheFixture(home, project.rootPath);
    const before = await fileTreeDigests(directory);
    const result = await createAdapterRegistry().find(a => a.id === 'codex')!.scan({ instance: instance('codex'), project });
    const user = result.bindings.find(b => b.name === 'library-skill')!;
    const local = result.bindings.find(b => b.name === 'project-library')!;
    const orphan = result.bindings.find(b => b.name === 'unconfigured-review')!;
    expect(inventoryCategory(user)).toBe('user-global');
    expect(user.classification?.agentId).toBeNull();
    expect(user.classification?.discoveredByAgentId).toBe('codex');
    expect(matchesClassification(user, [], ['codex'])).toBe(false);
    expect(matchesClassification(user, [], ['public'])).toBe(true);
    expect(inventoryCategory(local)).toBe('project');
    expect(user.classification?.sharedSource).toBeUndefined();
    expect(inventoryCategory(orphan)).toBe('agent-global');
    expect(orphan.classification?.scope).toBe('unknown');
    expect(orphan.classification?.location?.rootPath).toBe(instance('codex').configRoot);
    expect(matchesClassification(orphan, ['unknown'], ['codex'], ['agent-global'])).toBe(true);
    expect(matchesClassification(orphan, [], ['codex'], ['user-global'])).toBe(false);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('binds project plugins to every matching cached version and keeps global originals and safe states', async () => {
    await addPluginCacheFixture(home, project.rootPath);
    for (const agentId of ['codex', 'claude-code']) {
      const result = await createAdapterRegistry().find(a => a.id === agentId)!.scan({ instance: instance(agentId), project });
      const projectParent = result.bindings.find(b => b.projectId === project.id && b.kind === 'plugin' && b.pluginId?.includes(agentId === 'codex' ? 'fixture-tools' : 'claude-tools'))!;
      const projectChildren = result.bindings.filter(b => b.parentId === projectParent.id);
      expect(projectChildren.length).toBeGreaterThan(1);
      for (const child of projectChildren) {
        expect(inventoryCategory(child)).toBe('agent-project');
        expect(child.classification?.scope).toBe('project');
        expect(child.classification?.location?.category).toBe('agent-global');
        expect(child.sourcePath).toContain(`${path.sep}cache${path.sep}`);
        expect(child.configurationSourcePath).toBe(projectParent.configurationSourcePath);
        expect(child.writable).toBe(false);
        expect(child.enabled).toBe(true);
        expect(result.bindings.some(original => original.resourceId === child.resourceId && original.projectId === null)).toBe(true);
      }
      if (agentId === 'codex') expect(new Set(projectChildren.map(b => b.pluginVersion))).toEqual(new Set(['1.0.0', '2.0.0']));
      expect(new Set(result.bindings.map(b => b.id)).size).toBe(result.bindings.length);
    }
  });
  it('records remote installation markers without guessing version, use scope or enablement', async () => {
    await addPluginCacheFixture(home, project.rootPath);
    const marker = path.join(home, '.codex', 'plugins', 'cache', 'other-market', 'fixture-tools', '.codex-remote-plugin-install.json');
    await writeFile(marker, JSON.stringify({ schema_version: 1, remote_plugin_id: 'synthetic-plugin-id', secret: 'PRIVATE_INSTALL_SENTINEL' }));
    const result = await createAdapterRegistry().find(a => a.id === 'codex')!.scan({ instance: instance('codex') });
    const cached = result.bindings.filter(b => b.pluginId === 'fixture-tools@other-market');
    expect(cached.length).toBeGreaterThan(1);
    expect(cached.every(b => b.classification?.installationEvidence?.path === marker)).toBe(true);
    expect(cached.every(b => b.classification?.installationEvidence?.scope === 'unknown')).toBe(true);
    expect(cached.every(b => b.classification?.scope === 'unknown' && b.enabled === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INSTALL_SENTINEL');
    await writeFile(marker, JSON.stringify({ schema_version: 999, remote_plugin_id: 'synthetic-plugin-id' }));
    const unknown = await createAdapterRegistry().find(a => a.id === 'codex')!.scan({ instance: instance('codex') });
    expect(unknown.bindings.filter(b => b.pluginId === 'fixture-tools@other-market').every(b => !b.classification?.installationEvidence)).toBe(true);
  });
  it('rescans exactly the registered projects, replaces stale classifications and rejects unregistered IDs', async () => {
    const other = path.join(directory, 'registered-two');
    const outside = path.join(directory, 'unregistered');
    for (const [root, name] of [[other, 'registered-two'], [outside, 'must-not-find']]) {
      await mkdir(path.join(root!, '.codex'), { recursive: true });
      await writeFile(path.join(root!, '.codex', 'config.toml'), `[mcp_servers.${name}]\ncommand = "never-run"\n`);
    }
    const store = createStore(path.join(directory, 'manager-data'));
    try {
      const manager = new ManagerService({ store, adapters: createAdapterRegistry(), homeDir: home, env: {}, isolationRoot: directory });
      const first = manager.registerProject({ rootPath: project.rootPath, name: project.name });
      const second = manager.registerProject({ rootPath: other, name: '另一个登记项目' });
      const result = await manager.scan({ discover: true, scanRegisteredProjects: true });
      expect(result.bindings.some(b => b.projectId === first.id)).toBe(true);
      expect(result.bindings.some(b => b.projectId === second.id && b.name === 'registered-two')).toBe(true);
      expect(result.bindings.some(b => b.name === 'must-not-find')).toBe(false);
      await expect(manager.scan({ projectId: 'unregistered' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      await writeFile(path.join(other, '.codex', 'config.toml'), '[mcp_servers.changed]\ncommand = "never-run"\n');
      const refreshed = await manager.scan({ scanRegisteredProjects: true });
      expect(refreshed.bindings.some(b => b.projectId === second.id && b.name === 'registered-two')).toBe(false);
      expect(refreshed.bindings.find(b => b.projectId === second.id && b.name === 'changed')?.classification?.category).toBe('agent-project');
    } finally { store.close(); }
  });
  it('does not attach project components from a mismatched cached manifest identity', async () => {
    await addPluginCacheFixture(home, project.rootPath);
    const manifest = path.join(home, '.codex', 'plugins', 'cache', 'fixture-market', 'fixture-tools', '1.0.0', '.codex-plugin', 'plugin.json');
    await writeFile(manifest, JSON.stringify({ name: 'different-plugin' }));
    const result = await createAdapterRegistry().find(a => a.id === 'codex')!.scan({ instance: instance('codex'), project });
    const parent = result.bindings.find(b => b.projectId === project.id && b.pluginId === 'fixture-tools@fixture-market')!;
    expect(result.bindings.filter(b => b.parentId === parent.id).every(b => b.pluginVersion === '2.0.0')).toBe(true);
    expect(result.bindings.some(b => b.parentId === parent.id)).toBe(true);
  });
  it('validates nested inventory evidence and distinguishes servers in the same manifest', async () => {
    const context = { instance: instance('codex') };
    const common = { context, kind: 'mcp' as const, scope: 'native' as const, sourceKind: 'plugin' as const,
      sourcePath: path.join(home, '.codex', 'config.toml'), parentId: 'parent', configurationKey: 'plugins.shared' };
    const a = baseBinding({ ...common, name: 'server-a', nativeKey: 'plugin.server-a' });
    const b = baseBinding({ ...common, context: { instance: instance('claude-code') }, name: 'server-b', nativeKey: 'plugin.server-b' });
    await report([a, b], []);
    expect(a.classification?.sourceIdentity).not.toBe(b.classification?.sourceIdentity);
    const classified = classifyCatalog({ instances: [], projects: [], bindings: [a, b], lastScanAt: null });
    expect(classified.bindings.every(row => !row.classification?.sharedSource)).toBe(true);
    expect(ResourceClassificationSchema.safeParse(a.classification).success).toBe(true);
    expect(ResourceClassificationSchema.safeParse({ ...a.classification, location: { category: 'agent-global', rootPath: 42 } }).success).toBe(false);
    expect(ResourceClassificationSchema.safeParse({ ...a.classification, installationEvidence: { path: '/file', scope: 'invented', reason: '' } }).success).toBe(false);
  });
  it('ignores DSH package-manager YAML and keeps dynamic plugin declarations read-only', async () => {
    const profile = path.join(home, '.dsh', 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n - never-import\n');
    await writeFile(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(path.join(profile, 'cordis.patch.yml'), '- id: test-dynamic\n  name: "@deepseek-ai/dsh-mcp-client"\n  disabled: !!js >\n    throw new Error("MUST_NOT_RUN");\n  config:\n    serverName: dynamic\n');
    const result = await createAdapterRegistry().find(a => a.id === 'deepseek-harness')!.scan({ instance: instance('deepseek-harness') });
    const dynamic = result.bindings.find(b => b.kind === 'mcp' && b.name === 'dynamic')!;
    expect(dynamic.enabled).toBeNull();
    expect(dynamic.classification?.category).toBe('agent-global');
    expect(dynamic.writable).toBe(false);
    expect(result.diagnostics.some(note => note.includes('未使用受支持的静态插件行序列'))).toBe(false);
    expect(result.bindings.some(b => /pnpm-(?:lock|workspace)/.test(b.sourcePath))).toBe(false);
  });
});
