import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInstance } from '@agentdeck/contracts';
import { createAdapterRegistry } from '../packages/adapters/src/index';
import { createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers';

describe('evidence-backed adapter coverage', () => {
  let directory: string;
  let home: string;
  let project: { id: string; name: string; rootPath: string };
  beforeEach(async () => { directory = await createTestDirectory('coverage'); home = path.join(directory, 'home'); project = { id: 'registered', name: 'Coverage project', rootPath: path.join(directory, 'project') }; });
  afterEach(async () => removeTestDirectory(directory));
  async function file(target: string, text: string) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); }
  async function json(target: string, value: unknown) { await file(target, JSON.stringify(value)); }
  function instance(agentId: string): AgentInstance { const folder = { zcode: '.zcode', 'claude-code': '.claude', 'deepseek-harness': '.dsh' }[agentId]; return { id: agentId, agentId, name: agentId, configRoot: path.join(home, folder!), version: null, executable: null, discovery: 'manual', writable: false, checkedAt: '', diagnostics: [] }; }
  async function scan(agentId: string, withProject = false) { return createAdapterRegistry().find(a=>a.id===agentId)!.scan({ instance: instance(agentId), ...(withProject ? { project } : {}) }); }
  it('reads ZCode desktop per-manifest switches and documented default without matching names or executing resources', async () => {
    const root = instance('zcode').configRoot;
    const off = path.join(root, 'skills', 'off');
    const on = path.join(root, 'skills', 'on');
    const common = path.join(home, '.agents', 'skills', 'common');
    const scoped = path.join(project.rootPath, '.zcode', 'skills', 'off');
    const malformed = path.join(root, 'skills', 'malformed');
    const nested = path.join(root, 'skills', 'group', 'deeper', 'nested');
    for (const dir of [off, on, common, scoped, malformed, nested]) await file(path.join(dir, 'SKILL.md'), 'fixture');
    await json(path.join(root, 'cli/config.json'), { skills: {
      [path.join(off, 'SKILL.md').split(path.sep).join('/')]: { enable: false },
      [path.join(malformed, 'SKILL.md')]: { enable: 'false' },
      [path.join(nested, 'SKILL.md')]: { enable: true },
      'off': { enable: false },
    } });
    const before = await fileTreeDigests(directory);
    const result = await scan('zcode', true);
    expect(result.bindings.find(b => b.sourcePath === off)?.enabled).toBe(false);
    expect(result.bindings.find(b => b.sourcePath === on)?.enabled).toBe(true);
    expect(result.bindings.find(b => b.sourcePath === scoped)?.enabled).toBe(true);
    const publicSkill = result.bindings.find(b => b.sourcePath === common)!;
    expect(publicSkill.enabled).toBe(true);
    expect(publicSkill.classification?.agentId).toBeNull();
    expect(publicSkill.configurationControl?.mode).toBe('independent');
    expect(result.bindings.find(b => b.sourcePath === malformed)?.enabled).toBeNull();
    expect(result.bindings.find(b => b.sourcePath === nested)?.enabled).toBe(true);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('keeps plugin disablement and unknown cache state while honoring explicit ZCode child Skill switches', async () => {
    const root = instance('zcode').configRoot;
    const skills = [true, false].map((_, index) => path.join(root, 'cli/plugins/cache/market', `p${index}`, '1/skills/child'));
    for (const [index, dir] of skills.entries()) {
      await json(path.join(root, 'cli/plugins/cache/market', `p${index}`, '1/.zcode-plugin/plugin.json'), { name: `p${index}` });
      await file(path.join(dir, 'SKILL.md'), 'fixture');
    }
    await json(path.join(root, 'cli/config.json'), { plugins: { enabledPlugins: { 'p0@market': true, 'p1@market': false } }, skills: {
      [path.join(skills[0]!, 'SKILL.md')]: { enable: false }, [path.join(skills[1]!, 'SKILL.md')]: { enable: true },
    } });
    const result = await scan('zcode');
    for (const dir of skills) {
      const skill = result.bindings.find(b => b.sourcePath === dir)!;
      expect(skill.enabled).toBe(false);
      expect(skill.configurationControl?.mode).toBe('independent');
      expect(skill.writable).toBe(false);
    }
  });
  it('defaults missing ZCode Skill configuration but keeps malformed configuration unknown', async () => {
    const root = instance('zcode').configRoot;
    await file(path.join(root, 'skills/off/SKILL.md'), 'fixture');
    expect((await scan('zcode')).bindings.find(b => b.kind === 'skill')?.enabled).toBe(true);
    await json(path.join(root, 'cli/config.json'), { skills: 'invalid' });
    expect((await scan('zcode')).bindings.find(b => b.kind === 'skill')?.enabled).toBeNull();
  });
  it('reads ZCode desktop cache components, every version, installation proof, MCP files and safe disabled states', async () => {
    const root = instance('zcode').configRoot;
    await json(path.join(root, 'cli/config.json'), { plugins: { enabledPlugins: { 'tools@market': false } } });
    const versions = ['1.0.0', '2.0.0'];
    for (const version of versions) {
      const pkg = path.join(root, 'cli/plugins/cache/market/tools', version);
      await json(path.join(pkg, '.zcode-plugin/plugin.json'), { name: 'tools', skills: ['skills'], mcpServers: { same: { url: 'https://example.invalid', type: 'http', env: { TOKEN: 'PRIVATE_SENTINEL' } } } });
      await file(path.join(pkg, 'skills/review/SKILL.md'), 'fixture');
      await json(path.join(pkg, '.mcp.json'), { mcpServers: { same: { command: 'never-run' }, other: { command: 'never-run' } } });
    }
    await json(path.join(root, 'cli/plugins/installed_plugins.json'), { plugins: [{ id: 'tools@market', version: '1.0.0', scope: 'user', installPath: path.join(root, 'cli/plugins/cache/market/tools/1.0.0'), private: 'PRIVATE_SENTINEL' }] });
    const before = await fileTreeDigests(directory);
    const result = await scan('zcode');
    const parents = result.bindings.filter(b=>b.kind==='plugin' && b.origin==='cache');
    expect(parents).toHaveLength(2);
    expect(result.bindings.filter(b=>b.kind==='skill')).toHaveLength(2);
    expect(result.bindings.filter(b=>b.name==='same').every(b=>b.mcpTransport==='http')).toBe(true);
    expect(result.bindings.filter(b=>b.parentId).every(b=>b.enabled===false && !b.writable)).toBe(true);
    expect(parents.find(b=>b.pluginVersion==='1.0.0')?.classification?.installationEvidence?.scope).toBe('user-global');
    expect(parents.find(b=>b.pluginVersion==='2.0.0')?.classification?.installationEvidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('keeps conflicting ZCode identities unconfigured and excludes outside package declarations', async () => {
    const root = instance('zcode').configRoot;
    await json(path.join(root, 'cli/config.json'), { plugins: { enabledPlugins: { 'tools@market': true } } });
    const pkg = path.join(root, 'cli/plugins/cache/market/tools/1');
    await json(path.join(pkg, '.claude-plugin/plugin.json'), { name: 'wrong', skills: '../../../../outside', mcpServers: '../../../../outside.json' });
    const result = await scan('zcode');
    const parent = result.bindings.find(b=>b.origin==='cache')!;
    expect(parent.enabled).toBeNull(); expect(parent.pluginIdentityVerified).toBe(false);
    expect(parent.configurationSourcePath).toBeUndefined();
    expect(result.bindings.filter(b=>b.parentId)).toHaveLength(0);
    expect(result.diagnostics.some(d=>d.includes('越界'))).toBe(true);
  });
  it('reads the native project config, enable=false and generic MCP fallback only in empty native scopes', async () => {
    const root = instance('zcode').configRoot;
    await json(path.join(root, 'cli/config.json'), { mcp: { servers: { native: { command: 'never-run', enable: false } } } });
    await json(path.join(home, '.agents/mcp.json'), { mcpServers: { skipped: { command: 'never-run' } } });
    await json(path.join(project.rootPath, '.zcode/config.json'), { mcp: { servers: { native: { command: 'never-run' } } } });
    await json(path.join(project.rootPath, '.agents/mcp.json'), { mcpServers: { skippedProject: { command: 'never-run' } } });
    let result = await scan('zcode', true);
    expect(result.bindings.filter(b=>b.name==='native').map(b=>b.enabled)).toEqual([false, true]);
    expect(result.bindings.some(b=>b.name.startsWith('skipped'))).toBe(false);
    await json(path.join(project.rootPath, '.zcode/config.json'), {});
    result = await scan('zcode', true);
    const fallback = result.bindings.find(b=>b.name==='skippedProject')!;
    expect(fallback.projectId).toBe(project.id); expect(fallback.classification?.category).toBe('project');
    expect(fallback.classification?.agentId).toBeNull(); expect(fallback.classification?.discoveredByAgentId).toBe('zcode');
  });
  it('reads Claude project-local MCP from user state only for the registered project and retains same-name declarations', async () => {
    await json(path.join(home, '.claude.json'), { mcpServers: { same: { command: 'never-run' } }, projects: { [project.rootPath]: { mcpServers: { same: { command: 'never-run', env: { TOKEN: 'PRIVATE_SENTINEL' } } } }, [path.join(directory, 'unregistered')]: { mcpServers: { hidden: { command: 'never-run' } } } } });
    await json(path.join(project.rootPath, '.mcp.json'), { mcpServers: { same: { command: 'never-run' } } });
    const before = await fileTreeDigests(directory);
    expect((await scan('claude-code')).bindings.filter(b=>b.name==='same')).toHaveLength(1);
    const result = await scan('claude-code', true);
    expect(result.bindings.filter(b=>b.name==='same')).toHaveLength(3);
    expect(result.bindings.some(b=>b.name==='hidden')).toBe(false);
    const local = result.bindings.find(b=>b.configurationKey?.startsWith('projects['))!;
    expect(local.classification?.scope).toBe('project'); expect(local.classification?.category).toBe('agent-project');
    expect(local.sourceKind).toBe('user'); expect(local.classification?.location?.category).toBe('agent-global');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL'); expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('indexes DSH user insert patch declarations and leaves dynamic values unknown without execution', async () => {
    await file(path.join(instance('deepseek-harness').configRoot, 'cordis.patch.yml'), "- insert:\n    - id: memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: !!js 'throw new Error(\"MUST_NOT_RUN\")'\n      config:\n        serverName: memory\n        transport: stdio\n        command: never-run\n");
    const before = await fileTreeDigests(directory);
    const result = await scan('deepseek-harness');
    const mcp = result.bindings.find(b=>b.kind==='mcp')!;
    expect(mcp.name).toBe('memory'); expect(mcp.enabled).toBeNull(); expect(mcp.classification?.scope).toBe('user-global');
    expect(mcp.parentId).toBe(result.bindings.find(b=>b.kind==='plugin')?.id);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
});
