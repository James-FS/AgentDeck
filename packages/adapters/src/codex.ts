import TOML from '@iarna/toml';
import { editCodexEnabled, type CodexToggleTarget } from '@agentdeck/change-engine';
import type { AgentAdapter, AgentInstance, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import {
  baseBinding, declaredPath, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, isSafePathWithin, mcpTransport, object, report, safeMcpFile, safeTomlFile, scanSingleSkill, scanSkillRoot,
} from './shared.js';

const discoveredHomes = new Map<string, string>();

function enabledValue(value: unknown): boolean | null {
  const obj = object(value);
  return typeof obj?.enabled === 'boolean' ? obj.enabled : null;
}

function pluginChildState(parentEnabled: boolean | null, rawServer: unknown): { enabled: boolean | null; diagnostics: string[] } {
  const server = object(rawServer);
  if (parentEnabled === false) return { enabled: false, diagnostics: ['Disabled by the parent plugin configuration.'] };
  if (!server) return { enabled: null, diagnostics: ['Plugin MCP entry is not a static table.'] };
  const hasLocalValue = Object.hasOwn(server, 'enabled');
  const localEnabled = typeof server.enabled === 'boolean' ? server.enabled : null;
  if (hasLocalValue && localEnabled === null) {
    return { enabled: null, diagnostics: ['The plugin MCP enabled field is not a static boolean.'] };
  }
  if (parentEnabled !== true) {
    return {
      enabled: null,
      diagnostics: hasLocalValue ? ['A child enabled value cannot establish effective state without an enabled parent plugin identity.'] : ['Parent plugin configuration state is unknown.'],
    };
  }
  return { enabled: hasLocalValue ? localEnabled : true, diagnostics: [] };
}

type PluginConfiguration = { sourcePath: string; key: string; enabled: boolean | null };

function pluginIdentityParts(identity: string): { plugin: string; marketplace: string } | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/.exec(identity);
  return match ? { plugin: match[1]!, marketplace: match[2]! } : null;
}

function codexPluginConfigurations(config: Record<string, unknown> | null, sourcePath: string): Map<string, PluginConfiguration> {
  const plugins = object(config?.plugins);
  const result = new Map<string, PluginConfiguration>();
  if (!plugins) return result;
  for (const [identity, raw] of Object.entries(plugins)) {
    result.set(identity, { sourcePath, key: `plugins[${JSON.stringify(identity)}]`, enabled: enabledValue(raw) });
  }
  return result;
}

function addConfiguredCodexPlugins(args: {
  context: ScanContext;
  sourcePath: string;
  plugins: Record<string, unknown>;
  bindings: Binding[];
  sourceKind: 'user' | 'repository';
  scope: 'native' | 'project';
  projectId: string | null;
}): void {
  for (const [identity, raw] of Object.entries(args.plugins)) {
    const plugin = object(raw);
    const config: PluginConfiguration = {
      sourcePath: args.sourcePath,
      key: `plugins[${JSON.stringify(identity)}]`,
      enabled: enabledValue(plugin),
    };
    const parts = pluginIdentityParts(identity);
    const parent = baseBinding({
      context: args.context, kind: 'plugin', name: parts?.plugin ?? identity, scope: args.scope,
      sourceKind: args.sourceKind === 'user' ? 'user' : 'repository', sourcePath: args.sourcePath,
      projectId: args.projectId, nativeKey: config.key, enabled: config.enabled,
      origin: 'configuration', pluginId: identity, ...(parts ? { marketplace: parts.marketplace } : {}),
      configurationSourcePath: config.sourcePath, configurationKey: config.key, configurationEnabled: config.enabled,
      cacheState: 'unknown',
      diagnostics: plugin ? (parts ? [] : ['Plugin identity does not contain an exact name@marketplace pair.']) : ['Plugin table is not a static table.'],
      readOnlyReason: 'Codex plugin toggles are outside the supported independent MCP change engine.',
    });
    args.bindings.push(parent);
    const servers = object(plugin?.mcp_servers);
    if (!servers) continue;
    for (const [serverName, rawServer] of Object.entries(servers).slice(0, 200)) {
      const state = pluginChildState(config.enabled, rawServer);
      args.bindings.push(baseBinding({
        context: args.context, kind: 'mcp', name: serverName, scope: args.scope, sourceKind: 'plugin',
        sourcePath: args.sourcePath, projectId: args.projectId,
        nativeKey: `${config.key}.mcp_servers.${serverName}`, parentId: parent.id,
        enabled: state.enabled, origin: 'configuration', pluginId: identity,
        ...(parts ? { marketplace: parts.marketplace } : {}),
        configurationSourcePath: config.sourcePath, configurationKey: `${config.key}.mcp_servers.${serverName}`,
        configurationEnabled: config.enabled, cacheState: 'unknown',
        diagnostics: state.diagnostics,
        readOnlyReason: 'MCP servers declared by a plugin are read-only; only independent Codex MCP tables can be changed.',
      }));
    }
  }
}

const MAX_CODEX_PLUGIN_PACKAGES = 300;
const MAX_CODEX_PLUGIN_DIRECTORY_ENTRIES = 2400;
const MAX_PLUGIN_SKILLS = 100;
const MAX_PLUGIN_MCP_SERVERS = 200;

async function scanCodexPluginCache(args: {
  context: ScanContext;
  configuration: Map<string, PluginConfiguration>;
  bindings: Binding[];
  diagnostics: string[];
}): Promise<Set<string>> {
  const configRoot = args.context.instance.configRoot;
  const cacheRoot = path.join(configRoot, 'plugins', 'cache');
  const represented = new Set<string>();
  if (!(await isSafePathWithin(configRoot, cacheRoot))) return represented;
  let packagesScanned = 0;
  let entriesScanned = 0;
  const readDirectories = async (directory: string): Promise<string[]> => {
    if (entriesScanned >= MAX_CODEX_PLUGIN_DIRECTORY_ENTRIES) return [];
    const entries = await directDirectories(directory, args.diagnostics, 'Codex plugin cache directory');
    const remaining = Math.max(0, MAX_CODEX_PLUGIN_DIRECTORY_ENTRIES - entriesScanned);
    entriesScanned += Math.min(entries.length, remaining);
    if (entries.length > remaining) args.diagnostics.push('Codex plugin cache directory scan reached its bounded entry limit.');
    return entries.slice(0, remaining);
  };
  for (const marketplaceDir of await readDirectories(cacheRoot)) {
    const marketplace = path.basename(marketplaceDir);
    if (marketplace.startsWith('.')) continue;
    if (!(await isSafePathWithin(configRoot, marketplaceDir))) continue;
    for (const pluginDir of await readDirectories(marketplaceDir)) {
      const directoryName = path.basename(pluginDir);
      if (directoryName.startsWith('.')) continue;
      if (!(await isSafePathWithin(configRoot, pluginDir))) continue;
      for (const versionDir of await readDirectories(pluginDir)) {
        if (++packagesScanned > MAX_CODEX_PLUGIN_PACKAGES) {
          args.diagnostics.push('Codex plugin cache package scan reached its bounded package limit.');
          return represented;
        }
        if (!(await isSafePathWithin(configRoot, versionDir))) continue;
        const manifestPath = path.join(versionDir, '.codex-plugin', 'plugin.json');
        if (!(await isSafePathWithin(configRoot, manifestPath)) || !(await existsRegularFile(manifestPath))) continue;
        const parsed = await safeMcpFile<unknown>(manifestPath, args.diagnostics, 'Codex cached plugin manifest');
        const manifest = object(parsed);
        if (!manifest) continue;
        const identity = `${directoryName}@${marketplace}`;
        const manifestName = typeof manifest.name === 'string' ? manifest.name : null;
        const nameMismatch = manifestName !== null && manifestName !== directoryName;
        const config = nameMismatch ? undefined : args.configuration.get(identity);
        const version = path.basename(versionDir);
        const displayName = typeof manifest.name === 'string' && manifest.name.length <= 120 && !/[\r\n\0]/.test(manifest.name)
          ? manifest.name : directoryName;
        const parent = baseBinding({
          context: args.context, kind: 'plugin', name: displayName, scope: 'native', sourceKind: 'plugin',
          sourcePath: manifestPath, projectId: null, nativeKey: `cache:${marketplace}/${directoryName}/${version}`,
          identityPath: versionDir, enabled: config?.enabled ?? null,
          origin: 'cache', pluginId: identity, pluginVersion: version, marketplace,
          ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.key, configurationEnabled: config.enabled } : { configurationEnabled: null }),
          cacheState: 'present',
          diagnostics: [
            ...(nameMismatch ? ['Plugin manifest name does not match its cache directory identity; configuration association was withheld.'] : []),
            ...(!nameMismatch && !config ? ['This cached plugin version has no exact matching enabled plugin identity in config.toml.'] : []),
          ],
          readOnlyReason: 'A cached plugin version is read-only; runtime selection cannot be inferred from cache contents.',
        });
        args.bindings.push(parent);
        if (!nameMismatch) represented.add(identity);

        let skillDeclarations: string[] = ['./skills'];
        if (typeof manifest.skills === 'string') skillDeclarations = [manifest.skills];
        else if (Array.isArray(manifest.skills)) skillDeclarations = manifest.skills.filter((value): value is string => typeof value === 'string').slice(0, 20);
        else if (manifest.skills !== undefined) args.diagnostics.push('Codex plugin Skills declaration has an unsupported shape.');
        const seenSkillRoots = new Set<string>();
        for (const declaration of skillDeclarations) {
          const skillRoot = declaredPath(versionDir, declaration);
          if (!skillRoot) {
            args.diagnostics.push('Codex plugin Skill declaration escapes or is not a relative path inside its package.');
            continue;
          }
          if (seenSkillRoots.has(skillRoot)) continue;
          seenSkillRoots.add(skillRoot);
          if (!(await isSafePathWithin(configRoot, skillRoot))) {
            if (await existsDirectory(skillRoot)) args.diagnostics.push('Codex plugin Skill declaration crosses a symlink or junction and was skipped.');
            continue;
          }
          const metadata = {
            context: args.context, parentId: parent.id, pluginId: identity, pluginVersion: version,
            marketplace, ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.key } : {}),
            configurationEnabled: config?.enabled ?? null, diagnostics: args.diagnostics,
          };
          if (await existsRegularFile(path.join(skillRoot, 'SKILL.md')) || await existsRegularFile(path.join(skillRoot, 'skill.md'))) {
            args.bindings.push(...await scanSingleSkill({ directory: skillRoot, ...metadata }));
          } else {
            const children = await scanSkillRoot({
              root: skillRoot, context: args.context, scope: 'native', sourceKind: 'plugin', parentId: parent.id,
              projectId: null, origin: 'cache', pluginId: identity, pluginVersion: version, marketplace,
              ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.key } : {}),
              configurationEnabled: config?.enabled ?? null, cacheState: 'present', diagnostics: args.diagnostics,
            });
            args.bindings.push(...children.slice(0, MAX_PLUGIN_SKILLS));
            if (children.length > MAX_PLUGIN_SKILLS) args.diagnostics.push('A Codex plugin Skills root exceeded its bounded child limit.');
          }
        }

        const declaredMcp = manifest.mcpServers ?? manifest.mcp_servers;
        let mcpSource = manifestPath;
        let serverValues: unknown = declaredMcp;
        if (typeof declaredMcp === 'string') {
          const mcpPath = declaredPath(versionDir, declaredMcp);
          if (!mcpPath) {
            args.diagnostics.push('Codex plugin MCP declaration escapes or is not a relative path inside its package.');
            serverValues = null;
          } else if (!(await isSafePathWithin(configRoot, mcpPath))) {
            if (await existsRegularFile(mcpPath)) args.diagnostics.push('Codex plugin MCP declaration crosses a symlink or junction and was skipped.');
            serverValues = null;
          } else {
            mcpSource = mcpPath;
            const parsedMcp = await safeMcpFile<unknown>(mcpPath, args.diagnostics, 'Codex cached plugin MCP manifest');
            const mcpObject = object(parsedMcp);
            serverValues = mcpObject?.mcpServers ?? mcpObject?.mcp_servers ?? mcpObject;
          }
        }
        const servers = object(serverValues);
        if (servers) {
          for (const [serverName, rawServer] of Object.entries(servers).slice(0, MAX_PLUGIN_MCP_SERVERS)) {
            const state = pluginChildState(config?.enabled ?? null, rawServer);
            args.bindings.push(baseBinding({
              context: args.context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin',
              sourcePath: mcpSource, projectId: null, nativeKey: `cache:${marketplace}/${directoryName}/${version}.mcpServers.${serverName}`,
              parentId: parent.id, enabled: state.enabled, origin: 'cache', pluginId: identity, pluginVersion: version, marketplace,
              ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.key, configurationEnabled: config.enabled } : { configurationEnabled: null }),
              mcpTransport: mcpTransport(rawServer),
              cacheState: 'present',
              diagnostics: state.diagnostics,
              readOnlyReason: 'MCP servers bundled with a cached plugin cannot be changed independently.',
            }));
          }
          if (Object.keys(servers).length > MAX_PLUGIN_MCP_SERVERS) args.diagnostics.push('A Codex plugin MCP manifest exceeded its bounded child limit.');
        }
      }
    }
  }
  return represented;
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  info: {
    id: 'codex', name: 'Codex', description: 'Read-only local discovery and bounded configuration scanning for Codex.',
    supportedKinds: ['skill', 'plugin', 'mcp'],
    writeSupport: ['experimental: manually registered writable instance, independent user MCP', 'Codex 0.159.2/win32: user config-root Skill overrides and configured local marketplace plugin toggles'],
  },
  async discover({ homeDir, env }): Promise<AgentInstance[]> {
    const root = expandPath(env.CODEX_HOME || path.join(homeDir, '.codex'), homeDir);
    const executable = await findExecutable(env, ['codex']);
    const hasConfig = await existsRegularFile(path.join(root, 'config.toml'));
    const hasSkills = await existsDirectory(path.join(homeDir, '.agents', 'skills')) || await existsDirectory(path.join(root, 'skills'));
    if (!hasConfig && !hasSkills && !executable) return [];
    const found = instance({ agentId: 'codex', name: 'Codex', configRoot: root, executable });
    discoveredHomes.set(found.id, homeDir);
    return [found];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const { instance: agent, project } = context;
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const configPath = path.join(agent.configRoot, 'config.toml');
    const configPathSafe = !(await existsRegularFile(configPath)) || await isSafePathWithin(agent.configRoot, configPath);
    if (!configPathSafe) {
      diagnostics.push('Codex config.toml crosses a symlink or junction and was skipped.');
    }
    const parsed = configPathSafe ? await safeTomlFile(configPath, diagnostics, 'Codex config.toml', (text) => {
      if (/\r(?!\n)/.test(text)) throw new Error('unsupported-line-ending');
      return TOML.parse(text.replace(/\r\n/g, '\n')) as Record<string, unknown>;
    }) : { value: null, text: null };
    const config = parsed.value;
    const pluginConfigurations = codexPluginConfigurations(config, configPath);

    if (config) {
      const standalone = object(config.mcp_servers);
      if (standalone) {
        const writableInstance = (agent.discovery === 'manual' || agent.discovery === 'demo') && agent.writable;
        for (const [serverName, raw] of Object.entries(standalone)) {
          const server = object(raw);
          const state = server && server.enabled === undefined ? true : typeof server?.enabled === 'boolean' ? server.enabled : null;
          const transport = mcpTransport(server);
          const tableCount = parsed.text ? countCodexServerTables(parsed.text, serverName) : 0;
          const enabledFieldIsSupported = !server || server.enabled === undefined || typeof server.enabled === 'boolean';
          const supported = tableCount === 1 && server !== null && enabledFieldIsSupported;
          const writable = writableInstance && supported;
          const reasons: string[] = [];
          if (server?.enabled === undefined) reasons.push('Codex treats a missing enabled field as enabled by default.');
          else if (server && typeof server.enabled !== 'boolean') reasons.push('The enabled field is not a TOML boolean.');
          if (tableCount !== 1) reasons.push('The target table is duplicated or its syntax cannot be located safely.');
          if (transport !== 'stdio') reasons.push('Native write evidence applies only to standalone stdio MCP entries.');
          if (writableInstance && supported) reasons.push('Experimental write opt-in applies to structurally supported standalone user MCP, including HTTP and unknown transports. Native evidence remains limited to the verified STDIO scope; client runtime remains unobserved.');
          bindings.push(baseBinding({
            context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'user',
            sourcePath: configPath, projectId: null, nativeKey: `mcp_servers.${serverName}`, enabled: state,
            origin: 'configuration', configurationSourcePath: configPath, configurationKey: `mcp_servers.${serverName}`,
            configurationEnabled: state,
            mcpTransport: transport,
            writable,
            readOnlyReason: writable ? null : !writableInstance
              ? 'Writing requires a manually registered writable instance or an isolated writable demo instance.'
              : 'The TOML target table is not uniquely addressable.',
            diagnostics: reasons,
          }));
        }
      }
      const plugins = object(config.plugins);
      const cacheIdentities = await scanCodexPluginCache({ context, configuration: pluginConfigurations, bindings, diagnostics });
      if (plugins) {
        const configOnly = Object.fromEntries(Object.entries(plugins).filter(([identity, raw]) =>
          !cacheIdentities.has(identity) || Boolean(object(raw)?.mcp_servers),
        ));
        addConfiguredCodexPlugins({
          context, sourcePath: configPath, plugins: configOnly, bindings, sourceKind: 'user', scope: 'native', projectId: null,
        });
      }
    } else {
      await scanCodexPluginCache({ context, configuration: pluginConfigurations, bindings, diagnostics });
    }

    const userHome = discoveredHomes.get(agent.id) ?? path.dirname(agent.configRoot);
    const roots: Array<{ root: string; boundary: string; scope: 'user-global' | 'project'; source: 'user' | 'repository' | 'builtin' }> = [
      { root: path.join(userHome, '.agents', 'skills'), boundary: userHome, scope: 'user-global', source: 'user' },
      { root: path.join(agent.configRoot, 'skills'), boundary: agent.configRoot, scope: 'user-global', source: 'user' },
      { root: path.join(agent.configRoot, 'skills', '.system'), boundary: agent.configRoot, scope: 'user-global', source: 'builtin' },
    ];
    if (project) {
      roots.push({ root: path.join(project.rootPath, '.agents', 'skills'), boundary: project.rootPath, scope: 'project', source: 'repository' });
      roots.push({ root: path.join(project.rootPath, '.codex', 'skills'), boundary: project.rootPath, scope: 'project', source: 'repository' });
    }
    for (const root of roots) {
      if (!(await isSafePathWithin(root.boundary, root.root))) continue;
      bindings.push(...await scanSkillRoot({
        root: root.root, context, scope: root.scope, sourceKind: root.source,
        projectId: root.scope === 'user-global' ? null : context.project?.id ?? null,
        origin: 'filesystem', diagnostics,
      }));
    }

    if (project) {
      const projectConfigPath = path.join(project.rootPath, '.codex', 'config.toml');
      const projectConfigPathSafe = !(await existsRegularFile(projectConfigPath)) || await isSafePathWithin(project.rootPath, projectConfigPath);
      if (!projectConfigPathSafe) {
        diagnostics.push('Codex project config.toml crosses a symlink or junction and was skipped.');
      } else {
        const projectParsed = await safeTomlFile(projectConfigPath, diagnostics, 'Codex project config.toml', (text) => {
          if (/\r(?!\n)/.test(text)) throw new Error('unsupported-line-ending');
          return TOML.parse(text.replace(/\r\n/g, '\n')) as Record<string, unknown>;
        });
        const projectConfig = projectParsed.value;
        if (projectConfig) {
          const projectServers = object(projectConfig.mcp_servers);
          if (projectServers) {
            for (const [serverName, raw] of Object.entries(projectServers)) {
              const server = object(raw);
              const enabled = server && server.enabled === undefined ? true : typeof server?.enabled === 'boolean' ? server.enabled : null;
              const notes = server?.enabled === undefined ? ['Codex treats a missing enabled field as enabled by default.'] : [];
              bindings.push(baseBinding({
                context, kind: 'mcp', name: serverName, scope: 'project', sourceKind: 'repository',
                sourcePath: projectConfigPath, projectId: project.id, nativeKey: `mcp_servers.${serverName}`, enabled,
                origin: 'configuration', configurationSourcePath: projectConfigPath,
                configurationKey: `mcp_servers.${serverName}`, configurationEnabled: enabled,
                mcpTransport: mcpTransport(server),
                diagnostics: notes, readOnlyReason: 'Project Codex MCP configuration is read-only in this iteration.',
              }));
            }
          }
          const projectPlugins = object(projectConfig.plugins);
          if (projectPlugins) addConfiguredCodexPlugins({
            context, sourcePath: projectConfigPath, plugins: projectPlugins, bindings,
            sourceKind: 'repository', scope: 'project', projectId: project.id,
          });
        }
      }
    }

    for (const pluginDir of await directDirectories(path.join(agent.configRoot, 'plugins'), diagnostics, 'Codex plugin directory')) {
      const pluginName = path.basename(pluginDir);
      // These are infrastructure containers, not plugin packages.
      if (['cache', 'data', 'marketplaces'].includes(pluginName) || pluginName.startsWith('.')) continue;
      if (!(await isSafePathWithin(agent.configRoot, pluginDir))) continue;
      const parent = baseBinding({
        context, kind: 'plugin', name: pluginName, scope: 'native', sourceKind: 'plugin', sourcePath: pluginDir,
        projectId: null, nativeKey: `plugin-dir:${path.resolve(pluginDir)}`, origin: 'filesystem', cacheState: 'unknown',
        readOnlyReason: 'Filesystem plugin activation is not modified by this adapter.',
      });
      bindings.push(parent);
      const skillsRoot = path.join(pluginDir, 'skills');
      const bundledSkills = await isSafePathWithin(agent.configRoot, skillsRoot) ? await scanSkillRoot({
        root: skillsRoot, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, diagnostics,
        projectId: null, origin: 'filesystem',
      }) : [];
      bindings.push(...bundledSkills);
    }
    for (const binding of bindings) {
      if (binding.parentId !== null || binding.projectId !== null) continue;
      let target: CodexToggleTarget | undefined;
      if (binding.kind === 'skill' && binding.scope === 'user-global' && binding.sourceKind === 'user') {
        const manifest = path.join(binding.sourcePath, 'SKILL.md');
        if (await existsRegularFile(manifest) && await isSafePathWithin(agent.configRoot, manifest)) {
          target = { kind: 'skill', path: manifest };
          binding.controlScope = 'user-config-skill';
        } else binding.readOnlyReason = '初期仅验证配置根 skills 内的独立 SKILL.md；共享目录、项目和内置 Skill 保持只读。';
      }
      if (binding.kind === 'plugin' && binding.origin === 'cache' && binding.pluginId && binding.configurationSourcePath === configPath) {
        const parts = pluginIdentityParts(binding.pluginId);
        const market = parts ? object(object(config?.marketplaces)?.[parts.marketplace]) : null;
        if (market?.source_type === 'local' && typeof market.source === 'string' && path.isAbsolute(market.source) && typeof pluginConfigurations.get(binding.pluginId)?.enabled === 'boolean') {
          target = { kind: 'plugin', id: binding.pluginId };
          binding.controlScope = 'local-marketplace-plugin';
        } else binding.readOnlyReason = '初期仅验证已配置的本地市场插件整体开关；远程市场、未登记缓存和未知状态保持只读。';
      }
      if (!target) continue;
      binding.configurationSourcePath = configPath;
      binding.configurationKey = target.kind === 'skill' ? `skills.config[path=${JSON.stringify(target.path)}]` : `plugins[${JSON.stringify(target.id)}]`;
      let structurallySupported = false;
      try {
        if (parsed.text === null) throw new Error('missing-config');
        const check = editCodexEnabled(parsed.text, binding.name, binding.enabled ?? true, target);
        binding.enabled = check.previousEnabled;
        binding.configurationEnabled = check.previousEnabled;
        structurallySupported = true;
      } catch { binding.enabled = null; binding.configurationEnabled = null; }
      const verifiedVersion = agent.versionEvidence?.signature === 'codex-cli-version' && agent.versionEvidence.version === '0.159.2' && agent.versionEvidence.platform === 'win32';
      binding.writable = agent.discovery === 'manual' && agent.writable && verifiedVersion && structurallySupported;
      binding.readOnlyReason = binding.writable ? null : !structurallySupported
        ? '配置缺失或目标覆盖不能唯一安全定位；不创建文件或改写未知结构。'
        : !verifiedVersion ? '此开关仅验收 Codex CLI 0.159.2 / Windows；请检查版本，其他版本保持只读。'
        : '需要手动登记并明确允许配置修改；自动发现保持只读。';
      binding.diagnostics.push(target.kind === 'skill'
        ? '仅修改该 Codex 实例的按路径覆盖；Skill 原文保持不变。配置读取状态不代表当前会话已加载，变更后重启 Codex。'
        : '修改插件身份的整体开关，影响该身份全部缓存版本的 Skill/MCP/其他组件；不修改缓存，当前会话运行状态未知。');
    }
    return report(bindings, diagnostics);
  },
};

function countCodexServerTables(text: string, serverName: string): number {
  // This is a locator confidence check only; @iarna/toml has already validated syntax.
  // The editor performs token-aware section location before allowing a write.
  const header = /^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/gm;
  let count = 0;
  for (const match of text.matchAll(header)) {
    let parsedName = match[2] ?? match[3];
    if (match[1] !== undefined) {
      try { parsedName = JSON.parse(`"${match[1]}"`) as string; } catch { continue; }
    }
    if (parsedName === serverName) count += 1;
  }
  return count;
}
