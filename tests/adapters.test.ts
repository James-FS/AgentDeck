import path from 'node:path';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../packages/adapters/src/index.ts';
import type { AgentInstance, AgentAdapter } from '../packages/contracts/src/index.ts';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';

describe('independent adapter verification', () => {
  let directory: string;
  let home: string;
  let projectRoot: string;
  let registry: AgentAdapter[];

  beforeEach(async () => {
    directory = await createTestDirectory('adapters');
    const fixture = await copyCatalogFixture(directory);
    home = fixture.home;
    projectRoot = fixture.project;
    registry = createAdapterRegistry();
  });
  afterEach(async () => removeTestDirectory(directory));

  function instance(agentId: string): AgentInstance {
    const suffix: Record<string, string> = {
      codex: '.codex', 'claude-code': '.claude', zcode: '.zcode', 'deepseek-harness': '.dsh',
    };
    return {
      id: `fixture-${agentId}`, agentId, name: agentId,
      configRoot: path.join(home, suffix[agentId]!), version: null, executable: null,
      discovery: 'manual', writable: false, checkedAt: new Date().toISOString(), diagnostics: [],
    };
  }

  function adapter(agentId: string): AgentAdapter {
    const result = registry.find((entry) => entry.id === agentId);
    if (!result) throw new Error(`Missing adapter: ${agentId}`);
    return result;
  }

  it('registers the four clients through a registry', () => {
    expect(registry.map((entry) => entry.id).sort()).toEqual(
      ['codex', 'claude-code', 'zcode', 'deepseek-harness'].sort(),
    );
    expect(new Set(registry.map((entry) => entry.id)).size).toBe(registry.length);
  });

  it('discovers fixture config roots as read-only without inventing client versions', async () => {
    for (const entry of registry) {
      const discovered = await entry.discover({ homeDir: home, env: {} });
      expect(discovered.length, entry.id).toBeGreaterThan(0);
      expect(discovered.every((item) => item.writable === false), entry.id).toBe(true);
      expect(discovered.every((item) => item.version === null), entry.id).toBe(true);
    }
  });

  it('scans configuration without changing any source files or leaking authentication values', async () => {
    const before = await fileTreeDigests(directory);
    for (const entry of registry) {
      const report = await entry.scan({ instance: instance(entry.id) });
      expect(report.bindings.length, entry.id).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toContain('AGENTDECK_SECRET_SENTINEL');
      expect(report.bindings.every((binding) => binding.runtime === 'unknown'), entry.id).toBe(true);
      expect(report.bindings.every((binding) => binding.writable === false), entry.id).toBe(true);
      expect(report.bindings.every((binding) => ['configuration', 'cache', 'filesystem'].includes(binding.origin ?? '')), entry.id).toBe(true);
    }
    expect(await fileTreeDigests(directory)).toEqual(before);
  });

  it('keeps binding identity stable across repeated scans', async () => {
    for (const entry of registry) {
      const first = await entry.scan({ instance: instance(entry.id) });
      const second = await entry.scan({ instance: instance(entry.id) });
      expect(second.bindings.map((binding) => binding.id).sort(), entry.id)
        .toEqual(first.bindings.map((binding) => binding.id).sort());
    }
  });

  it('reads quoted Codex MCP server names and explicit enabled states', async () => {
    const report = await adapter('codex').scan({ instance: instance('codex') });
    const mcp = report.bindings.filter((binding) => binding.kind === 'mcp');
    expect(mcp.find((binding) => binding.name === 'docs')?.enabled).toBe(true);
    expect(mcp.find((binding) => binding.name === 'server.with-dot')?.enabled).toBe(false);
  });

  it('includes Codex system skills and excludes plugin infrastructure directories', async () => {
    const systemSkill = path.join(home, '.codex', 'skills', '.system', 'builtin-review');
    await mkdir(systemSkill, { recursive: true });
    await writeFile(path.join(systemSkill, 'SKILL.md'), '---\nname: builtin-review\ndescription: Fixture builtin skill.\n---\n');
    await mkdir(path.join(home, '.codex', 'plugins', 'cache'), { recursive: true });
    await mkdir(path.join(home, '.codex', 'plugins', '.plugin-appserver'), { recursive: true });
    const before = await fileTreeDigests(home);
    const result = await adapter('codex').scan({ instance: instance('codex') });
    expect(result.bindings.find(item => item.name === 'builtin-review')?.sourceKind).toBe('builtin');
    expect(result.bindings.some(item => item.kind === 'plugin' && ['cache', '.plugin-appserver'].includes(item.name))).toBe(false);
    expect(await fileTreeDigests(home)).toEqual(before);
  });

  it('uses bounded frontmatter only for Skill display, leaving native identity stable', async () => {
    const skillDir = path.join(home, '.codex', 'skills', 'stable-directory');
    const manifest = path.join(skillDir, 'SKILL.md');
    await mkdir(skillDir, { recursive: true });
    await writeFile(manifest, '---\nname: "Friendly Skill"\ndescription: >\n  Helps review\n  local files.\n---\nNo execution.\n');
    const first = (await adapter('codex').scan({ instance: instance('codex') })).bindings.find(item => item.sourcePath === skillDir)!;
    expect(first.name).toBe('stable-directory');
    expect(first.displayName).toBe('Friendly Skill');
    expect(first.description).toBe('Helps review local files.');
    await writeFile(manifest, '---\nname: "Renamed title"\ndescription: Updated summary.\n---\nNo execution.\n');
    const second = (await adapter('codex').scan({ instance: instance('codex') })).bindings.find(item => item.sourcePath === skillDir)!;
    expect(second.displayName).toBe('Renamed title');
    expect(second.id).toBe(first.id);
    expect(second.nativeKey).toBe(first.nativeKey);
    await writeFile(manifest, '---\nname: [invalid, title]\ndescription: {not: a scalar}\n---\nNo execution.\n');
    const fallback = (await adapter('codex').scan({ instance: instance('codex') })).bindings.find(item => item.sourcePath === skillDir)!;
    expect(fallback.displayName).toBeUndefined();
    expect(fallback.name).toBe('stable-directory');
    expect(fallback.description).toBe('Skill 来自有限本地目录扫描。');
  });

  it('finds grouped Skills without treating them as client-loaded or controllable', async () => {
    const root = path.join(home, '.codex', 'skills');
    const grouped = path.join(root, 'collection', 'grouped-review');
    const otherGroup = path.join(root, 'another-collection', 'grouped-review');
    const deep = path.join(root, 'one', 'two', 'three', 'too-deep');
    const outside = path.join(directory, 'outside-group');
    await mkdir(grouped, { recursive: true });
    await mkdir(otherGroup, { recursive: true });
    await mkdir(deep, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(grouped, 'SKILL.md'), '---\nname: Grouped Review\ndescription: Read-only grouped fixture.\n---\n');
    await writeFile(path.join(otherGroup, 'SKILL.md'), '---\nname: Grouped Review\ndescription: Same name, separate source.\n---\n');
    await writeFile(path.join(deep, 'SKILL.md'), '---\nname: Hidden by depth\n---\n');
    await writeFile(path.join(outside, 'SKILL.md'), '---\nname: Outside\n---\n');
    const link = path.join(root, 'linked-group');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const before = await fileTreeDigests(home);
      const report = await adapter('codex').scan({ instance: instance('codex') });
      const skill = report.bindings.find(item => item.sourcePath === grouped)!;
      expect(skill.name).toBe('grouped-review');
      expect(skill.displayName).toBe('Grouped Review');
      expect(skill.discoveryOnly).toBe(true);
      expect(skill.discoveryPath).toBe('collection/grouped-review');
      const peer = report.bindings.find(item => item.sourcePath === otherGroup)!;
      expect(peer.discoveryPath).toBe('another-collection/grouped-review');
      expect(peer.id).not.toBe(skill.id);
      expect(skill.enabled).toBeNull();
      expect(skill.writable).toBe(false);
      expect(skill.runtime).toBe('unknown');
      expect(skill.diagnostics.some(message => message.includes('仅为磁盘发现'))).toBe(true);
      expect(report.bindings.some(item => item.sourcePath === deep || item.sourcePath === outside)).toBe(false);
      expect(await fileTreeDigests(home)).toEqual(before);
    } finally {
      await rm(link);
    }
  });

  it('distinguishes Claude skill availability from its user source and global scope', async () => {
    const report = await adapter('claude-code').scan({ instance: instance('claude-code') });
    const skill = report.bindings.find((binding) => binding.name === 'claude-review' && binding.kind === 'skill');
    expect(skill).toBeDefined();
    expect(skill?.enabled).toBe(false);
    expect(skill?.scope).toBe('user-global');
    expect(skill?.sourceKind).toBe('user');
    expect(skill?.compatibilityClass).toBe('unknown');
  });

  it('does not apply Claude name overrides to a grouped disk-only Skill', async () => {
    const grouped = path.join(home, '.claude', 'skills', 'collection', 'claude-review');
    await mkdir(grouped, { recursive: true });
    await writeFile(path.join(grouped, 'SKILL.md'), '---\nname: Displayed Review\n---\n');
    const report = await adapter('claude-code').scan({ instance: instance('claude-code') });
    const skill = report.bindings.find(item => item.sourcePath === grouped)!;
    expect(skill.displayName).toBe('Displayed Review');
    expect(skill.enabled).toBeNull();
    expect(skill.configurationEnabled).toBeUndefined();
    expect(skill.runtime).toBe('unknown');
  });

  it('marks project resources as repository sources without making every skill portable', async () => {
    const report = await adapter('codex').scan({
      instance: instance('codex'),
      project: { id: 'fixture-project', name: 'Fixture', rootPath: projectRoot },
    });
    const skill = report.bindings.find((binding) => binding.name === 'project-review' && binding.kind === 'skill');
    expect(skill).toBeDefined();
    expect(skill?.scope).toBe('project');
    expect(skill?.sourceKind).toBe('repository');
    expect(skill?.compatibilityClass).toBe('unknown');
  });

  it('reports DSH dynamic disabled expressions as unknown instead of evaluating them', async () => {
    const report = await adapter('deepseek-harness').scan({ instance: instance('deepseek-harness') });
    const dynamic = report.bindings.find((binding) => binding.kind === 'mcp'
      && (binding.name === 'dynamic' || binding.nativeKey.includes('mcp-dynamic')));
    expect(dynamic).toBeDefined();
    expect(dynamic?.enabled).toBeNull();
  });

  it('keeps DSH project Skills and profiles inside the registered root', async () => {
    const target = path.join(directory, 'outside-dsh');
    await mkdir(path.join(target, 'skills', 'escaped-dsh-skill'), { recursive: true });
    await writeFile(path.join(target, 'skills', 'escaped-dsh-skill', 'SKILL.md'), 'fixture');
    await mkdir(path.join(target, 'profiles', 'web'), { recursive: true });
    await writeFile(path.join(target, 'profiles', 'web', 'cordis.patch.yml'), '- id: escaped-dsh-mcp\n  name: "@deepseek-ai/dsh-mcp-client"\n  disabled: false\n  config:\n    serverName: escaped-dsh-mcp\n');
    const link = path.join(projectRoot, '.dsh');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = await adapter('deepseek-harness').scan({ instance: instance('deepseek-harness'), project: { id: 'project-dsh', name: 'Project', rootPath: projectRoot } });
      expect(result.bindings.some(item => item.name.startsWith('escaped-dsh-'))).toBe(false);
    } finally {
      await rm(link);
    }
  });

  it('reports malformed TOML instead of pretending the client has an empty valid catalog', async () => {
    await writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.broken\nurl = "invalid"\n');
    const report = await adapter('codex').scan({ instance: instance('codex') });
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });
});
