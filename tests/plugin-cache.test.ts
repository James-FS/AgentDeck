import path from 'node:path';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../packages/adapters/src/index.ts';
import type { AgentInstance, Binding } from '../packages/contracts/src/index.ts';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';
import { addPluginCacheFixture } from './plugin-fixtures.ts';

describe('plugin cache and project source integrity', () => {
  let directory: string;
  let home: string;
  let projectRoot: string;
  beforeEach(async () => {
    directory = await createTestDirectory('plugin-cache');
    ({ home, project: projectRoot } = await copyCatalogFixture(directory));
    await addPluginCacheFixture(home, projectRoot);
  });
  afterEach(async () => removeTestDirectory(directory));
  function instance(agentId: string): AgentInstance {
    const root = { codex: '.codex', 'claude-code': '.claude', zcode: '.zcode' }[agentId]!;
    return { id: `cache-${agentId}`, agentId, name: agentId, configRoot: path.join(home, root), version: null, executable: null, discovery: 'manual', writable: false, checkedAt: new Date().toISOString(), diagnostics: [] };
  }
  async function scan(agentId: string, withProject = false) {
    const adapter = createAdapterRegistry().find(item => item.id === agentId)!;
    return adapter.scan({ instance: instance(agentId), ...(withProject ? { project: { id: 'project-one', name: 'Project', rootPath: projectRoot } } : {}) });
  }
  function assertChildren(bindings: Binding[], names: string[]) {
    for (const name of names) {
      const children = bindings.filter(item => item.name === name);
      expect(children.length, name).toBeGreaterThan(0);
      for (const child of children) {
        const parent = bindings.find(item => item.id === child.parentId);
        expect(parent?.kind).toBe('plugin');
        expect(child.projectId).toBe(parent?.projectId);
        expect(child.sourceKind).toBe('plugin');
        expect(child.writable).toBe(false);
        expect(child.runtime).toBe('unknown');
      }
    }
  }
  it('indexes every Codex cache version with parent links and keeps unconfigured marketplace state unknown', async () => {
    const before = await fileTreeDigests(home);
    const report = await scan('codex');
    assertChildren(report.bindings, ['cached-review-1.0.0', 'cached-review-2.0.0', 'cached-docs', 'unconfigured-review']);
    const cached = report.bindings.filter(item => item.sourcePath.includes(`${path.sep}cache${path.sep}`));
    expect(cached.filter(item => item.kind === 'plugin' && item.name === 'fixture-tools')).toHaveLength(3);
    for (const item of cached) {
      expect(item.origin).toBe('cache');
      expect(item.cacheState).toBe('present');
      expect(item.pluginId).toBeDefined();
      expect(item.pluginVersion).toBeDefined();
    }
    const associated = cached.find(item => item.name === 'cached-review-1.0.0')!;
    expect(associated.configurationSourcePath).toBe(path.join(home, '.codex/config.toml'));
    expect(associated.configurationEnabled).toBe(false);
    expect(associated.pluginId).toBe('fixture-tools@fixture-market');
    expect(associated.pluginVersion).toBe('1.0.0');
    expect(cached.filter(item => item.name === 'unconfigured-review').every(item => item.enabled === null)).toBe(true);
    expect(cached.filter(item => item.sourcePath.includes('fixture-market') && item.name.startsWith('cached-')).every(item => item.enabled === false)).toBe(true);
    expect(report.bindings.some(item => ['cache', '.plugin-appserver', 'marketplaces', 'data'].includes(item.name))).toBe(false);
    expect(JSON.stringify(report)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect(await fileTreeDigests(home)).toEqual(before);
    expect((await scan('codex')).bindings.map(item => item.id).sort()).toEqual(report.bindings.map(item => item.id).sort());
  });
  it('rejects declared paths outside a cached package', async () => {
    const report = await scan('codex');
    expect(report.bindings.some(item => item.name === 'must-not-import')).toBe(false);
    expect([...report.diagnostics, ...report.bindings.flatMap(item => item.diagnostics)].some(message => /越界|包内|相对路径/.test(message))).toBe(true);
  });
  it('reads a declared single-Skill directory and inline MCP without exposing its environment', async () => {
    const root = path.join(home, '.codex/plugins/cache/fixture-market/custom-tools/1.0.0');
    await mkdir(path.join(root, '.codex-plugin'), { recursive: true });
    await mkdir(path.join(root, 'custom', 'single-review'), { recursive: true });
    await writeFile(path.join(root, 'custom', 'single-review', 'SKILL.md'), '---\nname: Single Review Title\ndescription: Plugin skill summary.\n---\nfixture');
    await writeFile(path.join(root, '.codex-plugin/plugin.json'), JSON.stringify({
      name: 'custom-tools', version: '1.0.0', skills: ['./custom/single-review'],
      mcpServers: { 'inline-cache-docs': { command: 'fixture-only', env: { TOKEN: 'AGENTDECK_SECRET_SENTINEL' } } },
    }));
    const report = await scan('codex');
    assertChildren(report.bindings, ['single-review', 'inline-cache-docs']);
    const skill = report.bindings.find(item => item.name === 'single-review')!;
    expect(skill.displayName).toBe('Single Review Title');
    expect(skill.description).toBe('Plugin skill summary.');
    expect(JSON.stringify(report)).not.toContain('AGENTDECK_SECRET_SENTINEL');
  });
  it('keeps invalid plugin MCP enabled values unknown even when its parent is explicitly enabled', async () => {
    const configFile = path.join(home, '.codex/config.toml');
    await writeFile(configFile, (await readFile(configFile, 'utf8')).replace('[plugins."fixture-tools@fixture-market"]\nenabled = false', '[plugins."fixture-tools@fixture-market"]\nenabled = true'));
    const mcpFile = path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools/1.0.0/.mcp.json');
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { 'invalid-state-docs': { enabled: 'unknown-expression', command: 'fixture-only' } } }));
    const report = await scan('codex');
    expect(report.bindings.find(item => item.name === 'invalid-state-docs')?.enabled).toBeNull();
  });
  it('does not associate a conflicting manifest name with a configured cache folder identity', async () => {
    const file = path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools/1.0.0/.codex-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, name: 'different-tools' }));
    const report = await scan('codex');
    const conflicting = report.bindings.find(item => item.kind === 'plugin' && item.sourcePath === file)!;
    expect(conflicting.enabled).toBeNull();
    expect(conflicting.diagnostics.some(message => /身份|名称|冲突/.test(message))).toBe(true);
  });
  it('does not follow an intermediate junction in a declared skill path', async () => {
    const root = path.join(home, '.codex/plugins/cache/fixture-market/junction-tools/1.0.0');
    await mkdir(path.join(root, '.codex-plugin'), { recursive: true });
    await writeFile(path.join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'junction-tools', skills: './linked/skills' }));
    const target = path.join(directory, 'outside');
    await mkdir(path.join(target, 'skills', 'junction-secret'), { recursive: true });
    await writeFile(path.join(target, 'skills', 'junction-secret', 'SKILL.md'), 'fixture');
    await symlink(target, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect((await scan('codex')).bindings.some(item => item.name === 'junction-secret')).toBe(false);
    } finally {
      await rm(path.join(root, 'linked'));
    }
  });
  it('indexes Claude installed cache components and propagates explicit parent disable', async () => {
    const before = await fileTreeDigests(home);
    const report = await scan('claude-code');
    assertChildren(report.bindings, ['claude-cache-review', 'claude-cache-docs']);
    expect(report.bindings.filter(item => ['claude-cache-review', 'claude-cache-docs'].includes(item.name)).every(item => item.enabled === false)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect(await fileTreeDigests(home)).toEqual(before);
  });
  it('preserves directly installed Claude plugin components while excluding infrastructure containers', async () => {
    const root = path.join(home, '.claude/plugins/direct-tools');
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await mkdir(path.join(root, 'skills', 'direct-review'), { recursive: true });
    await writeFile(path.join(root, 'skills/direct-review/SKILL.md'), 'fixture');
    await writeFile(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'direct-tools', mcpServers: { 'direct-docs': { command: 'fixture-only' } } }));
    const report = await scan('claude-code', true);
    assertChildren(report.bindings, ['direct-review', 'direct-docs']);
    expect(report.bindings.filter(item => ['direct-review', 'direct-docs'].includes(item.name)).every(item => item.projectId === null)).toBe(true);
    expect(report.bindings.some(item => ['cache', 'data', 'marketplaces', '.plugin-appserver'].includes(item.name))).toBe(false);
  });
  it('keeps stale Claude installation registration visible without treating missing cache as available', async () => {
    const installedFile = path.join(home, '.claude/plugins/installed_plugins.json');
    await writeFile(installedFile, JSON.stringify({ version: 2, plugins: {
      'missing-tools@fixture-market': [{ scope: 'user', installPath: path.join(home, '.claude/plugins/cache/fixture-market/missing-tools/9.0.0'), version: '9.0.0' }],
    } }));
    const report = await scan('claude-code');
    const missing = report.bindings.find(item => item.pluginId === 'missing-tools@fixture-market');
    expect(missing?.kind).toBe('plugin');
    expect(missing?.cacheState).toBe('missing');
    expect(missing?.enabled).toBeNull();
    expect(missing?.runtime).toBe('unknown');
    expect(missing?.writable).toBe(false);
  });
  it('keeps Codex project configuration separate from global sources and read-only', async () => {
    const report = await scan('codex', true);
    const projectMcp = report.bindings.find(item => item.name === 'project-docs');
    expect(projectMcp?.projectId).toBe('project-one');
    expect(projectMcp?.scope).toBe('project');
    expect(projectMcp?.sourceKind).toBe('repository');
    expect(projectMcp?.writable).toBe(false);
    expect(projectMcp?.sourcePath).toBe(path.join(projectRoot, '.codex/config.toml'));
    expect(report.bindings.find(item => item.name === 'docs')?.projectId).toBeNull();
    expect(report.bindings.find(item => item.name === 'project-review')?.projectId).toBe('project-one');
    expect(new Set(report.bindings.map(item => item.id)).size).toBe(report.bindings.length);
  });
  it('does not scan project configuration or skills through an intermediate junction', async () => {
    const target = path.join(directory, 'outside-project');
    await mkdir(path.join(target, 'skills', 'junction-project-skill'), { recursive: true });
    await writeFile(path.join(target, 'skills', 'junction-project-skill', 'SKILL.md'), 'fixture');
    await writeFile(path.join(target, 'config.toml'), '[mcp_servers.junction-project-mcp]\ncommand = "fixture-only"\n');
    await rm(path.join(projectRoot, '.codex'), { recursive: true });
    await rm(path.join(projectRoot, '.agents'), { recursive: true });
    await symlink(target, path.join(projectRoot, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(target, path.join(projectRoot, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const report = await scan('codex', true);
      expect(report.bindings.some(item => item.name.startsWith('junction-project-'))).toBe(false);
    } finally {
      await rm(path.join(projectRoot, '.codex'));
      await rm(path.join(projectRoot, '.agents'));
    }
  });
  it('does not let Claude project plugin settings contaminate user-global children', async () => {
    const report = await scan('claude-code', true);
    assertChildren(report.bindings, ['claude-cache-review', 'claude-cache-docs']);
    const global = report.bindings.filter(item => ['claude-cache-review', 'claude-cache-docs'].includes(item.name) && item.projectId === null);
    expect(global).toHaveLength(2);
    expect(global.every(item => item.enabled === false)).toBe(true);
    const projectPlugins = report.bindings.filter(item => item.kind === 'plugin' && item.projectId === 'project-one');
    expect(projectPlugins.some(item => item.enabled === true)).toBe(true);
  });
  it('indexes observed ZCode configured plugin identities separately in user and project layers', async () => {
    const userFile = path.join(home, '.zcode/cli/config.json');
    const existing = JSON.parse(await readFile(userFile, 'utf8'));
    await writeFile(userFile, JSON.stringify({ ...existing, plugins: { enabledPlugins: { 'fixture-tools@fixture-market': true, 'unknown-tools@fixture-market': 'on' } } }));
    const projectFile = path.join(projectRoot, '.zcode/cli/config.json');
    await mkdir(path.dirname(projectFile), { recursive: true });
    await writeFile(projectFile, JSON.stringify({ plugins: { enabledPlugins: { 'fixture-tools@fixture-market': false } } }));
    const report = await scan('zcode', true);
    const configured = report.bindings.filter(item => item.kind === 'plugin' && item.pluginId === 'fixture-tools@fixture-market');
    expect(configured).toHaveLength(2);
    expect(configured.find(item => item.projectId === null)?.enabled).toBe(true);
    expect(configured.find(item => item.projectId === 'project-one')?.enabled).toBe(false);
    expect(configured.every(item => item.origin === 'configuration' && item.runtime === 'unknown' && !item.writable)).toBe(true);
    expect(configured.find(item => item.projectId === 'project-one')?.sourcePath).toBe(projectFile);
    expect(report.bindings.find(item => item.pluginId === 'unknown-tools@fixture-market')?.enabled).toBeNull();
  });
});
