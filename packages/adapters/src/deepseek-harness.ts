import { createHash } from 'node:crypto';
import type { AgentAdapter, Binding, ScanContext, ScanReport } from '@agentdeck/contracts';
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import path from 'node:path';
import {
  baseBinding, boundedText, directDirectories, directEntries, expandPath, existsDirectory,
  existsRegularFile, findExecutable, instance, isSafePathWithin, report, scanSkillRoot,
} from './shared.js';

interface YNode {
  items?: unknown[];
  value?: unknown;
  tag?: string;
  source?: string;
}

const DYNAMIC_MARKER = Object.freeze({ agentDeckDynamicExpression: true });
const CUSTOM_TAGS = [{
  tag: 'tag:yaml.org,2002:js',
  resolve: () => DYNAMIC_MARKER,
}];

function scalar(node: unknown): unknown {
  if (!isScalar(node)) return undefined;
  const value = node as YNode;
  if (value.tag === 'tag:yaml.org,2002:js') return undefined;
  return value.value;
}

function isDynamic(node: unknown): boolean {
  if (!node || typeof node !== 'object' || isAlias(node)) return true;
  const value = node as YNode;
  if (value.tag === 'tag:yaml.org,2002:js') return true;
  if (value.source !== undefined && value.value === undefined && !Array.isArray(value.items)) return true;
  const raw = scalar(node);
  return raw !== null && typeof raw === 'object';
}

function mapValue(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const items = (node as YNode).items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!isPair(item)) continue;
    const pair = item as { key?: unknown; value?: unknown };
    if (scalar(pair.key) === key) return pair.value;
  }
  return undefined;
}

function rowSequence(root: unknown): unknown[] {
  if (isSeq(root)) return (root as YNode).items ?? [];
  return [];
}

function staticString(node: unknown): string | null {
  const value = scalar(node);
  return typeof value === 'string' && !isDynamic(node) ? value : null;
}

function staticBoolean(node: unknown): boolean | null {
  const value = scalar(node);
  return typeof value === 'boolean' && !isDynamic(node) ? value : null;
}

function stableRowKey(sourcePath: string, rawId: string | null, rowIndex: number, rawSource: string): string {
  if (rawId) return rawId;
  const digest = createHash('sha256').update(`${sourcePath}\0${rowIndex}\0${rawSource}`).digest('hex').slice(0, 20);
  return `unidentified-${digest}`;
}

async function scanProfilePatch(context: ScanContext, file: string, boundary: string, profile: string, projectScope: boolean, diagnostics: string[]): Promise<Binding[]> {
  if (!(await isSafePathWithin(boundary, file))) {
    diagnostics.push(`DSH profile "${profile}" 跨越符号链接或 junction，已跳过。`);
    return [];
  }
  let sourceText: string;
  try { sourceText = await boundedText(file); }
  catch {
    diagnostics.push(`DSH profile "${profile}" 的 patch 不可读或超限，其条目已跳过。`);
    return [];
  }
  const document = parseDocument(sourceText, { customTags: CUSTOM_TAGS, schema: 'core' });
  if (document.errors.length > 0) {
    diagnostics.push(`DSH profile "${profile}" 包含非法 YAML，其条目已跳过。`);
    return [];
  }
  if (!isSeq(document.contents)) {
    diagnostics.push(`DSH profile "${profile}" 未使用受支持的静态插件行序列，其条目已跳过。`);
    return [];
  }
  const bindings: Binding[] = [];
  const rows = rowSequence(document.contents);
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') continue;
    const rawId = staticString(mapValue(row, 'id'));
    const id = stableRowKey(file, rawId, index, (row as YNode).source ?? '');
    const packageName = staticString(mapValue(row, 'name'));
    const disabledNode = mapValue(row, 'disabled');
    const disabled = staticBoolean(disabledNode);
    const state = disabled === null ? null : !disabled;
    const scope = projectScope ? 'project' : 'native';
    const sourceKind = projectScope ? 'repository' : 'user';
    const projectId = projectScope ? context.project?.id ?? null : null;
    const rowDiagnostics: string[] = [];
    if (!rawId) rowDiagnostics.push('该 DSH patch 行没有静态 id；绑定身份使用其有限行位置与内容摘要。');
    if (disabled === null) rowDiagnostics.push('DSH disabled 值缺失或为动态表达式；有效配置状态未知。');
    const parent = baseBinding({
      context, kind: 'plugin', name: packageName ?? `DSH profile row ${index + 1}`, scope, sourceKind,
      projectId, sourcePath: file, nativeKey: `profiles.${profile}.plugins.${id}`,
      enabled: state,
      origin: 'configuration', configurationSourcePath: file,
      configurationKey: `profiles.${profile}.plugins.${id}`, configurationEnabled: state,
      cacheState: 'unknown',
      diagnostics: rowDiagnostics,
      readOnlyReason: '在验证官方 manager 语义前，DSH profile patch 条目保持只读。',
    });
    bindings.push(parent);

    if (packageName !== '@deepseek-ai/dsh-mcp-client') continue;
    const config = mapValue(row, 'config');
    const serverName = staticString(mapValue(config, 'serverName'));
    if (!serverName) {
      diagnostics.push(`DSH MCP 行 "${id}" 没有静态服务器名；未暴露为 MCP 绑定。`);
      continue;
    }
    bindings.push(baseBinding({
      context, kind: 'mcp', name: serverName, scope, sourceKind, projectId,
      sourcePath: file, nativeKey: `profiles.${profile}.plugins.${id}.config.serverName`, parentId: parent.id,
      enabled: state,
      origin: 'configuration', configurationSourcePath: file,
      configurationKey: `profiles.${profile}.plugins.${id}.config.serverName`, configurationEnabled: state,
      cacheState: 'unknown',
      diagnostics: state === null ? rowDiagnostics : [],
      readOnlyReason: '该 MCP 服务器隶属 DSH 插件行，不能独立修改。',
    }));
  }
  return bindings;
}

async function scanProfiles(context: ScanContext, boundary: string, root: string, projectScope: boolean, diagnostics: string[]): Promise<Binding[]> {
  const bindings: Binding[] = [];
  if (!(await isSafePathWithin(boundary, root))) {
    if (await existsDirectory(root)) diagnostics.push('DSH profiles 跨越符号链接或 junction，已跳过。');
    return bindings;
  }
  for (const directory of await directDirectories(root)) {
    if (!(await isSafePathWithin(boundary, directory))) continue;
    const profile = path.basename(directory);
    const files = (await directEntries(directory)).filter((file) => /\.(?:patch\.)?ya?ml$/i.test(file));
    for (const file of files.slice(0, 40)) {
      if (!(await existsRegularFile(file)) || !(await isSafePathWithin(boundary, file))) continue;
      bindings.push(...await scanProfilePatch(context, file, boundary, profile, projectScope, diagnostics));
    }
  }
  return bindings;
}

export const deepSeekHarnessAdapter: AgentAdapter = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  info: {
    id: 'deepseek-harness', name: 'DeepSeek Harness',
    description: '对 DSH profile patch 行与文件系统 Skills 的只读有限扫描；不执行任何表达式。',
    supportedKinds: ['skill', 'plugin', 'mcp'], writeSupport: [],
  },
  async discover({ homeDir, env }) {
    const root = expandPath(env.DSH_HOME || path.join(homeDir, '.dsh'), homeDir);
    const executable = await findExecutable(env, ['dsh']);
    if (!(await existsDirectory(root)) && !executable) return [];
    return [instance({ agentId: 'deepseek-harness', name: 'DeepSeek Harness', configRoot: root, executable })];
  },
  async scan(context: ScanContext): Promise<ScanReport> {
    const bindings: Binding[] = [];
    const diagnostics: string[] = [];
    const root = context.instance.configRoot;
    const globalSkillsRoot = path.join(root, 'skills');
    if (await isSafePathWithin(root, globalSkillsRoot)) {
      bindings.push(...await scanSkillRoot({
        root: globalSkillsRoot, context, scope: 'user-global', origin: 'filesystem',
        sourceKind: 'user', projectId: null, diagnostics,
      }));
    } else if (await existsDirectory(globalSkillsRoot)) {
      diagnostics.push('DSH 用户 Skills 根目录跨越符号链接或 junction，已跳过。');
    }
    bindings.push(...await scanProfiles(context, root, path.join(root, 'profiles'), false, diagnostics));
    if (context.project) {
      const projectSkillsRoot = path.join(context.project.rootPath, '.dsh', 'skills');
      if (await isSafePathWithin(context.project.rootPath, projectSkillsRoot)) {
        bindings.push(...await scanSkillRoot({
          root: projectSkillsRoot, context, scope: 'project-directory', origin: 'filesystem',
          sourceKind: 'repository', projectId: context.project.id, diagnostics,
        }));
      } else if (await existsDirectory(projectSkillsRoot)) {
        diagnostics.push('DSH 项目 Skills 根目录跨越符号链接或 junction，已跳过。');
      }
      const projectDshRoot = path.join(context.project.rootPath, '.dsh');
      bindings.push(...await scanProfiles(context, context.project.rootPath, path.join(projectDshRoot, 'profiles'), true, diagnostics));
    }
    return report(bindings, diagnostics);
  },
};
