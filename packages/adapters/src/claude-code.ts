import type { AgentAdapter, AgentInstance, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import {
  baseBinding, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, object, report, safeMcpFile, scanSkillRoot,
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

async function scanPlugins(context: ScanContext, settings: Record<string, unknown> | null, diagnostics: string[]): Promise<Binding[]> {
  const bindings: Binding[] = [];
  const enabledPlugins = object(settings?.enabledPlugins);
  const pluginRoot = path.join(context.instance.configRoot, 'plugins');
  for (const dir of await directDirectories(pluginRoot)) {
    const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
    let manifest: Record<string, unknown> | null = null;
    if (await existsRegularFile(manifestPath)) manifest = object(await safeMcpFile(manifestPath, diagnostics, 'Claude plugin manifest'));
    const directoryName = path.basename(dir);
    const pluginName = typeof manifest?.name === 'string' ? manifest.name : directoryName;
    const statusEntry = enabledPlugins?.[pluginName] ?? enabledPlugins?.[directoryName];
    const status = enabledFrom(statusEntry);
    const parent = baseBinding({
      context, kind: 'plugin', name: pluginName, scope: 'native', sourceKind: 'plugin', sourcePath: manifestPath,
      nativeKey: `plugin:${directoryName}`, enabled: status,
      readOnlyReason: 'Claude Code plugin activation is read-only in this iteration.',
    });
    bindings.push(parent);

    const skillsDecl = manifest?.skills;
    const skillRoots: string[] = [path.join(dir, 'skills')];
    if (typeof skillsDecl === 'string') skillRoots.push(path.resolve(dir, skillsDecl));
    if (Array.isArray(skillsDecl)) {
      for (const value of skillsDecl.slice(0, 20)) if (typeof value === 'string') skillRoots.push(path.resolve(dir, value));
    }
    for (const skillRoot of [...new Set(skillRoots)]) {
      if (!isUnderPlugin(dir, skillRoot)) continue;
      bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, diagnostics }));
    }

    const mcp = manifest?.mcpServers ?? manifest?.mcp_servers;
    const childServers = object(mcp);
    if (childServers) {
      for (const [serverName, rawServer] of Object.entries(childServers)) {
        const server = object(rawServer);
        const serverState = typeof server?.enabled === 'boolean' ? server.enabled : true;
        bindings.push(baseBinding({
          context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin', sourcePath: manifestPath,
          nativeKey: `plugin:${pluginName}.mcpServers.${serverName}`, parentId: parent.id,
          enabled: status === false ? false : serverState,
          diagnostics: status === false ? ['Disabled by the parent plugin configuration.'] : [],
          readOnlyReason: 'This MCP entry belongs to a plugin and cannot be changed independently.',
        }));
      }
    }
  }
  return bindings;
}

function isUnderPlugin(pluginDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(pluginDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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
    for (const skillRoot of globalSkillRoots) bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'user-global', sourceKind: 'user', projectId: null, diagnostics }));
    for (const skillRoot of projectSkillRoots) bindings.push(...await scanSkillRoot({ root: skillRoot, context, scope: 'project', sourceKind: 'repository', diagnostics }));

    const userSettingsPath = path.join(root, 'settings.json');
    const userSettings = await readSettings(userSettingsPath, diagnostics, 'Claude user settings');
    const projectSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.json') : '';
    const localSettingsPath = context.project ? path.join(context.project.rootPath, '.claude', 'settings.local.json') : '';
    const projectSettings = projectSettingsPath ? await readSettings(projectSettingsPath, diagnostics, 'Claude project settings') : null;
    const localSettings = localSettingsPath ? await readSettings(localSettingsPath, diagnostics, 'Claude local project settings') : null;
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
            binding.diagnostics.push('Effective state comes from a Claude Code name-level Skill override.');
          }
          continue;
        }
        bindings.push(baseBinding({
          context, kind: 'skill', name, scope: source.scope, sourceKind: source.source, sourcePath: source.sourcePath,
          projectId: source.projectId, nativeKey: `skillOverrides.${name}`, enabled: state,
          diagnostics: ['This is a name-level override and may affect multiple same-named Skills.'],
          readOnlyReason: 'Claude Code Skill overrides are not enabled for writing before version validation.',
        }));
      }
    }

    const userMcpPath = path.join(homeDir, '.claude.json');
    const userState = await safeMcpFile<unknown>(userMcpPath, diagnostics, 'Claude user MCP state');
    bindings.push(...addMcpEntries({ context, file: userMcpPath, entries: object(userState)?.mcpServers, sourceKind: 'user', diagnostics, label: 'User MCP' }));
    if (context.project) {
      const projectMcpPath = path.join(context.project.rootPath, '.mcp.json');
      const projectConfig = await safeMcpFile<unknown>(projectMcpPath, diagnostics, 'Claude project MCP config');
      bindings.push(...addMcpEntries({ context, file: projectMcpPath, entries: object(projectConfig)?.mcpServers, sourceKind: 'repository', diagnostics, label: 'Project MCP' }));
    }
    bindings.push(...await scanPlugins(context, userSettings, diagnostics));
    return report(bindings, diagnostics);
  },
};
