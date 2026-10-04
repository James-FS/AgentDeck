import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../packages/adapters/src/index';
import { configurationState } from '../apps/web/src/configuration-state';
import { createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers';
import type { AgentInstance } from '../packages/contracts/src/index';

describe('Skill roots and native switch records', () => {
  let directory: string;
  let home: string;
  let project: { id: string; name: string; rootPath: string };
  beforeEach(async () => { directory = await createTestDirectory('skill-locations'); home = path.join(directory, 'home'); project = { id: 'registered', name: 'Registered project', rootPath: path.join(directory, 'project') }; });
  afterEach(async () => removeTestDirectory(directory));
  async function file(target: string, text: string) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); }
  async function json(target: string, value: unknown) { await file(target, JSON.stringify(value)); }
  function instance(agentId: string): AgentInstance { return { id: agentId, agentId, name: agentId, configRoot: path.join(home, agentId === 'codex' ? '.codex' : agentId === 'claude-code' ? '.claude' : '.dsh'), version: null, executable: null, discovery: 'manual', writable: false, checkedAt: '', diagnostics: [] }; }
  async function scan(agentId: string, scoped = false) { return createAdapterRegistry().find(a => a.id === agentId)!.scan({ instance: instance(agentId), ...(scoped ? { project } : {}) }); }
  it('reads Codex public, built-in and registered project path overrides without opening write authorization', async () => {
    const common = path.join(home, '.agents/skills/same');
    const builtin = path.join(home, '.codex/skills/.system/same');
    const local = path.join(project.rootPath, '.codex/skills/same');
    const unspecified = path.join(home, '.agents/skills/unspecified');
    for (const root of [common, builtin, local, unspecified]) await file(path.join(root, 'SKILL.md'), 'fixture');
    const config = path.join(home, '.codex/config.toml');
    await file(config, `[[skills.config]]\npath = ${JSON.stringify(path.join(common, 'SKILL.md'))}\nenabled = false\n[[skills.config]]\npath = ${JSON.stringify(path.join(builtin, 'SKILL.md'))}\nenabled = true\n`);
    const projectConfig = path.join(project.rootPath, '.codex/config.toml');
    await file(projectConfig, `[[skills.config]]\npath = ${JSON.stringify(path.join(local, 'SKILL.md'))}\nenabled = false\n`);
    const before = await fileTreeDigests(directory);
    const result = await scan('codex', true);
    const same = result.bindings.filter(b => b.kind === 'skill' && b.name === 'same');
    expect(same).toHaveLength(3);
    expect(same.find(b => b.sourcePath === common)?.enabled).toBe(false);
    expect(same.find(b => b.sourcePath === common)?.classification?.agentId).toBeNull();
    expect(same.find(b => b.sourcePath === builtin)?.enabled).toBe(true);
    expect(same.find(b => b.sourcePath === local)?.configurationSourcePath).toBe(projectConfig);
    expect(same.every(b => !b.writable && b.configurationControl?.mode === 'independent')).toBe(true);
    expect(result.bindings.find(b => b.sourcePath === unspecified)?.enabled).toBe(true);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('honors explicit public disablement among duplicate Codex overrides and never discovers arbitrary configured paths', async () => {
    const root = path.join(home, '.agents/skills/ambiguous');
    await file(path.join(root, 'SKILL.md'), 'fixture');
    const key = JSON.stringify(path.join(root, 'SKILL.md'));
    await file(path.join(home, '.codex/config.toml'), `[[skills.config]]\npath = ${key}\nenabled = false\n[[skills.config]]\npath = ${key}\nenabled = true\n[[skills.config]]\npath = ${JSON.stringify(path.join(directory, 'unregistered/SKILL.md'))}\nenabled = true\n`);
    await file(path.join(directory, 'unregistered/SKILL.md'), 'never-discover');
    const result = await scan('codex');
    expect(result.bindings.find(b => b.name === 'ambiguous')?.enabled).toBe(false);
    expect(result.bindings.some(b => b.sourcePath.includes('unregistered'))).toBe(false);
  });
  it('reads all four Claude visibility states and preserves per-name project/local provenance', async () => {
    const root = path.join(home, '.claude');
    const states = { normal: 'on', brief: 'name-only', manual: 'user-invocable-only', hidden: 'off' };
    for (const name of Object.keys(states)) await file(path.join(root, 'skills', name, 'SKILL.md'), 'fixture');
    for (const name of ['shared', 'local']) await file(path.join(project.rootPath, '.claude/skills', name, 'SKILL.md'), 'fixture');
    await json(path.join(root, 'settings.json'), { skillOverrides: states });
    const sharedSettings = path.join(project.rootPath, '.claude/settings.json');
    const localSettings = path.join(project.rootPath, '.claude/settings.local.json');
    await json(sharedSettings, { skillOverrides: { shared: 'off', local: 'off' } });
    await json(localSettings, { skillOverrides: { local: 'user-invocable-only' } });
    const before = await fileTreeDigests(directory);
    const result = await scan('claude-code', true);
    for (const [name, visibility] of Object.entries(states)) expect(result.bindings.find(b => b.name === name)?.configurationControl?.visibility).toBe(visibility);
    expect(configurationState(result.bindings.find(b => b.name === 'brief')!).label).toBe('已启用');
    expect(configurationState(result.bindings.find(b => b.name === 'manual')!).label).toBe('已启用');
    expect(result.bindings.find(b => b.name === 'shared')?.configurationSourcePath).toBe(sharedSettings);
    expect(result.bindings.find(b => b.name === 'local')?.configurationSourcePath).toBe(localSettings);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('keeps missing Claude user roots valid and public discoveries separate from native configuration records', async () => {
    await file(path.join(project.rootPath, '.agents/skills/shared/SKILL.md'), 'fixture');
    await json(path.join(project.rootPath, '.claude/settings.json'), { skillOverrides: { shared: 'off', invalid: true } });
    await json(path.join(home, '.claude.json'), { skillUsage: { shared: 100 }, enabledPlugins: { 'fake@market': true } });
    const result = await scan('claude-code', true);
    const shared = result.bindings.filter(b => b.name === 'shared');
    expect(shared).toHaveLength(2);
    expect(shared.find(b => b.origin === 'filesystem')?.enabled).toBeNull();
    expect(shared.find(b => b.origin === 'configuration')?.enabled).toBe(false);
    expect(result.bindings.find(b => b.name === 'invalid')?.enabled).toBeNull();
    expect(result.bindings.some(b => b.pluginId === 'fake@market')).toBe(false);
  });
  it('reads DSH native user/project roots but ignores audit hashes, usage state and logs as switches', async () => {
    const root = instance('deepseek-harness').configRoot;
    await file(path.join(root, 'skills/latex-resume/SKILL.md'), 'fixture');
    await file(path.join(project.rootPath, '.dsh/skills/resume-optimizer/SKILL.md'), 'fixture');
    await json(path.join(root, 'skill-manager-ytxue.checked.json'), { enabled: false, disabled: true, skill: 'latex-resume', hash: 'AUDIT_PRIVATE_SENTINEL' });
    await file(path.join(root, 'skill-manager-ytxue.log'), '启用，开始规范审计 LOG_PRIVATE_SENTINEL');
    const before = await fileTreeDigests(directory);
    const result = await scan('deepseek-harness', true);
    const skills = result.bindings.filter(b => b.kind === 'skill');
    expect(skills).toHaveLength(2);
    expect(skills.every(b => b.enabled === true && b.configurationControl?.mode === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
});
