import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rename, symlink } from 'node:fs/promises';
import { deepSeekHarnessAdapter } from '../packages/adapters/src/deepseek-harness';
import type { AgentInstance } from '@agentdeck/contracts';
import { createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers';

const BUNDLED_PATCH = [
  '- insert:',
  "    - id: skill-filesystem",
  "      name: '@deepseek-ai/dsh-skill-filesystem'",
  "    - id: skill-badge",
  "      name: '@deepseek-ai/dsh-skill-badge'",
  '      disabled: true',
  "    - id: hmr",
  "      name: '@deepseek-ai/dsh-hmr'",
  '      disabled: !!js "!ctx.get(\'profileContext\')"',
  "    - id: mcp-resources",
  "      name: '@deepseek-ai/dsh-mcp-resources'",
  "    - id: grouped",
  "      name: 'cordis:group'",
  '      group: true',
].join('\n');

describe('DSH bundled provenance without running the client', () => {
  let directory: string, home: string, app: string, profiles: string;
  async function file(p: string, value: string) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, value); }
  beforeEach(async () => {
    directory = await createTestDirectory('dsh-builtins');
    home = path.join(directory, 'home');
    app = path.join(home, '.dsh/app/node_modules/@deepseek-ai');
    profiles = path.join(home, '.dsh/profiles');
    await file(path.join(app, 'dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }));
    await file(path.join(app, 'dsh-base/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.7-rc.2' }));
    await file(path.join(app, 'dsh-base/cordis.patch.yml'), BUNDLED_PATCH);
    await file(path.join(app, 'dsh-hmr/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-hmr', version: '0.1.7-rc.2' }));
    await file(path.join(app, 'dsh-skill-office/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-skill-office', version: '0.1.7-rc.2' }));
    await file(path.join(app, 'dsh-skill-office/assets/office-docx/SKILL.md'), 'bundled office guidance');
    await file(path.join(app, 'dsh-skill-office/assets/office-pptx/SKILL.md'), 'bundled slides guidance');
    await file(path.join(app, 'dsh-agent-preset/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-preset', version: '0.1.7-rc.2' }));
    await file(path.join(app, 'dsh-agent-preset/skills/cordis-plugin-development/SKILL.md'), 'bundled preset authoring');
    await file(path.join(home, '.dsh/skills/latex-resume/SKILL.md'), 'user authored resume guidance');
    await file(path.join(home, '.dsh/skills/office-docx/SKILL.md'), 'bundled office guidance');
    await file(path.join(profiles, 'desktop/cordis.patch.yml'), "- id: memory\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: memory\n");
    await file(path.join(profiles, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }));
    await file(path.join(profiles, 'node_modules/@deepseek-ai/dsh-base/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.7-rc.2' }));
    await file(path.join(profiles, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), BUNDLED_PATCH);
  });
  afterEach(async () => removeTestDirectory(directory));
  function instance(): AgentInstance {
    return { id: 'dsh', agentId: 'deepseek-harness', name: 'DeepSeek Harness', configRoot: path.join(home, '.dsh'), version: null, executable: null, discovery: 'manual', writable: false, checkedAt: '', diagnostics: [] };
  }
  const scan = () => deepSeekHarnessAdapter.scan({ instance: instance() });

  it('inventories bundled resources while retaining separate installation paths and user sources, stays read-only', async () => {
    const before = await fileTreeDigests(directory);
    const report = await scan();
    const rows = report.bindings.filter(b => b.sourceKind === 'builtin' && b.kind === 'plugin');
    expect(rows.length).toBe(8);
    expect(rows.every(b => b.origin === 'filesystem' && b.enabled === null && b.writable === false)).toBe(true);
    expect(new Set(rows.map(b => b.builtinSourcePath)).size).toBe(2);
    const badge = rows.find(b => b.nativeKey.includes('skill-badge'))!;
    expect(badge.diagnostics.some(note => note.includes('disabled: true'))).toBe(true);
    const hmr = rows.find(b => b.nativeKey.includes('hmr'))!;
    expect(hmr.diagnostics.some(note => note.includes('动态表达式'))).toBe(true);
    expect(rows.some(b => b.nativeKey.includes('grouped'))).toBe(false);
    expect(rows.some(b => b.nativeKey.includes('profiles/'))).toBe(true);

    const userCopy = report.bindings.find(b => b.sourcePath === path.join(home, '.dsh', 'skills', 'office-docx'))!;
    expect(userCopy.sourceKind).toBe('user');
    expect(userCopy.builtinSourcePath).toBeUndefined();
    expect(userCopy.diagnostics.some(note => note.includes('未比较辅助文件'))).toBe(true);
    expect(report.bindings.filter(b => b.name === 'office-docx' && b.kind === 'skill')).toHaveLength(2);
    const pptx = report.bindings.find(b => b.name === 'office-pptx')!;
    expect(pptx.sourceKind).toBe('builtin');
    expect(pptx.enabled).toBeNull();
    expect(pptx.writable).toBe(false);
    expect(pptx.configurationStateReason).toContain('未确定');
    expect(pptx.classification?.location?.category).toBe('agent-global');
    const presetSkill = report.bindings.find(b => b.name === 'cordis-plugin-development')!;
    expect(presetSkill.sourceKind).toBe('builtin');
    expect(presetSkill.classification?.location?.reason).toContain('creator mode');
    const user = report.bindings.find(b => b.name === 'latex-resume')!;
    expect(user.sourceKind).toBe('user');
    expect(user.builtinSourcePath).toBeUndefined();
    expect(await fileTreeDigests(directory)).toEqual(before);
  });

  it('keeps an altered user copy and the bundled record separately instead of matching by name', async () => {
    await file(path.join(home, '.dsh/skills/office-docx/SKILL.md'), 'user modified office guidance');
    const report = await scan();
    const copies = report.bindings.filter(b => b.name === 'office-docx' && b.kind === 'skill');
    expect(copies).toHaveLength(2);
    expect(copies.find(b => b.sourcePath === path.join(home, '.dsh', 'skills', 'office-docx'))?.sourceKind).toBe('user');
    expect(copies.find(b => b.sourceKind === 'builtin')?.builtinSourcePath).toBe(path.join(app, 'dsh-skill-office/assets/office-docx/SKILL.md'));
  });

  it('does not reclassify project copies or merge differing auxiliary files when SKILL.md matches', async () => {
    const project = { id: 'registered', name: 'project', rootPath: path.join(directory, 'project') };
    const projectSkill = path.join(project.rootPath, '.dsh/skills/office-docx');
    await file(path.join(projectSkill, 'SKILL.md'), 'bundled office guidance');
    await file(path.join(projectSkill, 'scripts/helper.js'), 'project-specific code, never execute');
    await file(path.join(home, '.dsh/skills/office-docx/scripts/helper.js'), 'user-specific code, never execute');
    const before = await fileTreeDigests(directory);
    const report = await deepSeekHarnessAdapter.scan({ instance: instance(), project });
    const copies = report.bindings.filter(b => b.name === 'office-docx' && b.kind === 'skill');
    expect(copies).toHaveLength(3);
    const projectBinding = copies.find(b => b.projectId === project.id)!;
    expect(projectBinding.sourceKind).toBe('repository'); expect(projectBinding.builtinSourcePath).toBeUndefined();
    expect(projectBinding.classification?.category).toBe('agent-project');
    expect(copies.find(b => b.sourceKind === 'user')?.enabled).toBe(true);
    expect(copies.find(b => b.sourceKind === 'builtin')?.enabled).toBe(null);
    expect(await fileTreeDigests(directory)).toEqual(before);
  });

  it('requires the layer package identity and never treats dynamic names or structural groups as plugins', async () => {
    await file(path.join(app, 'dsh-base/package.json'), JSON.stringify({ name: '@other/package', version: '1' }));
    await file(path.join(profiles, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), '- id: dynamic\n  name: !!js "process.exit()"\n- id: group\n  name: cordis:group\n  group: true\n');
    const report = await scan();
    expect(report.bindings.filter(b => b.kind === 'plugin' && b.sourceKind === 'builtin')).toHaveLength(0);
    expect(report.bindings.some(b => b.name === 'latex-resume')).toBe(true);
  });

  it('never scans unofficial install directories next to the documented roots', async () => {
    const legacy = path.join(profiles, 'node_modules-old-rc6/@deepseek-ai');
    await file(path.join(legacy, 'dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }));
    await file(path.join(legacy, 'dsh-base/cordis.patch.yml'), BUNDLED_PATCH);
    const report = await scan();
    expect(report.bindings.filter(b => b.sourceKind === 'builtin').length).toBeGreaterThan(0);
    expect(report.bindings.every(b => !JSON.stringify(b.builtinSourcePath ?? '').includes('node_modules-old-rc6'))).toBe(true);
    expect(report.bindings.every(b => !(b.nativeKey.includes('builtin:') && b.nativeKey.includes('0.1.0')))).toBe(true);
  });

  it('does not follow a linked install marker into an external directory', async () => {
    const outside = path.join(directory, 'outside-marker');
    await rename(path.join(app, 'dsh'), outside);
    await symlink(outside, path.join(app, 'dsh'), 'junction');
    const report = await scan();
    expect(report.bindings.every(b => !(b.builtinSourcePath ?? '').startsWith(app))).toBe(true);
    expect(report.bindings.some(b => b.name === 'latex-resume')).toBe(true);
  });

  it('inventories only static bundled MCP names and keeps them unknown without executing expressions', async () => {
    await file(path.join(app, 'dsh-base/cordis.patch.yml'), "- id: mcp-static\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: bundled-server\n    transport: stdio\n- id: mcp-dynamic\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: !!js 'process.exit()'\n");
    const report = await scan();
    const mcp = report.bindings.filter(b => b.kind === 'mcp' && b.sourceKind === 'builtin');
    expect(mcp).toHaveLength(1); expect(mcp[0]?.name).toBe('bundled-server');
    expect(mcp[0]?.enabled).toBe(null); expect(mcp[0]?.writable).toBe(false); expect(mcp[0]?.mcpTransport).toBe('stdio');
    expect(mcp[0]?.parentId).toBeTruthy();
  });

  it('rejects an unverified installation root and still inventories the remaining verified root and user resources', async () => {
    await file(path.join(app, 'dsh/package.json'), JSON.stringify({ name: '@other/cli', version: '0.1.7-rc.2' }));
    const report = await scan();
    expect(report.bindings.every(b => !(b.builtinSourcePath ?? '').startsWith(app))).toBe(true);
    expect(report.bindings.some(b => b.nativeKey.startsWith('builtin:profiles/'))).toBe(true);
    expect(report.bindings.some(b => b.name === 'latex-resume' && b.sourceKind === 'user')).toBe(true);
    expect(report.bindings.some(b => b.kind === 'plugin' && b.origin === 'configuration')).toBe(true);
  });
});
