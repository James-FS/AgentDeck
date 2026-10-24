import type { Binding, ResourceKind, SourceKind } from '@agentdeck/contracts';
import { hasBuiltinEvidence, isCacheOnlyRecord, type DisplayPolicy } from './resource-visibility';

/**
 * Unified read-only display entities. Aggregation is presentation only: bindings,
 * independent findings and references are never merged, rewritten or used as
 * operation targets. Operations keep addressing real bindings / finding references.
 */

export interface EntityFinding {
  sourceId: string;
  findingPath: string;
  name: string;
  description: string | null;
  status: 'recognized' | 'candidate';
  reason?: string;
  contentHash?: string;
  actualPath?: string;
}

export interface EntityStatus { label: string; tone: 'on' | 'off' | 'unknown'; reason: string }

export interface ResourceEntity {
  /** Stable display key derived from physical/logical identity, not from row order. */
  key: string;
  kind: ResourceKind;
  name: string;
  description: string;
  /** Context-visible associated bindings, including records hidden by the display policy. */
  bindings: Binding[];
  visibleBindings: Binding[];
  hiddenBindings: Binding[];
  findings: EntityFinding[];
  /** Any associated record carries verified built-in source evidence. */
  builtin: boolean;
  /** Every binding is a pure cache record without configuration or installation association. */
  cacheOnly: boolean;
  independentOnly: boolean;
  publicResource: boolean;
  sourceKinds: SourceKind[];
  origins: Array<NonNullable<Binding['origin']>>;
  plugin?: { pluginId: string; marketplace: string | null; versions: string[]; configurations: number; cacheRecords: number; components: Array<{ key: string; kind: ResourceKind; name: string }> };
  mcp?: { identity: string; location: string | null; variants: number | null };
  fromPlugin: string | null;
  /** Other entities discovered under the same display name but a different physical source. */
  sameNameKeys: string[];
  /** Entities whose manifest content hash matches this one (finding evidence only; never auto-merged). */
  sameManifestKeys: string[];
}

export interface EntityCollection { entities: ResourceEntity[] }

export function mcpResourceIdentity(binding: Binding): string | null {
  // Plugin-attached MCP components keep their own entity; service grouping covers
  // standalone configurations, preserving the established plugin boundary.
  return binding.kind === 'mcp' && binding.parentId === null && binding.mcpService?.identity ? `mcp:${binding.mcpService.identity}` : null;
}

export function mcpGroupState(members: Binding[]): EntityStatus {
  const enabled = members.every(b => b.enabled === true) ? true : members.every(b => b.enabled === false) ? false : null;
  return { label: enabled === true ? '已启用' : enabled === false ? '已禁用' : '未确定', tone: enabled === true ? 'on' : enabled === false ? 'off' : 'unknown',
    reason: `汇总 ${members.length} 条匹配绑定的配置状态；不同或未知状态保留未确定，不表示共用进程。` };
}

/** Requires scanner-provided physical identity and explicit public user-directory evidence. */
export function publicResourceFlag(binding: Binding): boolean {
  const c = binding.classification;
  const root = c?.location?.rootPath?.replaceAll('\\', '/');
  return binding.projectId === null && c?.agentId === null && c?.category === 'user-global'
    && c.location?.category === 'user-global' && Boolean(root) && /\/\.agents(?:\/|$)/.test(root!)
    && Boolean(c.sourceIdentity);
}

export function publicGroupState(members: Binding[]): EntityStatus {
  return { label: '已启用', tone: 'on',
    reason: `按用户指定规则，公共 .agents 资源默认已启用；${members.filter(b => b.enabled === false).length} 条 Agent 禁用记录只影响各自绑定，不改变公共资源默认状态。` };
}

/**
 * Physical skill identity: one canonical manifest/skill root across "Skill 目录"
 * and "SKILL.md 文件" path conventions. Old indexes without scanner physical
 * identity keep a per-binding key and are never merged by name.
 */
export function skillEntityIdentity(binding: Binding): string | null {
  if (binding.kind !== 'skill') return null;
  if (!binding.classification?.sourceIdentity) return null;
  return `skill:${normalizeIdentityPath(binding.sourcePath)}`;
}

export function findingEntityIdentity(finding: EntityFinding): string | null {
  const manifestPath = finding.actualPath || finding.findingPath;
  const directory = manifestPath.replace(/[\\/]+SKILL\.md$/i, '').replace(/[\\/]+$/, '');
  return `skill:${normalizeIdentityPath(directory)}`;
}

export function normalizeIdentityPath(p: string): string {
  const unified = p.replaceAll('\\', '/');
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLocaleLowerCase('en-US') : unified;
}

function pluginEntityIdentity(binding: Binding): string | null {
  return binding.kind === 'plugin' && binding.pluginId && (binding.origin === 'configuration' || binding.origin === 'cache' && binding.pluginIdentityVerified === true)
    ? `plugin:${binding.instanceId}:${binding.projectId ?? ''}:${binding.pluginId}` : null;
}

export function entityDisplayName(binding: Binding): string {
  return binding.displayName || binding.name;
}

function bindingStateSummary(bindings: Binding[]): EntityStatus {
  if (bindings.length === 1) {
    const only = bindings[0]!;
    const tone = only.enabled === true ? 'on' : only.enabled === false ? 'off' : 'unknown';
    return { label: tone === 'on' ? '已启用' : tone === 'off' ? '已禁用' : '未确定', tone,
      reason: only.configurationStateReason ?? only.configurationControl?.reason ?? '来自扫描结果的静态配置状态；不代表会话加载、连接成功或实际调用。' };
  }
  const enabled = bindings.filter(b => b.enabled === true).length;
  const disabled = bindings.filter(b => b.enabled === false).length;
  const unknown = bindings.filter(b => b.enabled !== true && b.enabled !== false).length;
  const total = bindings.length;
  const parts: string[] = [];
  if (enabled) parts.push(`${enabled} 项启用`);
  if (disabled) parts.push(`${disabled} 项禁用`);
  if (unknown) parts.push(`${unknown} 项未确认`);
  // When every binding agrees, one clear label beats a count summary; the counts stay in the reason.
  const label = enabled === total ? '已启用' : disabled === total ? '已禁用' : parts.length ? parts.join(' · ') : '未确定';
  return { label, tone: disabled && !enabled ? 'off' : enabled && !disabled && !unknown ? 'on' : 'unknown',
    reason: `按去重后的真实绑定计算：${parts.length ? parts.join('，') : '没有可确定的配置状态'}；发现入口不计为配置绑定，也不代表会话加载。` };
}

export function entityStatus(entity: ResourceEntity): EntityStatus {
  if (entity.publicResource && entity.bindings.length) {
    const disabled = entity.bindings.filter(b => b.enabled === false);
    const agents = [...new Set(disabled.map(b => b.classification?.discoveredByAgentId ?? b.instanceId))];
    return { label: '已启用', tone: 'on',
      reason: `按用户指定的公共资源展示规则：用户 .agents 来源默认已启用。${disabled.length ? `${disabled.length} 条 Agent 禁用记录${agents.length ? `（${agents.join('、')}）` : ''}仅影响各自绑定。` : '未发现明确禁用记录。'}不代表实际会话加载。` };
  }
  if (entity.independentOnly || !entity.visibleBindings.length) {
    return { label: '独立发现 / 未绑定', tone: 'unknown',
      reason: '独立磁盘发现，未绑定到客户端；格式异常候选仍可见，可在详情查看说明。客户端加载状态未知。' };
  }
  return bindingStateSummary(entity.visibleBindings.length ? entity.visibleBindings : entity.bindings);
}

export function deriveEntities(args: { bindings: Binding[]; findings: EntityFinding[]; policy: DisplayPolicy }): EntityCollection {
  const { bindings, findings, policy } = args;
  const byId = new Map(bindings.map(binding => [binding.id, binding]));
  const pluginComponents = new Map<string, Array<{ key: string; kind: ResourceKind; name: string }>>();

  interface Draft {
    key: string;
    kind: ResourceKind;
    bindings: Binding[];
    findings: EntityFinding[];
    fromPlugin: string | null;
  }
  const drafts = new Map<string, Draft>();
  const draft = (key: string, kind: ResourceKind): Draft => {
    const existing = drafts.get(key);
    if (existing) return existing;
    const created: Draft = { key, kind, bindings: [], findings: [], fromPlugin: null };
    drafts.set(key, created);
    return created;
  };

  for (const binding of bindings) {
    const parent = binding.parentId ? byId.get(binding.parentId) : undefined;
    let key: string | null = null;
    if (binding.kind === 'plugin') key = pluginEntityIdentity(binding) ?? `binding:${binding.id}`;
    else if (binding.kind === 'mcp') key = mcpResourceIdentity(binding) ?? `binding:${binding.id}`;
    else key = skillEntityIdentity(binding) ?? `binding:${binding.id}`;
    const item = draft(key, binding.kind);
    item.bindings.push(binding);
    if (parent && binding.kind !== 'plugin') item.fromPlugin = entityDisplayName(parent);
  }
  for (const finding of findings) {
    const key = findingEntityIdentity(finding) ?? `finding:${finding.sourceId}:${finding.findingPath}`;
    const item = draft(key, 'skill');
    item.findings.push(finding);
  }

  // Plugin components (attached skills / MCPs) are separate entities; list them in plugin details.
  for (const item of drafts.values()) {
    if (item.kind !== 'plugin') continue;
    const ids = new Set(item.bindings.map(b => b.id));
    for (const [childKey, child] of drafts.entries()) {
      if (childKey === item.key) continue;
      if (child.bindings.some(b => b.parentId && ids.has(b.parentId))) {
        pluginComponents.set(item.key, [...pluginComponents.get(item.key) ?? [], { key: childKey, kind: child.kind, name: child.findings[0]?.name ?? entityDisplayName(child.bindings[0]!) }]);
      }
    }
  }

  const entities: ResourceEntity[] = [];
  for (const item of drafts.values()) {
    const representative = item.bindings[0];
    const name = item.findings[0]?.name ?? (representative ? entityDisplayName(representative) : item.key);
    const description = item.findings.find(f => f.description)?.description ?? representative?.description ?? item.findings[0]?.reason ?? '';
    const builtin = item.bindings.some(binding => hasBuiltinEvidence(binding, byId));
    const cacheOnly = item.bindings.length > 0 && item.bindings.every(binding => isCacheOnlyRecord(binding, byId));
    const visibleBindings = item.bindings.filter(binding =>
      !(isCacheOnlyRecord(binding, byId) && !policy.showCacheOnly));
    const hiddenBindings = item.bindings.filter(binding => !visibleBindings.includes(binding));
    // Built-in evidence is physical-source evidence: an independent entry for the same
    // physical source cannot bypass the built-in display switch.
    if (builtin && !policy.showBuiltin) continue;
    // Every record is hidden (pure cache with the switch off) and no independent entry exists.
    if (!visibleBindings.length && !item.findings.length) continue;
    const independentOnly = item.bindings.length === 0;
    const sourceKinds = [...new Set(item.bindings.map(b => b.sourceKind))];
    const origins = [...new Set(item.bindings.map(b => b.origin).filter((o): o is NonNullable<Binding['origin']> => Boolean(o)))];
    const entity: ResourceEntity = {
      key: item.key,
      kind: item.kind,
      name,
      description,
      bindings: item.bindings,
      visibleBindings,
      hiddenBindings,
      findings: item.findings,
      builtin,
      cacheOnly,
      independentOnly,
      publicResource: item.bindings.some(publicResourceFlag),
      sourceKinds,
      origins,
      fromPlugin: item.fromPlugin,
      sameNameKeys: [],
      sameManifestKeys: [],
    };
    const pluginMembers = item.kind === 'plugin' ? item.bindings : [];
    if (item.kind === 'plugin') {
      const configurations = pluginMembers.filter(b => b.origin === 'configuration').length;
      const cacheRecords = pluginMembers.filter(b => b.origin === 'cache').length;
      entity.plugin = {
        pluginId: representative?.pluginId ?? '',
        marketplace: representative?.marketplace ?? null,
        versions: [...new Set(pluginMembers.filter(b => b.origin === 'cache').map(b => b.pluginVersion).filter((v): v is string => Boolean(v)))],
        configurations,
        cacheRecords,
        components: pluginComponents.get(item.key) ?? [],
      };
    }
    if (item.kind === 'mcp') {
      const withService = item.bindings.filter(b => b.mcpService?.configurationIdentity);
      const tokens = withService.map(b => b.mcpService!.configurationIdentity);
      const sessions = new Set(tokens.map(token => token.split(':')[0]));
      entity.mcp = {
        identity: representative?.mcpService?.identity ?? '',
        location: representative?.mcpService?.location ?? null,
        variants: sessions.size === 1 && tokens.length ? new Set(tokens).size : null,
      };
    }
    entities.push(entity);
  }

  const byName = new Map<string, string[]>();
  const byManifestHash = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.kind === 'skill') byName.set(entity.name, [...byName.get(entity.name) ?? [], entity.key]);
    for (const finding of entity.findings) if (finding.contentHash) {
      byManifestHash.set(finding.contentHash, [...byManifestHash.get(finding.contentHash) ?? [], entity.key]);
    }
  }
  for (const entity of entities) {
    entity.sameNameKeys = (byName.get(entity.name) ?? []).filter(key => key !== entity.key);
    entity.sameManifestKeys = [...new Set(entity.findings.flatMap(f => f.contentHash ? byManifestHash.get(f.contentHash) ?? [] : []))].filter(key => key !== entity.key);
  }
  return { entities };
}
