import type { Binding, Project } from '@agentdeck/contracts';

export type SkillFileStatus = { disk: 'present' | 'missing' | 'unreadable' | 'configuration-only' | 'unknown'; format: 'valid' | 'invalid' | 'unavailable' | 'unknown'; reason: string; checkedAt?: string };
export interface SkillAvailabilityRow { binding: Binding; status: string; reason: string; conflict: boolean; file: SkillFileStatus }

function normalizePath(value: string): { key: string; absolute: boolean } {
  const slashed = value.replace(/\\/g, '/');
  const windows = /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//');
  const absolute = windows || slashed.startsWith('/');
  const prefix = windows && /^[A-Za-z]:/.test(slashed) ? slashed.slice(0, 2) : slashed.startsWith('//') ? '//' : absolute ? '/' : '';
  const rest = prefix === '//' ? slashed.slice(2) : prefix.length === 2 && windows ? slashed.slice(2) : prefix ? slashed.slice(prefix.length) : slashed;
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (segments.length && segments.at(-1) !== '..') segments.pop(); else if (!absolute) segments.push('..'); }
    else segments.push(segment);
  }
  const key = `${prefix}${prefix && prefix !== '//' ? '/' : ''}${segments.join('/')}`.replace(/\/$/, '') || (absolute ? prefix : '.');
  return { key: windows ? key.toLocaleLowerCase('en-US') : key, absolute };
}
function containsPath(candidate: string, root: string): boolean {
  const child = normalizePath(candidate);
  const parent = normalizePath(root);
  if (child.absolute !== parent.absolute) return false;
  return child.key === parent.key || child.key.startsWith(`${parent.key.replace(/\/$/, '')}/`);
}
function identity(binding: Binding): string | null {
  const value = binding.classification?.sourceIdentity || binding.sourcePath;
  return value ? normalizePath(value).key : null;
}

export function deriveSkillAvailability(input: {
  bindings: Binding[];
  projects: Project[];
  instanceId: string;
  projectId: string;
  workdir: string;
  files: Record<string, SkillFileStatus>;
}): SkillAvailabilityRow[] {
  const project = input.projects.find(item => item.id === input.projectId);
  const selectedWorkdir = input.workdir.trim() || project?.rootPath || '';
  const rows = input.bindings.filter(item => item.kind === 'skill' && item.instanceId === input.instanceId);
  const isInScope = (binding: Binding): boolean => {
    if (binding.scope === 'project' || binding.scope === 'project-directory') {
      if (!project || binding.projectId !== project.id) return false;
      if (selectedWorkdir && project.rootPath && !containsPath(selectedWorkdir, project.rootPath)) return false;
      if (binding.scope === 'project-directory' && binding.classification?.projectRoot && selectedWorkdir
        && !containsPath(selectedWorkdir, binding.classification.projectRoot)) return false;
    }
    return true;
  };
  const duplicateGroups = new Map<string, Map<string, boolean | null>>();
  for (const binding of rows.filter(isInScope)) {
    const file = input.files[binding.id];
    if (binding.enabled === false || file?.disk !== 'present' || file.format !== 'valid') continue;
    const name = (binding.displayName || binding.name).trim().toLocaleLowerCase('en-US');
    const source = identity(binding) ?? `binding:${binding.id}`;
    const sources = duplicateGroups.get(name) ?? new Map<string, boolean | null>();
    sources.set(source, binding.enabled);
    duplicateGroups.set(name, sources);
  }
  return rows.map(binding => {
    const file = input.files[binding.id] ?? { disk: 'unknown', format: 'unknown', reason: '当前文件状态尚未查询。' };
    const group = duplicateGroups.get((binding.displayName || binding.name).trim().toLocaleLowerCase('en-US'));
    const ownIdentity = identity(binding) ?? `binding:${binding.id}`;
    const distinctSources = group?.size ?? 0;
    const conflict = isInScope(binding) && distinctSources > 1 && group?.get(ownIdentity) === true
      && [...(group?.values() ?? [])].every(enabled => enabled === true);
    const potentialConflict = isInScope(binding) && distinctSources > 1 && group?.has(ownIdentity) === true && !conflict;
    let status: string;
    let reason = file.reason;
    if (binding.scope === 'project' || binding.scope === 'project-directory') {
      if (!project) {
        status = 'scope-mismatch'; reason = !project ? '需要选择项目以判断项目级 Skill 的范围。' : '此绑定属于其他项目。';
      } else if (binding.projectId === null) {
        status = 'scope-unknown'; reason = '扫描记录没有项目 ID，无法确认此项目级 Skill 的归属。';
      } else if (binding.projectId !== project.id) {
        status = 'scope-mismatch'; reason = '此绑定属于其他项目。';
      } else if (selectedWorkdir && project.rootPath && !containsPath(selectedWorkdir, project.rootPath)) {
        status = 'scope-mismatch'; reason = '工作目录不在所选项目根目录内。';
      } else if (binding.scope === 'project-directory' && selectedWorkdir && binding.classification?.projectRoot
        && !containsPath(selectedWorkdir, binding.classification.projectRoot)) {
        status = 'scope-mismatch'; reason = `工作目录超出 Skill 记录的子目录范围 ${binding.classification.projectRoot}。`;
      } else if (binding.scope === 'project-directory' && selectedWorkdir && !binding.classification?.projectRoot) {
        status = 'scope-unknown'; reason = '扫描记录没有子目录范围证据。';
      } else status = '';
    } else status = '';
    if (!status && file.disk === 'missing') { status = 'file-missing'; reason = '扫描时发现的 Skill 文件当前已不存在。'; }
    if (!status && file.disk === 'unreadable') { status = 'file-unreadable'; reason = file.reason; }
    if (!status && file.disk === 'configuration-only') { status = 'configuration-only'; reason = '这是客户端配置记录，没有关联到 Skill manifest。'; }
    if (!status && file.format === 'invalid') { status = 'format-invalid'; reason = file.reason || '当前 Skill manifest 格式无效。'; }
    if (!status && binding.enabled === false) { status = 'disabled'; reason = binding.configurationStateReason || '客户端配置将此 Skill 标记为禁用。'; }
    if (!status && conflict) { status = 'name-conflict'; reason = '同一选定范围内有多个当前可用来源使用相同 Skill 名称；优先级未确认。'; }
    if (!status && potentialConflict) { status = 'potential-name-conflict'; reason = '存在同名资源，但至少一条配置状态未知，无法确认是否同时可用或覆盖顺序。'; }
    if (!status && (file.disk === 'unknown' || file.format === 'unknown')) { status = 'status-unknown'; reason = '文件或格式状态尚未确认。'; }
    if (!status && binding.enabled === null) { status = 'configuration-unknown'; reason = '扫描未确认配置启用状态。'; }
    if (!status) { status = 'estimated-visible'; reason = '当前文件与配置符合静态规则；客户端运行时是否加载仍未知。'; }
    if ((conflict || potentialConflict) && !['scope-mismatch', 'scope-unknown', 'file-missing', 'file-unreadable', 'configuration-only', 'format-invalid', 'disabled'].includes(status)) {
      reason += ' 同名冲突存在，但加载顺序无法确认。';
    }
    return { binding, file, status, reason, conflict };
  });
}

export function pathIsWithin(candidate: string, root: string): boolean { return containsPath(candidate, root); }
