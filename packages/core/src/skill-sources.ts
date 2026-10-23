import { createHash } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { SkillSource, SkillSourceFinding, SkillSourceReport } from '@agentdeck/contracts';

const MAX_DIRECTORIES = 500;
const MAX_ENTRIES_PER_DIRECTORY = 2_000;
const MAX_FILES = 2 * 1024 * 1024;
const MAX_FRONTMATTER = 128 * 1024;
const EXAMPLE_SEGMENTS = new Set(['scripts', 'references', 'examples', 'templates', 'tests', 'test', 'assets']);
const NOISE_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.pnpm-store', '.venv', 'vendor']);
const EXPLICIT_HIDDEN_ENTRIES = new Set(['.agents', '.claude', '.codex', '.dsh', '.zcode', '.cursor', '.opencode', '.claude-plugin']);

export function skillSourceId(sourcePath: string): string {
  return `skill_source_${createHash('sha256').update(path.resolve(sourcePath).toLocaleLowerCase('en-US')).digest('hex').slice(0, 24)}`;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function scanSkillSource(source: SkillSource): Promise<SkillSourceReport> {
  const rootPath = path.resolve(source.path);
  const findings: SkillSourceFinding[] = [];
  const diagnostics: string[] = [];
  const visitedReal = new Set<string>();
  const maxDepth = source.mode === 'quick' ? 1 : 8;
  const limits = { maxDepth, maxDirectories: MAX_DIRECTORIES, maxEntriesPerDirectory: MAX_ENTRIES_PER_DIRECTORY,
    maxManifestBytes: MAX_FILES, maxFrontmatterBytes: MAX_FRONTMATTER };
  let visitedDirectories = 0;
  let truncatedAt: string | null = null;
  let continuationPath: string | null = null;
  const truncationReasons: string[] = [];
  const markTruncated = (reason: string, at: string, canContinueAt: string | null = null) => {
    if (truncatedAt === null) {
      truncatedAt = at;
      continuationPath = canContinueAt;
    }
    if (!truncationReasons.includes(reason)) truncationReasons.push(reason);
  };
  let rootReal: string;
  try {
    const rootStat = await stat(rootPath);
    if (!rootStat.isDirectory()) throw new Error('登记路径不是目录。');
    rootReal = await realpath(rootPath);
  } catch (error) {
    return { status: 'failed', rootPath, candidateCount: 0, recognizedCount: 0, skippedCount: 0,
      visitedDirectories: 0, limits, truncatedAt: null, continuationPath: null,
      diagnostics: [error instanceof Error ? error.message : '无法读取登记目录。'], findings };
  }
  const resolveContinuationDirectory = async (logical: string, entry: Dirent): Promise<string | null> => {
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && source.followLinks)) return null;
    try {
      const actual = await realpath(logical);
      if (!(await stat(logical)).isDirectory()) return null;
      if (!isInside(rootReal, actual)) {
        const reason = entry.isSymbolicLink() ? '链接目标越出登记目录边界，无法作为续扫入口。' : '目录实际路径越出登记目录边界，无法作为续扫入口。';
        diagnostics.push(`${reason} ${logical}`);
        findings.push({ logicalPath: logical, actualPath: actual, name: entry.name, status: 'skipped', reason, description: null });
        return null;
      }
      return logical;
    } catch {
      const reason = '目录在扫描期间发生变化或路径解析失败，无法作为续扫入口。';
      diagnostics.push(`${reason} ${logical}`);
      findings.push({ logicalPath: logical, actualPath: logical, name: entry.name, status: 'skipped', reason, description: null });
      return null;
    }
  };
  const visit = async (logical: string, real: string, depth: number, logicalParts: string[], insideSkillPackage: boolean): Promise<void> => {
    if (visitedDirectories >= MAX_DIRECTORIES) { markTruncated(`达到 ${MAX_DIRECTORIES} 个目录上限`, logical, logical); return; }
    const canonical = process.platform === 'win32' ? real.toLocaleLowerCase('en-US') : real;
    if (visitedReal.has(canonical)) {
      findings.push({ logicalPath: logical, actualPath: real, name: path.basename(logical), status: 'skipped', reason: '链接循环或目录已通过其他路径访问。', description: null });
      return;
    }
    visitedReal.add(canonical);
    visitedDirectories += 1;
    const entries: Dirent[] = [];
    let overflowEntry: Dirent | null = null;
    try {
      const directory = await opendir(logical);
      for await (const entry of directory) {
        if (entries.length >= MAX_ENTRIES_PER_DIRECTORY) { overflowEntry = entry; break; }
        entries.push(entry);
      }
    } catch { diagnostics.push(`无法读取目录：${logical}`); return; }
    if (overflowEntry !== null) {
      diagnostics.push(`目录超过 ${MAX_ENTRIES_PER_DIRECTORY} 个直接子项上限，扫描在此截断：${logical}`);
      const overflowPath = path.join(logical, overflowEntry.name);
      const canContinueAt = NOISE_DIRECTORIES.has(overflowEntry.name)
        || overflowEntry.name.startsWith('.') && !EXPLICIT_HIDDEN_ENTRIES.has(overflowEntry.name)
        ? null : await resolveContinuationDirectory(overflowPath, overflowEntry);
      markTruncated(`达到每目录 ${MAX_ENTRIES_PER_DIRECTORY} 个直接子项上限`, overflowPath, canContinueAt);
    }
    let manifestName: string | null = null;
    for (const filename of ['SKILL.md', 'skill.md']) {
      try { if ((await lstat(path.join(logical, filename))).isFile()) { manifestName = filename; break; } }
      catch { /* no manifest with this spelling */ }
    }
    let validSkillPackage = false;
    if (manifestName) {
      const logicalManifest = path.join(logical, manifestName);
      let status: SkillSourceFinding['status'] = 'candidate';
      let reason = 'SKILL.md 存在，但文件格式或必需字段无效。';
      let description: string | null = null;
      try {
        const info = await lstat(logicalManifest);
        if (!info.isFile() || info.size > MAX_FILES) throw new Error('manifest 不是普通文件或超过 2 MiB。');
        const text = (await readFile(logicalManifest, 'utf8')).replace(/^\uFEFF/, '');
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
        if (!frontmatter) throw new Error('缺少有效的 YAML frontmatter 起止标记。');
        if (Buffer.byteLength(frontmatter, 'utf8') > MAX_FRONTMATTER) throw new Error('YAML frontmatter 超过 128 KiB。');
        const document = parseDocument(frontmatter, { uniqueKeys: true, schema: 'core' });
        if (document.errors.length || !isMap(document.contents)) throw new Error('YAML frontmatter 无效或不是对象。');
        const nameNode = document.contents.get('name', true);
        const descriptionNode = document.contents.get('description', true);
        const nameValue: unknown = isScalar(nameNode) ? (nameNode as { value: unknown }).value : null;
        const descriptionValue: unknown = isScalar(descriptionNode) ? (descriptionNode as { value: unknown }).value : null;
        if (typeof nameValue !== 'string' || !nameValue.trim() || typeof descriptionValue !== 'string' || !descriptionValue.trim()) {
          throw new Error('frontmatter 缺少有效的字符串 name 或 description。');
        }
        const name = nameValue.trim().slice(0, 120);
        reason = `识别为 Skill（name: ${name}）。`;
        status = 'recognized';
        validSkillPackage = true;
        description = descriptionValue.trim().slice(0, 500);
      } catch (error) { reason = error instanceof Error ? error.message : reason; }
      const auxiliarySegment = logicalParts.find(part => {
        const normalized = part.toLocaleLowerCase('en-US');
        return EXAMPLE_SEGMENTS.has(normalized) && (normalized !== 'assets' || insideSkillPackage);
      });
      if (auxiliarySegment) {
        status = 'skipped';
        reason = auxiliarySegment.toLocaleLowerCase('en-US') === 'assets'
          ? '位于已识别 Skill 包的 assets 资源目录；内部模板或示例不作为独立 Skill。'
          : '位于 scripts/references/examples 等示例或辅助目录，避免误判为可用 Skill。';
        validSkillPackage = false;
      }
      findings.push({ logicalPath: logicalManifest, actualPath: path.join(real, manifestName), name: path.basename(logical), status, reason, description });
    }
    const canDescend = (entry: typeof entries[number]) => {
      if (entry.isSymbolicLink()) return source.followLinks;
      return entry.isDirectory();
    };
    if (depth >= maxDepth) {
      for (const pending of entries) {
        if (!canDescend(pending) || NOISE_DIRECTORIES.has(pending.name)
          || pending.name.startsWith('.') && !EXPLICIT_HIDDEN_ENTRIES.has(pending.name)) continue;
        const pendingPath = path.join(logical, pending.name);
        const canContinueAt = await resolveContinuationDirectory(pendingPath, pending);
        if (canContinueAt) {
          markTruncated(`达到最大深度 ${maxDepth}`, pendingPath, canContinueAt);
          break;
        }
      }
      return;
    }
    for (const entry of entries) {
      if (NOISE_DIRECTORIES.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !EXPLICIT_HIDDEN_ENTRIES.has(entry.name)) {
        if (entry.isDirectory()) findings.push({ logicalPath: path.join(logical, entry.name), actualPath: path.join(logical, entry.name),
          name: entry.name, status: 'skipped', reason: '隐藏目录不是已支持的项目 Skill 入口；已跳过。支持 .agents、.claude、.codex、.dsh 等明确入口。', description: null });
        continue;
      }
      const child = path.join(logical, entry.name);
      const parts = [...logicalParts, entry.name];
      if (entry.isSymbolicLink() && !source.followLinks) {
        let target = child;
        try { target = await realpath(child); } catch { /* preserve the unresolved logical target */ }
        let reason = '符号链接/junction 默认不跟随；可单独将显示的目标登记为扫描入口。';
        if (target === child) {
          reason += ' 链接目标无法解析，目录可能已变化或损坏。';
          diagnostics.push(`链接目标无法解析或已变化：${child}`);
        }
        findings.push({ logicalPath: child, actualPath: target, name: entry.name, status: 'skipped', reason, description: null });
        continue;
      }
      let childReal: string;
      try {
        if (entry.isSymbolicLink()) {
          childReal = await realpath(child);
          if (!(await stat(child)).isDirectory()) continue;
        } else if (entry.isDirectory()) childReal = await realpath(child);
        else continue;
      } catch {
        const reason = '目录在扫描期间发生变化或路径解析失败，已跳过。';
        diagnostics.push(`${reason} ${child}`);
        findings.push({ logicalPath: child, actualPath: child, name: entry.name, status: 'skipped', reason, description: null });
        continue;
      }
      if (!isInside(rootReal, childReal)) {
        const reason = entry.isSymbolicLink() ? '链接目标越出登记目录边界，已跳过。' : '目录实际路径越出登记目录边界，已跳过。';
        findings.push({ logicalPath: child, actualPath: childReal, name: entry.name, status: 'skipped', reason, description: null });
        diagnostics.push(`${reason} ${child}`);
        continue;
      }
      if (visitedDirectories >= MAX_DIRECTORIES) {
        markTruncated(`达到 ${MAX_DIRECTORIES} 个目录上限`, child, child);
        break;
      }
      await visit(child, childReal, depth + 1, parts, insideSkillPackage || validSkillPackage);
    }
  };
  await visit(rootPath, rootReal, 0, [], false);
  if (truncatedAt) diagnostics.push(`${truncationReasons.join('；')}，扫描在此截断：${truncatedAt}`);
  const candidateCount = findings.filter(item => item.status === 'candidate' || item.status === 'recognized').length;
  const recognizedCount = findings.filter(item => item.status === 'recognized').length;
  const skippedCount = findings.filter(item => item.status === 'skipped').length;
  return { status: diagnostics.length || truncatedAt ? 'partial' : 'complete', rootPath, rootRealPath: rootReal, candidateCount, recognizedCount,
    skippedCount, visitedDirectories, limits, truncatedAt, continuationPath, diagnostics, findings };
}
