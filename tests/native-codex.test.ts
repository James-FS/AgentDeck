import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import type { AgentInstance, Catalog, ChangePlan, CompatibilityReport, Operation } from '../packages/contracts/src/index.ts';
import { createTestDirectory, removeTestDirectory } from './helpers.ts';

const runFile = promisify(execFile);
const enabled = process.env.AGENTDECK_VERIFY_NATIVE_CODEX === '1';
const proofs: unknown[] = [];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe.runIf(enabled)('actual Codex configuration loading with isolated state', () => {
  afterAll(async () => {
    await mkdir('work/compatibility-proof', { recursive: true });
    await writeFile('work/compatibility-proof/native-codex.json', JSON.stringify({ verifiedAt: new Date().toISOString(), platform: process.platform, evidenceLevel: 'native-config', runtime: 'unverified', cases: proofs }, null, 2));
  });

  it.each(['missing-enabled', 'explicit-enabled-crlf-bom'] as const)('applies, natively rereads and restores %s without starting the server', async variant => {
    const executable = process.env.AGENTDECK_CODEX_PATH;
    expect(executable, 'Set AGENTDECK_CODEX_PATH to the actual Codex executable').toBeTruthy();
    const directory = await createTestDirectory('原生 Codex 配置 ');
    const home = path.join(directory, '隔离 home');
    const codexHome = path.join(home, '.codex');
    const cwd = path.join(directory, '样例 project');
    const dataDir = path.join(directory, 'manager-data');
    const marker = path.join(directory, 'server-was-started');
    const commandFile = path.join(cwd, 'agentdeck-never-start.cjs');
    let app: ReturnType<typeof createApp> | undefined;
    const realRoots = [process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), process.env.ZCODE_HOME ?? path.join(os.homedir(), '.zcode'), process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')];
    const realFiles = [path.join(realRoots[0]!, 'config.toml'), path.join(realRoots[1]!, 'settings.json'), path.join(realRoots[2]!, 'cli/config.json')];
    try {
      const previous = JSON.parse(await readFile('work/scan-proof/real-client-proof.json', 'utf8')) as { digests?: Record<string, string> };
      realFiles.push(...Object.keys(previous.digests ?? {}));
    } catch { /* Previous local proof is optional, never a checked-in prerequisite. */ }
    async function realDigests() {
      const result: Record<string, string | null> = {};
      for (const file of new Set(realFiles)) result[file] = await readFile(file).then(sha256).catch(() => null);
      return result;
    }
    const beforeReal = await realDigests();
    try {
      await mkdir(codexHome, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(path.join(home, 'temp'), { recursive: true });
      await writeFile(commandFile, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected startup');\n`);
      // Whitelist OS variables; do not inherit authentication, real configuration roots or project overrides.
      const env: NodeJS.ProcessEnv = {
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        PATH: process.env.PATH ?? process.env.Path, PATHEXT: process.env.PATHEXT,
        HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
        APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
        TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp'),
      };
      async function codex(args: string[]) {
        const result = await runFile(executable!, args, { cwd, env, windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024 });
        return result.stdout;
      }
      const versionOutput = (await codex(['--version'])).trim();
      expect(versionOutput).toMatch(/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
      // Use the native writer to obtain the actual transport shape; it only registers a synthetic server.
      await codex(['mcp', 'add', 'agentdeck-native-probe', '--env', 'AGENTDECK_FAKE_TOKEN=AGENTDECK_SECRET_SENTINEL', '--', 'node', 'agentdeck-never-start.cjs']);
      const configPath = path.join(codexHome, 'config.toml');
      let original = await readFile(configPath);
      await mkdir('work/compatibility-proof', { recursive: true });
      // All values in this native-generated fixture are synthetic and contain no machine paths.
      await writeFile('work/compatibility-proof/native-generated.toml', original);
      if (variant === 'explicit-enabled-crlf-bom') {
        const text = '# AgentDeck native fixture; preserved comment\n' + original.toString('utf8').replace('[mcp_servers.agentdeck-native-probe]', '[mcp_servers.agentdeck-native-probe]\nenabled = true # preserve this comment') + '\n[agentdeck_fixture]\nuntouched = "原文 untouched"\n';
        original = Buffer.from('\uFEFF' + text.replace(/\r?\n/g, '\r\n'));
        await writeFile(configPath, original);
      }
      const baseline = JSON.parse(await codex(['mcp', 'get', 'agentdeck-native-probe', '--json'])) as { enabled: boolean; transport: unknown };
      expect(baseline.enabled).toBe(true);
      const listing = JSON.parse(await codex(['mcp', 'list', '--json'])) as Array<{ name: string; enabled: boolean }>;
      expect(listing.map(item => item.name)).toEqual(['agentdeck-native-probe']);
      expect(listing[0]?.enabled).toBe(true);
      app = createApp({ dataDir, homeDir: home, userHomeDir: home, discoveryEnv: { PATH: path.dirname(executable!), PATHEXT: '.EXE', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, userDiscoveryEnv: {} });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const bootstrap = await fetch(`${origin}/api/v1/session/bootstrap`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: app.agentdeckAuth.issueBootstrapTicket() }) });
      expect(bootstrap.status).toBe(200);
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
      const { csrfToken } = await bootstrap.json() as { csrfToken: string };
      async function call<T>(method: string, endpoint: string, body?: unknown, expectedStatus = 200): Promise<T> {
        const response = await fetch(`${origin}/api/v1${endpoint}`, { method, headers: { Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        expect(response.status, endpoint).toBe(expectedStatus);
        const result = await response.json() as T;
        expect(JSON.stringify(result)).not.toContain('AGENTDECK_SECRET_SENTINEL');
        return result;
      }
      const instance = await call<AgentInstance>('POST', '/instances', { agentId: 'codex', configRoot: codexHome, writable: true }, 201);
      const compatibility = await call<CompatibilityReport>('POST', `/instances/${instance.id}/version-check`, {});
      const checked = compatibility.clients.find(item => item.instanceId === instance.id)!;
      expect(checked.status).toBe('verified-client');
      expect(checked.versionEvidence?.version).toBe(versionOutput.replace('codex-cli ', ''));
      expect(checked.capabilities.filter(item => item.area === 'runtime').every(item => item.status === 'unverified')).toBe(true);
      const catalog = await call<Catalog>('POST', '/scans', { instanceId: instance.id });
      const binding = catalog.bindings.find(item => item.name === 'agentdeck-native-probe')!;
      expect(binding.writable).toBe(true);
      expect(binding.enabled).toBe(true);
      const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
      expect(await readFile(configPath)).toEqual(original);
      const operation = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
      expect(operation.status).toBe('succeeded');
      const changed = await readFile(configPath);
      const disabled = JSON.parse(await codex(['mcp', 'get', 'agentdeck-native-probe', '--json'])) as typeof baseline;
      expect(disabled.enabled).toBe(false);
      expect(disabled.transport).toEqual(baseline.transport);
      const disabledList = JSON.parse(await codex(['mcp', 'list', '--json'])) as typeof listing;
      expect(disabledList[0]?.enabled).toBe(false);
      const repeated = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
      expect(repeated.id).toBe(operation.id);
      const restore = await call<ChangePlan>('POST', `/operations/${operation.id}/restore-plan`, {}, 201);
      await call<Operation>('POST', `/plans/${restore.id}/apply`, { digest: restore.afterHash });
      expect(await readFile(configPath)).toEqual(original);
      const restored = JSON.parse(await codex(['mcp', 'get', 'agentdeck-native-probe', '--json'])) as typeof baseline;
      expect(restored).toEqual(baseline);
      const disableAgain = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
      await call<Operation>('POST', `/plans/${disableAgain.id}/apply`, { digest: disableAgain.afterHash });
      const beforeEnable = await readFile(configPath);
      const enablePlan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: true }, 201);
      const enabledAgain = await call<Operation>('POST', `/plans/${enablePlan.id}/apply`, { digest: enablePlan.afterHash });
      expect((JSON.parse(await codex(['mcp', 'get', 'agentdeck-native-probe', '--json'])) as typeof baseline).enabled).toBe(true);
      const restoreEnable = await call<ChangePlan>('POST', `/operations/${enabledAgain.id}/restore-plan`, {}, 201);
      await call<Operation>('POST', `/plans/${restoreEnable.id}/apply`, { digest: restoreEnable.afterHash });
      expect(await readFile(configPath)).toEqual(beforeEnable);
      expect((JSON.parse(await codex(['mcp', 'get', 'agentdeck-native-probe', '--json'])) as typeof baseline).enabled).toBe(false);
      // Reset only the isolated fixture before the independent conflict cases below.
      await writeFile(configPath, original);
      const stalePlan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
      const external = Buffer.concat([original, Buffer.from('\n# external edit\n')]);
      await writeFile(configPath, external);
      await call('POST', `/plans/${stalePlan.id}/apply`, { digest: stalePlan.afterHash }, 409);
      expect(await readFile(configPath)).toEqual(external);
      await writeFile(configPath, original);
      const conflictPlan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
      const conflictOperation = await call<Operation>('POST', `/plans/${conflictPlan.id}/apply`, { digest: conflictPlan.afterHash });
      const externalAfterApply = Buffer.concat([await readFile(configPath), Buffer.from('\n# external edit after apply\n')]);
      await writeFile(configPath, externalAfterApply);
      await call('POST', `/operations/${conflictOperation.id}/restore-plan`, {}, 409);
      expect(await readFile(configPath)).toEqual(externalAfterApply);
      // Return the isolated test configuration to its native baseline; real sources were never targets.
      await writeFile(configPath, original);
      expect(await access(marker).then(() => true).catch(() => false)).toBe(false);
      expect(await realDigests()).toEqual(beforeReal);
      proofs.push({ version: versionOutput.replace('codex-cli ', ''), variant, resource: 'independent-mcp', scope: 'user-global', beforeHash: sha256(original), afterHash: sha256(changed), restoreHash: sha256(await readFile(configPath)), nativeGet: [true, false, true], nativeList: [true, false], explicitReenableVerified: true, transportUnchanged: true, replayIdempotent: true, stalePlanRejected: true, restoreConflictRejected: true, serverStarted: false, realSourceFilesChecked: Object.keys(beforeReal).length, realSourcesUnchanged: true });
      console.log(JSON.stringify({ version: versionOutput, variant, nativeGet: [true, false, true], realSourcesUnchanged: true }));
    } finally {
      await app?.close();
      expect(await realDigests()).toEqual(beforeReal);
      await removeTestDirectory(directory);
    }
  }, 90_000);
});
