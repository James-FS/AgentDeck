import { describe, expect, it } from 'vitest';
import type { Binding, Project } from '../packages/contracts/src/index.js';
import { deriveSkillAvailability, pathIsWithin, type SkillFileStatus } from '../apps/web/src/skill-availability.js';

const project: Project = { id: 'project-a', name: 'Project A', rootPath: '/work/project-a' };
function binding(input: Partial<Binding> & Pick<Binding, 'id' | 'name' | 'sourcePath'>): Binding {
  return { id: input.id, name: input.name, sourcePath: input.sourcePath, resourceId: input.resourceId ?? input.id,
    instanceId: input.instanceId ?? 'codex-one', projectId: input.projectId ?? null, kind: 'skill', description: '',
    nativeKey: input.nativeKey ?? input.name, scope: input.scope ?? 'user-global', sourceKind: 'user', compatibilityClass: 'unknown',
    parentId: null, enabled: input.enabled ?? true, writable: false, readOnlyReason: null, diagnostics: [], updatedAt: '2026-10-22T00:00:00Z',
    ...input } as Binding;
}
const present: SkillFileStatus = { disk: 'present', format: 'valid', reason: 'valid' };

describe('Skill availability rules', () => {
  it('keeps out-of-project duplicates out of conflict groups and gives range/disabled states precedence', () => {
    const rows = [
      binding({ id: 'global', name: 'shared', sourcePath: '/home/.agents/skills/shared', enabled: true }),
      binding({ id: 'a', name: 'shared', sourcePath: '/work/project-a/.agents/skills/shared', scope: 'project', projectId: project.id }),
      binding({ id: 'b', name: 'shared', sourcePath: '/work/project-b/.agents/skills/shared', scope: 'project', projectId: 'project-b' }),
      binding({ id: 'disabled', name: 'shared', sourcePath: '/home/disabled/shared', enabled: false }),
    ];
    const result = deriveSkillAvailability({ bindings: rows, projects: [project], instanceId: 'codex-one', projectId: project.id,
      workdir: project.rootPath, files: { global: present, a: present, b: present, disabled: present } });
    expect(result.find(item => item.binding.id === 'global')?.status).toBe('name-conflict');
    expect(result.find(item => item.binding.id === 'a')?.status).toBe('name-conflict');
    expect(result.find(item => item.binding.id === 'b')?.status).toBe('scope-mismatch');
    expect(result.find(item => item.binding.id === 'b')?.conflict).toBe(false);
    expect(result.find(item => item.binding.id === 'disabled')?.status).toBe('disabled');
    expect(result.find(item => item.binding.id === 'disabled')?.conflict).toBe(false);
  });

  it('normalizes path segments, preserves POSIX case and checks workdir against project and subdirectory roots', () => {
    expect(pathIsWithin('/work/project-a/src/../skills', '/work/project-a')).toBe(true);
    expect(pathIsWithin('/work/project-ab', '/work/project-a')).toBe(false);
    expect(pathIsWithin('/Work/Project-A', '/work/project-a')).toBe(false);
    expect(pathIsWithin('C:\\Work\\Project\\src\\..\\skills', 'c:/work/project')).toBe(true);
    const b = binding({ id: 'nested', name: 'nested', sourcePath: '/work/project-a/sub/skills/nested', scope: 'project-directory',
      projectId: project.id, classification: { scope: 'project-directory', agentId: 'codex', relationship: 'discovered', projectName: project.name,
        projectRoot: '/work/project-a/sub', evidencePath: '/work/project-a/sub', reason: 'fixture', contentCompatibility: 'unknown' } });
    const out = deriveSkillAvailability({ bindings: [b], projects: [project], instanceId: 'codex-one', projectId: project.id,
      workdir: '/work/project-a/../outside', files: { nested: present } });
    expect(out[0]?.status).toBe('scope-mismatch');
  });

  it('does not treat duplicate records for one physical source as conflicts, but catches manifest-name collisions', () => {
    const rows = [
      binding({ id: 'same-1', name: 'folder-one', displayName: 'effective-name', sourcePath: '/home/.agents/skills/effective-name' }),
      binding({ id: 'same-2', name: 'folder-two', displayName: 'effective-name', sourcePath: '/home/.agents/skills/../skills/effective-name' }),
      binding({ id: 'different', name: 'other-folder', displayName: 'effective-name', sourcePath: '/home/.agents/skills/other-folder' }),
    ];
    const result = deriveSkillAvailability({ bindings: rows, projects: [], instanceId: 'codex-one', projectId: '', workdir: '',
      files: { 'same-1': present, 'same-2': present, different: present } });
    expect(result.find(item => item.binding.id === 'same-1')?.conflict).toBe(true);
    expect(result.find(item => item.binding.id === 'same-2')?.conflict).toBe(true);
    expect(result.find(item => item.binding.id === 'different')?.conflict).toBe(true);
  });

  it('surfaces missing, unreadable, configuration-only and invalid files without claiming visibility', () => {
    const rows = [binding({ id: 'missing', name: 'collision', sourcePath: '/missing' }),
      binding({ id: 'healthy', name: 'collision', sourcePath: '/healthy' }),
      binding({ id: 'config', name: 'collision', sourcePath: '/home/.codex/config.toml' }),
      binding({ id: 'invalid', name: 'collision', sourcePath: '/home/.agents/skills/invalid' }),
      binding({ id: 'unreadable', name: 'collision', sourcePath: '/home/.agents/skills/secret' })];
    const result = deriveSkillAvailability({ bindings: rows, projects: [], instanceId: 'codex-one', projectId: '', workdir: '', files: {
      missing: { disk: 'missing', format: 'unavailable', reason: 'missing' }, healthy: present,
      config: { disk: 'configuration-only', format: 'unavailable', reason: 'config' },
      invalid: { disk: 'present', format: 'invalid', reason: 'bad yaml' },
      unreadable: { disk: 'unreadable', format: 'unavailable', reason: 'permission denied' },
    } });
    expect(result.map(item => item.status)).toEqual(['file-missing', 'estimated-visible', 'configuration-only', 'format-invalid', 'file-unreadable']);
    expect(result.find(item => item.binding.id === 'healthy')?.conflict).toBe(false);
    expect(result.find(item => item.binding.id === 'healthy')?.status).toBe('estimated-visible');
  });
});
