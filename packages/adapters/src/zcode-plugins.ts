import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import { baseBinding, declaredPath, directDirectories, existsDirectory, existsRegularFile, isSafePathWithin, mcpTransport, object, safeMcpFile, scanSingleSkill, scanSkillRoot } from './shared.js';

/** Static metadata only: never loads plugin code or expands environment variables. */
export async function scanZCodePlugins(context: ScanContext, configuration: Binding[], diagnostics: string[]): Promise<Binding[]> {
  const root = context.instance.configRoot;
  const bindings: Binding[] = [];
  const installedFile = path.join(root, 'cli', 'plugins', 'installed_plugins.json');
  const installed = await isSafePathWithin(root, installedFile)
    ? object(await safeMcpFile(installedFile, diagnostics, 'ZCode installed plugin registry')) : null;
  const rows = Array.isArray(installed?.plugins) ? installed.plugins.slice(0, 300).map(object) : [];
  let visited = 0;
  let packages = 0;
  const directories = async (dir: string) => {
    if (visited >= 2400 || !(await isSafePathWithin(root, dir))) return [];
    const found = await directDirectories(dir, diagnostics, 'ZCode plugin directory');
    const result = found.slice(0, 2400 - visited);
    visited += result.length;
    return result.filter(p => !path.basename(p).startsWith('.'));
  };
  async function scanPackage(directory: string, identity?: string, version?: string, marketplace?: string) {
    if (++packages > 300) return;
    let manifestPath: string | undefined;
    for (const candidate of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      const file = path.join(directory, candidate);
      if (await isSafePathWithin(root, file) && await existsRegularFile(file)) { manifestPath = file; break; }
    }
    if (!manifestPath) return;
    const manifest = object(await safeMcpFile(manifestPath, diagnostics, 'ZCode plugin manifest'));
    if (!manifest) return;
    const folder = identity?.split('@')[0] ?? path.basename(directory);
    const name = typeof manifest.name === 'string' && manifest.name.length <= 128 ? manifest.name : folder;
    const verified = manifest.name === folder;
    const config = verified && identity ? configuration.find(b => b.kind === 'plugin' && b.projectId === null && b.pluginId === identity && b.origin === 'configuration') : undefined;
    const registration = verified && identity && version ? rows.find(row => row?.id === identity && row.version === version && row.scope === 'user'
      && typeof row.installPath === 'string' && path.resolve(row.installPath).toLocaleLowerCase() === path.resolve(directory).toLocaleLowerCase()) : undefined;
    const parent = baseBinding({ context, kind: 'plugin', name, scope: 'native', sourceKind: 'plugin', sourcePath: manifestPath,
      nativeKey: identity ? `cache:${identity}/${version}` : `plugin-dir:${directory}`, identityPath: directory,
      projectId: null, origin: identity ? 'cache' : 'filesystem', enabled: config?.enabled ?? null,
      ...(identity ? { pluginId: identity, pluginVersion: version!, marketplace: marketplace!, pluginIdentityVerified: verified } : {}),
      ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.configurationKey!, configurationEnabled: config.enabled } : { configurationEnabled: null }),
      cacheState: 'present', diagnostics: verified ? [] : ['ZCode manifest 名称与目录身份不一致，不关联配置或安装登记。'],
      readOnlyReason: 'ZCode 插件静态盘点只读；缓存版本不代表当前采用版本。' });
    if (registration && parent.classification) {
      parent.classification.scope = 'user-global';
      parent.classification.relationship = 'configured';
      parent.classification.evidencePath = installedFile;
      parent.classification.reason = 'ZCode user 安装登记精确匹配插件身份、版本与实际缓存路径；不证明运行。';
      parent.classification.installationEvidence = { path: installedFile, scope: 'user-global', reason: parent.classification.reason };
    }
    bindings.push(parent);
    const metadata = { context, parentId: parent.id, diagnostics, ...(identity ? { pluginId: identity, pluginVersion: version!, marketplace: marketplace! } : {}),
      ...(config ? { configurationSourcePath: config.sourcePath, configurationKey: config.configurationKey! } : {}), configurationEnabled: config?.enabled ?? null, origin: identity ? 'cache' as const : 'filesystem' as const, cacheState: 'present' as const };
    const declarations = typeof manifest.skills === 'string' ? [manifest.skills]
      : Array.isArray(manifest.skills) ? manifest.skills.filter((v): v is string => typeof v === 'string').slice(0, 20) : ['./skills'];
    const seen = new Set<string>();
    for (const declaration of declarations) {
      const skillRoot = declaredPath(directory, declaration);
      if (!skillRoot) { diagnostics.push('ZCode 插件 Skill 声明越界，已跳过。'); continue; }
      if (!(await isSafePathWithin(root, skillRoot))) {
        // An optional skills directory may be absent; inspect metadata without following links.
        if (await lstat(skillRoot).then(() => true, () => false)) diagnostics.push('ZCode 插件 Skill 声明跨越链接或不在安全根内，已跳过。');
        continue;
      }
      if (seen.has(skillRoot)) continue;
      seen.add(skillRoot);
      if (await existsRegularFile(path.join(skillRoot, 'SKILL.md')) || await existsRegularFile(path.join(skillRoot, 'skill.md'))) bindings.push(...await scanSingleSkill({ directory: skillRoot, ...metadata }));
      else bindings.push(...(await scanSkillRoot({ root: skillRoot, scope: 'native', sourceKind: 'plugin', projectId: null, ...metadata })).slice(0, 100));
    }
    const values = new Map<string, { raw: unknown; file: string }>();
    async function readServers(file: string) {
      if (!(await isSafePathWithin(root, file)) || !(await existsRegularFile(file))) return;
      const json = object(await safeMcpFile(file, diagnostics, 'ZCode plugin MCP declaration'));
      const entries = object(json?.mcpServers) ?? json;
      if (entries) for (const [name, raw] of Object.entries(entries).slice(0, 200)) values.set(name, { raw, file });
    }
    await readServers(path.join(directory, '.mcp.json'));
    const declared = manifest.mcpServers ?? manifest.mcp_servers;
    if (typeof declared === 'string') {
      const file = declaredPath(directory, declared);
      if (file) await readServers(file); else diagnostics.push('ZCode 插件 MCP 声明越界，已跳过。');
    } else if (object(declared)) {
      for (const [name, raw] of Object.entries(object(declared)!).slice(0, 200)) values.set(name, { raw, file: manifestPath });
    }
    for (const [serverName, { raw, file }] of [...values].slice(0, 200)) {
      const server = object(raw);
      const flag = server && Object.hasOwn(server, 'enable') ? server.enable : server?.enabled;
      const enabled = parent.enabled === false ? false : parent.enabled === true && server ? flag === undefined ? true : typeof flag === 'boolean' ? flag : null : null;
      bindings.push(baseBinding({ ...metadata, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'plugin', projectId: null,
        sourcePath: file, nativeKey: `plugin:${identity ?? folder}.mcpServers.${serverName}`,
        enabled, mcpTransport: mcpTransport(raw), cacheState: 'present',
        diagnostics: server ? [] : ['ZCode 插件 MCP 声明不是静态对象。'], readOnlyReason: 'ZCode 插件 MCP 随父插件配置，只读且不执行。' }));
    }
  }
  for (const marketplaceDir of await directories(path.join(root, 'cli', 'plugins', 'cache'))) {
    for (const pluginDir of await directories(marketplaceDir)) {
      for (const versionDir of await directories(pluginDir)) await scanPackage(versionDir, `${path.basename(pluginDir)}@${path.basename(marketplaceDir)}`, path.basename(versionDir), path.basename(marketplaceDir));
    }
  }
  if (await existsDirectory(path.join(root, 'plugins'))) for (const directory of await directories(path.join(root, 'plugins'))) {
    if (!['cache', 'data', 'marketplaces'].includes(path.basename(directory))) await scanPackage(directory);
  }
  if (packages > 300 || visited >= 2400) diagnostics.push('ZCode 插件扫描达到包数或目录上限，结果不代表全量覆盖。');
  return bindings;
}
