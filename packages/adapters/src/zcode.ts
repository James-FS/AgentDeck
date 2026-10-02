import type { AgentAdapter, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import path from 'node:path';
import {
  baseBinding, directDirectories, expandPath, existsDirectory, existsRegularFile, findExecutable,
  instance, object, report, safeMcpFile, scanSkillRoot,
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
      diagnostics: server ? [] : ['MCP server entry is not a static object.'],
      readOnlyReason: 'ZCode MCP settings are read-only until a native write path is validated.',
    });
  });
}

function pluginEnabled(plugin: Record<string, unknown>): boolean | null {
  return typeof plugin.enabled === 'boolean' ? plugin.enabled : null;
}

async function scanPluginDirs(context: ScanContext, root: string, diagnostics: string[]): Promise<Binding[]> {
  const bindings: Binding[] = [];
  for (const dir of await directDirectories(root)) {
    const manifestPath = path.join(dir, '.zcode-plugin', 'plugin.json');
    const manifestFileExists = await existsRegularFile(manifestPath);
    if (!manifestFileExists) continue;
    const manifestResult = manifestFileExists ? await safeMcpFile<unknown>(manifestPath, diagnostics, 'ZCode plugin manifest') : null;
    const manifest = object(manifestResult);
    const name = typeof manifest?.name === 'string' ? manifest.name : path.basename(dir);
    const parent = baseBinding({
      context, kind: 'plugin', name, scope: 'native', sourceKind: 'plugin', projectId: null,
      sourcePath: manifestPath, nativeKey: `plugin-dir:${path.resolve(dir)}`,
      enabled: pluginEnabled(manifest ?? {}),
      readOnlyReason: 'ZCode plugin activation is not changed by the read-only adapter.',
    });
    bindings.push(parent);

    for (const candidate of [path.join(dir, 'skills'), ...(typeof manifest?.skills === 'string' ? [path.resolve(dir, manifest.skills)] : [])]) {
      if (!inside(dir, candidate)) continue;
      bindings.push(...await scanSkillRoot({ root: candidate, context, scope: 'native', sourceKind: 'plugin', parentId: parent.id, projectId: null, diagnostics }));
    }
    const servers = object(manifest?.mcpServers ?? manifest?.mcp_servers);
    if (servers) {
      for (const [serverName, raw] of Object.entries(servers)) {
        const server = object(raw);
        bindings.push(baseBinding({
          context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin', projectId: null,
          sourcePath: manifestPath, nativeKey: `plugin:${name}.mcpServers.${serverName}`, parentId: parent.id,
          enabled: manifest?.enabled === false ? false : typeof server?.enabled === 'boolean' ? server.enabled : null,
          diagnostics: manifest?.enabled === false ? ['Disabled by the parent plugin configuration.'] : [],
          readOnlyReason: 'Plugin MCP entries are read-only and cannot be changed independently.',
        }));
      }
    }
  }
  return bindings;
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function scanFile(context: ScanContext, file: string, source: 'user' | 'repository', bindings: Binding[], diagnostics: string[]): Promise<void> {
  if (!(await existsRegularFile(file))) return;
  const parsed = await safeMcpFile<unknown>(file, diagnostics, source === 'user' ? 'ZCode user config' : 'ZCode project config');
  if (parsed) bindings.push(...addServers(context, file, parsed, source));
}

export const zcodeAdapter: AgentAdapter = {
  id: 'zcode',
  name: 'ZCode',
  info: {
    id: 'zcode', name: 'Official ZCode CLI', description: 'Read-only bounded scanner for the official ZCode CLI config and local extensions.',
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
    await scanFile(context, path.join(root, 'cli', 'config.json'), 'user', bindings, diagnostics);
    if (context.project) {
      await scanFile(context, path.join(context.project.rootPath, '.zcode', 'cli', 'config.json'), 'repository', bindings, diagnostics);
    }

    const roots: Array<{ path: string; scope: 'user-global' | 'project-directory'; source: 'user' | 'repository'; projectId: string | null }> = [
      { path: path.join(root, 'skills'), scope: 'user-global', source: 'user', projectId: null },
    ];
    if (context.project) {
      roots.push({ path: path.join(context.project.rootPath, '.zcode', 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
      roots.push({ path: path.join(context.project.rootPath, 'skills'), scope: 'project-directory', source: 'repository', projectId: context.project.id });
    }
    for (const candidate of roots) bindings.push(...await scanSkillRoot({
      root: candidate.path, context, scope: candidate.scope, sourceKind: candidate.source, projectId: candidate.projectId, diagnostics,
    }));

    bindings.push(...await scanPluginDirs(context, path.join(root, 'plugins'), diagnostics));
    return report(bindings, diagnostics);
  },
};
