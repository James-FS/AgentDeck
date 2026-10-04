import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app';
import { createStore } from '../packages/storage/src/index';
import { editDshEnabled, prepareToggle, applyPrepared, recoverIncomplete } from '../packages/change-engine/src/index';
import type { AgentInstance, Binding, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index';
import { createTestDirectory, removeTestDirectory, fileTreeDigests } from './helpers';

describe('Claude and DSH user plugin switches', () => {
  let directory: string, home: string, cookie: string, csrf: string, origin: string;
  let app: ReturnType<typeof createApp>;
  const root = (agent: string) => path.join(home, agent === 'claude-code' ? '.claude' : '.dsh');
  const config = (agent: string) => path.join(root(agent), agent === 'claude-code' ? 'settings.json' : 'profiles/default/cordis.patch.yml');
  async function file(p: string, text: string) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, text); }
  async function call<T = Record<string, unknown>>(url: string, body?: unknown, status = 200) {
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url: '/api/v1'+url,
      headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': csrf }, ...(body === undefined ? {} : { payload: body }) });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.body).not.toContain('PRIVATE_PROFILE_SENTINEL');
    return response.json<T>();
  }
  async function register(agent: string, writable?: boolean) {
    const instance = await call<AgentInstance>('/instances', { agentId: agent, configRoot: root(agent), ...(writable === undefined ? {} : { writable }) }, 201);
    const catalog = await call<Catalog>('/scans', { instanceId: instance.id });
    const binding = catalog.bindings.find(row => row.instanceId === instance.id && row.kind === 'plugin' && row.name === 'switchable')!;
    return { instance, binding, catalog };
  }
  beforeEach(async () => {
    directory = await createTestDirectory('profile-switch 中文'); home = path.join(directory, 'home');
    await file(config('claude-code'), '{\r\n  "enabledPlugins": {"switchable@fixture": true},\r\n  "env": {"TOKEN": "PRIVATE_PROFILE_SENTINEL"}\r\n}\r\n');
    await file(path.join(root('claude-code'), 'skills/independent/SKILL.md'), 'never execute');
    await file(config('deepseek-harness'), '# preserve\r\n- id: tools\r\n  name: switchable\r\n  disabled: false # keep comment\r\n  config:\r\n    token: PRIVATE_PROFILE_SENTINEL\r\n- id: mcp\r\n  name: "@deepseek-ai/dsh-mcp-client"\r\n  disabled: false\r\n  config: {serverName: inherited, command: never-execute}\r\n');
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, userHomeDir: home, discoveryEnv: {}, userDiscoveryEnv: {} });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const session = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: { host: new URL(origin).host, origin }, payload: { ticket: app.agentdeckAuth.issueBootstrapTicket() } });
    cookie = String(session.headers['set-cookie']).split(';')[0]!; csrf = session.json().csrfToken;
  });
  afterEach(async () => { await app?.close(); await removeTestDirectory(directory); });
  for (const agent of ['claude-code', 'deepseek-harness']) {
    it(`${agent}: defaults to enabled control, changes one boolean and restores exact bytes`, async () => {
      const initial = await readFile(config(agent)); const files = await fileTreeDigests(home);
      const { instance, binding } = await register(agent);
      expect(instance.writable).toBe(true); expect(binding.writable).toBe(true);
      const plan = await call<ChangePlan>('/plans', { bindingId: binding.id, enabled: false }, 201);
      expect(await readFile(config(agent))).toEqual(initial);
      const operation = await call<Operation>(`/plans/${plan.id}/apply`, { digest: plan.afterHash });
      expect(await readFile(config(agent), 'utf8')).toBe(initial.toString().replace(agent === 'claude-code' ? 'true' : 'disabled: false', agent === 'claude-code' ? 'false' : 'disabled: true'));
      expect((await call<Catalog>('/catalog')).bindings.find(row => row.id === binding.id)?.enabled).toBe(false);
      const restore = await call<ChangePlan>(`/operations/${operation.id}/restore-plan`, {}, 201);
      await call(`/plans/${restore.id}/apply`, { digest: restore.afterHash });
      expect(await readFile(config(agent))).toEqual(initial); expect(await fileTreeDigests(home)).toEqual(files);
    });
    it(`${agent}: migrates old default permissions, preserves opt-out and rechecks revoke/conflict`, async () => {
      const { instance, binding } = await register(agent);
      const store = createStore(path.join(directory, 'data'));
      const legacy = { ...instance, writable: false }; delete legacy.togglePolicyVersion;
      store.putInstance(legacy); store.close();
      expect((await call<Catalog>('/scans', { instanceId: instance.id })).instances.find(row => row.id === instance.id)?.writable).toBe(true);
      await register(agent, false);
      await call('/plans', { bindingId: binding.id, enabled: false }, 403);
      expect((await call<Catalog>('/scans', { discover: true })).instances.find(row => row.id === instance.id)?.writable).toBe(false);
      await register(agent, true);
      const plan = await call<ChangePlan>('/plans', { bindingId: binding.id, enabled: false }, 201);
      const reopened = createStore(path.join(directory, 'data')); reopened.putInstance({ ...reopened.getInstance(instance.id)!, writable: false }); reopened.close();
      await call(`/plans/${plan.id}/apply`, { digest: plan.afterHash }, 403);
      await register(agent, true);
      const pending = await call<ChangePlan>('/plans', { bindingId: binding.id, enabled: false }, 201);
      await writeFile(config(agent), (await readFile(config(agent), 'utf8')).replace('PRIVATE_PROFILE_SENTINEL', 'external-edit'));
      await call(`/plans/${pending.id}/apply`, { digest: pending.afterHash }, 409);
    });
  }
  it('keeps Claude project, cache-only, synced and independent Skills read-only; installed user cache gets only settings target', async () => {
    const pkg = path.join(root('claude-code'), 'plugins/cache/fixture/installed/1.0');
    await file(path.join(pkg, '.claude-plugin/plugin.json'), '{"name":"installed","version":"1.0"}');
    await file(path.join(root('claude-code'), 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'installed@fixture': [{ scope: 'user', installPath: pkg, version: '1.0' }] } }));
    const unconfigured = path.join(root('claude-code'), 'plugins/cache/fixture/cache-only/1.0');
    await file(path.join(unconfigured, '.claude-plugin/plugin.json'), '{"name":"cache-only"}');
    const { instance, catalog } = await register('claude-code');
    expect(catalog.bindings.find(row => row.name === 'independent')?.writable).toBe(false);
    expect(catalog.bindings.find(row => row.name === 'cache-only')?.writable).toBe(false);
    const installed = catalog.bindings.find(row => row.name === 'installed')!;
    expect(installed.writable).toBe(true);
    const plan = await call<ChangePlan>('/plans', { bindingId: installed.id, enabled: false }, 201);
    await call(`/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(JSON.parse(await readFile(config('claude-code'), 'utf8')).enabledPlugins['installed@fixture']).toBe(false);
    const projectRoot = path.join(directory, 'project');
    await file(path.join(projectRoot, '.claude/settings.json'), '{"enabledPlugins":{"switchable@fixture":false}}');
    const project = await call<{ id: string }>('/projects', { rootPath: projectRoot }, 201);
    const scanned = await call<Catalog>('/scans', { instanceId: instance.id, projectId: project.id });
    const row = scanned.bindings.find(item => item.projectId === project.id && item.kind === 'plugin')!;
    expect(row.writable).toBe(false); await call('/plans', { bindingId: row.id, enabled: true }, 403);
    await file(config('claude-code'), '{"enabledPlugins":{"organization@synced":true}}');
    expect((await register('claude-code')).catalog.bindings.find(item => item.pluginId === 'organization@synced')?.writable).toBe(false);
  });
  it('DSH dynamic/invalid/duplicate switches, protected modules and child MCP stay read-only', async () => {
    const { catalog } = await register('deepseek-harness');
    const child = catalog.bindings.find(row => row.kind === 'mcp')!;
    expect(child.writable).toBe(false); await call('/plans', { bindingId: child.id, enabled: false }, 403);
    for (const source of [
      '- {id: tools, name: switchable, disabled: !!js "process.exit()"}\n',
      '- {id: tools, name: switchable, disabled: "false"}\n',
      '- {id: tools, name: switchable, disabled: false}\n- {id: tools, name: switchable, disabled: true}\n',
      '- {id: manager, name: "@deepseek-ai/dsh-plugin-manager", disabled: false}\n',
    ]) {
      await file(config('deepseek-harness'), source);
      const result = (await register('deepseek-harness')).catalog.bindings.filter(row => row.instanceId === catalog.instances.find(i => i.agentId === 'deepseek-harness')?.id);
      expect(result.length).toBeGreaterThan(0); expect(result.every(row => !row.writable)).toBe(true);
      expect(await readFile(config('deepseek-harness'), 'utf8')).toBe(source);
    }
  });
  it('inserts missing DSH disabled without rewriting config or comments and restores absence', async () => {
    for (const source of ['# keep\r\n- id: tools\r\n  name: switchable # keep\r\n  config: {value: 42}\r\n', '- {id: tools, name: switchable, config: {value: 42}}\n']) {
      await file(config('deepseek-harness'), source);
      const { binding } = await register('deepseek-harness');
      expect(binding.writable).toBe(true);
      const plan = await call<ChangePlan>('/plans', { bindingId: binding.id, enabled: false }, 201);
      const operation = await call<Operation>(`/plans/${plan.id}/apply`, { digest: plan.afterHash });
      const changed = await readFile(config('deepseek-harness'), 'utf8');
      expect(changed.replace(source.includes('\r\n') ? '  disabled: true\r\n' : ', disabled: true', '')).toBe(source);
      const restore = await call<ChangePlan>(`/operations/${operation.id}/restore-plan`, {}, 201);
      await call(`/plans/${restore.id}/apply`, { digest: restore.afterHash });
      expect(await readFile(config('deepseek-harness'), 'utf8')).toBe(source);
    }
  });
  it('DSH editor preserves BOM/CRLF/comments/tags and durable recovery keeps the YAML target', async () => {
    const original = '\uFEFF# note\r\n- {id: one, name: tools, disabled: false, expression: !!js "neverExecute()"} # comment\r\n';
    const target = { kind: 'dsh-yaml' as const, id: 'one', name: 'tools' };
    expect(editDshEnabled(original, false, target).text).toBe(original.replace('disabled: false', 'disabled: true'));
    await file(config('deepseek-harness'), original);
    const prepared = await prepareToggle({ configPath: config('deepseek-harness'), serverName: 'tools', enabled: false, target });
    const applied = await applyPrepared(prepared, { dataDir: path.join(directory, 'data') });
    expect((await recoverIncomplete({ dataDir: path.join(directory, 'data') })).items.some(item => item.operationId === applied.operation.id && item.status === 'completed')).toBe(true);
  });
  it('rejects Claude duplicate/non-boolean settings and keeps defaults from mutating during scans', async () => {
    for (const source of ['{"enabledPlugins":{"switchable@fixture":"on"}}', '{"enabledPlugins":{"switchable@fixture":true,"switchable@fixture":false}}']) {
      await file(config('claude-code'), source);
      const { catalog } = await register('claude-code');
      const candidates: Binding[] = catalog.bindings.filter(row => row.kind === 'plugin');
      expect(candidates.every(row => !row.writable)).toBe(true);
      expect(await readFile(config('claude-code'), 'utf8')).toBe(source);
    }
  });
  it('controls explicit Claude user installation without a standalone manifest, without creating cache contents', async () => {
    const installPath = path.join(root('claude-code'), 'plugins/cache/fixture/lsp/1.0');
    await mkdir(installPath, { recursive: true });
    await file(path.join(root('claude-code'), 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'lsp@fixture': [{ scope: 'user', version: '1.0', installPath }],
      'unknown@fixture': [{ version: '1.0', installPath }],
    } }));
    const initial = await fileTreeDigests(path.join(root('claude-code'), 'plugins'));
    const { catalog } = await register('claude-code');
    const binding = catalog.bindings.find(row => row.pluginId === 'lsp@fixture')!;
    expect(binding.writable).toBe(true);
    expect(catalog.bindings.find(row => row.pluginId === 'unknown@fixture')?.writable).toBe(false);
    const plan = await call<ChangePlan>('/plans', { bindingId: binding.id, enabled: false }, 201);
    await call(`/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(JSON.parse(await readFile(config('claude-code'), 'utf8')).enabledPlugins['lsp@fixture']).toBe(false);
    expect(await fileTreeDigests(path.join(root('claude-code'), 'plugins'))).toEqual(initial);
  });
});
