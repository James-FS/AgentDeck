import type { Binding, ResourceKind } from '@agentdeck/contracts';

export interface PluginGroup {
  members: Binding[];
  versions: string[];
  configurations: number;
  cacheRecords: number;
  state: { label: string; tone: 'on' | 'off' | 'unknown'; reason: string };
}
export interface PublicGroup { members: Binding[]; state: PluginGroup['state'] }
export interface McpGroup { members: Binding[]; matchingMembers: Binding[]; variants: number | null; state: PluginGroup['state'] }
export interface ResourceRow { key: string; binding: Binding; depth: number; children: number; group?: PluginGroup; publicGroup?: PublicGroup; mcpGroup?: McpGroup; mcpBinding?: boolean; versionRecord?: boolean }

export function mcpResourceIdentity(binding: Binding): string | null {
  return binding.kind === 'mcp' && binding.parentId === null && binding.mcpService?.identity ? binding.mcpService.identity : null;
}
export function mcpGroupState(members: Binding[]): PluginGroup['state'] {
  const enabled = members.every(b => b.enabled === true) ? true : members.every(b => b.enabled === false) ? false : null;
  return { label: enabled === true ? '已启用' : enabled === false ? '已禁用' : '未确定', tone: enabled === true ? 'on' : enabled === false ? 'off' : 'unknown',
    reason: `汇总 ${members.length} 条匹配绑定的配置状态；不同或未知状态保留未确定，不表示共用进程。` };
}

/** Requires scanner-provided physical identity and explicit public user-directory evidence. */
export function publicResourceIdentity(binding: Binding): string | null {
  const c = binding.classification;
  const root = c?.location?.rootPath?.replaceAll('\\', '/');
  return binding.parentId === null && binding.projectId === null && c?.agentId === null && c.category === 'user-global'
    && c.location?.category === 'user-global' && root && /\/\.agents(?:\/|$)/.test(root) && c.sourceIdentity
    ? JSON.stringify([binding.kind, c.sourceIdentity]) : null;
}
export function publicGroupState(members: Binding[]): PluginGroup['state'] {
  return { label: '已启用', tone: 'on',
    reason: `按用户指定规则，公共 .agents 资源默认已启用；${members.filter(b => b.enabled === false).length} 条 Agent 禁用记录只影响各自绑定，不改变公共资源默认状态。` };
}

/** Presentation only: no bindings, indexes or operation targets are merged or rewritten. */
export function resourceRows(bindings: Binding[], matches: (binding: Binding, includeChildren?: boolean) => boolean,
  expanded: Set<string>, kind: 'all' | ResourceKind): ResourceRow[] {
  const roots = bindings.filter(b => b.parentId === null);
  const children = new Map<string, Binding[]>();
  for (const child of bindings) if (child.parentId) children.set(child.parentId, [...(children.get(child.parentId) ?? []), child]);
  const identities = new Map<string, Binding[]>();
  const publicIdentities = new Map<string, Binding[]>();
  const mcpIdentities = new Map<string, Binding[]>();
  const identity = (b: Binding) => b.kind === 'plugin' && b.pluginId && (b.origin === 'configuration' || b.origin === 'cache' && b.pluginIdentityVerified === true)
    ? JSON.stringify([b.instanceId, b.projectId, b.pluginId]) : null;
  for (const root of roots) {
    const mcpKey = mcpResourceIdentity(root);
    if (mcpKey) mcpIdentities.set(mcpKey, [...(mcpIdentities.get(mcpKey) ?? []), root]);
    const publicKey = publicResourceIdentity(root);
    if (publicKey) publicIdentities.set(publicKey, [...(publicIdentities.get(publicKey) ?? []), root]);
    const key = identity(root);
    if (key) identities.set(key, [...(identities.get(key) ?? []), root]);
  }
  const output: ResourceRow[] = [];
  const visited = new Set<string>();
  const matchingChildren = (b: Binding) => (children.get(b.id) ?? []).filter(child => matches(child, kind === 'plugin'));
  const relevant = (b: Binding) => matches(b) || b.kind === 'plugin' && matchingChildren(b).length > 0;
  for (const root of roots) {
    const mcpId = mcpResourceIdentity(root);
    const mcpMembers = mcpId ? mcpIdentities.get(mcpId)! : [];
    if (mcpId && mcpMembers.length > 1) {
      const key = `mcp-group:${mcpId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const matching = mcpMembers.filter(relevant);
      if (!matching.length) continue;
      const tokens = mcpMembers.map(b => b.mcpService!.configurationIdentity);
      const sessions = new Set(tokens.map(token => token.split(':')[0]));
      const variants = sessions.size === 1 ? new Set(tokens).size : null;
      output.push({ key, binding: matching[0]!, depth: 0, children: mcpMembers.length,
        mcpGroup: { members: mcpMembers, matchingMembers: matching, variants, state: mcpGroupState(matching) } });
      if (expanded.has(key)) for (const member of matching) output.push({ key: member.id, binding: member, depth: 1, children: 0, mcpBinding: true });
      continue;
    }
    const publicId = publicResourceIdentity(root);
    if (publicId) {
      const key = `public-group:${publicId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const members = publicIdentities.get(publicId)!;
      const matching = members.filter(relevant);
      if (!matching.length) continue;
      output.push({ key, binding: matching[0]!, depth: 0, children: 0, publicGroup: { members, state: publicGroupState(members) } });
      continue;
    }
    const id = identity(root);
    const members = id ? identities.get(id)! : [root];
    if (id && members.length > 1) {
      if (visited.has(id)) continue;
      visited.add(id);
      const matching = members.filter(relevant);
      if (!matching.length) continue;
      const key = `plugin-group:${id}`;
      // Keep a real supported operation target; choosing it does not select a runtime version.
      const representative = matching.find(b => b.writable) ?? matching.find(b => b.origin === 'configuration') ?? matching[0]!;
      const configurations = members.filter(b => b.origin === 'configuration');
      const states = (configurations.length ? configurations : members).map(b => b.enabled);
      const enabled = states.every(v => v === true) ? true : states.every(v => v === false) ? false : null;
      const group: PluginGroup = { members, configurations: configurations.length,
        versions: [...new Set(members.filter(b => b.origin === 'cache').map(b => b.pluginVersion).filter((v): v is string => Boolean(v)))],
        cacheRecords: members.filter(b => b.origin === 'cache').length,
        state: { label: enabled === true ? '已启用' : enabled === false ? '已禁用' : '未确定', tone: enabled === true ? 'on' : enabled === false ? 'off' : 'unknown',
          reason: '同一实例/项目/插件身份的配置汇总；不代表某个缓存版本正在使用。配置记录不一致或无开关证据时未确定。' } };
      output.push({ key, binding: representative, depth: 0, children: members.length, group });
      if (expanded.has(key)) for (const member of matching) {
        output.push({ key: member.id, binding: member, depth: 1, children: 0, versionRecord: true });
        for (const child of matchingChildren(member)) output.push({ key: child.id, binding: child, depth: 2, children: 0 });
      }
      continue;
    }
    if (!relevant(root)) continue;
    output.push({ key: root.id, binding: root, depth: 0, children: (children.get(root.id) ?? []).length });
    if (expanded.has(root.id)) for (const child of matchingChildren(root)) output.push({ key: child.id, binding: child, depth: 1, children: 0 });
  }
  return output;
}
