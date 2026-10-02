import type { AgentAdapter, AgentInstance, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
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
}): Binding[] {
  const result: Binding[] = [];
  const servers = object(args.entries);
  if (!servers) return result;
  for (const [name, raw] of Object.entries(servers)) {
    const server = object(raw);
    const enabled = typeof server?.enabled === 'boolean' ? server.enabled : null;
    result.push(baseBinding({
      context: args.context, kind: 'mcp', name, scope: args.context.project && args.sourceKind === 'repository' ? 'project' : 'native',
      sourceKind: args.sourceKind, sourcePath: args.file, projectId: args.sourceKind === 'user' ? null : args.context.project?.id ?? null,
      nativeKey: `mcpServers.${name}`, enabled,
      origin: 'configuration', configurationSourcePath: args.file,
      configurationKey: args.configurationKey ? `${args.configurationKey}.${name}` : `mcpServers.${name}`,
      configurationEnabled: enabled, cacheState: 'unknown',
      mcpTransport: mcpTransport(server),
      diagnostics: server ? [] : [`${args.label} entry is not a static object.`],
      readOnlyReason: 'Claude Code MCP configuration is read-only in this iteration.',
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
    diagnostics: [...(parts ? [] : ['Plugin identity does not contain an exact name@marketplace pair.']), ...(args.diagnostics ?? [])],
    readOnlyReason: 'Claude Code plugin activation is read-only in this iteration.',
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
    if (entries.length > remaining) args.diagnostics.push('Claude plugin cache directory scan reached its bounded entry limit.');
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
            args.diagnostics.push('Claude plugin cache package scan reached its bounded package limit.');
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
            ...(configuration ? {
              configurationSourcePath: configuration.sourcePath,
              configurationKey: configuration.key,
              configurationEnabled: configuration.enabled,
            } : { configurationEnabled: null }),
            cacheState: 'present',
            diagnostics: [
              ...(nameMismatch ? ['Plugin manifest name does not match its cache directory identity; configuration association was withheld.'] : []),
              ...(!nameMismatch && !configuration ? ['This cached plugin version has no exact matching user enabledPlugins identity.'] : []),
            ],
            readOnlyReason: 'A cached plugin version is read-only; runtime selection cannot be inferred from cache contents.',
          });
          bindings.push(parent);
          if (nameMismatch) cacheIdentityConflicts.add(`${identity}\0${version}`);
          else cacheVersions.add(`${identity}\0${version}`);

          let skillDeclarations: string[] = ['./skills'];
          if (typeof manifest.skills === 'string') skillDeclarations = [manifest.skills];
          else if (Array.isArray(manifest.skills)) skillDeclarations = manifest.skills.filter((value): value is string => typeof value === 'string').slice(0, 20);
          else if (manifest.skills !== undefined) args.diagnostics.push('Claude plugin Skills declaration has an unsupported shape.');
          const seen = new Set<string>();
          for (const declaration of skillDeclarations) {
            const skillRoot = declaredPath(versionDir, declaration);
            if (!skillRoot) {
              args.diagnostics.push('Claude plugin Skill declaration escapes or is not a relative path inside its package.');
              continue;
            }
            if (seen.has(skillRoot)) continue;
            seen.add(skillRoot);
            if (!(await isSafePathWithin(root, skillRoot))) {
              if (await existsDirectory(skillRoot)) args.diagnostics.push('Claude plugin Skill declaration crosses a symlink or junction and was skipped.');
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
              if (children.length > MAX_CLAUDE_PLUGIN_SKILLS) args.diagnostics.push('A Claude plugin Skills root exceeded its bounded child limit.');
            }
          }

          const mcpDeclaration = manifest.mcpServers ?? manifest.mcp_servers;
          let mcpSource = manifestPath;
          let serverValues: unknown = mcpDeclaration;
          if (typeof mcpDeclaration === 'string') {
            const mcpPath = declaredPath(versionDir, mcpDeclaration);
            if (!mcpPath) {
              args.diagnostics.push('Claude plugin MCP declaration escapes or is not a relative path inside its package.');
              serverValues = null;
            } else if (!(await isSafePathWithin(root, mcpPath))) {
              if (await existsRegularFile(mcpPath)) args.diagnostics.push('Claude plugin MCP declaration crosses a symlink or junction and was skipped.');
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
                mcpTransport: mcpTransport(rawServer),
                cacheState: 'present',
                diagnostics: [
                  ...(configuration?.enabled === false ? ['Disabled by the parent plugin configuration.'] : []),
                  ...(invalidLocalState ? ['The plugin MCP enabled field is not a static boolean.'] : []),
                  ...(configuration?.enabled == null && hasLocalEnabled ? ['A child enabled value cannot establish effective state without an enabled parent plugin identity.'] : []),
                ],
                readOnlyReason: 'MCP servers bundled with a cached plugin cannot be changed independently.',
              }));
            }
            if (Object.keys(childServers).length > MAX_CLAUDE_PLUGIN_MCP_SERVERS) args.diagnostics.push('A Claude plugin MCP manifest exceeded its bounded child limit.');
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
          args.diagnostics.push('Claude installed plugin registry reached its bounded registration limit.');
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
        if (recordProjectId === null && version && cacheVersions.has(cacheVersionKey) && pathMatches) continue;
        const configuration = recordProjectId === null ? userConfigs.get(identity) : undefined;
        const registrationKey = `plugins[${JSON.stringify(identity)}][${index}]`;
        const registrationDiagnostics = [
          ...(!pathMatches ? ['Installed plugin registration does not point to the matching in-root cache version.'] : []),
          ...(cacheIdentityConflicts.has(packageKey) ? ['Plugin manifest name conflicts with the installed plugin identity.'] : []),
          ...(pathMatches && !manifestPresent ? ['Installed plugin registration points to a cache version with no readable plugin manifest.'] : []),
        ];
        addClaudePluginConfiguration({
          context, identity, sourcePath: installedFile, key: registrationKey,
          enabled: configuration?.enabled ?? null,
          projectId: recordProjectId,
          sourceKind: recordProjectId ? 'repository' : 'user',
          cacheState: pathMatches ? cacheIdentityConflicts.has(packageKey) ? 'unknown' : manifestPresent ? 'present' : 'missing' : 'unknown',
          ...(version ? { version } : {}), diagnostics: registrationDiagnostics, bindings,
        });
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
    else if (manifest.skills !== undefined) diagnostics.push('Claude filesystem plugin Skills declaration has an unsupported shape.');
    for (const declaration of new Set(declarations)) {
      const skillRoot = declaredPath(dir, declaration);
      if (!skillRoot) { diagnostics.push('Claude filesystem plugin Skill declaration escapes or is not a relative path inside its package.'); continue; }
      if (!(await isSafePathWithin(root, skillRoot))) {
        if (await existsDirectory(skillRoot)) diagnostics.push('Claude filesystem plugin Skill declaration crosses a symlink or junction and was skipped.');
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
        if (children.length > MAX_CLAUDE_PLUGIN_SKILLS) diagnostics.push('A Claude filesystem plugin Skills root exceeded its bounded child limit.');
      }
    }

    const declaredMcp = manifest.mcpServers ?? manifest.mcp_servers;
    let mcpSource = manifestPath;
    let serverValues: unknown = declaredMcp;
    if (typeof declaredMcp === 'string') {
      const mcpPath = declaredPath(dir, declaredMcp);
      if (!mcpPath) {
        diagnostics.push('Claude filesystem plugin MCP declaration escapes or is not a relative path inside its package.');
        serverValues = null;
      } else if (!(await isSafePathWithin(root, mcpPath))) {
        if (await existsRegularFile(mcpPath)) diagnostics.push('Claude filesystem plugin MCP declaration crosses a symlink or junction and was skipped.');
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
          mcpTransport: mcpTransport(raw),
          diagnostics: [
            ...(explicitEnabled ? ['A bundled server flag does not establish the parent plugin configuration or runtime state.'] : []),
            'No exact name@marketplace configuration identity was available for this filesystem plugin.',
          ],
          readOnlyReason: 'MCP servers bundled with a filesystem plugin cannot be changed independently.',
        }));
      }
      if (Object.keys(servers).length > MAX_CLAUDE_PLUGIN_MCP_SERVERS) diagnostics.push('A Claude filesystem plugin MCP manifest exceeded its bounded child limit.');
    }
  }
  return bindings;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left).replace(/[\\/]+$/, '');
  const b = path.resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  info: {
    id: 'claude-code', name: 'Claude Code', description: 'Read-only bounded scan of Claude Code Skills, plugin metadata, and MCP configuration.',
    supportedKinds: ['skill', 'plugin', 'mcp'], writeSupport: [],
  },
  async discover({ homeDir, env }): Promise<AgentInstance[]> {
    const root = expandPath(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), homeDir);
    const executable = await findExecutable(env, ['claude']);
    const hasState = await existsDirectory(root) || await existsRegularFile(path.join(homeDir, '.claude.json'));
    if (!hasState && !executable) return [];
    return [instance({ agentId: 'claude-code', name: 'Claude Code', configRoot: root, executable })];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const root = context.instance.configRoot;
    const homeDir = path.dirname(root);
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
      bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'project', sourceKind: 'repository', projectId: context.project!.id, origin: 'filesystem', diagnostics }));
    }

    const userSettingsPath = path.join(root, 'settings.json');
    const userSettingsSafe = !(await existsRegularFile(userSettingsPath)) || await isSafePathWithin(root, userSettingsPath);
    if (!userSettingsSafe) diagnostics.push('Claude user settings cross a symlink or junction and were skipped.');
    const userSettings = userSettingsSafe ? await readSettings(userSettingsPath, diagnostics, 'Claude user settings') : null;
    const projectSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.json') : '';
    const localSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.local.json') : '';
    const projectSettingsSafe = !projectSettingsPath || !(await existsRegularFile(projectSettingsPath)) || await isSafePathWithin(context.project!.rootPath, projectSettingsPath);
    const localSettingsSafe = !localSettingsPath || !(await existsRegularFile(localSettingsPath)) || await isSafePathWithin(context.project!.rootPath, localSettingsPath);
    if (!projectSettingsSafe) diagnostics.push('Claude project settings cross a symlink or junction and were skipped.');
    if (!localSettingsSafe) diagnostics.push('Claude local project settings cross a symlink or junction and were skipped.');
    const projectSettings = projectSettingsSafe && projectSettingsPath ? await readSettings(projectSettingsPath, diagnostics, 'Claude project settings') : null;
    const localSettings = localSettingsSafe && localSettingsPath ? await readSettings(localSettingsPath, diagnostics, 'Claude local project settings') : null;
    const projectOverrideSettings = { ...(projectSettings ?? {}), ...(localSettings ?? {}) };
    const overrides = [
      { settings: userSettings, sourcePath: userSettingsPath, source: 'user' as const, scope: 'user-global' as const, projectId: null },
      ...(context.project ? [
        { settings: projectOverrideSettings, sourcePath: localSettings?.skillOverrides ? localSettingsPath : projectSettingsPath, source: 'repository' as const, scope: 'project' as const, projectId: context.project.id },
      ] : []),
    ];
    for (const source of overrides) {
      const skillOverrides = object(source.settings?.skillOverrides);
      if (!skillOverrides) continue;
      for (const [name, rawState] of Object.entries(skillOverrides)) {
        const state = enabledFrom(rawState);
        if (state === null) continue;
        const matches = bindings.filter((binding) => binding.kind === 'skill'
          && binding.name === name
          && binding.sourceKind === source.source
          && binding.scope === source.scope
          && binding.parentId === null);
        if (matches.length > 0) {
          for (const binding of matches) {
            binding.enabled = state;
            binding.configurationEnabled = state;
            binding.configurationSourcePath = source.sourcePath;
            binding.configurationKey = `skillOverrides.${name}`;
            binding.diagnostics.push('Effective state comes from a Claude Code name-level Skill override.');
          }
          continue;
        }
        bindings.push(baseBinding({
          context, kind: 'skill', name, scope: source.scope, sourceKind: source.source, sourcePath: source.sourcePath,
          projectId: source.projectId, nativeKey: `skillOverrides.${name}`, enabled: state,
          origin: 'configuration', configurationSourcePath: source.sourcePath,
          configurationKey: `skillOverrides.${name}`, configurationEnabled: state,
          diagnostics: ['This is a name-level override and may affect multiple same-named Skills.'],
          readOnlyReason: 'Claude Code Skill overrides are not enabled for writing before version validation.',
        }));
      }
    }

    const userMcpPath = path.join(homeDir, '.claude.json');
    const userMcpSafe = !(await existsRegularFile(userMcpPath)) || await isSafePathWithin(homeDir, userMcpPath);
    if (!userMcpSafe) diagnostics.push('Claude user MCP state crosses a symlink or junction and was skipped.');
    const userState = userMcpSafe ? await safeMcpFile<unknown>(userMcpPath, diagnostics, 'Claude user MCP state') : null;
    bindings.push(...addMcpEntries({ context, file: userMcpPath, entries: object(userState)?.mcpServers, sourceKind: 'user', diagnostics, label: 'User MCP' }));
    if (context.project) {
      const projectMcpPath = path.join(context.project.rootPath, '.mcp.json');
      const projectMcpSafe = !(await existsRegularFile(projectMcpPath)) || await isSafePathWithin(context.project.rootPath, projectMcpPath);
      if (!projectMcpSafe) diagnostics.push('Claude project MCP config crosses a symlink or junction and was skipped.');
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
    return report(bindings, diagnostics);
  },
};
