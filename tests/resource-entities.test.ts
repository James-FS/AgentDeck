import { describe, expect, it } from 'vitest';
import type { Binding } from '../packages/contracts/src/index';
import { deriveEntities, entityStatus, findingEntityIdentity, skillEntityIdentity } from '../apps/web/src/resource-entities';
import { defaultDisplayPolicy, hasBuiltinEvidence, hasConfigurationAssociation, isCacheOnlyRecord } from '../apps/web/src/resource-visibility';
import type { EntityFinding } from '../apps/web/src/resource-entities';

function binding(id: string, extra: Partial<Binding> = {}): Binding {
  return { id, instanceId: 'zcode', projectId: null, name: 'computer-use', kind: 'plugin', scope: 'native', sourceKind: 'plugin', compatibilityClass: 'unknown',
    parentId: null, sourcePath: `C:/fixture/${id}`, nativeKey: id, enabled: null, writable: false, readOnlyReason: 'readonly', diagnostics: [], updatedAt: '',
    pluginId: 'computer-use@official', pluginVersion: id, pluginIdentityVerified: true, origin: 'cache', ...extra };
}

function skill(id: string, extra: Partial<Binding> = {}): Binding {
  const value = binding(id, { kind: 'skill', pluginId: undefined, origin: undefined, sourceKind: 'user', enabled: true, ...extra });
  value.classification = { category: 'user-global', scope: 'user-global', agentId: null, discoveredByAgentId: 'zcode', relationship: 'discovered',
    projectName: null, projectRoot: null, evidencePath: value.sourcePath, reason: 'fixture', contentCompatibility: 'unknown', sourceIdentity: `phys-${id}`,
    location: { category: 'user-global', rootPath: 'C:/fixture/skills', evidencePath: value.sourcePath, reason: 'fixture' } };
  return value;
}

function finding(sourceId: string, logicalPath: string, extra: Partial<EntityFinding> = {}): EntityFinding {
  return { sourceId, findingPath: logicalPath, name: logicalPath.split(/[\\/]/).slice(-2)[0] ?? logicalPath, description: 'independent fixture', status: 'recognized', ...extra };
}

const derive = (bindings: Binding[], findings: EntityFinding[] = [], policy = defaultDisplayPolicy) =>
  deriveEntities({ bindings, findings, policy });

describe('built-in and cache-only display policy', () => {
  it('hides verified built-in records by default and reveals them through the switch, including inherited children', () => {
    const parent = binding('builtin-parent', { sourceKind: 'builtin', builtinSourcePath: 'C:/app/resources/plugin', origin: 'configuration', configurationSourcePath: 'C:/fixture/config.toml' });
    const child = binding('builtin-child', { kind: 'skill', sourceKind: 'plugin', parentId: 'builtin-parent', pluginId: undefined, origin: undefined });
    const byId = new Map([[parent.id, parent], [child.id, child]]);
    expect(hasBuiltinEvidence(parent, byId)).toBe(true);
    expect(hasBuiltinEvidence(child, byId)).toBe(true);
    expect(derive([parent, child]).entities).toHaveLength(0);
    const revealed = derive([parent, child], [], { showBuiltin: true, showCacheOnly: false }).entities;
    // The plugin and its attached Skill are separate entities; both carry built-in evidence.
    expect(revealed).toHaveLength(2);
    expect(revealed.every(entity => entity.builtin)).toBe(true);
  });

  it('never treats agent-global directories, official marketplaces or unknown states as built-in evidence', () => {
    const userSkill = skill('user-in-codex', { sourceKind: 'user', sourcePath: 'C:/fixture/home/.codex/skills/mine' });
    userSkill.classification!.category = 'agent-global';
    userSkill.classification!.location = { category: 'agent-global', rootPath: 'C:/fixture/home/.codex', evidencePath: userSkill.sourcePath, reason: 'fixture' };
    const official = binding('official', { origin: 'configuration', marketplace: 'official', configurationSourcePath: 'C:/fixture/home/.codex/config.toml', enabled: false });
    expect(hasBuiltinEvidence(userSkill, new Map([[userSkill.id, userSkill]]))).toBe(false);
    expect(derive([userSkill, official]).entities).toHaveLength(2);
    expect(derive([userSkill, official]).entities.every(entity => !entity.builtin)).toBe(true);
  });

  it('hides pure cache records without configuration or installation association and keeps disabled configurations visible', () => {
    const pureCache = binding('pure-cache', { pluginId: undefined, name: 'pure-cache-app' });
    const configured = binding('configured', { pluginId: undefined, name: 'configured-app', origin: 'configuration', configurationSourcePath: 'C:/fixture/config.toml', configurationKey: 'plugins.computer-use', enabled: false });
    const installed = binding('installed', { pluginId: undefined, name: 'installed-app', classification: { scope: 'user-global', agentId: 'zcode', relationship: 'configured', projectName: null, projectRoot: null,
      evidencePath: 'C:/fixture/installed.json', reason: 'fixture', contentCompatibility: 'unknown', sourceIdentity: 'phys-installed',
      installationEvidence: { path: 'C:/fixture/installed.json', scope: 'user-global', reason: 'adapter install record' } } });
    expect(isCacheOnlyRecord(pureCache, new Map([[pureCache.id, pureCache]]))).toBe(true);
    expect(hasConfigurationAssociation(configured, new Map([[configured.id, configured]]))).toBe(true);
    expect(hasConfigurationAssociation(installed, new Map([[installed.id, installed]]))).toBe(true);
    const entities = derive([pureCache, configured, installed]).entities;
    expect(entities.map(entity => entity.key).sort()).toEqual(['binding:configured', 'binding:installed']);
    const revealed = derive([pureCache, configured, installed], [], { showBuiltin: false, showCacheOnly: true }).entities;
    expect(revealed).toHaveLength(3);
    expect(revealed.find(entity => entity.key === 'binding:pure-cache')!.visibleBindings).toHaveLength(1);
  });

  it('keeps cache versions of an associated plugin out of the representative state but keeps the plugin visible', () => {
    const configured = binding('config', { origin: 'configuration', pluginVersion: undefined, configurationSourcePath: 'C:/fixture/config.toml', enabled: true });
    const v1 = binding('v1', { writable: true });
    const v2 = binding('v2', { enabled: false });
    const entities = derive([configured, v1, v2]).entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.visibleBindings.map(b => b.id)).toEqual(['config']);
    expect(entities[0]!.hiddenBindings.map(b => b.id).sort()).toEqual(['v1', 'v2']);
    expect(entities[0]!.plugin!.versions).toEqual(['v1', 'v2']);
    expect(entityStatus(entities[0]!).label).toBe('已启用');
  });

  it('counts overlapping hidden reasons on the same entity without double-adding distinct entities', () => {
    const builtinCache = binding('builtin-cache', { sourceKind: 'builtin' });
    const userSkillEntity = skill('plain');
    const collection = derive([builtinCache, userSkillEntity], [], defaultDisplayPolicy);
    expect(collection.entities.map(entity => entity.key)).toEqual(['skill:c:/fixture/plain']);
    expect(entityStatus(collection.entities[0]!).label).toBe('已启用');
  });
});

describe('unified skill entities across bindings and independent findings', () => {
  it('aggregates the same physical skill discovered by several agents and entries into one entity', () => {
    const codexCopy = skill('codex-copy', { instanceId: 'codex', name: 'shared-skill', sourcePath: 'C:/fixture/.agents/skills/shared' });
    codexCopy.classification!.discoveredByAgentId = 'codex';
    const zcodeCopy = skill('zcode-copy', { name: 'shared-skill', sourcePath: 'C:/fixture/.agents/skills/shared' });
    const sharedFinding = finding('source-1', 'C:/fixture/.agents/skills/shared/SKILL.md', { name: 'shared-skill', actualPath: 'C:/fixture/.agents/skills/shared/SKILL.md' });
    const entities = derive([codexCopy, zcodeCopy], [sharedFinding]).entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.bindings).toHaveLength(2);
    expect(entities[0]!.findings).toHaveLength(1);
    expect(entities[0]!.key.startsWith('skill:')).toBe(true);
    expect(entityStatus(entities[0]!).label).toBe('已启用');
  });

  it('unifies the Skill directory and SKILL.md file path conventions through the physical manifest', () => {
    expect(skillEntityIdentity(skill('a', { sourcePath: 'C:/Fixture/Skills/Demo' }))).toBe(findingEntityIdentity(finding('s', 'C:/fixture/skills/demo/SKILL.md', { actualPath: 'C:/Fixture/Skills/Demo\\SKILL.md' })));
  });

  it('keeps old indexes without physical identity separate and never merges same names', () => {
    const oldIndex = skill('old', { name: 'demo' });
    delete oldIndex.classification!.sourceIdentity;
    const modern = skill('modern', { name: 'demo', sourcePath: 'C:/fixture/skills/demo' });
    const sameNameDifferentDir = skill('other', { name: 'demo', sourcePath: 'C:/elsewhere/demo' });
    const entities = derive([oldIndex, modern, sameNameDifferentDir]).entities;
    expect(entities).toHaveLength(3);
    expect(entities.find(entity => entity.key === 'binding:old')).toBeDefined();
    const modernEntity = entities.find(entity => entity.key === 'skill:c:/fixture/skills/demo')!;
    expect(modernEntity.sameNameKeys).toContain('skill:c:/elsewhere/demo');
  });

  it('marks identical manifest content between copies without merging physical duplicates', () => {
    const first = finding('s1', 'C:/one/SKILL.md', { contentHash: 'a'.repeat(64) });
    const second = finding('s2', 'C:/two/SKILL.md', { contentHash: 'a'.repeat(64) });
    const third = finding('s3', 'C:/three/SKILL.md', { contentHash: 'b'.repeat(64) });
    const entities = derive([], [first, second, third]).entities;
    expect(entities).toHaveLength(3);
    const one = entities.find(entity => entity.key === 'skill:c:/one')!;
    expect(one.sameManifestKeys).toEqual(['skill:c:/two']);
    expect(one.independentOnly).toBe(true);
    expect(entityStatus(one).label).toBe('独立发现 / 未绑定');
  });

  it('does not let an independent entry bypass verified built-in hiding on the same physical source', () => {
    const bound = skill('builtin', { sourceKind: 'builtin', builtinSourcePath: 'C:/app/skills/builtin', sourcePath: 'C:/fixture/skills/builtin' });
    const entry = finding('user-source', 'C:/fixture/skills/builtin/SKILL.md', { name: 'builtin', actualPath: 'C:/fixture/skills/builtin/SKILL.md' });
    // The user registered the same physical directory; the identity matches the binding.
    expect(derive([bound], [entry], defaultDisplayPolicy).entities).toHaveLength(0);
    const revealed = derive([bound], [entry], { showBuiltin: true, showCacheOnly: false }).entities;
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.builtin).toBe(true);
    expect(revealed[0]!.bindings).toHaveLength(1);
    expect(revealed[0]!.findings).toHaveLength(1);
    // A different physical directory stays a separate, visible independent resource.
    const elsewhere = finding('user-source-2', 'C:/elsewhere/builtin/SKILL.md', { name: 'builtin-copy', actualPath: 'C:/elsewhere/builtin/SKILL.md' });
    expect(derive([bound], [elsewhere], defaultDisplayPolicy).entities.map(entity => entity.key)).toEqual(['skill:c:/elsewhere/builtin']);
  });
});

describe('plugin and MCP logical identities', () => {
  it('collapses configuration and cache versions of one plugin identity while separating agents, projects and marketplaces', () => {
    const contexts = [{ instanceId: 'zcode' }, { instanceId: 'another-zcode' }, { instanceId: 'codex' }, { instanceId: 'zcode', projectId: 'project' }, { instanceId: 'zcode', pluginId: 'computer-use@other' }];
    const values = contexts.flatMap((context, i) => [binding(`${i}-config`, { ...context, origin: 'configuration' as const, pluginVersion: undefined }), binding(`${i}-v1`, context)]);
    const entities = derive(values).entities;
    expect(entities).toHaveLength(contexts.length);
    expect(entities.every(entity => entity.plugin!.configurations === 1 && entity.plugin!.cacheRecords === 1)).toBe(true);
  });

  it('does not group unverified manifest identities or plugins identified only by names', () => {
    const values = [binding('v1'), binding('v2'), binding('conflict', { pluginIdentityVerified: false }), binding('filesystem', { pluginId: undefined, origin: 'filesystem' })];
    // Pure-cache entities would be hidden by the default display policy; show them to test grouping itself.
    const policy = { showBuiltin: false, showCacheOnly: true };
    const entities = derive(values, [], policy).entities;
    expect(entities).toHaveLength(3);
    const grouped = entities.find(entity => entity.plugin)!;
    expect(grouped.bindings.map(b => b.id)).toEqual(['v1', 'v2']);
    expect(entities.find(entity => entity.key === 'binding:conflict')).toBeDefined();
    expect(entities.find(entity => entity.key === 'binding:filesystem')).toBeDefined();
  });

  it('folds the same MCP service across agents and keeps component entries attached to their plugin', () => {
    const service = { identity: 'same-entry', kind: 'local-entry' as const, location: 'D:/services/server.mjs', configurationIdentity: 'scan:same', evidencePath: 'e', reason: 'r' };
    const values = [binding('codex', { instanceId: 'codex', kind: 'mcp', pluginId: undefined, origin: 'configuration', mcpService: service }),
      binding('zcode', { kind: 'mcp', pluginId: undefined, origin: 'configuration', mcpService: { ...service, configurationIdentity: 'scan:other' } })];
    const entities = derive(values).entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.mcp!.variants).toBe(2);
    expect(entityStatus(entities[0]!).label).toBe('2 项未确认');
  });

  it('lists attached skills and MCPs as separate entities with plugin attribution', () => {
    const parent = binding('parent', { origin: 'configuration', configurationSourcePath: 'C:/fixture/config.toml', enabled: true });
    const childSkill = binding('child-skill', { kind: 'skill', sourceKind: 'plugin', parentId: 'parent', origin: 'cache', name: 'helper' });
    const entities = derive([parent, childSkill]).entities;
    expect(entities).toHaveLength(2);
    const child = entities.find(entity => entity.kind === 'skill')!;
    expect(child.fromPlugin).toBe('computer-use');
    expect(entities.find(entity => entity.kind === 'plugin')!.plugin!.components.map(component => component.key)).toEqual([child.key]);
  });
});

describe('stable keys and hidden counts', () => {
  it('keeps entity keys stable when binding order or representatives change', () => {
    const first = skill('first', { name: 'stable', sourcePath: 'C:/fixture/skills/stable' });
    const second = skill('second', { name: 'stable', sourcePath: 'C:/fixture/skills/stable' });
    expect(derive([first, second]).entities[0]!.key).toBe(derive([second, first]).entities[0]!.key);
  });

  it('reports hidden entities through the corresponding switch only', () => {
    const builtinEntity = binding('builtin-plugin', { pluginId: 'builtin@app', sourceKind: 'builtin', origin: 'configuration', configurationSourcePath: 'C:/fixture/config.toml' });
    const cacheEntity = binding('cache-plugin');
    const both = binding('builtin-cache', { pluginId: 'mixed@app', sourceKind: 'builtin' });
    expect(derive([builtinEntity, cacheEntity, both], [], { showBuiltin: false, showCacheOnly: false }).entities).toHaveLength(0);
    const partial = derive([builtinEntity, cacheEntity, both], [], { showBuiltin: true, showCacheOnly: false }).entities;
    expect(partial.map(entity => entity.key)).toEqual(['plugin:zcode::builtin@app']);
    const full = derive([builtinEntity, cacheEntity, both], [], { showBuiltin: true, showCacheOnly: true }).entities;
    expect(full).toHaveLength(3);
  });
});
