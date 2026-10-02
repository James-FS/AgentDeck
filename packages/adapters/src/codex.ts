import TOML from '@iarna/toml';
import type { AgentAdapter, AgentInstance, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import {
  baseBinding, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, object, report, safeTomlFile, scanSkillRoot,
} from './shared.js';

const discoveredHomes = new Map<string, string>();

function enabledValue(value: unknown): boolean | null {
  const obj = object(value);
  return typeof obj?.enabled === 'boolean' ? obj.enabled : null;
}

function addCodexPluginBindings(args: {
  context: ScanContext;
  sourcePath: string;
  plugins: Record<string, unknown>;
  bindings: Binding[];
  diagnostics: string[];
}): void {
  for (const [pluginName, raw] of Object.entries(args.plugins)) {
    const plugin = object(raw);
    const key = `plugins.${pluginName}`;
    const parent = baseBinding({
      context: args.context, kind: 'plugin', name: pluginName, scope: 'native', sourceKind: 'plugin',
      sourcePath: args.sourcePath, projectId: null, nativeKey: key, enabled: enabledValue(plugin),
      diagnostics: plugin ? [] : ['Plugin table is not a static table.'],
      readOnlyReason: 'Codex plugin toggles are outside the supported independent MCP change engine.',
    });
    args.bindings.push(parent);
    const servers = object(plugin?.mcp_servers);
    if (!servers) continue;
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = object(rawServer);
      const localEnabled = typeof server?.enabled === 'boolean' ? server.enabled : true;
      const effective = plugin?.enabled === false ? false : localEnabled;
      args.bindings.push(baseBinding({
        context: args.context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin',
        sourcePath: args.sourcePath, projectId: null, nativeKey: `${key}.mcp_servers.${serverName}`, parentId: parent.id,
        enabled: effective,
        diagnostics: plugin?.enabled === false ? ['Disabled by the parent plugin configuration.'] : [],
        readOnlyReason: 'MCP servers declared by a plugin are read-only; only independent Codex MCP tables can be changed.',
      }));
    }
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  name: 'Codex',
  info: {
    id: 'codex', name: 'Codex', description: 'Read-only local discovery and bounded configuration scanning for Codex.',
    supportedKinds: ['skill', 'plugin', 'mcp'],
    writeSupport: ['experimental: manually registered writable instance, independent mcp_servers entries in config.toml only'],
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
    let config: Record<string, unknown> | null = null;
    const parsed = await safeTomlFile(configPath, diagnostics, 'Codex config.toml', (text) => {
      if (/\r(?!\n)/.test(text)) throw new Error('unsupported-line-ending');
      return TOML.parse(text.replace(/\r\n/g, '\n')) as Record<string, unknown>;
    });
    config = parsed.value;

    if (config) {
      const standalone = object(config.mcp_servers);
      if (standalone) {
        const writableInstance = (agent.discovery === 'manual' || agent.discovery === 'demo') && agent.writable;
        for (const [serverName, raw] of Object.entries(standalone)) {
          const server = object(raw);
          const state = server && server.enabled === undefined ? true : typeof server?.enabled === 'boolean' ? server.enabled : null;
          const tableCount = parsed.text ? countCodexServerTables(parsed.text, serverName) : 0;
          const enabledFieldIsSupported = !server || server.enabled === undefined || typeof server.enabled === 'boolean';
          const supported = tableCount === 1 && server !== null && enabledFieldIsSupported;
          const writable = writableInstance && supported;
          const reasons: string[] = [];
          if (server?.enabled === undefined) reasons.push('Codex treats a missing enabled field as enabled by default.');
          else if (server && typeof server.enabled !== 'boolean') reasons.push('The enabled field is not a TOML boolean.');
          if (tableCount !== 1) reasons.push('The target table is duplicated or its syntax cannot be located safely.');
          if (writableInstance && supported) reasons.push('Experimental: this Codex version has not been validated on a real installation.');
          bindings.push(baseBinding({
            context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'user',
            sourcePath: configPath, projectId: null, nativeKey: `mcp_servers.${serverName}`, enabled: state,
            writable,
            readOnlyReason: writable ? null : !writableInstance
              ? 'Writing requires a manually registered writable instance or an isolated writable demo instance.'
              : 'The TOML target table is not uniquely addressable.',
            diagnostics: reasons,
          }));
        }
      }
      const plugins = object(config.plugins);
      if (plugins) addCodexPluginBindings({ context, sourcePath: configPath, plugins, bindings, diagnostics });
    }

    const roots: Array<{ root: string; scope: 'user-global' | 'project'; source: 'user' | 'repository' }> = [
      { root: path.join(discoveredHomes.get(agent.id) ?? path.dirname(agent.configRoot), '.agents', 'skills'), scope: 'user-global', source: 'user' },
      { root: path.join(agent.configRoot, 'skills'), scope: 'user-global', source: 'user' },
    ];
    if (project) {
      roots.push({ root: path.join(project.rootPath, '.agents', 'skills'), scope: 'project', source: 'repository' });
      roots.push({ root: path.join(project.rootPath, '.codex', 'skills'), scope: 'project', source: 'repository' });
    }
    for (const root of roots) bindings.push(...await scanSkillRoot({
      root: root.root, context, scope: root.scope, sourceKind: root.source,
      projectId: root.scope === 'user-global' ? null : context.project?.id ?? null, diagnostics,
    }));

    for (const pluginDir of await directDirectories(path.join(agent.configRoot, 'plugins'))) {
      const pluginName = path.basename(pluginDir);
      const parent = bindings.find((binding) => binding.kind === 'plugin' && binding.name === pluginName)
        ?? baseBinding({
          context, kind: 'plugin', name: pluginName, scope: 'native', sourceKind: 'plugin', sourcePath: pluginDir,
          projectId: null, nativeKey: `plugin-dir:${path.resolve(pluginDir)}`, readOnlyReason: 'Filesystem plugin activation is not modified by this adapter.',
        });
      if (!bindings.includes(parent)) bindings.push(parent);
      const bundledSkills = await scanSkillRoot({
        root: path.join(pluginDir, 'skills'), context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, diagnostics,
        projectId: null,
      });
      bindings.push(...bundledSkills);
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
