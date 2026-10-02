import path from 'node:path';
import { writeFile } from 'node:fs/promises';
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

  it('distinguishes Claude skill availability from its user source and global scope', async () => {
    const report = await adapter('claude-code').scan({ instance: instance('claude-code') });
    const skill = report.bindings.find((binding) => binding.name === 'claude-review' && binding.kind === 'skill');
    expect(skill).toBeDefined();
    expect(skill?.enabled).toBe(false);
    expect(skill?.scope).toBe('user-global');
    expect(skill?.sourceKind).toBe('user');
    expect(skill?.compatibilityClass).toBe('unknown');
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

  it('reports malformed TOML instead of pretending the client has an empty valid catalog', async () => {
    await writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.broken\nurl = "invalid"\n');
    const report = await adapter('codex').scan({ instance: instance('codex') });
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });
});
