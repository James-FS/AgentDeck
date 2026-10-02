import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { createStore } from '../packages/storage/src/index.ts';
import { applyPrepared, type PreparedChange } from '../packages/change-engine/src/index.ts';
import type { AgentInstance, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index.ts';
import { copyCatalogFixture, createTestDirectory, removeTestDirectory } from './helpers.ts';

describe('local API with actual network peers and isolated configuration', () => {
  let directory: string;
  let home: string;
  let app: ReturnType<typeof createApp>;
  let origin: string;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    directory = await createTestDirectory('server-');
    ({ home } = await copyCatalogFixture(directory));
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, demoDir: path.join(directory, 'demo'), discoveryEnv: {}, allowedOrigins: [] });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    expect(response.status).toBe(200);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
  });

  afterEach(async () => {
    await app?.close();
    if (directory) await removeTestDirectory(directory);
  });

  async function call<T = Record<string, unknown>>(method: string, endpoint: string, body?: unknown, authenticated = true, extraHeaders: Record<string, string> = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Origin: origin,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      ...(authenticated ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...extraHeaders,
    };
    return await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: T }>((resolve, reject) => {
      const request = httpRequest(new URL(endpoint, origin), { method, headers }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode!, headers: response.headers, body: text ? JSON.parse(text) : null });
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }

  async function writableCodex() {
    const registration = await call<AgentInstance>('POST', '/api/v1/instances', { agentId: 'codex', configRoot: path.join(home, '.codex'), writable: true });
    expect(registration.status).toBe(201);
    const instance = registration.body as AgentInstance;
    const scan = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id });
    expect(scan.status).toBe(200);
    const binding = (scan.body as Catalog).bindings.find(item => item.instanceId === instance.id && item.kind === 'mcp' && item.name === 'docs')!;
    expect(binding).toBeDefined();
    return { instance, binding };
  }

  it('requires a session and CSRF token and consumes bootstrap tickets once', async () => {
    expect((await call('GET', '/api/v1/catalog', undefined, false)).status).toBe(401);
    expect((await call('POST', '/api/v1/demo', {}, true, { 'X-CSRF-Token': '' })).status).toBe(403);
    const ticket = app.agentdeckAuth.issueBootstrapTicket();
    expect((await call('POST', '/api/v1/session/bootstrap', { ticket }, false)).status).toBe(200);
    expect((await call('POST', '/api/v1/session/bootstrap', { ticket }, false)).status).toBe(401);
  });

  it('rejects hostile Host and browser Origin even after the server has started', async () => {
    expect((await call('GET', '/health', undefined, false, { Host: 'attacker.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/catalog', undefined, true, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/catalog', undefined, true, { Origin: 'http://localhost:5173' })).status).toBe(403);
  });

  it('discovers four fixture clients without exposing configuration credentials', async () => {
    const response = await call<Catalog>('POST', '/api/v1/scans', { discover: true });
    expect(response.status).toBe(200);
    const catalog = response.body as Catalog;
    expect(new Set(catalog.instances.map(item => item.agentId)).size).toBe(4);
    expect(catalog.bindings.length).toBeGreaterThan(5);
    expect(JSON.stringify(catalog)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect(catalog.instances.every(item => !item.writable)).toBe(true);
    const binding = catalog.bindings.find(item => item.kind === 'mcp' && item.name === 'docs')!;
    expect((await call('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).status).toBe(403);
  });

  it('keeps explicit instance registration when rediscovering the same root', async () => {
    const { instance } = await writableCodex();
    const response = await call<Catalog>('POST', '/api/v1/scans', { discover: true });
    const saved = (response.body as Catalog).instances.find(item => path.resolve(item.configRoot) === path.resolve(instance.configRoot));
    expect(saved?.id).toBe(instance.id);
    expect(saved?.discovery).toBe('manual');
    expect(saved?.writable).toBe(true);
  });

  it('upgrades a discovered root to manual registration without creating a second instance', async () => {
    const initial = (await call<Catalog>('POST', '/api/v1/scans', { discover: true })).body;
    const discovered = initial.instances.find(item => item.agentId === 'codex')!;
    const { instance } = await writableCodex();
    expect(instance.id).toBe(discovered.id);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.instances.filter(item => item.agentId === 'codex')).toHaveLength(1);
    expect(catalog.instances.find(item => item.id === instance.id)?.discovery).toBe('manual');
  });

  it('merges project and user bindings without duplicates and keeps another project scan', async () => {
    const { instance } = await writableCodex();
    const projectRoot = path.join(directory, 'project');
    const registered = await call('POST', '/api/v1/projects', { rootPath: projectRoot });
    expect(registered.status).toBe(201);
    const projectId = registered.body.id;
    const scanned = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id, projectId });
    expect(scanned.status).toBe(200);
    const rows = (scanned.body as Catalog).bindings;
    expect(rows.some(item => item.name === 'project-review' && item.projectId === projectId)).toBe(true);
    expect(rows.some(item => item.name === 'docs' && item.projectId === null)).toBe(true);
    expect(new Set(rows.map(item => item.id)).size).toBe(rows.length);
    const rescanned = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id });
    expect((rescanned.body as Catalog).bindings.some(item => item.name === 'project-review' && item.projectId === projectId)).toBe(true);
  });

  it('persists a prepared plan, applies once, refreshes the catalog, and restores exact bytes', async () => {
    const { binding } = await writableCodex();
    const before = await readFile(binding.sourcePath);
    const prepared = await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false });
    expect(prepared.status).toBe(201);
    const plan = prepared.body as ChangePlan;
    expect(JSON.stringify(plan)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(true);
    const applied = await call<Operation>('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(applied.status).toBe(200);
    const operation = applied.body as Operation;
    expect(operation.status).toBe('succeeded');
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(false);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
    const replay = await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(operation.id);
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: 'incorrect-digest' })).status).toBe(409);
    const restoration = await call<ChangePlan>('POST', `/api/v1/operations/${operation.id}/restore-plan`, {});
    expect(restoration.status).toBe(201);
    const restorePlan = restoration.body as ChangePlan;
    expect((await call('POST', `/api/v1/plans/${restorePlan.id}/apply`, { digest: restorePlan.afterHash })).status).toBe(200);
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(true);
    const restoredCatalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(restoredCatalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(true);
  });

  it('refuses stale plans and records a conflict without overwriting external edits', async () => {
    const { binding } = await writableCodex();
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    const externallyEdited = Buffer.concat([await readFile(binding.sourcePath), Buffer.from('\n# edited externally\n')]);
    await writeFile(binding.sourcePath, externallyEdited);
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash })).status).toBe(409);
    expect((await readFile(binding.sourcePath)).equals(externallyEdited)).toBe(true);
    const operations = (await call<Operation[]>('GET', '/api/v1/operations')).body;
    expect(operations.some(item => item.status === 'conflict')).toBe(true);
  });

  it('reinitializes demo from actual state instead of resetting the displayed toggle', async () => {
    const first = await call<Catalog>('POST', '/api/v1/demo', {});
    expect(first.status).toBe(200);
    const binding = (first.body as Catalog).bindings.find(item => item.kind === 'mcp' && item.writable)!;
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash })).status).toBe(200);
    const second = await call<Catalog>('POST', '/api/v1/demo', {});
    expect(second.status).toBe(200);
    expect((second.body as Catalog).bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
  });

  it('retains registrations and scan results across server restart', async () => {
    const { instance, binding } = await writableCodex();
    await app.close();
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, demoDir: path.join(directory, 'demo') });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.instances.find(item => item.id === instance.id)?.writable).toBe(true);
    expect(catalog.bindings.find(item => item.id === binding.id)?.name).toBe('docs');
  });

  it('recovers a completed native write whose manager database commit was interrupted', async () => {
    const { binding } = await writableCodex();
    const original = await readFile(binding.sourcePath);
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    await app.close();
    const dataDir = path.join(directory, 'data');
    const store = createStore(dataDir);
    let operation: Operation;
    try {
      const prepared = store.getPlan(plan.id)!.privateData as PreparedChange;
      // Exercise the engine phase, then omit the manager commit to simulate this crash boundary.
      operation = (await applyPrepared(prepared, { dataDir })).operation;
      expect(store.getOperation(operation.id)).toBeNull();
      expect(store.getPlan(plan.id)?.dto.status).toBe('ready');
    } finally { store.close(); }
    app = createApp({ dataDir, homeDir: home, demoDir: path.join(directory, 'demo'), discoveryEnv: {} });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
    const operations = (await call<Operation[]>('GET', '/api/v1/operations')).body;
    expect(operations.find(item => item.id === operation!.id)?.status).toBe('succeeded');
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
    const replay = await call<Operation>('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(operation!.id);
    const restoration = await call<ChangePlan>('POST', `/api/v1/operations/${operation!.id}/restore-plan`, {});
    expect(restoration.status).toBe(201);
    expect((await call('POST', `/api/v1/plans/${restoration.body.id}/apply`, { digest: restoration.body.afterHash })).status).toBe(200);
    expect((await readFile(binding.sourcePath)).equals(original)).toBe(true);
  });

  it('delivers live catalog events over an authenticated SSE connection', async () => {
    let stream: import('node:http').IncomingMessage | undefined;
    let text = '';
    let notify: (() => void) | undefined;
    const connection = await new Promise<import('node:http').ClientRequest>((resolve, reject) => {
      const request = httpRequest(new URL('/api/v1/events', origin), { headers: { Origin: origin, Cookie: cookie } }, response => {
        stream = response;
        expect(response.statusCode).toBe(200);
        response.on('data', chunk => { text += chunk.toString(); notify?.(); });
        resolve(request);
      });
      request.on('error', reject);
      request.end();
    });
    try {
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE catalog event was not delivered')), 5000);
        notify = () => { if (text.includes('event: catalog.changed')) { clearTimeout(timer); resolve(); } };
        notify();
      });
      expect((await call('POST', '/api/v1/projects', { rootPath: path.join(directory, 'project') })).status).toBe(201);
      await received;
      expect(text).toMatch(/id: \d+/);
      expect(text).not.toContain('AGENTDECK_SECRET_SENTINEL');
    } finally {
      notify = undefined;
      stream?.destroy();
      connection.destroy();
    }
  });
});
