import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { prepareToggle, applyPrepared, prepareRestore, recoverIncomplete, serializePreparedChange, deserializePreparedChange } from '../packages/change-engine/src/index.ts';
import { createStore } from '../packages/storage/src/index.ts';
import type { AgentInstance, Binding, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index.ts';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';

describe('bounded Codex Skill and local plugin configuration controls', () => {
  let root: string;
  let home: string;
  let config: string;
  let skill: string;
  let executable: string;
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let csrf: string;
  let version: string;
  let origin: string;
  const dataDir = () => path.join(root, 'data');
  async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', url: string, body?: unknown, expected = 200, extra: Record<string, string> = {}) {
    const reply = await app.inject({ method, url: `/api/v1${url}`, headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf, ...extra }, ...(body === undefined ? {} : { payload: body }) });
    expect(reply.statusCode, url + ' ' + reply.body).toBe(expected);
    expect(reply.body).not.toContain('AGENTDECK_SECRET_SENTINEL');
    return reply.json<T>();
  }
  async function register(writable = true) {
    const instance = await call<AgentInstance>('POST', '/instances', { agentId: 'codex', configRoot: path.dirname(config), writable }, 201);
    await call('POST', `/instances/${instance.id}/version-check`, {});
    const catalog = await call<Catalog>('POST', '/scans', { instanceId: instance.id });
    return { instance, catalog };
  }
  async function apply(binding: Binding) {
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    const operation = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
    return { plan, operation };
  }
  beforeEach(async () => {
    root = await createTestDirectory('codex-controls 中文 ');
    ({ home } = await copyCatalogFixture(root));
    config = path.join(home, '.codex/config.toml');
    skill = path.join(home, '.codex/skills/user-review/SKILL.md');
    executable = path.join(root, 'codex.exe');
    await writeFile(executable, 'synthetic version identity');
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, '---\nname: user-review\ndescription: synthetic fixture\n---\nNo execution.\n');
    const cache = path.join(home, '.codex/plugins/cache/local/probe/1.0.0');
    await mkdir(path.join(cache, '.codex-plugin'), { recursive: true });
    await mkdir(path.join(cache, 'skills/child'), { recursive: true });
    await writeFile(path.join(cache, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'probe', version: '1.0.0', skills: './skills', mcpServers: './.mcp.json' }));
    await writeFile(path.join(cache, 'skills/child/SKILL.md'), 'fixture');
    await writeFile(path.join(cache, '.mcp.json'), JSON.stringify({ mcpServers: { child: { command: 'never-start' } } }));
    await writeFile(config, `\uFEFF# preserve\r\n[plugins."probe@local"]\r\nenabled = true # retained\r\nsecret = "AGENTDECK_SECRET_SENTINEL"\r\n\r\n[marketplaces.local]\r\nsource_type = "local"\r\nsource = ${JSON.stringify(path.join(root, 'market'))}\r\n`);
    version = '0.159.2';
    app = createApp({ dataDir: dataDir(), homeDir: home, userHomeDir: home, discoveryEnv: {}, userDiscoveryEnv: {}, platform: 'win32', executableResolver: async () => executable,
      versionRunner: async () => ({ stdout: `codex-cli ${version}`, stderr: '', exitCode: 0 }) });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const reply = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: { host: new URL(origin).host, origin }, payload: { ticket: app.agentdeckAuth.issueBootstrapTicket() } });
    expect(reply.statusCode).toBe(200);
    cookie = String(reply.headers['set-cookie']).split(';')[0]!;
    csrf = reply.json<{ csrfToken: string }>().csrfToken;
  });
  afterEach(async () => { await app?.close(); await removeTestDirectory(root); });

  it.each(['skill', 'plugin'] as const)('previews, applies and exactly restores %s without editing source assets', async kind => {
    const { catalog } = await register();
    const binding = catalog.bindings.find(row => row.kind === kind && row.name === (kind === 'skill' ? 'user-review' : 'probe'))!;
    expect(binding.writable).toBe(true);
    const original = await readFile(config);
    const sourceBefore = await fileTreeDigests(path.join(home, '.codex/skills'));
    const cacheBefore = await fileTreeDigests(path.join(home, '.codex/plugins/cache'));
    await call('POST', '/plans', { bindingId: binding.id, enabled: false }, 401, { cookie: '' });
    await call('POST', '/plans', { bindingId: binding.id, enabled: false }, 403, { 'x-csrf-token': '' });
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    expect(plan.targetPath).toBe(config);
    expect(await readFile(config)).toEqual(original);
    const op = await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect((await call<Operation>('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash })).id).toBe(op.id);
    const rows = (await call<Catalog>('GET', '/catalog')).bindings;
    expect(rows.find(row => row.id === binding.id)?.enabled).toBe(false);
    if (kind === 'plugin') expect(rows.filter(row => row.parentId === binding.id).every(row => row.enabled === false && !row.writable)).toBe(true);
    const restore = await call<ChangePlan>('POST', `/operations/${op.id}/restore-plan`, {}, 201);
    await call('POST', `/plans/${restore.id}/apply`, { digest: restore.afterHash });
    expect(await readFile(config)).toEqual(original);
    expect(await fileTreeDigests(path.join(home, '.codex/skills'))).toEqual(sourceBefore);
    expect(await fileTreeDigests(path.join(home, '.codex/plugins/cache'))).toEqual(cacheBefore);
  });

  it('keeps unverified versions, project, builtin and plugin children read-only despite default controls', async () => {
    const auto = await call<Catalog>('POST', '/scans', { discover: true });
    const autoCodex = auto.instances.find(row => row.agentId === 'codex')!;
    expect(auto.bindings.filter(row => row.instanceId === autoCodex.id && row.kind !== 'mcp').every(row => !row.writable)).toBe(true);
    expect(auto.instances.find(row => row.agentId === 'codex')?.writable).toBe(true);
    await call('POST', `/instances/${autoCodex.id}/version-check`, {});
    const verifiedAuto = await call<Catalog>('POST', '/scans', { instanceId: autoCodex.id });
    expect(verifiedAuto.bindings.find(row => row.instanceId === autoCodex.id && row.name === 'user-review')?.writable).toBe(true);
    version = '0.159.3';
    const { catalog } = await register();
    expect(catalog.bindings.filter(row => row.instanceId === autoCodex.id).every(row => !row.writable)).toBe(true);
    const skillRow = catalog.bindings.find(row => row.name === 'user-review')!;
    await call('POST', '/plans', { bindingId: skillRow.id, enabled: false }, 403);
    version = '0.159.2';
    const registered = await register();
    const project = await call<{ id: string }>('POST', '/projects', { rootPath: path.join(root, 'project') }, 201);
    const scanned = await call<Catalog>('POST', '/scans', { instanceId: registered.instance.id, projectId: project.id });
    for (const row of scanned.bindings.filter(row => row.parentId !== null || row.sourceKind === 'builtin' || row.projectId !== null || row.name === 'global-review')) {
      expect(row.writable).toBe(false);
      await call('POST', '/plans', { bindingId: row.id, enabled: false }, 403);
    }
  });

  it.each(['revocation', 'executable-replacement'] as const)('rechecks %s before applying a prepared Skill plan', async condition => {
    const { catalog } = await register();
    const binding = catalog.bindings.find(row => row.name === 'user-review')!;
    const original = await readFile(config);
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    if (condition === 'revocation') await call('POST', '/instances', { agentId: 'codex', configRoot: path.dirname(config), writable: false }, 201);
    else await writeFile(executable, 'changed native executable identity');
    await call('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash }, 403);
    expect(await readFile(config)).toEqual(original);
  });

  it('preserves external edits during apply and restore conflicts', async () => {
    const { catalog } = await register();
    const binding = catalog.bindings.find(row => row.name === 'user-review')!;
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    const external = Buffer.concat([await readFile(config), Buffer.from('\r\n# external\r\n')]);
    await writeFile(config, external);
    await call('POST', `/plans/${plan.id}/apply`, { digest: plan.afterHash }, 409);
    expect(await readFile(config)).toEqual(external);
    const { operation } = await apply(binding);
    const changed = Buffer.concat([await readFile(config), Buffer.from('\r\n# external after\r\n')]);
    await writeFile(config, changed);
    await call('POST', `/operations/${operation.id}/restore-plan`, {}, 409);
    expect(await readFile(config)).toEqual(changed);
  });

  it('rejects duplicate/inline Skill overrides and restores a serialized existing override with BOM/CRLF', async () => {
    const target = { kind: 'skill' as const, path: skill };
    const source = `\uFEFF# preserve\r\n[[skills.config]]\r\npath = ${JSON.stringify(skill)}\r\nenabled = true # retain\r\nnotes = """\r\nenabled = false\r\n"""\r\n`;
    await writeFile(config, source);
    const prepared = deserializePreparedChange(serializePreparedChange(await prepareToggle({ configPath: config, serverName: 'user-review', target, enabled: false })));
    const applied = await applyPrepared(prepared, { dataDir: dataDir() });
    expect(await readFile(config, 'utf8')).toBe(source.replace('enabled = true', 'enabled = false'));
    expect((await recoverIncomplete({ dataDir: dataDir() })).items.some(row => row.operationId === applied.operation.id && row.status === 'completed')).toBe(true);
    await applyPrepared(await prepareRestore({ operationId: applied.operation.id, dataDir: dataDir() }), { dataDir: dataDir() });
    expect(await readFile(config, 'utf8')).toBe(source);
    for (const text of [source + `\r\n[[skills.config]]\r\npath = ${JSON.stringify(skill)}\r\nenabled = false\r\n`, `[skills]\nconfig = [{ path = ${JSON.stringify(skill)}, enabled = true }]\n`, '[skills]\nconfig = []\n']) {
      await writeFile(config, text);
      await expect(prepareToggle({ configPath: config, serverName: 'user-review', target, enabled: false })).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    }
  });

  it('recovers a plugin write before the database commit and can restore it after restart', async () => {
    const { catalog } = await register();
    const binding = catalog.bindings.find(row => row.kind === 'plugin' && row.name === 'probe')!;
    const original = await readFile(config);
    const plan = await call<ChangePlan>('POST', '/plans', { bindingId: binding.id, enabled: false }, 201);
    await app.close();
    const store = createStore(dataDir());
    const prepared = store.getPlan(plan.id)!.privateData as Parameters<typeof applyPrepared>[0];
    const applied = await applyPrepared(prepared, { dataDir: dataDir() });
    store.close();
    const recovered = await recoverIncomplete({ dataDir: dataDir() });
    expect(recovered.items.find(row => row.operationId === applied.operation.id)?.status).toBe('completed');
    await applyPrepared(await prepareRestore({ operationId: applied.operation.id, dataDir: dataDir() }), { dataDir: dataDir() });
    expect(await readFile(config)).toEqual(original);
  });
});
