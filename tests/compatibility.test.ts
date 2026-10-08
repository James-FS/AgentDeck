import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { createStore } from '../packages/storage/src/index.ts';
import type { AgentId, AgentInstance, Catalog, ChangePlan, CompatibilityReport, Operation } from '../packages/contracts/src/index.ts';
import { parseRecognizedVersion, runVersionCommand, type VersionRunnerInput, type VersionRunnerOutput } from '../packages/core/src/version-check.ts';
import { mcpTransport } from '../packages/adapters/src/shared.ts';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';

describe('client compatibility evidence over authenticated HTTP', () => {
  let directory: string;
  let home: string;
  let executable: string | null;
  let app: ReturnType<typeof createApp>;
  let origin: string;
  let cookie: string;
  let csrf: string;
  let output: VersionRunnerOutput;
  let calls: VersionRunnerInput[];
  let resolverAgent: AgentId | undefined;
  let candidateAgent: AgentId;
  let runnerEffect: (() => Promise<void>) | undefined;
  let resolverEffect: (() => Promise<void>) | undefined;

  async function start() {
    app = createApp({
      dataDir: path.join(directory, 'data'), homeDir: home, userHomeDir: home,
      discoveryEnv: { PATH: path.join(directory, 'bin'), PATHEXT: '.EXE', OPENAI_API_KEY: 'SHOULD_NOT_INHERIT' }, userDiscoveryEnv: {},
      executableResolver: async agentId => { resolverAgent = agentId; await resolverEffect?.(); return agentId === candidateAgent ? executable : null; },
      versionRunner: async input => { calls.push(input); await runnerEffect?.(); return output; },
    });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const session = await fetch(`${origin}/api/v1/session/bootstrap`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: app.agentdeckAuth.issueBootstrapTicket() }) });
    cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    csrf = (await session.json() as { csrfToken: string }).csrfToken;
  }
  async function call<T = Record<string, unknown>>(method: string, endpoint: string, body?: unknown, expected = 200, headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}/api/v1${endpoint}`, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, endpoint).toBe(expected);
    return await response.json() as T;
  }
  async function register(agentId = 'codex', configRoot = path.join(home, '.codex'), writable = false) {
    return call<AgentInstance>('POST', '/instances', { agentId, configRoot, writable }, 201);
  }
  async function report() { return call<CompatibilityReport>('GET', '/compatibility'); }
  beforeEach(async () => {
    directory = await createTestDirectory('compatibility-');
    ({ home } = await copyCatalogFixture(directory));
    await mkdir(path.join(directory, 'bin'));
    executable = path.join(directory, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    await writeFile(executable, 'fake executable identity');
    output = { stdout: 'codex-cli 0.159.2\n', stderr: 'PRIVATE_STDERR_SENTINEL', exitCode: 0 };
    calls = [];
    resolverAgent = undefined;
    candidateAgent = 'codex';
    runnerEffect = undefined;
    resolverEffect = undefined;
    await start();
  });
  afterEach(async () => { await app?.close(); if (directory) await removeTestDirectory(directory); });

  it('reports missing adapters without inventing instances and scans never run a client', async () => {
    const empty = await report();
    expect(empty.clients).toHaveLength(4);
    expect(empty.clients.every(client => client.instanceId === null && client.versionEvidence === null)).toBe(true);
    expect(empty.clients.find(client => client.agentId === 'codex')?.status).toBe('executable-unverified');
    expect(empty.clients.find(client => client.agentId === 'claude-code')?.status).toBe('configuration-only');
    const before = await fileTreeDigests(home);
    const scanned = await call<Catalog>('POST', '/scans', { discover: true });
    expect(scanned.instances).toHaveLength(4);
    expect(calls).toHaveLength(0);
    const result = await report();
    expect(result.clients.find(client => client.agentId === 'codex')?.status).toBe('executable-unverified');
    expect(result.clients.find(client => client.agentId === 'claude-code')?.status).toBe('configuration-only');
    expect(result.clients.every(client => client.versionEvidence === null)).toBe(true);
    expect(await fileTreeDigests(home)).toEqual(before);
  });

  it('records exact version evidence in isolated state without granting writes or runtime claims', async () => {
    const instance = await register();
    const before = await fileTreeDigests(home);
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const result = await report();
    const client = result.clients.find(row => row.instanceId === instance.id)!;
    expect(client.status).toBe('verified-client');
    expect(client.versionEvidence?.version).toBe('0.159.2');
    expect(client.versionEvidence?.signature).toBe('codex-cli-version');
    expect(resolverAgent).toBeDefined();
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.args).toEqual(['--version']);
    expect(input.executable).toBe(executable);
    expect(input.cwd.startsWith(path.join(directory, 'data') + path.sep)).toBe(true);
    for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ZCODE_HOME', 'DSH_HOME']) {
      expect(input.env[key], key).toBeTruthy();
      expect(input.env[key]!.startsWith(path.join(directory, 'data') + path.sep), key).toBe(true);
    }
    expect(input.env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_STDERR_SENTINEL');
    const native = client.capabilities.filter(item => item.area === 'native-config' && item.status === 'verified' && item.resourceKind === 'mcp');
    expect(native).toHaveLength(process.platform === 'win32' ? 1 : 0);
    expect(native.every(item => item.resourceKind === 'mcp' && item.scope === 'native' && item.sourceKind === 'user' && item.controlScope === 'standalone-user-mcp' && item.mcpTransport === 'stdio' && item.clientVersion === '0.159.2' && item.platform === 'win32')).toBe(true);
    const catalog = await call<Catalog>('POST', '/scans', { instanceId: instance.id });
    expect(catalog.instances.find(row => row.id === instance.id)?.writable).toBe(false);
    expect(catalog.bindings.every(row => !row.writable)).toBe(true);
    expect(await fileTreeDigests(home)).toEqual(before);
  });

  it.each([
    { transport: 'http', fields: 'url = "https://example.invalid/mcp"' },
    { transport: 'unknown', fields: 'custom_transport = "experimental"' },
  ])('defaults supported $transport MCP switches on and still respects explicit read-only registration', async ({ transport, fields }) => {
    const configPath = path.join(home, '.codex/config.toml');
    await writeFile(configPath, `# isolated experimental transport\n[mcp_servers.experimental]\n${fields}\nenabled = true # preserve\n`);
    const before = await readFile(configPath);
    const discovered = await call<Catalog>('POST', '/scans', { discover: true });
    const automatic = discovered.bindings.find(row => row.name === 'experimental')!;
    expect(automatic.mcpTransport).toBe(transport);
    expect(automatic.writable).toBe(true);
    await call('POST', '/plans', { bindingId: automatic.id, enabled: false }, 201);
    expect(await readFile(configPath)).toEqual(before);
    const instance = await register('codex', path.dirname(configPath), true);
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const catalog = await call<Catalog>('POST', '/scans', { instanceId: instance.id });
    const binding = catalog.bindings.find(row => row.name === 'experimental')!;
    expect(binding.writable).toBe(true);
    const client = (await report()).clients.find(row => row.instanceId === instance.id)!;
    const fixture = client.capabilities.find(row => row.area === 'fixture-validation' && row.resourceKind === 'mcp' && row.sourceKind === 'user')!;
    expect(fixture.status).toBe('verified');
    expect(fixture.writable).toBe(true);
    expect(fixture.mcpTransport).toBeUndefined();
    expect(client.capabilities.filter(row => row.area === 'native-config' && row.status === 'verified' && row.resourceKind === 'mcp').every(row => row.mcpTransport === 'stdio')).toBe(true);
    await call('POST', '/plans', { bindingId: binding.id, enabled: false }, 401, { Cookie: '' });
    await call('POST', '/plans', { bindingId: binding.id, enabled: false }, 403, { 'X-CSRF-Token': '' });
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    expect(await readFile(configPath)).toEqual(before);
    const operation = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect((await readFile(configPath, 'utf8'))).toContain('enabled = false # preserve');
    const restore = await call<ChangePlan>('POST', `/operations/${operation.id}/restore-plan`, {}, 201);
    await call('POST', `/plans/${restore.id}/apply`, { digest: restore.afterHash });
    expect(await readFile(configPath)).toEqual(before);
    await register('codex', path.dirname(configPath), false);
    await call('POST', '/scans', { instanceId: instance.id });
    await call('POST', '/plans', { bindingId: binding.id, enabled: false }, 403);
  });

  it('requires authentication and CSRF, rejects supplied command paths, and leaves demo isolated', async () => {
    const instance = await register();
    await call('POST', `/instances/${instance.id}/version-check`, {}, 401, { Cookie: '' });
    await call('POST', `/instances/${instance.id}/version-check`, {}, 403, { 'X-CSRF-Token': '' });
    await call('POST', `/instances/${instance.id}/version-check`, { executable: executable, command: 'danger' }, 400);
    expect(calls).toHaveLength(0);
    await call<Catalog>('POST', '/demo', {});
    expect((await report()).clients.some(client => client.status === 'demo')).toBe(true);
    const demo = (await call<Catalog>('GET', '/catalog')).instances.find(row => row.discovery === 'demo')!;
    await call('POST', `/instances/${demo.id}/version-check`, {});
    expect(calls).toHaveLength(0);
  });

  it('invalidates prior recognized versions after output failure or an unknown signature', async () => {
    const instance = await register();
    await call('POST', `/instances/${instance.id}/version-check`, {});
    for (const result of [
      { stdout: 'other-client 9.0.0 PRIVATE_STDOUT_SENTINEL', stderr: '', exitCode: 0 },
      { stdout: 'codex-cli 0.159.2', stderr: 'PRIVATE_STDERR_SENTINEL', exitCode: 1 },
    ]) {
      output = result;
      await call('POST', `/instances/${instance.id}/version-check`, {});
      const current = (await report()).clients.find(row => row.instanceId === instance.id)!;
      expect(current.status).toBe('executable-unverified');
      expect(current.versionEvidence).toBeNull();
      expect(current.capabilities.filter(item => item.area === 'native-config').every(item => item.status !== 'verified')).toBe(true);
      expect(JSON.stringify(current)).not.toMatch(/PRIVATE_STDOUT_SENTINEL|PRIVATE_STDERR_SENTINEL/);
    }
  });

  it('does not reuse native evidence for another CLI version', async () => {
    const instance = await register();
    output = { stdout: 'codex-cli 0.160.0', stderr: '', exitCode: 0 };
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const client = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(client.status).toBe('verified-client');
    expect(client.versionEvidence?.version).toBe('0.160.0');
    expect(client.capabilities.filter(item => item.area === 'native-config').every(item => item.status !== 'verified')).toBe(true);
  });

  it('rejects a version observation when executable identity changes during the probe', async () => {
    const instance = await register();
    runnerEffect = async () => { await writeFile(executable!, 'replaced while version command was running'); };
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const client = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(client.status).toBe('executable-unverified');
    expect(client.versionEvidence).toBeNull();
  });

  it('does not overwrite a write-permission revocation made while the version command is running', async () => {
    const instance = await register('codex', path.join(home, '.codex'), true);
    runnerEffect = async () => {
      await call('POST', '/instances', { agentId: 'codex', configRoot: path.join(home, '.codex'), writable: false }, 201);
    };
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const catalog = await call<Catalog>('GET', '/catalog');
    expect(catalog.instances.find(row => row.id === instance.id)?.writable).toBe(false);
  });

  it('invalidates evidence when the executable is replaced or removed, preserving manual opt-in', async () => {
    const instance = await register('codex', path.join(home, '.codex'), true);
    await call('POST', `/instances/${instance.id}/version-check`, {});
    await writeFile(executable!, 'replaced executable with different file identity');
    const changed = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(changed.status).toBe('executable-unverified');
    expect(changed.versionEvidence).toBeNull();
    await call('POST', `/instances/${instance.id}/version-check`, {});
    await unlink(executable!);
    executable = null;
    const removed = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(removed.status).toBe('configuration-only');
    expect(removed.versionEvidence).toBeNull();
    const refreshed = await call<Catalog>('POST', '/scans', { discover: true });
    const saved = refreshed.instances.find(row => row.id === instance.id)!;
    expect(saved.writable).toBe(true);
    expect(saved.executable).toBeNull();
    expect(saved.version).toBeNull();
  });

  it('preserves a concurrent permission revocation while refreshing a compatibility report', async () => {
    const instance = await register('codex', path.join(home, '.codex'), true);
    await call('POST', `/instances/${instance.id}/version-check`, {});
    await writeFile(executable!, 'new candidate identity during report refresh');
    resolverEffect = async () => {
      resolverEffect = undefined;
      await call('POST', '/instances', { agentId: 'codex', configRoot: instance.configRoot, writable: false, name: 'Revoked during refresh' }, 201);
    };
    const client = (await report()).clients.find(row => row.instanceId === instance.id)!;
    const saved = (await call<Catalog>('GET', '/catalog')).instances.find(row => row.id === instance.id)!;
    expect(saved.writable).toBe(false);
    expect(saved.name).toBe('Revoked during refresh');
    expect(client.capabilities.every(row => !row.writable)).toBe(true);
    expect(client.versionEvidence).toBeNull();
  });

  it('persists valid observations across restart and rejects legacy bare version strings as evidence', async () => {
    const instance = await register();
    await call('POST', `/instances/${instance.id}/version-check`, {});
    await app.close();
    await start();
    expect((await report()).clients.find(row => row.instanceId === instance.id)?.versionEvidence?.version).toBe('0.159.2');
    await app.close();
    const store = createStore(path.join(directory, 'data'));
    const saved = store.getInstance(instance.id)!;
    delete saved.versionEvidence;
    saved.version = '0.159.2';
    store.putInstance(saved);
    store.close();
    await start();
    const legacy = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(legacy.status).not.toBe('verified-client');
    expect(legacy.versionEvidence).toBeNull();
  });

  it('keeps reports distinct for two configurations using the same client executable', async () => {
    const first = await register();
    const secondRoot = path.join(directory, 'second-codex');
    await mkdir(secondRoot);
    const second = await register('codex', secondRoot);
    const rows = (await report()).clients.filter(row => row.agentId === 'codex');
    expect(rows.map(row => row.instanceId).sort()).toEqual([first.id, second.id].sort());
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
  });

  it('reports a configuration root that is a regular file as missing and never runs unverified clients', async () => {
    const rootFile = path.join(directory, 'not-a-directory');
    await writeFile(rootFile, 'not configuration');
    const instance = await register('zcode', rootFile);
    executable = null;
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const client = (await report()).clients.find(row => row.instanceId === instance.id)!;
    expect(client.configurationState).toBe('missing');
    expect(client.status).toBe('not-found');
    const dsh = await register('deepseek-harness', path.join(home, '.dsh'));
    candidateAgent = 'deepseek-harness';
    executable = path.join(directory, 'bin', 'unverified-dsh.exe');
    await writeFile(executable, 'unknown distribution');
    await call('POST', `/instances/${dsh.id}/version-check`, {});
    expect(calls).toHaveLength(0);
    expect((await report()).clients.find(row => row.instanceId === dsh.id)?.status).toBe('executable-unverified');
  });
});

describe('bounded version runner and signatures', () => {
  it('keeps contradictory or incomplete transport metadata from borrowing STDIO evidence', () => {
    expect(mcpTransport({ command: 'node', args: ['never-start.cjs'] })).toBe('stdio');
    expect(mcpTransport({ url: 'https://example.invalid/mcp' })).toBe('http');
    for (const value of [
      { command: 'node', url: 'https://example.invalid/mcp' },
      { url: 'https://example.invalid/mcp', type: 'stdio' },
      { command: 'node', type: 'http' },
      { command: 'node', type: 'sse' },
      { type: 'stdio' },
    ]) expect(mcpTransport(value)).toBe('unknown');
  });

  it('recognizes exact CLI signatures and rejects surrounding text and unrelated versions', () => {
    expect(parseRecognizedVersion('codex', 'codex-cli 0.159.2\n')?.version).toBe('0.159.2');
    expect(parseRecognizedVersion('claude-code', '2.1.266 (Claude Code)')?.version).toBe('2.1.266');
    expect(parseRecognizedVersion('codex', 'codex-cli 0.159.2\nsecret-value')).toBeNull();
    expect(parseRecognizedVersion('codex', 'othercodex 0.159.2')).toBeNull();
    expect(parseRecognizedVersion('zcode', 'zcode 1.0.0')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('handles CMD shims with spaces, bounds output and kills timed-out descendants', async () => {
    const directory = await createTestDirectory('version shim 中文 ');
    try {
      const executable = path.join(directory, 'codex.cmd');
      const common: VersionRunnerInput = { executable, args: ['--version'], cwd: directory, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: directory }, timeoutMs: 3000, maxOutputBytes: 4096 };
      await writeFile(executable, '@echo off\r\necho codex-cli 0.159.2\r\n');
      expect((await runVersionCommand(common)).stdout.trim()).toBe('codex-cli 0.159.2');
      await writeFile(executable, '@echo off\r\nfor /L %%i in (1,1,400) do echo overflowing-output\r\n');
      await expect(runVersionCommand({ ...common, maxOutputBytes: 128 })).rejects.toThrow();
      const marker = path.join(directory, 'descendant-survived');
      const script = path.join(directory, 'wait.cjs');
      await writeFile(script, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 1200);\n`);
      await writeFile(executable, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
      await expect(runVersionCommand({ ...common, timeoutMs: 150 })).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(await readFile(marker).then(() => true).catch(() => false)).toBe(false);
      const malicious = path.join(directory, 'bad&codex.cmd');
      await writeFile(malicious, '@echo off\r\necho codex-cli 0.159.2\r\n');
      await expect(runVersionCommand({ ...common, executable: malicious })).rejects.toThrow();
    } finally { await removeTestDirectory(directory); }
  });

  it.runIf(process.platform !== 'win32')('runs direct executables without a shell', async () => {
    const directory = await createTestDirectory('version-runner-');
    try {
      const executable = path.join(directory, 'codex');
      await writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.159.2\\n"\n');
      await chmod(executable, 0o755);
      const result = await runVersionCommand({ executable, args: ['--version'], cwd: directory, env: {}, timeoutMs: 1000, maxOutputBytes: 4096 });
      expect(result.stdout.trim()).toBe('codex-cli 0.159.2');
    } finally { await removeTestDirectory(directory); }
  });
});
