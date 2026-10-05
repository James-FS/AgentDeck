import type { AgentAdapter, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import { scanZCodePlugins } from './zcode-plugins.js';
import { markZCodeToggleTargets } from './zcode-toggle.js';
import { findZCodeDesktopRoot, scanZCodeBuiltins } from './zcode-builtin.js';
import {
  baseBinding, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, isPublicGlobalResource, isSafePathWithin, mcpTransport, object, report, safeMcpFile, scanSkillRoot,
} from './shared.js';

function addServers(context: ScanContext, file: string, config: unknown, source: 'user' | 'repository'): Binding[] {
  const root = object(config);
  const mcp = object(root?.mcp);
  const servers = object(mcp?.servers);
  if (!servers) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const server = object(raw);
    const flag = server && Object.hasOwn(server, 'enable') ? server.enable : server?.enabled;
    const enabled = !server ? null : flag === undefined ? true : typeof flag === 'boolean' ? flag : null;
    return baseBinding({
      context, kind: 'mcp', name, scope: source === 'repository' ? 'project' : 'native',
      sourceKind: source, projectId: source === 'repository' ? context.project?.id ?? null : null,
      sourcePath: file, nativeKey: `mcp.servers.${name}`,
      enabled, mcpTransport: mcpTransport(server), mcpConfig: server,
      origin: 'configuration', configurationSourcePath: file, configurationKey: `mcp.servers.${name}`,
      configurationEnabled: enabled, cacheState: 'unknown',
      diagnostics: server ? [] : ['MCP 服务器条目不是静态对象。'],
      readOnlyReason: '在验证原生写入方式前，ZCode MCP 设置保持只读。',
    });
  });
}

function addEnabledPluginConfigurations(context: ScanContext, file: string, config: unknown, source: 'user' | 'repository'): Binding[] {
  const root = object(config);
  const plugins = object(root?.plugins);
  const enabledPlugins = object(plugins?.enabledPlugins);
  if (!enabledPlugins) return [];
  return Object.entries(enabledPlugins).map(([identity, raw]) => {
    const enabled = typeof raw === 'boolean' ? raw : null;
    const parts = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/.exec(identity);
    const key = `plugins.enabledPlugins[${JSON.stringify(identity)}]`;
    return baseBinding({
      context, kind: 'plugin', name: parts?.[1] ?? identity,
      scope: source === 'repository' ? 'project' : 'native',
      sourceKind: source, projectId: source === 'repository' ? context.project?.id ?? null : null,
      sourcePath: file, nativeKey: key, enabled,
      origin: 'configuration', pluginId: identity, ...(parts ? { marketplace: parts[2] } : {}),
      configurationSourcePath: file, configurationKey: key, configurationEnabled: enabled,
      cacheState: 'unknown',
      diagnostics: typeof raw === 'boolean' ? [] : ['ZCode enabledPlugins 值不是静态布尔值。'],
      readOnlyReason: '在验证原生行为前，ZCode 插件启用状态保持只读。',
    });
  });
}

async function scanFile(context: ScanContext, file: string, boundary: string, source: 'user' | 'repository', bindings: Binding[], diagnostics: string[]): Promise<void> {
  if (!(await existsRegularFile(file))) return;
  if (!(await isSafePathWithin(boundary, file))) {
    diagnostics.push('ZCode 配置跨越符号链接或 junction，已跳过。');
    return;
  }
  const parsed = await safeMcpFile<unknown>(file, diagnostics, source === 'user' ? 'ZCode user config' : 'ZCode project config');
  if (parsed) bindings.push(...addServers(context, file, parsed, source), ...addEnabledPluginConfigurations(context, file, parsed, source));
}

async function scanFallbackMcp(context: ScanContext, home: string, source: 'user' | 'repository', bindings: Binding[], diagnostics: string[]) {
  const projectId = source === 'repository' ? context.project!.id : null;
  if (bindings.some(b => b.kind === 'mcp' && b.projectId === projectId && b.origin === 'configuration')) return;
  const boundary = source === 'repository' ? context.project!.rootPath : home;
  const file = path.join(boundary, '.agents', 'mcp.json');
  if (!(await isSafePathWithin(boundary, file))) return;
  const config = object(await safeMcpFile(file, diagnostics, 'ZCode generic MCP fallback'));
  const servers = object(config?.mcpServers);
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers).slice(0, 200)) {
    const server = object(raw);
    const flag = server && Object.hasOwn(server, 'enable') ? server.enable : server?.enabled;
    const enabled = !server ? null : flag === undefined ? true : typeof flag === 'boolean' ? flag : null;
    bindings.push(baseBinding({ context, kind: 'mcp', name, scope: projectId ? 'project' : 'user-global', sourceKind: source,
      projectId, sourcePath: file, nativeKey: `mcpServers.${name}`, enabled, mcpTransport: mcpTransport(raw), mcpConfig: server, origin: 'configuration',
      configurationSourcePath: file, configurationKey: `mcpServers.${name}`, configurationEnabled: enabled,
      location: { category: projectId ? 'project' : 'user-global', rootPath: path.dirname(file), evidencePath: file,
        reason: '公共 .agents/mcp.json 来源；ZCode 同范围无原生 MCP 声明时的静态回退证据，不代表其他客户端加载。' },
      readOnlyReason: 'ZCode 公共 MCP 回退只读；不连接服务器。' }));
  }
}
const discoveredHomes = new Map<string, string>();

/** Desktop Settings -> Skills persists per-SKILL.md overrides in the user CLI config. */
async function applyDesktopSkillSwitches(root: string, bindings: Binding[], diagnostics: string[]) {
  const file = path.join(root, 'cli', 'config.json');
  if (!(await isSafePathWithin(root, file))) return;
  const config = object(await safeMcpFile(file, diagnostics, 'ZCode desktop Skill switches'));
  if (!config) return;
  const entries = config.skills === undefined ? {} : object(config.skills);
  if (!entries) {
    diagnostics.push('ZCode skills 开关记录不是静态对象，未推断默认状态。');
    for (const binding of bindings.filter(b => b.kind === 'skill')) binding.configurationStateReason = 'ZCode skills 配置无效，状态未确定。';
    return;
  }
  const keys = Object.keys(entries);
  const bounded = keys.length <= 300;
  const normalize = (p: string) => path.resolve(p).split(path.sep).join('/');
  const overrides = new Map<string, boolean | null>();
  const disabledPaths = new Set<string>();
  for (const key of keys.slice(0, 300)) {
    if (!path.isAbsolute(key)) continue;
    const value = object(entries[key]);
    const normalized = normalize(key);
    const enabled = value && !Object.hasOwn(value, 'enable') ? true : typeof value?.enable === 'boolean' ? value.enable : null;
    if (enabled === false) disabledPaths.add(normalized);
    overrides.set(normalized, overrides.has(normalized) && overrides.get(normalized) !== enabled ? null : enabled);
  }
  if (!bounded) diagnostics.push('ZCode Skill 开关记录超过有界读取上限，未匹配条目不推断默认状态。');
  for (const binding of bindings.filter(b => b.kind === 'skill')) {
    if (binding.builtinSourcePath && binding.origin === 'filesystem') continue;
    const manifest = await existsRegularFile(path.join(binding.sourcePath, 'SKILL.md')) ? path.join(binding.sourcePath, 'SKILL.md') : path.join(binding.sourcePath, 'skill.md');
    const key = normalize(manifest);
    const explicit = overrides.has(key);
    // A plugin's identity/version must still be resolved by its parent evidence.
    if (!explicit && (binding.parentId || !bounded)) continue;
    const enabled = isPublicGlobalResource(binding) && disabledPaths.has(key) ? false : explicit ? overrides.get(key)! : true;
    const parent = binding.parentId ? bindings.find(b => b.id === binding.parentId) : undefined;
    binding.enabled = parent?.enabled === false ? false : enabled;
    binding.configurationEnabled = enabled;
    binding.configurationSourcePath = file;
    binding.configurationKey = `skills[${JSON.stringify(key)}].enable`;
    binding.configurationControl = { mode: enabled === null ? 'unknown' : 'independent',
      reason: `${enabled === null ? '开关值不是静态布尔值，状态未确定；' : ''}${explicit ? 'ZCode 桌面按 SKILL.md 路径保存的独立 enable 开关' : 'ZCode 桌面 Skill 开关缺省为允许；启用时删除路径覆盖记录'}${parent?.enabled === false ? '；父插件配置禁用仍阻止使用' : ''}。仅表示设置页配置，不代表最终运行时配置或实际调用。` };
  }
}

export const zcodeAdapter: AgentAdapter = {
  id: 'zcode',
  name: 'ZCode',
  info: {
    id: 'zcode', name: 'ZCode', description: '只读扫描 ZCode 配置与本地扩展；发现配置不代表已识别桌面或 CLI 客户端。',
    supportedKinds: ['skill', 'plugin', 'mcp'], writeSupport: ['default supported switches: existing ZCode user config Skill, configured/installed plugin and independent MCP boolean toggles'],
  },
  async discover({ homeDir, env }) {
    const root = expandPath(env.ZCODE_HOME || path.join(homeDir, '.zcode'), homeDir);
    const executable = await findExecutable(env, ['zcode']);
    if (!(await existsDirectory(root)) && !(await existsRegularFile(path.join(root, 'cli', 'config.json'))) && !executable) return [];
    const found = instance({ agentId: 'zcode', name: 'ZCode', configRoot: root, executable });
    const desktop = await findZCodeDesktopRoot(env, homeDir);
    if (desktop) found.desktopResourceRoot = desktop;
    discoveredHomes.set(found.id, homeDir);
    return [found];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const root = context.instance.configRoot;
    await scanFile(context, path.join(root, 'cli', 'config.json'), root, 'user', bindings, diagnostics);
    if (context.project) {
      await scanFile(context, path.join(context.project.rootPath, '.zcode', 'config.json'), context.project.rootPath, 'repository', bindings, diagnostics);
      await scanFile(context, path.join(context.project.rootPath, '.zcode', 'cli', 'config.json'), context.project.rootPath, 'repository', bindings, diagnostics);
    }

    await scanFallbackMcp(context, discoveredHomes.get(context.instance.id) ?? path.dirname(root), 'user', bindings, diagnostics);
    if (context.project) await scanFallbackMcp(context, '', 'repository', bindings, diagnostics);

    const roots: Array<{ path: string; scope: 'user-global' | 'project-directory'; source: 'user' | 'repository'; projectId: string | null }> = [
      { path: path.join(root, 'skills'), scope: 'user-global', source: 'user', projectId: null },
      { path: path.join(discoveredHomes.get(context.instance.id) ?? path.dirname(root), '.agents', 'skills'), scope: 'user-global', source: 'user', projectId: null },
    ];
    if (context.project) {
      roots.push({ path: path.join(context.project.rootPath, '.zcode', 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
      roots.push({ path: path.join(context.project.rootPath, 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
      roots.push({ path: path.join(context.project.rootPath, '.agents', 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
    }
    for (const candidate of roots) {
      const common = candidate.path.includes(`${path.sep}.agents${path.sep}`);
      const boundary = candidate.projectId === null ? common ? discoveredHomes.get(context.instance.id) ?? path.dirname(root) : root : context.project!.rootPath;
      if (!(await isSafePathWithin(boundary, candidate.path))) continue;
      bindings.push(...await scanSkillRoot({
        root: candidate.path, context, scope: candidate.scope, sourceKind: candidate.source,
        ...(common || (context.project && candidate.path === path.join(context.project.rootPath, 'skills')) ? {
          location: { category: candidate.projectId ? 'project' as const : 'user-global' as const, rootPath: candidate.path, evidencePath: candidate.path,
            reason: '明确公共 Skill 来源；ZCode 支持的静态发现入口，不证明所有 Agent 使用。' },
        } : {}),
        projectId: candidate.projectId, origin: 'filesystem', diagnostics,
      }));
    }

    bindings.push(...await scanZCodePlugins(context, bindings, diagnostics));
    await scanZCodeBuiltins(context, bindings, diagnostics);
    await applyDesktopSkillSwitches(root, bindings, diagnostics);
    await markZCodeToggleTargets(context, bindings, diagnostics);
    return report(bindings, diagnostics);
  },
};
