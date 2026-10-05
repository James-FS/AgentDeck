import type { AgentAdapter, AgentInstance, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import { markClaudeToggleTargets } from './claude-toggle.js';
import {
  baseBinding, declaredPath, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, isSafePathWithin, mcpTransport, object, report, safeMcpFile, scanSingleSkill, scanSkillRoot,
} from './shared.js';

function enabledFrom(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'off' || value.toLowerCase() === 'disabled') return false;
    if (value.toLowerCase() === 'on' || value.toLowerCase() === 'enabled') return true;
  }
  return null;
}

function addMcpEntries(args: {
  context: ScanContext;
  file: string;
  entries: unknown;
  sourceKind: 'user' | 'repository';
  diagnostics: string[];
  label: string;
  configurationKey?: string;
  projectId?: string;
}): Binding[] {
  const result: Binding[] = [];
  const servers = object(args.entries);
  if (!servers) return result;
  for (const [name, raw] of Object.entries(servers)) {
    const server = object(raw);
    const enabled = typeof server?.enabled === 'boolean' ? server.enabled : null;
    result.push(baseBinding({
      context: args.context, kind: 'mcp', name, scope: args.projectId || (args.context.project && args.sourceKind === 'repository') ? 'project' : 'native',
      sourceKind: args.sourceKind, sourcePath: args.file, projectId: args.projectId ?? (args.sourceKind === 'user' ? null : args.context.project?.id ?? null),
      nativeKey: `mcpServers.${name}`, enabled,
      origin: 'configuration', configurationSourcePath: args.file,
      configurationKey: args.configurationKey ? `${args.configurationKey}.${name}` : `mcpServers.${name}`,
      configurationEnabled: enabled, cacheState: 'unknown',
      mcpTransport: mcpTransport(server), mcpConfig: server,
      diagnostics: server ? [] : [`${args.label} entry is not a static object.`],
      readOnlyReason: 'Claude Code MCP 配置在本轮为只读。',
    }));
  }
  return result;
}

async function readSettings(file: string, diagnostics: string[], label: string): Promise<Record<string, unknown> | null> {
  if (!(await existsRegularFile(file))) return null;
  const value = await safeMcpFile<unknown>(file, diagnostics, label);
  return object(value);
}

type PluginIdentity = { plugin: string; marketplace: string };
type PluginConfiguration = { sourcePath: string; key: string; enabled: boolean | null };

function parsePluginIdentity(identity: string): PluginIdentity | null {
  const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/.exec(identity);
  return match ? { plugin: match[1]!, marketplace: match[2]! } : null;
}

function pluginConfigurations(settings: Record<string, unknown> | null, sourcePath: string): Map<string, PluginConfiguration> {
  const result = new Map<string, PluginConfiguration>();
  const enabledPlugins = object(settings?.enabledPlugins);
  if (!enabledPlugins) return result;
  for (const [identity, raw] of Object.entries(enabledPlugins)) {
    result.set(identity, { sourcePath, key: `enabledPlugins[${JSON.stringify(identity)}]`, enabled: enabledFrom(raw) });
  }
  return result;
}

function addClaudePluginConfiguration(args: {
  context: ScanContext;
  identity: string;
  sourcePath: string;
  key: string;
  enabled: boolean | null;
  projectId: string | null;
  sourceKind: 'user' | 'repository';
  cacheState: 'present' | 'missing' | 'unknown';
  version?: string;
  diagnostics?: string[];
  bindings: Binding[];
}): Binding {
  const parts = parsePluginIdentity(args.identity);
  const parent = baseBinding({
    context: args.context, kind: 'plugin', name: parts?.plugin ?? args.identity,
    scope: args.projectId ? 'project' : 'native', sourceKind: args.sourceKind,
    sourcePath: args.sourcePath, projectId: args.projectId, nativeKey: args.key, enabled: args.enabled,
    origin: 'configuration', pluginId: args.identity, ...(parts ? { marketplace: parts.marketplace } : {}),
    ...(args.version ? { pluginVersion: args.version } : {}),
    configurationSourcePath: args.sourcePath, configurationKey: args.key,
    configurationEnabled: args.enabled, cacheState: args.cacheState,
    diagnostics: [...(parts ? [] : ['插件身份不包含精确的 name@marketplace 组合。']), ...(args.diagnostics ?? [])],
    readOnlyReason: 'Claude Code 插件启用状态在本轮为只读。',
  });
  args.bindings.push(parent);
  return parent;
}

const MAX_CLAUDE_PLUGIN_PACKAGES = 300;
const MAX_CLAUDE_PLUGIN_DIRECTORY_ENTRIES = 2400;
const MAX_CLAUDE_PLUGIN_SKILLS = 100;
const MAX_CLAUDE_PLUGIN_MCP_SERVERS = 200;

async function scanClaudePlugins(args: {
  context: ScanContext;
  settings: Record<string, unknown> | null;
  settingsPath: string;
  projectSettings: Record<string, unknown> | null;
  projectSettingsPath: string;
  projectLocalSettings: Record<string, unknown> | null;
  projectLocalSettingsPath: string;
  diagnostics: string[];
}): Promise<Binding[]> {
  const { context } = args;
  const root = context.instance.configRoot;
  const bindings: Binding[] = [];
  const userConfigs = pluginConfigurations(args.settings, args.settingsPath);
  const cacheRoot = path.join(root, 'plugins', 'cache');
  const cacheVersions = new Set<string>();
  const cacheIdentityConflicts = new Set<string>();
  let packageCount = 0;
  let entriesScanned = 0;
  const readDirectories = async (directory: string): Promise<string[]> => {
    if (entriesScanned >= MAX_CLAUDE_PLUGIN_DIRECTORY_ENTRIES) return [];
    const entries = await directDirectories(directory, args.diagnostics, 'Claude plugin cache directory');
    const remaining = Math.max(0, MAX_CLAUDE_PLUGIN_DIRECTORY_ENTRIES - entriesScanned);
    entriesScanned += Math.min(entries.length, remaining);
    if (entries.length > remaining) args.diagnostics.push('Claude 插件缓存目录扫描达到条目上限。');
    return entries.slice(0, remaining);
  };
  if (await isSafePathWithin(root, cacheRoot)) {
    cacheScan: for (const marketplaceDir of await readDirectories(cacheRoot)) {
      const marketplace = path.basename(marketplaceDir);
      if (marketplace.startsWith('.') || !(await isSafePathWithin(root, marketplaceDir))) continue;
      for (const pluginDir of await readDirectories(marketplaceDir)) {
        const pluginFolder = path.basename(pluginDir);
        if (pluginFolder.startsWith('.') || !(await isSafePathWithin(root, pluginDir))) continue;
        for (const versionDir of await readDirectories(pluginDir)) {
          if (++packageCount > MAX_CLAUDE_PLUGIN_PACKAGES) {
            args.diagnostics.push('Claude 插件缓存包扫描达到包数上限。');
            break cacheScan;
          }
          if (!(await isSafePathWithin(root, versionDir))) continue;
          const manifestPath = path.join(versionDir, '.claude-plugin', 'plugin.json');
          if (!(await isSafePathWithin(root, manifestPath)) || !(await existsRegularFile(manifestPath))) continue;
          const manifest = object(await safeMcpFile<unknown>(manifestPath, args.diagnostics, 'Claude cached plugin manifest'));
          if (!manifest) continue;
          const identity = `${pluginFolder}@${marketplace}`;
          const version = path.basename(versionDir);
          const manifestName = typeof manifest.name === 'string' ? manifest.name : null;
          const nameMismatch = manifestName !== null && manifestName !== pluginFolder;
          const configuration = nameMismatch ? undefined : userConfigs.get(identity);
          const displayName = typeof manifest.name === 'string' && manifest.name.length <= 120 && !/[\r\n\0]/.test(manifest.name)
            ? manifest.name : pluginFolder;
          const pluginId = identity;
          const parent = baseBinding({
            context, kind: 'plugin', name: displayName, scope: 'native', sourceKind: 'plugin',
            sourcePath: manifestPath, projectId: null, nativeKey: `cache:${marketplace}/${pluginFolder}/${version}`,
            identityPath: versionDir, enabled: configuration?.enabled ?? null,
            origin: 'cache', pluginId, pluginVersion: version, marketplace,
            pluginIdentityVerified: manifestName === pluginFolder,
            ...(configuration ? {
              configurationSourcePath: configuration.sourcePath,
              configurationKey: configuration.key,
              configurationEnabled: configuration.enabled,
            } : { configurationEnabled: null }),
            cacheState: 'present',
            diagnostics: [
              ...(nameMismatch ? ['插件 manifest 名称与缓存目录身份不一致，已撤销配置关联。'] : []),
              ...(!nameMismatch && !configuration ? ['This cached plugin version has no exact matching user enabledPlugins identity.'] : []),
            ],
            readOnlyReason: '缓存插件版本只读；无法从缓存内容推断当前运行版本。',
          });
          bindings.push(parent);
          if (nameMismatch) cacheIdentityConflicts.add(`${identity}\0${version}`);
          else cacheVersions.add(`${identity}\0${version}`);

          let skillDeclarations: string[] = ['./skills'];
          if (typeof manifest.skills === 'string') skillDeclarations = [manifest.skills];
          else if (Array.isArray(manifest.skills)) skillDeclarations = manifest.skills.filter((value): value is string => typeof value === 'string').slice(0, 20);
          else if (manifest.skills !== undefined) args.diagnostics.push('Claude 插件 Skills 声明结构不受支持。');
          const seen = new Set<string>();
          for (const declaration of skillDeclarations) {
            const skillRoot = declaredPath(versionDir, declaration);
            if (!skillRoot) {
              args.diagnostics.push('Claude 插件 Skill 声明越界或不是包内相对路径。');
              continue;
            }
            if (seen.has(skillRoot)) continue;
            seen.add(skillRoot);
            if (!(await isSafePathWithin(root, skillRoot))) {
              if (await existsDirectory(skillRoot)) args.diagnostics.push('Claude 插件 Skill 声明跨越符号链接或 junction，已跳过。');
              continue;
            }
            const childMetadata = {
              context, parentId: parent.id, pluginId, pluginVersion: version, marketplace,
              ...(configuration ? { configurationSourcePath: configuration.sourcePath, configurationKey: configuration.key } : {}),
              configurationEnabled: configuration?.enabled ?? null, diagnostics: args.diagnostics,
            };
            if (await existsRegularFile(path.join(skillRoot, 'SKILL.md')) || await existsRegularFile(path.join(skillRoot, 'skill.md'))) {
              bindings.push(...await scanSingleSkill({ directory: skillRoot, ...childMetadata }));
            } else {
              const children = await scanSkillRoot({
                root: skillRoot, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, projectId: null,
                origin: 'cache', pluginId, pluginVersion: version, marketplace,
                ...(configuration ? { configurationSourcePath: configuration.sourcePath, configurationKey: configuration.key } : {}),
                configurationEnabled: configuration?.enabled ?? null, cacheState: 'present', diagnostics: args.diagnostics,
              });
              bindings.push(...children.slice(0, MAX_CLAUDE_PLUGIN_SKILLS));
              if (children.length > MAX_CLAUDE_PLUGIN_SKILLS) args.diagnostics.push('某个 Claude 插件 Skills 根超过子项上限。');
            }
          }

          const mcpDeclaration = manifest.mcpServers ?? manifest.mcp_servers;
          let mcpSource = manifestPath;
          let serverValues: unknown = mcpDeclaration;
          if (typeof mcpDeclaration === 'string') {
            const mcpPath = declaredPath(versionDir, mcpDeclaration);
            if (!mcpPath) {
              args.diagnostics.push('Claude 插件 MCP 声明越界或不是包内相对路径。');
              serverValues = null;
            } else if (!(await isSafePathWithin(root, mcpPath))) {
              if (await existsRegularFile(mcpPath)) args.diagnostics.push('Claude 插件 MCP 声明跨越符号链接或 junction，已跳过。');
              serverValues = null;
            } else {
              mcpSource = mcpPath;
              const mcpDocument = object(await safeMcpFile<unknown>(mcpPath, args.diagnostics, 'Claude cached plugin MCP manifest'));
              serverValues = mcpDocument?.mcpServers ?? mcpDocument?.mcp_servers ?? mcpDocument;
            }
          }
          const childServers = object(serverValues);
          if (childServers) {
            for (const [serverName, rawServer] of Object.entries(childServers).slice(0, MAX_CLAUDE_PLUGIN_MCP_SERVERS)) {
              const server = object(rawServer);
              const hasLocalEnabled = server !== null && Object.hasOwn(server, 'enabled');
              const localEnabled = typeof server?.enabled === 'boolean' ? server.enabled : null;
              const effective = configuration?.enabled === false ? false
                : hasLocalEnabled ? configuration?.enabled === true ? localEnabled : null
                  : configuration?.enabled ?? null;
              const invalidLocalState = hasLocalEnabled && localEnabled === null;
              bindings.push(baseBinding({
                context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin',
                sourcePath: mcpSource, projectId: null, nativeKey: `cache:${marketplace}/${pluginFolder}/${version}.mcpServers.${serverName}`,
                parentId: parent.id, enabled: effective, origin: 'cache', pluginId, pluginVersion: version, marketplace,
                ...(configuration ? {
                  configurationSourcePath: configuration.sourcePath,
                  configurationKey: configuration.key,
                  configurationEnabled: configuration.enabled,
                } : { configurationEnabled: null }),
                mcpTransport: mcpTransport(rawServer), mcpConfig: object(rawServer),
                cacheState: 'present',
                diagnostics: [
                  ...(configuration?.enabled === false ? ['已由父插件配置停用。'] : []),
                  ...(invalidLocalState ? ['插件 MCP 的 enabled 字段不是静态布尔值。'] : []),
                  ...(configuration?.enabled == null && hasLocalEnabled ? ['没有已启用的父插件身份时，子级 enabled 值不能确定生效状态。'] : []),
                ],
                readOnlyReason: '插件缓存附带的 MCP 不能独立修改。',
              }));
            }
            if (Object.keys(childServers).length > MAX_CLAUDE_PLUGIN_MCP_SERVERS) args.diagnostics.push('某个 Claude 插件 MCP 清单超过子项上限。');
          }
        }
      }
    }
  }

  const installedFile = path.join(root, 'plugins', 'installed_plugins.json');
  const installedDocument = await isSafePathWithin(root, installedFile)
    ? object(await safeMcpFile<unknown>(installedFile, args.diagnostics, 'Claude installed plugin registry')) : null;
  const installed = object(installedDocument?.plugins);
  if (installed) {
    let registrationCount = 0;
    for (const [identity, rawRecords] of Object.entries(installed)) {
      const parts = parsePluginIdentity(identity);
      if (!parts || !Array.isArray(rawRecords)) continue;
      for (const [index, rawRecord] of rawRecords.slice(0, 20).entries()) {
        if (++registrationCount > 300) {
          args.diagnostics.push('Claude 已安装插件登记达到登记数上限。');
          break;
        }
        const record = object(rawRecord);
        if (!record) continue;
        const projectPath = typeof record.projectPath === 'string' ? path.resolve(record.projectPath) : null;
        const scope = record.scope;
        const isProjectRecord = scope === 'project' || scope === 'local' || projectPath !== null;
        const recordProjectId = isProjectRecord && context.project && projectPath && samePath(projectPath, context.project.rootPath)
          ? context.project.id : null;
        if (isProjectRecord && recordProjectId === null) continue;
        if (!isProjectRecord && scope !== undefined && scope !== 'user' && scope !== 'user-global') continue;
        const version = typeof record.version === 'string' && /^[A-Za-z0-9._+-]{1,120}$/.test(record.version) && record.version !== '.' && record.version !== '..'
          ? record.version : undefined;
        const expected = version ? path.join(root, 'plugins', 'cache', parts.marketplace, parts.plugin, version) : null;
        const declaredInstallPath = typeof record.installPath === 'string' ? path.resolve(record.installPath) : null;
        const pathMatches = expected !== null && declaredInstallPath !== null && samePath(expected, declaredInstallPath);
        const manifestPath = expected ? path.join(expected, '.claude-plugin', 'plugin.json') : null;
        const packageKey = version ? `${identity}\0${version}` : '';
        const manifestPresent = Boolean(manifestPath && await isSafePathWithin(root, manifestPath)
          && await existsRegularFile(manifestPath) && !cacheIdentityConflicts.has(packageKey));
        const cacheVersionKey = packageKey;
        if (recordProjectId === null && version && cacheVersions.has(cacheVersionKey) && pathMatches) {
          const cached = bindings.filter(item => item.pluginId === identity && item.pluginVersion === version);
          if (scope === 'user' || scope === 'user-global') {
            for (const item of cached) {
              if (item.classification) item.classification.installationEvidence = {
                path: installedFile, scope: 'user-global', reason: '明确 user 安装记录精确匹配插件身份、版本与缓存路径。',
              };
              if (item.classification && !item.configurationSourcePath) {
                item.classification.scope = 'user-global';
                item.classification.relationship = 'configured';
                item.classification.evidencePath = installedFile;
                item.classification.reason = 'installed_plugins.json 的 user 安装记录精确匹配插件身份、版本和缓存路径；不证明当前加载或跨 Agent 兼容。';
              }
            }
          }
          continue;
        }
        const configuration = recordProjectId === null ? userConfigs.get(identity) : undefined;
        const registrationKey = `plugins[${JSON.stringify(identity)}][${index}]`;
        const registrationDiagnostics = [
          ...(!pathMatches ? ['已安装插件登记没有指向配置根内匹配的缓存版本。'] : []),
          ...(cacheIdentityConflicts.has(packageKey) ? ['插件 manifest 名称与已安装插件身份冲突。'] : []),
          ...(pathMatches && !manifestPresent ? ['Installed plugin registration points to a cache version with no readable plugin manifest.'] : []),
        ];
        const registered = addClaudePluginConfiguration({
          context, identity, sourcePath: installedFile, key: registrationKey,
          enabled: configuration?.enabled ?? null,
          projectId: recordProjectId,
          sourceKind: recordProjectId ? 'repository' : 'user',
          cacheState: pathMatches ? cacheIdentityConflicts.has(packageKey) ? 'unknown' : manifestPresent ? 'present' : 'missing' : 'unknown',
          ...(version ? { version } : {}), diagnostics: registrationDiagnostics, bindings,
        });
        if (scope === undefined && !isProjectRecord && !configuration && registered.classification) {
          registered.classification.scope = 'unknown';
          registered.classification.reason = '安装记录没有明确 scope，且没有关联用户配置；作用范围未知。';
        }
        if (registered.classification) registered.classification.installationEvidence = {
          path: installedFile, scope: registered.classification.scope === 'project' ? 'project'
            : registered.classification.scope === 'user-global' ? 'user-global' : 'unknown',
          reason: '安装登记记录；缓存是否匹配另行显示，不证明实际加载。',
        };
      }
    }
  }

  const configuredIdentities = new Map<string, PluginConfiguration>();
  for (const [identity, config] of userConfigs) configuredIdentities.set(identity, config);
  for (const [identity, config] of configuredIdentities) {
    const hasCache = [...cacheVersions].some(item => item.startsWith(`${identity}\0`));
    const hasRegisteredRow = bindings.some(item => item.pluginId === identity && item.origin === 'configuration' && item.projectId === null);
    if (!hasCache && !hasRegisteredRow) {
      addClaudePluginConfiguration({
        context, identity, sourcePath: config.sourcePath, key: config.key, enabled: config.enabled,
        projectId: null, sourceKind: 'user', cacheState: 'unknown', bindings,
      });
    }
  }

  if (context.project) {
    const projectEnabled = object(args.projectSettings?.enabledPlugins);
    const localEnabled = object(args.projectLocalSettings?.enabledPlugins);
    for (const [identity, raw] of Object.entries(projectEnabled ?? {})) {
      if (Object.hasOwn(localEnabled ?? {}, identity)) continue;
      const source = args.projectSettingsPath;
      const key = `enabledPlugins[${JSON.stringify(identity)}]`;
      addClaudePluginConfiguration({
        context, identity, sourcePath: source, key, enabled: enabledFrom(raw), projectId: context.project.id,
        sourceKind: 'repository', cacheState: 'unknown', bindings,
      });
    }
    for (const [identity, raw] of Object.entries(localEnabled ?? {})) {
      const source = args.projectLocalSettingsPath;
      const key = `enabledPlugins[${JSON.stringify(identity)}]`;
      addClaudePluginConfiguration({
        context, identity, sourcePath: source, key, enabled: enabledFrom(raw), projectId: context.project.id,
        sourceKind: 'repository', cacheState: 'unknown', bindings,
      });
    }
  }
  return bindings;
}

async function scanClaudeFilesystemPlugins(context: ScanContext, diagnostics: string[]): Promise<Binding[]> {
  const root = context.instance.configRoot;
  const pluginRoot = path.join(root, 'plugins');
  const bindings: Binding[] = [];
  if (!(await isSafePathWithin(root, pluginRoot))) return bindings;
  const infrastructure = new Set(['cache', 'data', 'marketplaces']);
  for (const dir of await directDirectories(pluginRoot, diagnostics, 'Claude plugin directory')) {
    const folder = path.basename(dir);
    if (folder.startsWith('.') || infrastructure.has(folder)) continue;
    if (!(await isSafePathWithin(root, dir))) continue;
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
    if (!(await isSafePathWithin(root, manifestPath)) || !(await existsRegularFile(manifestPath))) continue;
    const manifest = object(await safeMcpFile<unknown>(manifestPath, diagnostics, 'Claude filesystem plugin manifest'));
    if (!manifest) continue;
    const name = typeof manifest.name === 'string' && manifest.name.length <= 120 && !/[\r\n\0]/.test(manifest.name)
      ? manifest.name : folder;
    const version = typeof manifest.version === 'string' && /^[A-Za-z0-9._+-]{1,120}$/.test(manifest.version)
      ? manifest.version : undefined;
    const parent = baseBinding({
      context, kind: 'plugin', name, scope: 'native', sourceKind: 'plugin', sourcePath: manifestPath,
      projectId: null, nativeKey: `filesystem-plugin:${path.resolve(dir)}`, identityPath: dir,
      ...(version ? { pluginVersion: version } : {}), origin: 'filesystem', cacheState: 'unknown',
      enabled: null, configurationEnabled: null,
      readOnlyReason: 'Claude filesystem plugin activation is read-only; its configured runtime state is unknown.',
    });
    bindings.push(parent);

    let declarations: string[] = ['./skills'];
    if (typeof manifest.skills === 'string') declarations = [manifest.skills];
    else if (Array.isArray(manifest.skills)) declarations = manifest.skills.filter((item): item is string => typeof item === 'string').slice(0, 20);
    else if (manifest.skills !== undefined) diagnostics.push('Claude 文件系统插件 Skills 声明结构不受支持。');
    for (const declaration of new Set(declarations)) {
      const skillRoot = declaredPath(dir, declaration);
      if (!skillRoot) { diagnostics.push('Claude 文件系统插件 Skill 声明越界或不是包内相对路径。'); continue; }
      if (!(await isSafePathWithin(root, skillRoot))) {
        if (await existsDirectory(skillRoot)) diagnostics.push('Claude 文件系统插件 Skill 声明跨越符号链接或 junction，已跳过。');
        continue;
      }
      if (await existsRegularFile(path.join(skillRoot, 'SKILL.md')) || await existsRegularFile(path.join(skillRoot, 'skill.md'))) {
        bindings.push(...await scanSingleSkill({ directory: skillRoot, context, parentId: parent.id, origin: 'filesystem', cacheState: 'unknown', diagnostics }));
      } else {
        const children = await scanSkillRoot({
          root: skillRoot, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id,
          projectId: null, origin: 'filesystem', cacheState: 'unknown', diagnostics,
        });
        bindings.push(...children.slice(0, MAX_CLAUDE_PLUGIN_SKILLS));
        if (children.length > MAX_CLAUDE_PLUGIN_SKILLS) diagnostics.push('某个 Claude 文件系统插件 Skills 根超过子项上限。');
      }
    }

    const declaredMcp = manifest.mcpServers ?? manifest.mcp_servers;
    let mcpSource = manifestPath;
    let serverValues: unknown = declaredMcp;
    if (typeof declaredMcp === 'string') {
      const mcpPath = declaredPath(dir, declaredMcp);
      if (!mcpPath) {
        diagnostics.push('Claude 文件系统插件 MCP 声明越界或不是包内相对路径。');
        serverValues = null;
      } else if (!(await isSafePathWithin(root, mcpPath))) {
        if (await existsRegularFile(mcpPath)) diagnostics.push('Claude 文件系统插件 MCP 声明跨越符号链接或 junction，已跳过。');
        serverValues = null;
      } else {
        mcpSource = mcpPath;
        const document = object(await safeMcpFile<unknown>(mcpPath, diagnostics, 'Claude filesystem plugin MCP manifest'));
        serverValues = document?.mcpServers ?? document?.mcp_servers ?? document;
      }
    } else if (declaredMcp === undefined) {
      const defaultMcp = path.join(dir, '.mcp.json');
      if (await isSafePathWithin(root, defaultMcp) && await existsRegularFile(defaultMcp)) {
        mcpSource = defaultMcp;
        const document = object(await safeMcpFile<unknown>(defaultMcp, diagnostics, 'Claude filesystem plugin MCP manifest'));
        serverValues = document?.mcpServers ?? document?.mcp_servers ?? document;
      }
    }
    const servers = object(serverValues);
    if (servers) {
      for (const [serverName, raw] of Object.entries(servers).slice(0, MAX_CLAUDE_PLUGIN_MCP_SERVERS)) {
        const server = object(raw);
        const explicitEnabled = server !== null && Object.hasOwn(server, 'enabled');
        bindings.push(baseBinding({
          context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin',
          sourcePath: mcpSource, projectId: null, nativeKey: `filesystem-plugin:${folder}.mcpServers.${serverName}`,
          parentId: parent.id, enabled: null, origin: 'filesystem', ...(version ? { pluginVersion: version } : {}),
          configurationEnabled: null, cacheState: 'unknown',
          mcpTransport: mcpTransport(raw), mcpConfig: object(raw),
          diagnostics: [
            ...(explicitEnabled ? ['包内服务器标记不能确定父插件配置或运行状态。'] : []),
            'No exact name@marketplace configuration identity was available for this filesystem plugin.',
          ],
          readOnlyReason: '文件系统插件附带的 MCP 不能独立修改。',
        }));
      }
      if (Object.keys(servers).length > MAX_CLAUDE_PLUGIN_MCP_SERVERS) diagnostics.push('某个 Claude 文件系统插件 MCP 清单超过子项上限。');
    }
  }
  return bindings;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left).replace(/[\\/]+$/, '');
  const b = path.resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

const discoveredHomes = new Map<string, string>();

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  info: {
    id: 'claude-code', name: 'Claude Code', description: '对 Claude Code Skills、插件元数据与 MCP 配置的只读有限扫描。',
    supportedKinds: ['skill', 'plugin', 'mcp'], writeSupport: [],
  },
  async discover({ homeDir, env }): Promise<AgentInstance[]> {
    const root = expandPath(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), homeDir);
    const executable = await findExecutable(env, ['claude']);
    const hasState = await existsDirectory(root) || await existsRegularFile(path.join(homeDir, '.claude.json'));
    if (!hasState && !executable) return [];
    const found = instance({ agentId: 'claude-code', name: 'Claude Code', configRoot: root, executable });
    discoveredHomes.set(found.id, homeDir);
    return [found];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const root = context.instance.configRoot;
    const homeDir = discoveredHomes.get(context.instance.id) ?? path.dirname(root);
    const globalSkillRoots = [path.join(root, 'skills')];
    const projectSkillRoots = context.project ? [
      path.join(context.project.rootPath, '.claude', 'skills'),
      path.join(context.project.rootPath, '.agents', 'skills'),
    ] : [];
    for (const skillRoot of globalSkillRoots) {
      if (!(await isSafePathWithin(root, skillRoot))) continue;
      bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'user-global', sourceKind: 'user', projectId: null, origin: 'filesystem', diagnostics }));
    }
    for (const skillRoot of projectSkillRoots) {
      if (!(await isSafePathWithin(context.project!.rootPath, skillRoot))) continue;
      bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'project', sourceKind: 'repository', projectId: context.project!.id, origin: 'filesystem', diagnostics,
        ...(skillRoot === path.join(context.project!.rootPath, '.agents', 'skills') ? {
          location: { category: 'project' as const, rootPath: skillRoot, evidencePath: skillRoot,
            reason: '已登记项目的公共 .agents/skills 来源；适配器发现不证明此客户端已加载。' },
        } : {}) }));
    }

    const userSettingsPath = path.join(root, 'settings.json');
    const userSettingsSafe = !(await existsRegularFile(userSettingsPath)) || await isSafePathWithin(root, userSettingsPath);
    if (!userSettingsSafe) diagnostics.push('Claude 用户设置跨越符号链接或 junction，已跳过。');
    const userSettings = userSettingsSafe ? await readSettings(userSettingsPath, diagnostics, 'Claude user settings') : null;
    const projectSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.json') : '';
    const localSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.local.json') : '';
    const projectSettingsSafe = !projectSettingsPath || !(await existsRegularFile(projectSettingsPath)) || await isSafePathWithin(context.project!.rootPath, projectSettingsPath);
    const localSettingsSafe = !localSettingsPath || !(await existsRegularFile(localSettingsPath)) || await isSafePathWithin(context.project!.rootPath, localSettingsPath);
    if (!projectSettingsSafe) diagnostics.push('Claude 项目设置跨越符号链接或 junction，已跳过。');
    if (!localSettingsSafe) diagnostics.push('Claude 本地项目设置跨越符号链接或 junction，已跳过。');
    const projectSettings = projectSettingsSafe && projectSettingsPath ? await readSettings(projectSettingsPath, diagnostics, 'Claude project settings') : null;
    const localSettings = localSettingsSafe && localSettingsPath ? await readSettings(localSettingsPath, diagnostics, 'Claude local project settings') : null;
    const overrides = [
      { settings: userSettings, sourcePath: userSettingsPath, source: 'user' as const, scope: 'user-global' as const, projectId: null },
      ...(context.project ? [
        { settings: projectSettings, sourcePath: projectSettingsPath, source: 'repository' as const, scope: 'project' as const, projectId: context.project.id },
        { settings: localSettings, sourcePath: localSettingsPath, source: 'repository' as const, scope: 'project' as const, projectId: context.project.id },
      ] : []),
    ];
    for (const source of overrides) {
      const skillOverrides = object(source.settings?.skillOverrides);
      if (!skillOverrides) continue;
      for (const [name, rawState] of Object.entries(skillOverrides).slice(0, 300)) {
        const visibility = typeof rawState === 'string' && ['on', 'name-only', 'user-invocable-only', 'off'].includes(rawState)
          ? rawState as 'on' | 'name-only' | 'user-invocable-only' | 'off' : undefined;
        const state = visibility ? visibility !== 'off' : null;
        const control = { mode: 'independent' as const, ...(visibility ? { visibility } : {}),
          reason: visibility ? `Claude skillOverrides 的显式可见性 ${visibility}；仅为该设置层的记录，不代表所有权限、frontmatter 和最终配置合成。`
            : 'Claude skillOverrides 值不是官方四种可见性状态，未推断启用。' };
        const matches = bindings.filter((binding) => binding.kind === 'skill'
          && (binding.displayName ?? binding.name) === name
          && binding.sourceKind === source.source
          && binding.scope === source.scope
          && binding.parentId === null
          && binding.classification?.agentId === 'claude-code'
          && [...globalSkillRoots, ...projectSkillRoots].some((root) => path.dirname(binding.sourcePath) === root));
        if (matches.length > 0) {
          for (const binding of matches) {
            binding.enabled = state;
            binding.configurationEnabled = state;
            binding.configurationSourcePath = source.sourcePath;
            binding.configurationKey = `skillOverrides.${name}`;
            binding.configurationControl = control;
            binding.diagnostics.push('可见性记录来自 Claude Code 的名字级 Skill 覆盖；不确认当前会话生效。');
          }
          continue;
        }
        const override = baseBinding({
          context, kind: 'skill', name, scope: source.scope, sourceKind: source.source, sourcePath: source.sourcePath,
          projectId: source.projectId, nativeKey: `skillOverrides.${name}`, enabled: state,
          origin: 'configuration', configurationSourcePath: source.sourcePath,
          configurationKey: `skillOverrides.${name}`, configurationEnabled: state,
          diagnostics: ['这是名字级覆盖，可能影响多个同名 Skill。'],
          readOnlyReason: '版本验证前，Claude Code Skill 覆盖未开放写入。',
        });
        override.configurationControl = control;
        bindings.push(override);
      }
    }

    const userMcpPath = path.join(homeDir, '.claude.json');
    const userMcpSafe = !(await existsRegularFile(userMcpPath)) || await isSafePathWithin(homeDir, userMcpPath);
    if (!userMcpSafe) diagnostics.push('Claude 用户 MCP 状态跨越符号链接或 junction，已跳过。');
    const userState = userMcpSafe ? await safeMcpFile<unknown>(userMcpPath, diagnostics, 'Claude user MCP state') : null;
    bindings.push(...addMcpEntries({ context, file: userMcpPath, entries: object(userState)?.mcpServers, sourceKind: 'user', diagnostics, label: 'User MCP' }));
    if (context.project) {
      const projects = object(object(userState)?.projects);
      for (const [registeredPath, rawProject] of Object.entries(projects ?? {})) {
        if (!path.isAbsolute(registeredPath) || !samePath(registeredPath, context.project.rootPath)) continue;
        const local = addMcpEntries({ context, file: userMcpPath, entries: object(rawProject)?.mcpServers,
          sourceKind: 'user', projectId: context.project.id, diagnostics, label: 'Claude project-local MCP',
          configurationKey: `projects[${JSON.stringify(registeredPath)}].mcpServers` });
        for (const binding of local) if (binding.classification) binding.classification.location = {
          category: 'agent-global', rootPath: homeDir, evidencePath: userMcpPath,
          reason: '项目私有 MCP 声明保存在用户 .claude.json 中；配置使用范围属于已登记项目，原文仍位于用户目录。',
        };
        bindings.push(...local);
      }
      const projectMcpPath = path.join(context.project.rootPath, '.mcp.json');
      const projectMcpSafe = !(await existsRegularFile(projectMcpPath)) || await isSafePathWithin(context.project.rootPath, projectMcpPath);
      if (!projectMcpSafe) diagnostics.push('Claude 项目 MCP 配置跨越符号链接或 junction，已跳过。');
      const projectConfig = projectMcpSafe ? await safeMcpFile<unknown>(projectMcpPath, diagnostics, 'Claude project MCP config') : null;
      bindings.push(...addMcpEntries({ context, file: projectMcpPath, entries: object(projectConfig)?.mcpServers, sourceKind: 'repository', diagnostics, label: 'Project MCP' }));
    }
    const pluginBindings = await scanClaudePlugins({
      context, settings: userSettings, settingsPath: userSettingsPath,
      projectSettings, projectSettingsPath, projectLocalSettings: localSettings,
      projectLocalSettingsPath: localSettingsPath, diagnostics,
    });
    bindings.push(...pluginBindings);
    bindings.push(...await scanClaudeFilesystemPlugins(context, diagnostics));
    await markClaudeToggleTargets(context, bindings);
    return report(bindings, diagnostics);
  },
};
