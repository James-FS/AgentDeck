import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import { baseBinding, boundedRead, declaredPath, directDirectories, existsRegularFile, isSafePathWithin, object, safeMcpFile, scanSkillRoot, mcpTransport } from './shared.js';

/** Installation metadata only. Never invokes ZCode or imports bundled code. */
export async function findZCodeDesktopRoot(env: NodeJS.ProcessEnv, homeDir?: string): Promise<string | null> {
  const candidates: string[] = [];
  if (env.ZCODE_DESKTOP_ROOT) candidates.push(env.ZCODE_DESKTOP_ROOT);
  else if (process.platform === 'win32' && env.SystemRoot && homeDir && env.USERPROFILE
    && path.resolve(homeDir).toLowerCase() === path.resolve(env.USERPROFILE).toLowerCase()) {
    const script = "$ErrorActionPreference='SilentlyContinue'; @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { Get-ItemProperty ($_+'\\*') } | Where-Object { $_.DisplayName -match '^ZCode(\\s|$)' } | ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation } elseif ($_.DisplayIcon) { Split-Path -Parent ($_.DisplayIcon.Trim('\"') -replace ',\\d+$','') } }";
    const output = await new Promise<string>(resolve => execFile(path.join(env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : stdout)));
    candidates.push(...output.split(/\r?\n/).filter(Boolean).slice(0, 8));
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const root = path.resolve(candidate);
    const metaFile = path.join(root, 'resources/glm/.node-bundle-meta.json');
    if (!(await isSafePathWithin(root, metaFile)) || !(await existsRegularFile(path.join(root, 'ZCode.exe')))) continue;
    const meta = object(await safeMcpFile(metaFile, [], 'ZCode bundled package metadata'));
    if (meta?.runtime === 'electron-node' && meta.entry === 'zcode.cjs' && await isSafePathWithin(root, path.join(root, 'resources/glm/zcode.cjs'))) return root;
  }
  return null;
}

export async function scanZCodeBuiltins(context: ScanContext, bindings: Binding[], diagnostics: string[]) {
  const desktop = context.instance.desktopResourceRoot;
  if (!desktop) return;
  if (await findZCodeDesktopRoot({ ZCODE_DESKTOP_ROOT: desktop }) !== desktop) return;
  const root = path.join(desktop, 'resources/glm/packages');
  if (!(await isSafePathWithin(desktop, root))) return;
  const digest = async (file: string) => createHash('sha256').update(await boundedRead(file, 1024 * 1024)).digest('hex');
  function mark(binding: Binding, evidence: string) {
    binding.sourceKind = 'builtin'; binding.builtinSourcePath = evidence;
    if (binding.classification?.location) binding.classification.location.reason += ` 内置来源证据：客户端随包资源 ${evidence}；缓存项另经完整身份、版本和内容摘要匹配，不证明启用或运行。`;
  }
  const packages = await directDirectories(root, diagnostics, 'ZCode built-in packages');
  if (packages.length > 40) diagnostics.push('ZCode 内置包目录超过 40 项，只扫描有界子集。');
  for (const directory of packages.slice(0, 40)) {
    if (!(await isSafePathWithin(root, directory))) continue;
    const packageFile = path.join(directory, 'package.json');
    const standalone = path.basename(directory) === 'bundled-skills';
    if (!standalone && !(await isSafePathWithin(directory, packageFile))) continue;
    const pkg = object(await safeMcpFile(packageFile, diagnostics, 'ZCode bundled package'));
    if (!standalone && (typeof pkg?.name !== 'string' || !pkg.name.startsWith('@zcode/'))) continue;
    const manifestFile = path.join(directory, '.zcode-plugin/plugin.json');
    if (await existsRegularFile(manifestFile) && !(await isSafePathWithin(directory, manifestFile))) continue;
    const manifest = object(await safeMcpFile(manifestFile, diagnostics, 'ZCode bundled plugin'));
    if (!manifest && path.basename(directory) !== 'bundled-skills') continue;
    const name = typeof manifest?.name === 'string' ? manifest.name : 'bundled-skills';
    const version = typeof manifest?.version === 'string' ? manifest.version : typeof pkg?.version === 'string' ? pkg.version : standalone ? 'bundled' : null;
    if (!version) continue;
    const evidence = manifest ? manifestFile : path.join(desktop, 'resources/glm/.node-bundle-meta.json');
    const peers: Binding[] = [];
    for (const binding of bindings.filter(b => b.kind === 'plugin' && b.projectId === null && b.origin === 'cache'
      && b.pluginIdentityVerified && b.pluginId === `${name}@zcode-plugins-official` && b.pluginVersion === version)) {
      try { if (await digest(binding.sourcePath) === await digest(evidence)) { mark(binding, evidence); peers.push(binding); } } catch { /* Missing/oversized proof stays unclassified. */ }
    }
    const declarations = typeof manifest?.skills === 'string' ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills.filter((v): v is string => typeof v === 'string').slice(0, 20) : ['./skills'];
    if (peers.length) {
      for (const configuration of bindings.filter(b => b.kind === 'plugin' && b.projectId === null && b.origin === 'configuration' && b.pluginId === `${name}@zcode-plugins-official`)) mark(configuration, evidence);
      for (const peer of peers) for (const child of bindings.filter(b => b.parentId === peer.id && b.kind === 'mcp')) {
        const bundledFile = path.resolve(directory, path.relative(path.dirname(path.dirname(peer.sourcePath)), child.sourcePath));
        if (!(await isSafePathWithin(directory, bundledFile))) continue;
        try { if (await digest(child.sourcePath) === await digest(bundledFile)) mark(child, bundledFile); } catch { /* Content cannot be proven. */ }
      }
    }
    const bundled: Binding[] = [];
    let parent: Binding | undefined;
    if (manifest && !peers.length) {
      parent = baseBinding({ context, kind: 'plugin', name, scope: 'native', sourceKind: 'builtin', projectId: null,
        sourcePath: evidence, nativeKey: `builtin:${name}/${version}`, origin: 'filesystem', pluginVersion: version,
        location: { category: 'agent-global', rootPath: root, evidencePath: evidence, reason: 'ZCode 安装目录随包插件清单；不代表已启用。' },
        readOnlyReason: '客户端随包资源只读；不修改安装目录或猜测内置开关。' });
      parent.configurationStateReason = '发现客户端随包资源，未关联当前启用配置，状态未确定。'; mark(parent, evidence); bundled.push(parent);
    }
    for (const declaration of declarations) {
      const skills = declaredPath(directory, declaration);
      if (!skills || !(await isSafePathWithin(directory, skills))) continue;
      const found = await scanSkillRoot({ context, root: skills, scope: 'user-global', sourceKind: 'builtin', projectId: null,
        origin: 'filesystem', ...(parent ? { parentId: parent.id } : {}), diagnostics,
        location: { category: 'agent-global', rootPath: root, evidencePath: evidence, reason: 'ZCode 安装目录随包 Skill；不证明其他 Agent 使用。' } });
      for (const skill of found) {
        const relative = path.relative(directory, skill.sourcePath);
        let matched = false;
        for (const peer of peers) for (const child of bindings.filter(b => b.parentId === peer.id && b.kind === 'skill')) {
          if (path.relative(path.dirname(path.dirname(peer.sourcePath)), child.sourcePath) !== relative) continue;
          try { if (await digest(path.join(child.sourcePath, 'SKILL.md')) === await digest(path.join(skill.sourcePath, 'SKILL.md'))) { mark(child, path.join(skill.sourcePath, 'SKILL.md')); matched = true; } } catch { /* No matching content evidence. */ }
        }
        if (!matched) { mark(skill, path.join(skill.sourcePath, 'SKILL.md')); skill.configurationStateReason = '客户端随包 Skill，仅静态发现，启用状态未确定。'; skill.readOnlyReason = '客户端随包原文只读。'; bundled.push(skill); }
      }
    }
    if (parent) {
      const mcpFile = path.join(directory, '.mcp.json');
      if (await isSafePathWithin(directory, mcpFile)) {
        const mcp = object(await safeMcpFile(mcpFile, diagnostics, 'ZCode bundled MCP'));
        for (const [serverName, value] of Object.entries(object(mcp?.mcpServers) ?? {}).slice(0, 200)) {
          const b = baseBinding({ context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'builtin', projectId: null, parentId: parent.id,
            sourcePath: mcpFile, nativeKey: `builtin:${name}.mcpServers.${serverName}`, origin: 'filesystem', mcpTransport: mcpTransport(value),
            location: { category: 'agent-global', rootPath: root, evidencePath: mcpFile, reason: '客户端随包 MCP 静态声明，不连接或执行。' }, readOnlyReason: '内置 MCP 未验证独立开关。' });
          b.configurationStateReason = parent.configurationStateReason ?? '内置 MCP 未关联启用配置。'; mark(b, mcpFile); bundled.push(b);
        }
      }
    }
    bindings.push(...bundled);
  }
}
