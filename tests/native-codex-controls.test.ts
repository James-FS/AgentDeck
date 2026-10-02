import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createApp } from '../apps/server/src/app.ts';
import type { AgentInstance, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index.ts';
import { createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';

const runFile = promisify(execFile);
const enabled = process.env.AGENTDECK_VERIFY_NATIVE_CODEX === '1';
type NativeSkill = { name: string; path: string; enabled: boolean; pluginId: string | null };

// Test-only RPC: never starts a thread/turn, model, MCP handshake or hook.
async function nativeRpc(executable: string, cwd: string, env: NodeJS.ProcessEnv, method: 'skills/list' | 'skills/config/write', params: unknown) {
  const child = spawn(executable, ['app-server', '--stdio'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let outputSize = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let seq = 0;
  function rejectAll(reason: string) { for (const entry of pending.values()) entry.reject(new Error(reason)); pending.clear(); }
  const timer = setTimeout(() => { rejectAll('Native discovery timed out.'); child.kill(); }, 12000);
  child.on('error', () => rejectAll('Native discovery could not start.'));
  child.on('exit', () => rejectAll('Native discovery exited before answering.'));
  child.stderr.on('data', chunk => { outputSize += chunk.length; if (outputSize > 2 * 1024 * 1024) { rejectAll('Native output limit exceeded.'); child.kill(); } });
  child.stdout.on('data', chunk => {
    outputSize += chunk.length;
    if (outputSize > 2 * 1024 * 1024) { rejectAll('Native output limit exceeded.'); child.kill(); return; }
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        const entry = response.id === undefined ? undefined : pending.get(response.id);
        if (entry) { pending.delete(response.id!); if (response.error) entry.reject(new Error('Native discovery rejected the request.')); else entry.resolve(response.result); }
      } catch { rejectAll('Native discovery returned invalid JSON.'); }
    }
  });
  function request(name: string, input: unknown) {
    const id = ++seq;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(JSON.stringify({ id, method: name, params: input }) + '\n');
    return result;
  }
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'agentdeck-config-validation', version: '0.1.0' } }) as { codexHome: string };
    expect(path.resolve(initialized.codexHome)).toBe(path.resolve(env.CODEX_HOME!));
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return await request(method, params);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
  }
}

describe.runIf(enabled)('actual Codex Skill and local marketplace plugin controls in isolated directories', () => {
  it('natively rereads disabled/re-enabled Skill and plugin states, restores exact bytes and never changes real sources', async () => {
    const executable = process.env.AGENTDECK_CODEX_PATH!;
    expect(executable).toBeTruthy();
    const root = await createTestDirectory('原生 Skill 插件 ');
    const home = path.join(root, '隔离 home');
    const codexHome = path.join(home, '.codex');
    const cwd = path.join(root, '项目 project');
    const market = path.join(root, '本地市场');
    const skillPath = path.join(codexHome, 'skills/native-skill/SKILL.md');
    const pluginRoot = path.join(market, 'probe');
    const configPath = path.join(codexHome, 'config.toml');
    let app: ReturnType<typeof createApp> | undefined;
    const realFiles = [path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), path.join(os.homedir(), '.claude/settings.json')];
    try { const proof = JSON.parse(await readFile('work/scan-proof/real-client-proof.json', 'utf8')) as { digests?: Record<string, string> }; realFiles.push(...Object.keys(proof.digests ?? {})); } catch { /* optional prior scan proof */ }
    async function realDigests() {
      const result: Record<string, string | null> = {};
      for (const file of new Set(realFiles)) result[file] = await readFile(file).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => null);
      return result;
    }
    const realBefore = await realDigests();
    try {
      for (const dir of [cwd, path.dirname(skillPath), path.join(home, 'tmp'), path.join(market, '.agents/plugins'), path.join(pluginRoot, '.codex-plugin'), path.join(pluginRoot, 'skills/native-plugin-skill')]) await mkdir(dir, { recursive: true });
      const markdown = '---\nname: native-skill\ndescription: Synthetic discovery fixture.\n---\nDo not run commands.\n';
      await writeFile(skillPath, markdown);
      await writeFile(path.join(pluginRoot, 'skills/native-plugin-skill/SKILL.md'), markdown.replace('name: native-skill', 'name: native-plugin-skill'));
      await writeFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'probe', version: '1.0.0', description: 'Synthetic local fixture', skills: './skills/' }));
      await writeFile(path.join(market, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'local', interface: { displayName: 'Local fixture' }, plugins: [{ name: 'probe', source: { source: 'local', path: './probe' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }] }));
      const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH ?? process.env.Path, PATHEXT: process.env.PATHEXT,
        HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp') };
      const codex = async (args: string[]) => (await runFile(executable, args, { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
      expect((await codex(['--version'])).trim()).toBe('codex-cli 0.159.2');
      // Native fixture generation only: a local synthetic plugin with no executable components.
      await codex(['plugin', 'marketplace', 'add', market, '--json']);
      await codex(['plugin', 'add', 'probe@local', '--json']);
      await nativeRpc(executable, cwd, env, 'skills/config/write', { path: skillPath, enabled: true });
      const nativeGenerated = await readFile(configPath, 'utf8');
      const original = Buffer.from('\uFEFF# retained native fixture\r\n' + nativeGenerated.replace(/\r?\n/g, '\r\n') + '\r\n[agentdeck_fixture]\r\nnotes = "untouched"\r\n');
      await writeFile(configPath, original);
      const assetsBefore = await fileTreeDigests(path.join(codexHome, 'plugins/cache'));
      async function skills() { const reply = await nativeRpc(executable, cwd, env, 'skills/list', { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: NativeSkill[] }> }; return reply.data.flatMap(row => row.skills); }
      async function plugin() { const listing = JSON.parse(await codex(['plugin', 'list', '--marketplace', 'local', '--json'])) as { installed: Array<{ pluginId: string; enabled: boolean }> }; return listing.installed.find(row => row.pluginId === 'probe@local')!; }
      expect((await skills()).find(row => row.path === skillPath)?.enabled).toBe(true);
      expect((await plugin()).enabled).toBe(true);
      app = createApp({ dataDir: path.join(root, 'manager'), homeDir: home, userHomeDir: home, discoveryEnv: {}, userDiscoveryEnv: {}, executableResolver: async () => executable });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const session = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: { host: new URL(origin).host, origin }, payload: { ticket: app.agentdeckAuth.issueBootstrapTicket() } });
      expect(session.statusCode).toBe(200);
      const cookie = String(session.headers['set-cookie']).split(';')[0]!;
      const csrf = session.json<{ csrfToken: string }>().csrfToken;
      async function call<T>(method: 'POST' | 'GET', url: string, body?: unknown, status = 200) {
        const response = await app!.inject({ method, url: '/api/v1' + url, headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf }, ...(body === undefined ? {} : { payload: body }) });
        expect(response.statusCode, response.body).toBe(status); return response.json<T>();
      }
      const instance = await call<AgentInstance>('POST', '/instances', { agentId: 'codex', configRoot: codexHome, writable: true }, 201);
      await call('POST', `/instances/${instance.id}/version-check`, {});
      const catalog = await call<Catalog>('POST', '/scans', { instanceId: instance.id });
      const proof: unknown[] = [];
      for (const kind of ['skill', 'plugin'] as const) {
        const binding = catalog.bindings.find(row => row.kind === kind && row.name === (kind === 'skill' ? 'native-skill' : 'probe'))!;
        expect(binding.writable).toBe(true);
        const originalForKind = await readFile(configPath);
        const state = async () => kind === 'skill' ? (await skills()).find(row => row.path === skillPath)!.enabled : (await plugin()).enabled;
        const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
        expect(await readFile(configPath)).toEqual(originalForKind);
        const op = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
        expect(await state()).toBe(false);
        if (kind === 'plugin') expect((await skills()).some(row => row.pluginId === 'probe@local' && row.enabled)).toBe(false);
        const restore = await call<ChangePlan>('POST', `/operations/${op.id}/restore-plan`, {}, 201);
        await call('POST', `/plans/${restore.id}/apply`, { digest: restore.afterHash });
        expect(await state()).toBe(true);
        expect(await readFile(configPath)).toEqual(originalForKind);
        const secondDisable = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
        await call('POST', `/plans/${secondDisable.id}/apply`, { digest: secondDisable.afterHash });
        const disabledBytes = await readFile(configPath);
        expect(await state()).toBe(false);
        const enablePlan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: true }, 201);
        const enabledOp = await call<Operation>('POST', `/plans/${enablePlan.id}/apply`, { digest: enablePlan.afterHash });
        expect(await state()).toBe(true);
        const undoEnable = await call<ChangePlan>('POST', `/operations/${enabledOp.id}/restore-plan`, {}, 201);
        await call('POST', `/plans/${undoEnable.id}/apply`, { digest: undoEnable.afterHash });
        expect(await state()).toBe(false);
        expect(await readFile(configPath)).toEqual(disabledBytes);
        proof.push({ kind, controlScope: binding.controlScope, nativeStates: [true, false, true, false, true, false], disabledOperation: op.id, exactBytesRestored: true });
      }
      expect(await readFile(skillPath, 'utf8')).toBe(markdown);
      expect(await fileTreeDigests(path.join(codexHome, 'plugins/cache'))).toEqual(assetsBefore);
      expect(await realDigests()).toEqual(realBefore);
      await mkdir('work/compatibility-proof', { recursive: true });
      await writeFile('work/compatibility-proof/native-codex-controls.json', JSON.stringify({ verifiedAt: new Date().toISOString(), version: '0.159.2', platform: process.platform, runtime: 'unverified', realSourcesUnchanged: true, realSourceCount: Object.values(realBefore).filter(Boolean).length, cases: proof }, null, 2));
      console.log(JSON.stringify({ version: '0.159.2', controls: ['user-config-skill', 'local-marketplace-plugin'], realSourcesUnchanged: true }));
    } finally {
      await app?.close();
      expect(await realDigests()).toEqual(realBefore);
      await removeTestDirectory(root);
    }
  }, 60000);
});
