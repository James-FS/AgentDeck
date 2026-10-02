import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentId, ClientVersionEvidence, ExecutableIdentity } from '@agentdeck/contracts';

export const VERSION_CHECK_TIMEOUT_MS = 5_000;
export const VERSION_CHECK_MAX_OUTPUT_BYTES = 4_096;

export interface VersionRunnerInput {
  executable: string;
  args: readonly ['--version'];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface VersionRunnerOutput { stdout: string; stderr: string; exitCode: number }
export type VersionCheckRunner = (input: VersionRunnerInput) => Promise<VersionRunnerOutput>;
export type ExecutableResolver = (agentId: AgentId, env: NodeJS.ProcessEnv) => Promise<string | null>;

const executableNames: Record<AgentId, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  zcode: 'zcode',
  'deepseek-harness': 'dsh',
};

export async function resolvePathExecutable(agentId: AgentId, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathValue = env.PATH ?? env.Path ?? '';
  const suffixes = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const name = executableNames[agentId];
  if (!name) return null;
  const variants = path.extname(name) ? [name] : suffixes.map(suffix => `${name}${suffix}`);
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const variant of variants) {
      const candidate = path.resolve(directory, variant);
      try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* try the next PATH candidate */ }
    }
  }
  return null;
}

export async function inspectExecutable(candidate: string, checkedAt = new Date().toISOString()): Promise<ExecutableIdentity | null> {
  try {
    const metadata = await stat(candidate, { bigint: true });
    if (!metadata.isFile()) return null;
    const resolved = await realpath(candidate);
    const identity = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].join(':');
    return { path: path.resolve(candidate), realPath: resolved, fileIdentity: identity, checkedAt };
  } catch { return null; }
}

export function sameExecutable(left: ExecutableIdentity | null | undefined, right: ExecutableIdentity | null | undefined): boolean {
  if (!left || !right) return left === right;
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return normalize(left.path) === normalize(right.path)
    && normalize(left.realPath) === normalize(right.realPath)
    && left.fileIdentity === right.fileIdentity;
}

export function parseRecognizedVersion(agentId: AgentId, output: string): Pick<ClientVersionEvidence, 'version' | 'signature'> | null {
  const text = output.replace(/^\uFEFF/, '').trim();
  if (agentId === 'codex') {
    const match = /^(?:codex-cli|Codex CLI)\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i.exec(text);
    return match?.[1] ? { version: match[1], signature: 'codex-cli-version' } : null;
  }
  if (agentId === 'claude-code') {
    const match = /^(?:Claude Code\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)|v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s+\(Claude Code\))$/i.exec(text);
    const version = match?.[1] ?? match?.[2];
    return version ? { version, signature: 'claude-code-version' } : null;
  }
  return null;
}

export const runVersionCommand: VersionCheckRunner = (input) => new Promise((resolve, reject) => {
  const extension = path.extname(input.executable).toLowerCase();
  const windowsScript = process.platform === 'win32' && (extension === '.cmd' || extension === '.bat');
  if (windowsScript && /[%!^&|<>"()\r\n]/.test(input.executable)) {
    reject(new Error('unsafe-command-path'));
    return;
  }
  const windowsRoot = input.env.SystemRoot ?? input.env.WINDIR ?? 'C:\\Windows';
  const command = windowsScript ? path.join(windowsRoot, 'System32', 'cmd.exe') : input.executable;
  const args = windowsScript
    ? ['/d', '/s', '/c', `""${input.executable}" --version"`]
    : [...input.args];
  let child;
  try {
    child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      ...(windowsScript ? { windowsVerbatimArguments: true } : {}),
      ...(process.platform !== 'win32' ? { detached: true } : {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    reject(new Error('version-command-failed'));
    return;
  }
  let stdout = '';
  let stderr = '';
  let byteCount = 0;
  let settled = false;
  let pendingError: Error | null = null;
  const terminate = (error: Error) => {
    if (pendingError) return;
    pendingError = error;
    clearTimeout(timer);
    if (process.platform === 'win32' && child.pid) {
      const taskkill = path.join(windowsRoot, 'System32', 'taskkill.exe');
      try {
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        const fallback = setTimeout(() => child.kill('SIGKILL'), 1_000);
        fallback.unref();
        killer.on('error', () => { clearTimeout(fallback); child.kill('SIGKILL'); });
        killer.on('close', code => { if (code !== 0) { clearTimeout(fallback); child.kill('SIGKILL'); } else clearTimeout(fallback); });
      } catch { child.kill('SIGKILL'); }
    } else {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  };
  const finish = (error?: Error, value?: VersionRunnerOutput) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else if (value) resolve(value);
  };
  const timer = setTimeout(() => terminate(new Error('version-check-timeout')), input.timeoutMs);
  timer.unref();
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    byteCount += chunk.byteLength;
    if (byteCount > input.maxOutputBytes) {
      terminate(new Error('version-check-output-limit'));
      return;
    }
    if (target === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout?.on('data', chunk => append('stdout', Buffer.from(chunk)));
  child.stderr?.on('data', chunk => append('stderr', Buffer.from(chunk)));
  child.on('error', () => {
    if (!pendingError) pendingError = new Error('version-command-failed');
  });
  child.on('close', (exitCode) => {
    if (pendingError) finish(pendingError);
    else if (exitCode !== 0) finish(new Error('version-command-failed'));
    else finish(undefined, { stdout, stderr, exitCode: 0 });
  });
});
