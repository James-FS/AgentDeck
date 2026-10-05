import { describe, expect, it } from 'vitest';
import type { Binding } from '../packages/contracts/src/index';
import { resourceRows } from '../apps/web/src/resource-tree';

function binding(id: string, extra: Partial<Binding> = {}): Binding {
  return { id, instanceId: 'zcode', projectId: null, name: 'computer-use', kind: 'plugin', scope: 'native', sourceKind: 'plugin', compatibilityClass: 'unknown',
    parentId: null, sourcePath: `work/tests/${id}`, nativeKey: id, enabled: true, runtime: 'unknown', writable: false, readOnlyReason: 'readonly', diagnostics: [], updatedAt: '',
    pluginId: 'computer-use@official', pluginVersion: id, pluginIdentityVerified: true, origin: 'cache', ...extra };
}
const all = () => true;

function mcp(id: string, extra: Partial<Binding> = {}): Binding {
  return binding(id, { kind:'mcp', pluginId:undefined, origin:'configuration',
    mcpService:{identity:'same-entry',kind:'local-entry',location:'D:/services/server.mjs',configurationIdentity:'scan:same',evidencePath:id,reason:'literal path'},...extra });
}
describe('MCP service presentation groups', () => {
  it('folds same entry across Agents/projects, retains all original bindings and independent targets', () => {
    const values = [mcp('codex',{instanceId:'codex',writable:true}),mcp('zcode',{instanceId:'zcode',enabled:false}),mcp('project',{projectId:'p',scope:'project',instanceId:'claude'})];
    const before = JSON.stringify(values);
    const rows = resourceRows(values,all,new Set(),'mcp');
    expect(rows).toHaveLength(1); expect(rows[0]!.mcpGroup?.members).toEqual(values);
    expect(rows[0]!.mcpGroup?.state.label).toBe('未确定');
    const expanded = resourceRows(values,all,new Set([rows[0]!.key]),'mcp');
    expect(expanded.filter(b=>b.mcpBinding).map(row=>row.binding.id)).toEqual(['codex','zcode','project']);
    expect(expanded[1]!.binding.writable).toBe(true); expect(JSON.stringify(values)).toBe(before);
  });
  it('requires service evidence rather than names/config directories and leaves plugin children attached', () => {
    const other = mcp('other'); other.mcpService!.identity = 'different-entry';
    const values=[mcp('a'),mcp('b'),other,mcp('unknown',{mcpService:undefined}),mcp('child',{parentId:'parent'}),binding('parent')];
    expect(resourceRows(values,all,new Set(),'all')).toHaveLength(4);
  });
  it('filters by real binding, summarizes matching states and flags private configuration differences', () => {
    const first=mcp('first',{enabled:true}); const second=mcp('second',{enabled:false}); second.mcpService!.configurationIdentity='scan:different';
    const rows=resourceRows([first,second],b=>b.enabled===false,new Set(),'mcp');
    expect(rows).toHaveLength(1); expect(rows[0]!.mcpGroup?.members).toHaveLength(2);
    expect(rows[0]!.mcpGroup?.matchingMembers).toEqual([second]); expect(rows[0]!.mcpGroup?.state.label).toBe('已禁用');
    expect(rows[0]!.mcpGroup?.variants).toBe(2);
    expect(resourceRows([first,second],()=>false,new Set(),'mcp')).toHaveLength(0);
  });
  it('does not claim config difference when old indexes come from a different comparison session', () => {
    const first=mcp('old'), second=mcp('new'); second.mcpService!.configurationIdentity='new-scan:digest';
    expect(resourceRows([first,second],all,new Set(),'mcp')[0]!.mcpGroup?.variants).toBeNull();
  });
});
describe('plugin cache presentation groups', () => {
  it('collapses configuration and versions while preserving every real row and operation target on expansion', () => {
    const values = [binding('config', { origin: 'configuration', pluginVersion: undefined }), binding('v1', { writable: true }), binding('v2'),
      binding('skill1', { kind: 'skill', parentId: 'v1', pluginVersion: 'v1' }), binding('skill2', { kind: 'skill', parentId: 'v2', pluginVersion: 'v2' }), binding('mcp', { kind: 'mcp', parentId: 'v1' })];
    const before = JSON.stringify(values);
    const collapsed = resourceRows(values, all, new Set(), 'all');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.group?.versions).toEqual(['v1', 'v2']);
    expect(collapsed[0]!.group?.configurations).toBe(1);
    expect(collapsed[0]!.binding).toBe(values[1]);
    const open = resourceRows(values, all, new Set([collapsed[0]!.key]), 'all');
    expect(open.filter(row => !row.group).map(row => row.binding.id).sort()).toEqual(values.map(row => row.id).sort());
    expect(new Set(open.map(row => row.key)).size).toBe(open.length);
    expect(JSON.stringify(values)).toBe(before);
  });
  it('keeps Agents, instances, projects and marketplaces separate despite equal names', () => {
    const contexts = [{ instanceId: 'zcode' }, { instanceId: 'another-zcode' }, { instanceId: 'codex' }, { instanceId: 'zcode', projectId: 'project' }, { instanceId: 'zcode', pluginId: 'computer-use@other' }];
    const values = contexts.flatMap((context, i) => [binding(`${i}-a`, context), binding(`${i}-b`, context)]);
    const rows = resourceRows(values, all, new Set(), 'all');
    expect(rows).toHaveLength(contexts.length);
    expect(rows.every(row => row.group?.members.length === 2)).toBe(true);
  });
  it('does not group unverified manifest identities or plugins identified only by names', () => {
    const values = [binding('v1'), binding('v2'), binding('conflict', { pluginIdentityVerified: false }), binding('filesystem', { pluginId: undefined, origin: 'filesystem' })];
    const rows = resourceRows(values, all, new Set(), 'all');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.group?.members.map(b => b.id)).toEqual(['v1', 'v2']);
    expect(rows[1]!.binding.id).toBe('conflict');
  });
  it('preserves matches for child-only searches, version/source filters and resource type tabs', () => {
    const values = [binding('v1'), binding('v2'), binding('child1', { kind: 'skill', parentId: 'v1', name: 'review' }), binding('child2', { kind: 'skill', parentId: 'v2', name: 'review' })];
    const matches = (b: Binding) => b.id === 'child2';
    const rows = resourceRows(values, matches, new Set(), 'skill');
    expect(rows).toHaveLength(1);
    const open = resourceRows(values, matches, new Set([rows[0]!.key]), 'skill');
    expect(open.filter(row => !row.group).map(row => row.binding.id)).toEqual(['v2', 'child2']);
    expect(rows[0]!.group?.versions).toHaveLength(2);
    expect(resourceRows(values, () => false, new Set(), 'all')).toHaveLength(0);
  });
  it('does not claim a current version or resolve conflicting configuration states', () => {
    const values = [binding('v1', { enabled: true }), binding('v2', { enabled: false })];
    const rows = resourceRows(values, all, new Set(), 'all');
    expect(rows[0]!.group?.state.label).toBe('未确定');
    expect(rows[0]!.group?.state.reason).toContain('不代表某个缓存版本正在使用');
  });
});

function publicBinding(id: string, extra: Partial<Binding> = {}): Binding {
  const value = binding(id, {kind:'skill',pluginId:undefined,origin:'filesystem',sourcePath:'C:/Users/fixture/.agents/skills/shared',...extra});
  value.classification = { category:'user-global',scope:'user-global',agentId:null,discoveredByAgentId:id,relationship:'discovered',projectName:null,projectRoot:null,
    evidencePath:value.sourcePath,reason:'public fixture',contentCompatibility:'unknown',sourceIdentity:'physical-public-resource',
    location:{category:'user-global',rootPath:'C:/Users/fixture/.agents/skills',evidencePath:value.sourcePath,reason:'public source'}};
  return value;
}
describe('public user resource presentation', () => {
  it('shows one physical public resource while preserving separate Agent and instance states', () => {
    const values=[publicBinding('codex',{enabled:null}),publicBinding('zcode',{enabled:false,instanceId:'zcode'})];
    const before=JSON.stringify(values);
    const rows=resourceRows(values,all,new Set(),'skill');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicGroup?.members).toEqual(values);
    expect(rows[0]!.publicGroup?.state.label).toBe('已启用');
    expect(rows[0]!.publicGroup?.members.filter(b=>b.enabled===false).map(b=>b.id)).toEqual(['zcode']);
    expect(JSON.stringify(values)).toBe(before);
  });
  it('requires physical identity, user scope and .agents directory evidence instead of equal names', () => {
    const values=[publicBinding('a'),publicBinding('b'),publicBinding('copy'),publicBinding('unknown'),publicBinding('project',{projectId:'project'})];
    values[2]!.classification!.sourceIdentity='another-file';
    delete values[3]!.classification!.sourceIdentity;
    expect(resourceRows(values,all,new Set(),'skill')).toHaveLength(4);
    expect(resourceRows([publicBinding('x',{kind:'mcp'}),publicBinding('y')],all,new Set(),'all')).toHaveLength(2);
  });
  it('keeps all known Agent states when any binding matches filters and does not invent missing Agent bindings', () => {
    const values=[publicBinding('codex',{enabled:null}),publicBinding('zcode',{enabled:true})];
    const rows=resourceRows(values,b=>b.enabled===true,new Set(),'skill');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.binding.id).toBe('zcode');
    expect(rows[0]!.publicGroup?.members).toHaveLength(2);
    expect(rows[0]!.publicGroup?.state.tone).toBe('on');
    expect(resourceRows(values,()=>false,new Set(),'skill')).toHaveLength(0);
  });
});
