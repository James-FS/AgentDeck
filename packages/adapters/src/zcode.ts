import type { AgentAdapter, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import {
  baseBinding, declaredPath, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, isSafePathWithin, object, report, safeMcpFile, scanSkillRoot,
} from './shared.js';

function addServers(context: ScanContext, file: string, config: unknown, source: 'user' | 'repository'): Binding[] {
  const root = object(config);
  const mcp = object(root?.mcp);
  const servers = object(mcp?.servers);
  if (!servers) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const server = object(raw);
    return baseBinding({
      context, kind: 'mcp', name, scope: source === 'repository' ? 'project' : 'native',
      sourceKind: source, projectId: source === 'repository' ? context.project?.id ?? null : null,
      sourcePath: file, nativeKey: `mcp.servers.${name}`,
      enabled: typeof server?.enabled === 'boolean' ? server.enabled : null,
      origin: 'configuration', configurationSourcePath: file, configurationKey: `mcp.servers.${name}`,
      configurationEnabled: typeof server?.enabled === 'boolean' ? server.enabled : null, cacheState: 'unknown',
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

async function scanPluginDirs(context: ScanContext, root: string, diagnostics: string[]): Promise<Binding[]> {
  const bindings: Binding[] = [];
  for (const dir of await directDirectories(root, diagnostics, 'ZCode plugin directory')) {
    if (!(await isSafePathWithin(context.instance.configRoot, dir))) continue;
    const manifestPath = path.join(dir, '.zcode-plugin', 'plugin.json');
    if (!(await isSafePathWithin(context.instance.configRoot, manifestPath))) continue;
    const manifestFileExists = await existsRegularFile(manifestPath);
    if (!manifestFileExists) continue;
    const manifestResult = manifestFileExists ? await safeMcpFile<unknown>(manifestPath, diagnostics, 'ZCode plugin manifest') : null;
    const manifest = object(manifestResult);
    const name = typeof manifest?.name === 'string' ? manifest.name : path.basename(dir);
    const parent = baseBinding({
      context, kind: 'plugin', name, scope: 'native', sourceKind: 'plugin', projectId: null,
      sourcePath: manifestPath, nativeKey: `plugin-dir:${path.resolve(dir)}`,
      enabled: null, configurationEnabled: null,
      origin: 'filesystem', cacheState: 'unknown',
      readOnlyReason: '只读适配器不修改 ZCode 插件启用状态。',
    });
    bindings.push(parent);

    const skillDeclarations = typeof manifest?.skills === 'string' ? [manifest.skills] : ['./skills'];
    for (const declaration of skillDeclarations) {
      const candidate = declaredPath(dir, declaration);
      if (!candidate) { diagnostics.push('ZCode 插件 Skill 声明越界或不是包内相对路径。'); continue; }
      if (!(await isSafePathWithin(context.instance.configRoot, candidate))) continue;
      bindings.push(...await scanSkillRoot({ root: candidate, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, projectId: null, origin: 'filesystem', diagnostics }));
    }
    const servers = object(manifest?.mcpServers ?? manifest?.mcp_servers);
    if (servers) {
      for (const serverName of Object.keys(servers).slice(0, 200)) {
        bindings.push(baseBinding({
          context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin', projectId: null,
          sourcePath: manifestPath, nativeKey: `plugin:${name}.mcpServers.${serverName}`, parentId: parent.id,
          enabled: null, configurationEnabled: null,
          origin: 'filesystem', cacheState: 'unknown',
          diagnostics: ['该文件系统插件没有可用的精确 name@marketplace 配置身份。'],
          readOnlyReason: '插件 MCP 条目只读，不能独立修改。',
        }));
      }
    }
  }
  return bindings;
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

export const zcodeAdapter: AgentAdapter = {
  id: 'zcode',
  name: 'ZCode',
  info: {
    id: 'zcode', name: 'Official ZCode CLI', description: '针对官方 ZCode CLI 配置与本地扩展的只读有限扫描。',
    supportedKinds: ['skill', 'plugin', 'mcp'], writeSupport: [],
  },
  async discover({ homeDir, env }) {
    const root = expandPath(env.ZCODE_HOME || path.join(homeDir, '.zcode'), homeDir);
    const executable = await findExecutable(env, ['zcode']);
    if (!(await existsDirectory(root)) && !(await existsRegularFile(path.join(root, 'cli', 'config.json'))) && !executable) return [];
    return [instance({ agentId: 'zcode', name: 'ZCode', configRoot: root, executable })];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const root = context.instance.configRoot;
    await scanFile(context, path.join(root, 'cli', 'config.json'), root, 'user', bindings, diagnostics);
    if (context.project) {
      await scanFile(context, path.join(context.project.rootPath, '.zcode', 'cli', 'config.json'), context.project.rootPath, 'repository', bindings, diagnostics);
    }

    const roots: Array<{ path: string; scope: 'user-global' | 'project-directory'; source: 'user' | 'repository'; projectId: string | null }> = [
      { path: path.join(root, 'skills'), scope: 'user-global', source: 'user', projectId: null },
    ];
    if (context.project) {
      roots.push({ path: path.join(context.project.rootPath, '.zcode', 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
      roots.push({ path: path.join(context.project.rootPath, 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
    }
    for (const candidate of roots) {
      const boundary = candidate.projectId === null ? root : context.project!.rootPath;
      if (!(await isSafePathWithin(boundary, candidate.path))) continue;
      bindings.push(...await scanSkillRoot({
        root: candidate.path, context, scope: candidate.scope, sourceKind: candidate.source,
        projectId: candidate.projectId, origin: 'filesystem', diagnostics,
      }));
    }

    const pluginRoot = path.join(root, 'plugins');
    if (await isSafePathWithin(root, pluginRoot)) bindings.push(...await scanPluginDirs(context, pluginRoot, diagnostics));
    return report(bindings, diagnostics);
  },
};
