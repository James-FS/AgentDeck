import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSkillSource } from '../packages/core/src/skill-sources.js';
import { ManagerService } from '../packages/core/src/index.js';
import { createStore, type AgentDeckStore } from '../packages/storage/src/index.js';
import { SkillSourceSchema } from '../packages/contracts/src/index.js';

const temporary: string[] = [];
async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdeck-skill-sources-'));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))); });

describe('custom Skill source scanning', () => {
  it('validates nested persisted reports before they reach the UI', () => {
    const invalid = { id: 'x', path: 'C:/skills', mode: 'deep', followLinks: false, scannedAt: null,
      report: { status: 'complete', rootPath: 'C:/skills', candidateCount: 'one', recognizedCount: 0, skippedCount: 0,
        visitedDirectories: 1, limits: {}, truncatedAt: null, diagnostics: [], findings: [] } };
    expect(SkillSourceSchema.safeParse(invalid).success).toBe(false);
  });

  it('persists independent resource sources across restart and refreshes additions and deletions', async () => {
    const root = await tempDir();
    const data = path.join(root, 'data');
    const library = path.join(root, 'library');
    const skill = path.join(library, 'new-skill', 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '---\nname: new-skill\ndescription: Added later.\n---');
    let store: AgentDeckStore = createStore(data);
    const manager = new ManagerService({ store, adapters: [], homeDir: root });
    const registered = await manager.registerSkillSource({ path: library });
    expect(registered.report?.recognizedCount).toBe(1);
    expect(manager.catalog().bindings).toHaveLength(0);
    store.close();
    store = createStore(data);
    const restarted = new ManagerService({ store, adapters: [], homeDir: root });
    expect(restarted.catalog().skillSources).toHaveLength(1);
    await rm(skill);
    const refreshed = await restarted.scanRegisteredSkillSource(registered.id);
    expect(refreshed.report?.recognizedCount).toBe(0);
    store.close();
  });

  it('merges concurrent registrations and does not resurrect an entry removed during scanning', async () => {
    const root = await tempDir();
    const slowRoot = path.join(root, 'slow');
    const fastRoot = path.join(root, 'fast');
    for (let index = 0; index < 40; index += 1) {
      const folder = path.join(slowRoot, `skill-${index}`);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Slow.\n---`);
    }
    await mkdir(fastRoot, { recursive: true });
    await writeFile(path.join(fastRoot, 'SKILL.md'), '---\nname: fast\ndescription: Fast.\n---');
    const store: AgentDeckStore = createStore(path.join(root, 'data'));
    try {
      const manager = new ManagerService({ store, adapters: [], homeDir: root });
      const [slow, fast] = await Promise.all([
        manager.registerSkillSource({ path: slowRoot, mode: 'deep' }),
        manager.registerSkillSource({ path: fastRoot, mode: 'deep' }),
      ]);
      expect(manager.catalog().skillSources?.map(item => item.id).sort()).toEqual([slow.id, fast.id].sort());
      expect(slow.report?.recognizedCount).toBe(40);
      const pending = manager.scanRegisteredSkillSource(slow.id);
      manager.removeSkillSource(slow.id);
      await expect(pending).rejects.toMatchObject({ code: 'SKILL_SOURCE_NOT_FOUND' });
      expect(manager.catalog().skillSources?.map(item => item.id)).toEqual([fast.id]);
    } finally { store.close(); }
  });

  it('recognizes a Skill at the registered root and keeps malformed manifests as candidates', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'SKILL.md'), '---\nname: standalone\ndescription: one\n---\nbody');
    await mkdir(path.join(root, 'bad'));
    await writeFile(path.join(root, 'bad', 'SKILL.md'), 'not frontmatter');
    const report = await scanSkillSource({ id: 'x', path: root, mode: 'quick', followLinks: false, scannedAt: null, report: null });
    expect(report.status).toBe('complete');
    expect(report.candidateCount).toBe(2);
    expect(report.recognizedCount).toBe(1);
    expect(report.findings.find(item => item.name === 'bad')?.status).toBe('candidate');
  });

  it('recognizes the registered root manifest before applying the directory-entry cap', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'SKILL.md'), '---\nname: root-probe\ndescription: Root manifest.\n---');
    await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(path.join(root, `A${String(index).padStart(5, '0')}.txt`), 'x')));
    const report = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(report.recognizedCount).toBe(1);
    expect(report.status).toBe('partial');
    expect(report.continuationPath).toBeNull();
    expect(report.diagnostics.some(message => message.startsWith('，'))).toBe(false);
    expect(report.diagnostics.join(' ')).toContain('每目录 2000 个直接子项上限');
  });

  it('keeps templates under a recognized Skill package auxiliary, while allowing an explicitly registered template root', async () => {
    const root = await tempDir();
    const template = path.join(root, 'assets', 'template');
    await mkdir(template, { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), '---\nname: parent\ndescription: Parent Skill.\n---');
    await writeFile(path.join(template, 'SKILL.md'), '---\nname: template\ndescription: Example template.\n---');
    const packageReport = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(packageReport.recognizedCount).toBe(1);
    expect(packageReport.findings.find(item => item.name === 'template')?.status).toBe('skipped');
    expect(packageReport.findings.find(item => item.name === 'template')?.reason).toContain('assets 资源目录');
    const explicitReport = await scanSkillSource({ id: 'y', path: template, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(explicitReport.recognizedCount).toBe(1);
  });

  it('discovers explicit hidden project entries while excluding repository and dependency noise', async () => {
    const root = await tempDir();
    for (const [directory, name] of [['.agents/skills/real', 'real'], ['.claude/skills/claude', 'claude'],
      ['.codex/skills/codex', 'codex'], ['.dsh/skills/dsh', 'dsh'], ['.git/skills/fake', 'git-fake'],
      ['node_modules/pkg/skills/fake', 'module-fake']] as const) {
      const folder = path.join(root, directory);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture.\n---`);
    }
    const report = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(report.recognizedCount).toBe(4);
    expect(report.findings.map(item => item.name)).not.toContain('git-fake');
    expect(report.findings.map(item => item.name)).not.toContain('module-fake');
  });

  it('accepts UTF-8 BOM before frontmatter', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'SKILL.md'), '\uFEFF---\nname: probe\ndescription: Probe.\n---\n');
    const report = await scanSkillSource({ id: 'x', path: root, mode: 'quick', followLinks: false, scannedAt: null, report: null });
    expect(report.recognizedCount).toBe(1);
  });

  it('reports quick and deep depth boundaries as partial with actionable truncation locations', async () => {
    const root = await tempDir();
    const nestedSkill = path.join(root, 'quick', 'group', 'real');
    await mkdir(nestedSkill, { recursive: true });
    await writeFile(path.join(nestedSkill, 'SKILL.md'), '---\nname: deep-probe\ndescription: Deep.\n---');
    const quick = await scanSkillSource({ id: 'x', path: root, mode: 'quick', followLinks: false, scannedAt: null, report: null });
    expect(quick.status).toBe('partial');
    expect(quick.truncatedAt).toBe(path.join(root, 'quick', 'group'));
    expect(quick.continuationPath).toBe(quick.truncatedAt);
    expect(quick.diagnostics.join(' ')).toContain('最大深度 1');
    const eightDeep = path.join(root, ...Array.from({ length: 9 }, (_, i) => `level-${i}`));
    await mkdir(eightDeep, { recursive: true });
    const deep = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(deep.status).toBe('partial');
    expect(deep.diagnostics.join(' ')).toContain('最大深度 8');
  });

  it('keeps example manifests from being mistaken for available Skills', async () => {
    const root = await tempDir();
    await mkdir(path.join(root, 'examples', 'demo'), { recursive: true });
    await writeFile(path.join(root, 'examples', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: example\n---');
    const report = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(report.findings[0]?.status).toBe('skipped');
    expect(report.findings[0]?.reason).toContain('示例');
  });

  it('does not follow links unless enabled and limits followed targets to the registered root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await mkdir(path.join(outside, 'linked'));
    await writeFile(path.join(outside, 'linked', 'SKILL.md'), '---\nname: outside\ndescription: out\n---');
    await symlink(path.join(outside, 'linked'), path.join(root, 'external'), 'junction');
    const skipped = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: false, scannedAt: null, report: null });
    expect(skipped.findings.some(item => item.reason.includes('默认不跟随'))).toBe(true);
    const followed = await scanSkillSource({ id: 'x', path: root, mode: 'deep', followLinks: true, scannedAt: null, report: null });
    expect(followed.recognizedCount).toBe(0);
    expect(followed.findings.some(item => item.reason.includes('越出登记目录边界'))).toBe(true);
  });
});
