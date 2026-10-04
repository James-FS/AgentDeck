import path from 'node:path';
import type { Binding } from '@agentdeck/contracts';
import { existsRegularFile, isPublicGlobalResource, object } from './shared.js';

/** Read explicit path overrides independently of the narrower write authorization. */
export async function readCodexSkillOverrides(bindings: Binding[], config: unknown, file: string, projectId: string | null): Promise<void> {
  const skills = object(object(config)?.skills);
  const rows = skills?.config;
  if (!Array.isArray(rows)) return;
  const normalize = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const matches = new Map<string, unknown[]>();
  for (const raw of rows.slice(0, 300)) {
    const row = object(raw);
    if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue;
    const key = normalize(row.path);
    matches.set(key, [...(matches.get(key) ?? []), row.enabled]);
  }
  for (const binding of bindings.filter(b => b.kind === 'skill' && b.parentId === null && b.projectId === projectId && !b.discoveryOnly)) {
    const manifest = path.join(binding.sourcePath, await existsRegularFile(path.join(binding.sourcePath, 'SKILL.md')) ? 'SKILL.md' : 'skill.md');
    const values = matches.get(normalize(manifest));
    if (!values) continue;
    // Omitted enabled in an explicit row is the supported default; duplicate rows remain ambiguous.
    const publicDisabled = isPublicGlobalResource(binding) && values.includes(false);
    const enabled = publicDisabled ? false : rows.length <= 300 && values.length === 1 ? values[0] === undefined ? true : typeof values[0] === 'boolean' ? values[0] : null : null;
    binding.enabled = enabled;
    binding.configurationEnabled = enabled;
    binding.configurationSourcePath = file;
    binding.configurationKey = `skills.config[path=${JSON.stringify(manifest)}]`;
    binding.configurationControl = { mode: 'independent', reason: enabled === null
      ? 'Codex 按完整路径的 Skill 覆盖存在重复、非布尔值或超出读取上限，状态未确定。'
      : 'Codex config.toml 的显式按完整 SKILL.md 路径覆盖；只读配置证据，不证明原生客户端加载或项目最终配置合成。' };
  }
}
