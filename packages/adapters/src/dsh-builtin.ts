import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Binding, ScanContext } from '@agentdeck/contracts';
import {
  baseBinding, boundedRead, boundedText, directEntries, existsRegularFile,
  isSafePathWithin, object, safeMcpFile, scanSkillRoot,
} from './shared.js';
import { isDynamic, mapValue, parseStaticPatchRows, staticBoolean, staticString } from './dsh-patch.js';

/** Installation metadata only. Never executes DeepSeek Harness or imports bundled code. */

const MAX_BUNDLE_FILES_PER_PACKAGE = 8;
const MAX_ROWS_PER_BUNDLE_FILE = 300;
/** Explicit packages with a verified bundled-skill mechanism; no generic SKILL.md sweep. */
const BUNDLED_SKILL_PACKAGES = [
  { pkg: 'dsh-skill-office', dir: 'assets', mechanism: 'dsh-skill-office 以随包 assets 目录注册 source 为 bundled 的 Skill 提供方。' },
  { pkg: 'dsh-agent-preset', dir: 'skills', mechanism: '随包 README 载明该目录经 skill-filesystem 在 creator mode 挂载；挂载条件是动态行为，静态盘点未验证。' },
];
const BUNDLE_MANIFEST_PACKAGES = ['dsh-base', 'dsh-sdk-app', 'dsh-web-app'];

/** Explicit install roots below the DSH home; never a disk-wide search. */
function installRoots(root: string): Array<{ tag: string; packages: string }> {
  return ['app', 'profiles'].map(tag => ({ tag, packages: path.join(root, tag, 'node_modules', '@deepseek-ai') }));
}

async function isVerifiedDshInstall(packages: string, diagnostics: string[]): Promise<string | null> {
  const file = path.join(packages, 'dsh', 'package.json');
  if (!(await isSafePathWithin(packages, file))) return null;
  const marker = object(await safeMcpFile(file, diagnostics, 'DSH bundled install marker'));
  return marker?.name === '@deepseek-ai/dsh' && typeof marker.version === 'string' && marker.version.length > 0 && marker.version.length <= 128 ? marker.version : null;
}

function mark(binding: Binding, evidence: string) {
  binding.sourceKind = 'builtin';
  binding.builtinSourcePath = evidence;
  if (binding.classification?.location) binding.classification.location.reason += ` 内置来源证据：客户端随包资源 ${evidence}；内置来源与启用状态分开，不证明已启用或会话加载。`;
}

export async function scanDshBuiltins(context: ScanContext, bindings: Binding[], diagnostics: string[]) {
  const root = context.instance.configRoot;
  const digest = async (file: string) => createHash('sha256').update(await boundedRead(file)).digest('hex');
  const installs: Array<{ tag: string; packages: string; version: string }> = [];
  for (const candidate of installRoots(root)) {
    if (!(await isSafePathWithin(root, candidate.packages))) continue;
    const version = await isVerifiedDshInstall(candidate.packages, diagnostics);
    if (version) installs.push({ ...candidate, version });
  }
  if (!installs.length) return;
  const bundled: Binding[] = [];
  for (const install of installs) {
    const installLabel = `DSH ${install.tag} 安装根（@deepseek-ai/dsh ${install.version}）`;
    for (const entry of BUNDLED_SKILL_PACKAGES) {
      const pkgDir = path.join(install.packages, entry.pkg);
      if (!(await isSafePathWithin(install.packages, pkgDir))) continue;
      const pkgFile = path.join(pkgDir, 'package.json');
      if (!(await isSafePathWithin(pkgDir, pkgFile))) continue;
      const pkg = object(await safeMcpFile(pkgFile, diagnostics, 'DSH bundled skill package'));
      if (pkg?.name !== `@deepseek-ai/${entry.pkg}`) continue;
      const skillRoot = path.join(pkgDir, entry.dir);
      if (!(await isSafePathWithin(pkgDir, skillRoot))) continue;
      const found = await scanSkillRoot({ root: skillRoot, context, scope: 'user-global', sourceKind: 'builtin', projectId: null,
        origin: 'filesystem', diagnostics,
        location: { category: 'agent-global', rootPath: install.packages, evidencePath: skillRoot,
          reason: `${installLabel}随包 Skill；${entry.mechanism}不证明其他 Agent 使用。` } });
      for (const skill of found) {
        const evidence = (await existsRegularFile(path.join(skill.sourcePath, 'SKILL.md')))
          ? path.join(skill.sourcePath, 'SKILL.md') : path.join(skill.sourcePath, 'skill.md');
        let bundledDigest: string | null = null;
        try { bundledDigest = await digest(evidence); } catch { /* Unprovable content still stays inventoried below. */ }
        if (bundledDigest !== null) {
          for (const candidate of bindings.filter(b => b.kind === 'skill' && b.name === skill.name && b.sourceKind !== 'builtin' && !b.parentId)) {
            const candidateManifest = path.join(candidate.sourcePath, await existsRegularFile(path.join(candidate.sourcePath, 'SKILL.md')) ? 'SKILL.md' : 'skill.md');
            if (!(await isSafePathWithin(candidate.sourcePath, candidateManifest))) continue;
            try { if (await digest(candidateManifest) !== bundledDigest) continue; } catch { continue; }
            candidate.diagnostics.push(`SKILL.md 摘要与随包文件 ${evidence} 相同；未比较辅助文件，不改变用户/项目来源或合并独立路径绑定。`);
          }
        }
        mark(skill, evidence);
        skill.configurationStateReason = '客户端随包 Skill，仅静态发现，未关联当前启用配置，状态未确定。';
        skill.readOnlyReason = '客户端随包原文只读。';
        bundled.push(skill);
      }
    }
    for (const layerPkg of BUNDLE_MANIFEST_PACKAGES) {
      const pkgDir = path.join(install.packages, layerPkg);
      if (!(await isSafePathWithin(install.packages, pkgDir))) continue;
      const pkgFile = path.join(pkgDir, 'package.json');
      if (!(await isSafePathWithin(pkgDir, pkgFile))) continue;
      const pkg = object(await safeMcpFile(pkgFile, diagnostics, 'DSH bundled layer package'));
      if (pkg?.name !== `@deepseek-ai/${layerPkg}`) continue;
      const layerFiles: string[] = [];
      const mainPatch = path.join(pkgDir, 'cordis.patch.yml');
      if (await existsRegularFile(mainPatch)) layerFiles.push(mainPatch);
      const presetsDir = path.join(pkgDir, 'presets');
      if (await isSafePathWithin(pkgDir, presetsDir)) {
        layerFiles.push(...(await directEntries(presetsDir, diagnostics, 'DSH bundled presets')).filter(file => /\.ya?ml$/i.test(file)));
      }
      if (layerFiles.length > MAX_BUNDLE_FILES_PER_PACKAGE) diagnostics.push('DSH 随包清单层文件超过上限，只扫描有界子集。');
      for (const file of layerFiles.slice(0, MAX_BUNDLE_FILES_PER_PACKAGE)) {
        if (!(await isSafePathWithin(install.packages, file))) continue;
        const relFile = path.relative(install.packages, file).split(path.sep).join('/');
        let rows: unknown[] | null;
        try {
          rows = parseStaticPatchRows(await boundedText(file));
        } catch {
          diagnostics.push(`DSH 随包清单层 "${relFile}" 不可读或超限，已跳过。`);
          continue;
        }
        if (!rows) {
          diagnostics.push(`DSH 随包清单层 "${relFile}" 包含非法 YAML 或不是受支持的静态插件行序列，已跳过。`);
          continue;
        }
        for (const [index, row] of rows.entries()) {
          if (index >= MAX_ROWS_PER_BUNDLE_FILE) {
            diagnostics.push(`DSH 随包清单层 "${relFile}" 行数超过有界上限，只盘点前 ${MAX_ROWS_PER_BUNDLE_FILE} 行。`);
            break;
          }
          if (!row || typeof row !== 'object') continue;
          const rawId = staticString(mapValue(row, 'id'));
          const name = staticString(mapValue(row, 'name'));
          if (!name || name === 'cordis:group' || staticBoolean(mapValue(row, 'group')) === true) continue;
          const disabledNode = mapValue(row, 'disabled');
          const disabled = staticBoolean(disabledNode);
          const scoped = /^@deepseek-ai\/[A-Za-z0-9._-]+$/.test(name);
          const referencedFile = scoped ? path.join(install.packages, name.slice('@deepseek-ai/'.length), 'package.json') : null;
          const reference = referencedFile && await isSafePathWithin(install.packages, referencedFile)
            ? object(await safeMcpFile(referencedFile, diagnostics, 'DSH referenced package metadata')) : null;
          const pkgPresent = reference?.name === name;
          const parent = baseBinding({
            context, kind: 'plugin', name: name ?? `DSH bundled row ${index + 1}`, scope: 'native', sourceKind: 'builtin',
            sourcePath: file, projectId: null, nativeKey: `builtin:${install.tag}/${relFile}#${index}.${rawId ?? `row-${index}`}`,
            origin: 'filesystem', enabled: null,
            location: { category: 'agent-global', rootPath: install.packages, evidencePath: file,
              reason: `${installLabel}随包插件清单层 ${relFile} 的静态行声明；${scoped ? (pkgPresent ? '同名插件包存在于该安装根。' : '未在该安装根核对到同名插件包。') : '该行名称不是 @deepseek-ai 包名，未核对包存在性。'}层叠后的生效状态未确定，不证明会话加载。` },
            diagnostics: [
              ...(!rawId ? ['该随包行没有静态 id；绑定身份使用有限行位置。'] : []),
              ...(!name ? ['该随包行没有静态插件包名。'] : []),
              ...(disabled === null && disabledNode !== undefined ? [isDynamic(disabledNode) ? '随包 disabled 值为动态表达式，默认状态未确定。' : '随包 disabled 值不是静态布尔值，默认状态未确定。'] : []),
              ...(disabled === true ? ['随包默认层声明 disabled: true；后续配置层可覆盖。'] : []),
              ...(scoped && !pkgPresent ? ['随包行引用的插件包未在该安装根核对到。'] : []),
            ],
            readOnlyReason: '客户端随包清单只读；不修改安装目录。',
          });
          parent.configurationStateReason = '发现客户端随包插件清单声明；实际状态取决于 profile 层叠与动态表达式，未确定。';
          mark(parent, file);
          bundled.push(parent);
          if (name === '@deepseek-ai/dsh-mcp-client') {
            const config = mapValue(row, 'config');
            const serverName = staticString(mapValue(config, 'serverName'));
            if (!serverName) continue;
            const transport = staticString(mapValue(config, 'transport'));
            const child = baseBinding({ context, kind: 'mcp', name: serverName, scope: 'native', sourceKind: 'builtin',
              projectId: null, parentId: parent.id, sourcePath: file, nativeKey: `${parent.nativeKey}.config.serverName`, origin: 'filesystem',
              mcpTransport: transport === 'stdio' ? 'stdio' : ['http', 'sse', 'streamable-http'].includes(transport ?? '') ? 'http' : 'unknown',
              ...(parent.classification?.location ? { location: { ...parent.classification.location } } : {}),
              readOnlyReason: '随包 MCP 仅静态声明，启用状态与独立控制机制未确定。' });
            child.configurationStateReason = parent.configurationStateReason;
            mark(child, file); bundled.push(child);
          }
        }
      }
    }
  }
  bindings.push(...bundled);
}
