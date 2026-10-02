import { randomUUID, createHash } from 'node:crypto';
import {
  chmod, copyFile, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ChangePlan, Operation } from '@agentdeck/contracts';
import { editCodexEnabled } from './toml-edit.js';
import {
  type AppliedChange,
  ChangeEngineError,
  type EngineOptions,
  type PathIdentity,
  type PathIdentityEntry,
  type PreparedChange,
  type CodexToggleTarget,
  type PrepareToggleInput,
  type RecoveryItem,
  type RecoveryReport,
} from './types.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_META_BYTES = 256 * 1024;
const MAX_RECOVERY_FILES = 1000;

interface AppliedRecord {
  schemaVersion: 1;
  operation: Operation;
  plan: ChangePlan;
  configPath: string;
  serverName: string;
  target?: CodexToggleTarget;
  beforeHash: string;
  afterHash: string;
  snapshotPath: string | null;
  beforeEnabled: boolean | null;
  desiredEnabled: boolean | null;
  restoreOf?: string;
  appliedIdentity: PathIdentity;
}

interface JournalRecord {
  schemaVersion: 1;
  operationId: string;
  stage: 'prepared' | 'writing' | 'applied' | 'aborted' | 'conflict';
  plan: ChangePlan;
  operation: Operation;
  configPath: string;
  serverName: string;
  target?: CodexToggleTarget;
  beforeHash: string;
  afterHash: string;
  snapshotPath: string | null;
  beforeEnabled: boolean | null;
  desiredEnabled: boolean | null;
  preparedIdentity: PathIdentity;
  appliedIdentity?: PathIdentity;
  pendingTempPath?: string;
  expectedAfterIdentity?: PathIdentity;
}

interface TargetLock { release(): Promise<void> }

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(code: ConstructorParameters<typeof ChangeEngineError>[0], message: string): never {
  throw new ChangeEngineError(code, message);
}

function safeNow(input?: Date): Date { return input ? new Date(input.getTime()) : new Date(); }

function stateLabel(value: boolean | null): string { return value === null ? 'unknown' : value ? 'true' : 'false'; }

function targetLabel(serverName: string, target?: CodexToggleTarget): string {
  if (target?.kind === 'plugin') return `[plugins.${JSON.stringify(target.id)}]`;
  if (target?.kind === 'skill') return `[[skills.config]]\npath = ${JSON.stringify(target.path)}`;
  return `[mcp_servers.${JSON.stringify(serverName)}]`;
}

function decodeUtf8(bytes: Buffer): string {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = hasBom ? bytes.subarray(3) : bytes;
  const text = payload.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(payload)) fail('INVALID_CONFIG', 'The Codex TOML file is not valid UTF-8.');
  return `${hasBom ? '\uFEFF' : ''}${text}`;
}

async function readConfig(configPath: string): Promise<Buffer> {
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.size > 1024 * 1024) fail('INVALID_CONFIG', 'The Codex TOML target is not a regular file within the size limit.');
    const bytes = await readFile(configPath);
    if (bytes.byteLength > 1024 * 1024) fail('INVALID_CONFIG', 'The Codex TOML target exceeds the size limit.');
    return bytes;
  } catch (error) {
    if (error instanceof ChangeEngineError) throw error;
    fail('IO_ERROR', 'The Codex TOML target could not be read.');
  }
}

function parseRelativeComponents(absolute: string): { root: string; parts: string[] } {
  const parsed = path.parse(absolute);
  const remainder = absolute.slice(parsed.root.length);
  return { root: parsed.root, parts: remainder.split(path.sep).filter(Boolean) };
}

async function capturePathIdentity(targetPath: string): Promise<PathIdentity> {
  const absolute = path.resolve(targetPath);
  const { root, parts } = parseRelativeComponents(absolute);
  let current = root;
  const entries: PathIdentityEntry[] = [];
  try {
    const rootStat = await lstat(root);
    entries.push({ path: root, realPath: await realpath(root), dev: rootStat.dev, ino: rootStat.ino, symbolicLink: rootStat.isSymbolicLink(), linkTarget: rootStat.isSymbolicLink() ? await readlink(root) : null });
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index] ?? '');
      const info = await lstat(current);
      const symbolicLink = info.isSymbolicLink();
      if (index < parts.length - 1 && !symbolicLink && !info.isDirectory()) fail('PATH_CHANGED', 'The target path structure changed after planning.');
      if (index === parts.length - 1 && (symbolicLink || !info.isFile())) fail('PATH_CHANGED', 'The target file identity is not a regular file.');
      const linkTarget = symbolicLink ? await readlink(current) : null;
      entries.push({ path: current, realPath: await realpath(current), dev: info.dev, ino: info.ino, symbolicLink, linkTarget });
    }
    return { realPath: await realpath(absolute), entries };
  } catch (error) {
    if (error instanceof ChangeEngineError) throw error;
    fail('PATH_CHANGED', 'The target path could not be resolved safely.');
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameIdentity(expected: PathIdentity, actual: PathIdentity): boolean {
  if (!samePath(expected.realPath, actual.realPath) || expected.entries.length !== actual.entries.length) return false;
  return expected.entries.every((entry, index) => {
    const current = actual.entries[index];
    if (!current || !samePath(entry.path, current.path) || !samePath(entry.realPath, current.realPath)) return false;
    if (entry.symbolicLink !== current.symbolicLink || entry.linkTarget !== current.linkTarget) return false;
    return (entry.dev === 0 || current.dev === 0 || entry.dev === current.dev)
      && (entry.ino === 0 || current.ino === 0 || entry.ino === current.ino);
  });
}

function dataPath(dataDir: string, ...parts: string[]): string {
  return path.join(path.resolve(dataDir), 'change-engine', ...parts);
}

async function ensureDataDir(dataDir: string): Promise<string> {
  const absolute = path.resolve(dataDir);
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    return await realpath(absolute);
  } catch { fail('IO_ERROR', 'The AgentDeck data directory is unavailable.'); }
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
  } catch { fail('IO_ERROR', 'The AgentDeck operation storage could not be created.'); }
}

async function assertWithinDataDir(dataRoot: string, candidate: string): Promise<void> {
  const rel = path.relative(dataRoot, path.resolve(candidate));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('IO_ERROR', 'The backup path is outside the AgentDeck data directory.');
}

async function writeExclusive(file: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  try {
    const handle = await open(file, 'wx', mode);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== 'win32') await chmod(file, mode);
  } catch { fail('IO_ERROR', 'AgentDeck could not persist the protected operation data.'); }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temp, JSON.stringify(value), 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof ChangeEngineError) throw error;
    fail('IO_ERROR', 'AgentDeck could not update the protected operation journal.');
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_META_BYTES) return null;
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch { return null; }
}

function lockPathFor(identity: PathIdentity): string {
  const canonical = identity.realPath;
  return path.join(path.dirname(canonical), `.${path.basename(canonical)}.agentdeck.lock`);
}

async function staleLockPid(lockFile: string): Promise<{ stale: boolean; contents: Buffer | null }> {
  try {
    const contents = await readFile(lockFile);
    if (contents.length > 4096) return { stale: false, contents };
    const parsed = JSON.parse(contents.toString('utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return { stale: false, contents };
    try { process.kill(parsed.pid, 0); return { stale: false, contents }; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { stale: true, contents } : { stale: false, contents }; }
  } catch { return { stale: true, contents: null }; }
}

async function acquireTargetLock(identity: PathIdentity): Promise<TargetLock> {
  const lockFile = lockPathFor(identity);
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      return {
        async release() {
          try {
            const live = await readFile(lockFile, 'utf8');
            if (live === contents) await rm(lockFile, { force: true });
          } catch { /* lock was already removed */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('IO_ERROR', 'The target directory cannot host an AgentDeck write lock.');
      const prior = await staleLockPid(lockFile);
      if (!prior.stale || !prior.contents) fail('LOCKED', 'Another AgentDeck operation holds the target lock.');
      try {
        const current = await readFile(lockFile);
        if (!current.equals(prior.contents)) fail('LOCKED', 'The target lock changed while being checked.');
        await rm(lockFile);
      } catch (inner) {
        if (inner instanceof ChangeEngineError) throw inner;
        fail('LOCKED', 'The stale target lock could not be cleared safely.');
      }
    }
  }
  fail('LOCKED', 'Another AgentDeck operation holds the target lock.');
}

async function assertCurrentPrepared(prepared: PreparedChange): Promise<Buffer> {
  if (sha256(prepared.private.originalBytes) !== prepared.plan.beforeHash
    || sha256(prepared.private.updatedBytes) !== prepared.plan.afterHash) {
    fail('CONFIG_CHANGED', 'The protected plan contents no longer match their recorded digests.');
  }
  const currentIdentity = await capturePathIdentity(prepared.private.configPath);
  if (!sameIdentity(prepared.private.pathIdentity, currentIdentity)) fail('PATH_CHANGED', 'The target path identity changed after planning.');
  const current = await readConfig(prepared.private.configPath);
  if (sha256(current) !== prepared.plan.beforeHash) fail('CONFIG_CHANGED', 'The Codex configuration changed after planning.');
  return current;
}

async function saveSnapshot(root: string, operationId: string, bytes: Buffer): Promise<string> {
  const directory = path.join(root, 'change-engine', 'snapshots');
  await ensurePrivateDirectory(directory);
  const realDirectory = await realpath(directory);
  const snapshot = path.join(realDirectory, `${operationId}.bin`);
  await assertWithinDataDir(root, snapshot);
  await writeExclusive(snapshot, bytes, 0o600);
  return snapshot;
}

async function readSnapshot(root: string, snapshot: string, expectedHash: string): Promise<Buffer> {
  await assertWithinDataDir(root, snapshot);
  try {
    const info = await lstat(snapshot);
    if (!info.isFile() || info.size > 1024 * 1024) fail('RECOVERY_CONFLICT', 'The recovery snapshot is missing or invalid.');
    const canonicalSnapshot = await realpath(snapshot);
    const canonicalRel = path.relative(root, canonicalSnapshot);
    if (canonicalRel === '..' || canonicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRel)) fail('RECOVERY_CONFLICT', 'The recovery snapshot resolves outside the AgentDeck data directory.');
    const bytes = await readFile(snapshot);
    if (sha256(bytes) !== expectedHash) fail('RECOVERY_CONFLICT', 'The recovery snapshot digest does not match its journal.');
    return bytes;
  } catch (error) {
    if (error instanceof ChangeEngineError) throw error;
    fail('RECOVERY_CONFLICT', 'The recovery snapshot is missing or invalid.');
  }
}

async function atomicReplaceTarget(
  configPath: string,
  original: Buffer,
  updated: Buffer,
  identity: PathIdentity,
  beforeRename: (tempPath: string, expectedAfter: PathIdentity) => Promise<void>,
): Promise<void> {
  const temp = path.join(path.dirname(identity.realPath), `.${path.basename(identity.realPath)}.agentdeck-${randomUUID()}.tmp`);
  try {
    await copyFile(configPath, temp, fsConstants.COPYFILE_EXCL);
    const originalInfo = await stat(configPath);
    if (process.platform !== 'win32') await chmod(temp, originalInfo.mode & 0o7777);
    const handle = await open(temp, 'r+');
    try { await handle.truncate(0); await handle.writeFile(updated); await handle.sync(); } finally { await handle.close(); }

    const tempStat = await stat(temp);
    const finalEntry = identity.entries[identity.entries.length - 1];
    if (!finalEntry) fail('PATH_CHANGED', 'The target file identity is incomplete.');
    const expectedAfter: PathIdentity = {
      realPath: identity.realPath,
      entries: identity.entries.map((entry, index) => index === identity.entries.length - 1
        ? { ...entry, dev: tempStat.dev, ino: tempStat.ino, symbolicLink: false, linkTarget: null }
        : entry),
    };
    await beforeRename(temp, expectedAfter);

    const currentIdentity = await capturePathIdentity(configPath);
    if (!sameIdentity(identity, currentIdentity)) fail('PATH_CHANGED', 'The target path identity changed before replacement.');
    const current = await readConfig(configPath);
    if (sha256(current) !== sha256(original)) fail('CONFIG_CHANGED', 'The Codex configuration changed immediately before replacement.');
    await rename(temp, configPath);
    try {
      const directory = await open(path.dirname(configPath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* directory sync is not available on every platform */ }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof ChangeEngineError) throw error;
    fail('IO_ERROR', 'AgentDeck could not atomically replace the Codex TOML file.');
  }
}

function planFor(args: {
  configPath: string; beforeHash: string; afterHash: string; diff: string; desiredEnabled: boolean | null;
  now: Date; ttlMs: number; action?: ChangePlan['action']; restoreOf?: string; instanceId?: string; bindingId?: string;
}): ChangePlan {
  return {
    id: randomUUID(),
    instanceId: args.instanceId ?? '',
    bindingId: args.bindingId ?? '',
    action: args.action ?? 'toggle',
    targetPath: path.resolve(args.configPath),
    beforeHash: args.beforeHash,
    afterHash: args.afterHash,
    diff: args.diff,
    desiredEnabled: args.desiredEnabled,
    createdAt: args.now.toISOString(),
    expiresAt: new Date(args.now.getTime() + args.ttlMs).toISOString(),
    ...(args.restoreOf ? { restoreOf: args.restoreOf } : {}),
    status: 'ready',
  };
}

export async function prepareToggle(input: PrepareToggleInput): Promise<PreparedChange> {
  if (!input.serverName.trim()) fail('AMBIGUOUS_TARGET', 'The requested independent MCP server name is empty.');
  const configPath = path.resolve(input.configPath);
  const originalBytes = await readConfig(configPath);
  const original = decodeUtf8(originalBytes);
  const edited = editCodexEnabled(original, input.serverName, input.enabled, input.target);
  const updatedBytes = Buffer.from(edited.text, 'utf8');
  const afterHash = sha256(updatedBytes);
  const beforeHash = sha256(originalBytes);
  const now = safeNow(input.now);
  const identity = await capturePathIdentity(configPath);
  const plan = planFor({
    configPath, beforeHash, afterHash,
    diff: afterHash === beforeHash ? 'The resource already has the requested enabled state.'
      : `${targetLabel(input.serverName, input.target)}\n- enabled = ${edited.hadEnabledField ? String(edited.previousEnabled) : 'missing (default/override not set)'}\n+ enabled = ${String(input.enabled)}`,
    desiredEnabled: input.enabled, now, ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
  });
  return {
    plan,
    private: {
      configPath, serverName: input.serverName, originalBytes, updatedBytes, pathIdentity: identity,
      beforeEnabled: edited.previousEnabled, desiredEnabled: input.enabled,
      ...(input.target ? { target: input.target } : {}),
    },
  };
}

export async function applyPrepared(prepared: PreparedChange, options: EngineOptions): Promise<AppliedChange> {
  const now = safeNow(options.now);
  if (prepared.plan.status !== 'ready' || Date.parse(prepared.plan.expiresAt) <= now.getTime()) fail('PLAN_EXPIRED', 'The prepared change is expired or no longer ready.');
  const initialBytes = await assertCurrentPrepared(prepared);
  const root = await ensureDataDir(options.dataDir);
  const lock = await acquireTargetLock(prepared.private.pathIdentity);
  const operationId = randomUUID();
  let snapshotPath: string | null = null;
  const journalPath = dataPath(root, 'journal', `${operationId}.json`);
  const operation: Operation = {
    id: operationId, planId: prepared.plan.id, status: 'failed', kind: prepared.plan.action,
    targetPath: prepared.plan.targetPath, createdAt: now.toISOString(), error: null, backupId: snapshotPath ? operationId : null,
  };
  let journal: JournalRecord = {
    schemaVersion: 1, operationId, stage: 'prepared', plan: prepared.plan, operation,
    configPath: prepared.private.configPath, serverName: prepared.private.serverName,
    ...(prepared.private.target ? { target: prepared.private.target } : {}),
    beforeHash: prepared.plan.beforeHash, afterHash: prepared.plan.afterHash,
    snapshotPath: null, beforeEnabled: prepared.private.beforeEnabled, desiredEnabled: prepared.private.desiredEnabled,
    preparedIdentity: prepared.private.pathIdentity,
  };
  try {
    await ensurePrivateDirectory(path.dirname(journalPath));
    if (prepared.plan.beforeHash !== prepared.plan.afterHash) snapshotPath = await saveSnapshot(root, operationId, initialBytes);
    journal = { ...journal, snapshotPath, operation: { ...operation, backupId: snapshotPath ? operationId : null } };
    await writeJsonAtomic(journalPath, journal);
    await assertCurrentPrepared(prepared);
    if (prepared.plan.beforeHash !== prepared.plan.afterHash) {
      journal = { ...journal, stage: 'writing' };
      await writeJsonAtomic(journalPath, journal);
      await atomicReplaceTarget(prepared.private.configPath, prepared.private.originalBytes, prepared.private.updatedBytes, prepared.private.pathIdentity, async (tempPath, expectedAfterIdentity) => {
        journal = { ...journal, pendingTempPath: tempPath, expectedAfterIdentity };
        await writeJsonAtomic(journalPath, journal);
      });
    }
    const finalBytes = await readConfig(prepared.private.configPath);
    if (sha256(finalBytes) !== prepared.plan.afterHash) fail('CONFIG_CHANGED', 'The target content changed while the plan was being applied.');
    const appliedIdentity = await capturePathIdentity(prepared.private.configPath);
    const appliedPlan: ChangePlan = { ...prepared.plan, status: 'applied' };
    const succeeded: Operation = { ...operation, status: 'succeeded', backupId: snapshotPath ? operationId : null };
    const record: AppliedRecord = {
      schemaVersion: 1, operation: succeeded, plan: appliedPlan, configPath: prepared.private.configPath,
      serverName: prepared.private.serverName, beforeHash: prepared.plan.beforeHash, afterHash: prepared.plan.afterHash,
      ...(prepared.private.target ? { target: prepared.private.target } : {}),
      snapshotPath, beforeEnabled: prepared.private.beforeEnabled, desiredEnabled: prepared.private.desiredEnabled,
      ...(prepared.plan.restoreOf ? { restoreOf: prepared.plan.restoreOf } : {}), appliedIdentity,
    };
    journal = { ...journal, stage: 'applied', plan: appliedPlan, operation: succeeded, appliedIdentity };
    await writeJsonAtomic(dataPath(root, 'operations', `${operationId}.json`), record);
    await writeJsonAtomic(journalPath, journal);
    return { plan: appliedPlan, operation: succeeded, journalPath, snapshotPath };
  } catch (error) {
    if (error instanceof ChangeEngineError) {
      if (journal.stage === 'writing') {
        try {
          const identity = await capturePathIdentity(prepared.private.configPath);
          const current = await readConfig(prepared.private.configPath);
          const currentHash = sha256(current);
          if (currentHash === prepared.plan.beforeHash && sameIdentity(prepared.private.pathIdentity, identity)) {
            journal = { ...journal, stage: 'aborted', operation: { ...operation, status: 'failed', error: error.safeMessage } };
          } else if (currentHash !== prepared.plan.afterHash) {
            journal = { ...journal, stage: 'conflict', operation: { ...operation, status: 'conflict', error: error.safeMessage } };
          }
          await writeJsonAtomic(journalPath, journal).catch(() => undefined);
        } catch { /* retain writing stage so startup recovery can inspect the live file */ }
      }
      throw error;
    }
    fail('IO_ERROR', 'AgentDeck could not finish the prepared file change.');
  } finally {
    await lock.release();
  }
}

export async function prepareRestore(input: { operationId: string; dataDir: string; now?: Date; ttlMs?: number }): Promise<PreparedChange> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) {
    fail('RECOVERY_CONFLICT', 'The requested operation identity is invalid.');
  }
  const root = await ensureDataDir(input.dataDir);
  const recordPath = dataPath(root, 'operations', `${input.operationId}.json`);
  const record = await readJson<AppliedRecord>(recordPath);
  if (!record || record.schemaVersion !== 1 || record.operation.status !== 'succeeded' || !record.snapshotPath) {
    fail('RECOVERY_CONFLICT', 'This operation has no verified recovery snapshot.');
  }
  const snapshot = await readSnapshot(root, record.snapshotPath, record.beforeHash);
  const previousDocument = editCodexEnabled(decodeUtf8(snapshot), record.serverName, record.desiredEnabled ?? true, record.target);
  const currentIdentity = await capturePathIdentity(record.configPath);
  if (!sameIdentity(record.appliedIdentity, currentIdentity)) fail('PATH_CHANGED', 'The target path identity changed after the operation.');
  const current = await readConfig(record.configPath);
  if (sha256(current) !== record.afterHash) fail('RECOVERY_CONFLICT', 'The target changed after the operation; restoration would overwrite an external edit.');
  const now = safeNow(input.now);
  const plan = planFor({
    configPath: record.configPath, beforeHash: record.afterHash, afterHash: record.beforeHash,
    diff: `${targetLabel(record.serverName, record.target)}\n- enabled = ${stateLabel(record.desiredEnabled)}\n+ enabled = ${previousDocument.hadEnabledField ? stateLabel(previousDocument.previousEnabled) : 'missing (default/override not set)'}\nRestore the exact configuration snapshot saved by this AgentDeck operation.`,
    desiredEnabled: record.beforeEnabled, now, ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    action: 'restore', restoreOf: input.operationId,
    instanceId: record.plan.instanceId, bindingId: record.plan.bindingId,
  });
  return {
    plan,
    private: {
      configPath: record.configPath, serverName: record.serverName, originalBytes: current, updatedBytes: snapshot,
      pathIdentity: currentIdentity, beforeEnabled: record.desiredEnabled, desiredEnabled: record.beforeEnabled,
      ...(record.target ? { target: record.target } : {}),
    },
  };
}

async function safelyMarkJournal(file: string, journal: JournalRecord): Promise<void> {
  await writeJsonAtomic(file, journal);
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recoveryOperation(value: unknown): Operation | null {
  if (!isJsonRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.planId !== 'string'
    || (value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'conflict')
    || (value.kind !== 'toggle' && value.kind !== 'restore')
    || typeof value.targetPath !== 'string' || !path.isAbsolute(value.targetPath)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.error !== null && typeof value.error !== 'string')
    || (value.backupId !== null && typeof value.backupId !== 'string')) return null;
  // Reconstruct the public contract instead of passing through arbitrary persisted JSON.
  return {
    id: value.id,
    planId: value.planId,
    status: value.status,
    kind: value.kind,
    targetPath: value.targetPath,
    createdAt: value.createdAt,
    error: value.error,
    backupId: value.backupId,
  };
}

function isPathIdentity(value: unknown): value is PathIdentity {
  if (!isJsonRecord(value) || typeof value.realPath !== 'string' || !Array.isArray(value.entries)) return false;
  return value.entries.every((entry) => isJsonRecord(entry)
    && typeof entry.path === 'string' && typeof entry.realPath === 'string'
    && typeof entry.dev === 'number' && typeof entry.ino === 'number'
    && typeof entry.symbolicLink === 'boolean'
    && (entry.linkTarget === null || typeof entry.linkTarget === 'string'));
}

function matchesAppliedPlan(value: unknown, journal: JournalRecord): value is ChangePlan {
  if (!isJsonRecord(value)) return false;
  const expected = journal.plan;
  return value.status === 'applied'
    && value.id === expected.id
    && value.instanceId === expected.instanceId
    && value.bindingId === expected.bindingId
    && value.action === expected.action
    && typeof value.targetPath === 'string' && samePath(value.targetPath, journal.configPath)
    && value.beforeHash === journal.beforeHash
    && value.afterHash === journal.afterHash
    && value.desiredEnabled === journal.desiredEnabled
    && value.createdAt === expected.createdAt
    && value.expiresAt === expected.expiresAt
    && value.diff === expected.diff
    && value.restoreOf === expected.restoreOf;
}

async function verifiedAppliedOperation(root: string, journal: JournalRecord, operationId: string): Promise<Operation | null> {
  if (!isPathIdentity(journal.appliedIdentity) || !matchesAppliedPlan(journal.plan, journal)) return null;
  const journalOperation = recoveryOperation(journal.operation);
  if (!journalOperation || journalOperation.id !== operationId || journalOperation.status !== 'succeeded'
    || journalOperation.error !== null || journalOperation.planId !== journal.plan.id
    || journalOperation.kind !== journal.plan.action || !samePath(journalOperation.targetPath, journal.configPath)
    || journalOperation.backupId !== (journal.snapshotPath ? operationId : null)) return null;

  const record = await readJson<unknown>(dataPath(root, 'operations', `${operationId}.json`));
  if (!isJsonRecord(record) || record.schemaVersion !== 1
    || typeof record.configPath !== 'string' || !samePath(record.configPath, journal.configPath)
    || record.serverName !== journal.serverName
    || JSON.stringify(record.target) !== JSON.stringify(journal.target)
    || record.beforeHash !== journal.beforeHash || record.afterHash !== journal.afterHash
    || record.snapshotPath !== journal.snapshotPath
    || record.beforeEnabled !== journal.beforeEnabled || record.desiredEnabled !== journal.desiredEnabled
    || !isPathIdentity(record.appliedIdentity)
    || !sameIdentity(journal.appliedIdentity, record.appliedIdentity)
    || !matchesAppliedPlan(record.plan, journal)) return null;
  const recordedOperation = recoveryOperation(record.operation);
  if (!recordedOperation || recordedOperation.id !== journalOperation.id
    || recordedOperation.planId !== journalOperation.planId
    || recordedOperation.status !== 'succeeded' || recordedOperation.error !== null
    || recordedOperation.kind !== journalOperation.kind
    || !samePath(recordedOperation.targetPath, journalOperation.targetPath)
    || recordedOperation.createdAt !== journalOperation.createdAt
    || recordedOperation.backupId !== journalOperation.backupId) return null;
  return recordedOperation;
}

export async function recoverIncomplete(options: { dataDir: string }): Promise<RecoveryReport> {
  const root = await ensureDataDir(options.dataDir);
  const journalDir = dataPath(root, 'journal');
  const items: RecoveryItem[] = [];
  const diagnostics: string[] = [];
  let names: string[];
  try {
    const entries = await readdir(journalDir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .slice(0, MAX_RECOVERY_FILES).map((entry) => entry.name);
  } catch { return { items, diagnostics }; }
  for (const name of names) {
    const file = path.join(journalDir, name);
    const journal = await readJson<JournalRecord>(file);
    if (!journal || journal.schemaVersion !== 1) {
      diagnostics.push('An unreadable journal entry was retained for manual review.');
      items.push({ operationId: path.basename(name, '.json'), status: 'ignored', message: 'Journal format was invalid.' });
      continue;
    }
    const filenameOperationId = path.basename(name, '.json');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filenameOperationId)
      || journal.operationId !== filenameOperationId) {
      diagnostics.push('A journal identity did not match its storage filename.');
      items.push({ operationId: filenameOperationId, status: 'ignored', message: 'Journal identity could not be verified.' });
      continue;
    }
    if (journal.stage === 'applied') {
      try {
        const operation = await verifiedAppliedOperation(root, journal, journal.operationId);
        if (!operation) {
          diagnostics.push(`Journal ${journal.operationId} applied record failed verification.`);
          items.push({ operationId: journal.operationId, status: 'ignored', message: 'The applied operation record could not be verified.' });
        } else {
          items.push({ operationId: journal.operationId, status: 'completed', message: 'The applied operation record was verified for audit reconciliation.', operation });
        }
      } catch {
        diagnostics.push(`Journal ${journal.operationId} applied record failed verification.`);
        items.push({ operationId: journal.operationId, status: 'ignored', message: 'The applied operation record could not be verified.' });
      }
      continue;
    }
    if (journal.stage === 'aborted' || journal.stage === 'conflict') continue;
    const operationId = journal.operationId;
    let lock: TargetLock | null = null;
    try {
      const initialIdentity = await capturePathIdentity(journal.configPath);
      lock = await acquireTargetLock(initialIdentity);
      const identity = await capturePathIdentity(journal.configPath);
      const current = await readConfig(journal.configPath);
      const currentHash = sha256(current);
      if (currentHash === journal.beforeHash && sameIdentity(journal.preparedIdentity, identity)) {
        if (journal.pendingTempPath && safePendingTempPath(identity, journal.pendingTempPath)) {
          await rm(journal.pendingTempPath, { force: true }).catch(() => undefined);
        }
        await safelyMarkJournal(file, { ...journal, stage: 'aborted' });
        items.push({ operationId, status: 'not-applied', message: 'The native file still matches the pre-operation snapshot.' });
      } else if (currentHash === journal.afterHash && journal.snapshotPath && journal.expectedAfterIdentity
        && sameIdentity(journal.expectedAfterIdentity, identity)) {
        await readSnapshot(root, journal.snapshotPath, journal.beforeHash);
        const appliedIdentity = await capturePathIdentity(journal.configPath);
        const plan = { ...journal.plan, status: 'applied' as const };
        const operation: Operation = { ...journal.operation, status: 'succeeded', error: null };
        const record: AppliedRecord = {
          schemaVersion: 1, operation, plan, configPath: journal.configPath, serverName: journal.serverName,
          ...(journal.target ? { target: journal.target } : {}),
          beforeHash: journal.beforeHash, afterHash: journal.afterHash, snapshotPath: journal.snapshotPath,
          beforeEnabled: journal.beforeEnabled, desiredEnabled: journal.desiredEnabled,
          ...(journal.plan.restoreOf ? { restoreOf: journal.plan.restoreOf } : {}), appliedIdentity,
        };
        await writeJsonAtomic(dataPath(root, 'operations', `${operationId}.json`), record);
        await safelyMarkJournal(file, { ...journal, stage: 'applied', plan, operation, appliedIdentity });
        const verifiedOperation = await verifiedAppliedOperation(root, { ...journal, stage: 'applied', plan, operation, appliedIdentity }, operationId);
        if (!verifiedOperation) {
          diagnostics.push(`Journal ${operationId} applied record failed verification.`);
          items.push({ operationId, status: 'ignored', message: 'The completed operation record could not be verified.' });
        } else {
          items.push({ operationId, status: 'completed', message: 'The file matches the planned result and the operation record was completed.', operation: verifiedOperation });
        }
      } else {
        await safelyMarkJournal(file, { ...journal, stage: 'conflict' });
        items.push({ operationId, status: 'conflict', message: 'The file matches neither the recorded before nor after digest.' });
      }
    } catch (error) {
      const code = error instanceof ChangeEngineError ? error.code : 'IO_ERROR';
      if (code === 'LOCKED') {
        items.push({ operationId, status: 'ignored', message: 'Another AgentDeck operation currently holds this target lock.' });
      } else {
        diagnostics.push(`Journal ${operationId} requires review (${code}).`);
        items.push({ operationId, status: 'conflict', message: 'Recovery stopped because the target or snapshot could not be verified.' });
        await safelyMarkJournal(file, { ...journal, stage: 'conflict' }).catch(() => undefined);
      }
    } finally {
      await lock?.release();
    }
  }
  return { items, diagnostics };
}

function safePendingTempPath(identity: PathIdentity, candidate: string): boolean {
  const parent = path.dirname(identity.realPath);
  const base = path.basename(identity.realPath);
  const rel = path.relative(parent, path.resolve(candidate));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
    && path.basename(candidate).startsWith(`.${base}.agentdeck-`)
    && path.basename(candidate).endsWith('.tmp');
}
