import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_PREFIX, ApplyPlanSchema, BootstrapSchema, CreatePlanSchema,
  RegisterInstanceSchema, RegisterProjectSchema, ScanRequestSchema,
  type AgentAdapter, type ApiError, type ChangePlan,
  type Operation, type SseEvent,
} from '@agentdeck/contracts';
import { ManagerError, ManagerService } from '@agentdeck/core';
import { createStore, type AgentDeckStore } from '@agentdeck/storage';
import { createAdapterRegistry } from '@agentdeck/adapters';
import * as defaultChangeEngine from '@agentdeck/change-engine';

type PreparedChange = { plan: ChangePlan; private: unknown };
type ApplyResult = { plan: ChangePlan; operation: Operation; journalPath?: string; snapshotPath?: string };
export interface ChangeEngine {
  prepareToggle(input: { configPath: string; serverName: string; enabled: boolean; now?: Date; ttlMs?: number }): Promise<PreparedChange> | PreparedChange;
  applyPrepared(prepared: PreparedChange, options: { dataDir: string; now?: Date }): Promise<ApplyResult> | ApplyResult;
  prepareRestore(input: { operationId: string; dataDir: string; now?: Date; ttlMs?: number }): Promise<PreparedChange> | PreparedChange;
  recoverIncomplete?(input: { dataDir: string }): Promise<RecoveryReport> | RecoveryReport;
}

interface RecoveryReport {
  items?: Array<{ status?: string; operation?: Operation }>;
  /** Kept as a compatible shape for engines that return verified records separately. */
  operations?: Operation[];
  diagnostics?: string[];
}

export interface AppOptions {
  dataDir?: string;
  homeDir?: string;
  userHomeDir?: string;
  userDiscoveryEnv?: NodeJS.ProcessEnv;
  demoDir?: string;
  adapterRegistry?: AgentAdapter[] | { createAdapterRegistry(): AgentAdapter[] };
  adapters?: AgentAdapter[];
  discoveryEnv?: NodeJS.ProcessEnv;
  store?: AgentDeckStore;
  changeEngine?: ChangeEngine;
  fixtures?: unknown;
  allowedOrigins?: string[];
  staticDir?: string;
  port?: number;
  devMode?: boolean;
  now?: () => Date;
  closeStoreOnClose?: boolean;
  logger?: boolean;
}

interface BootstrapTicket { expiresAt: number }
interface LocalSession { csrfToken: string; expiresAt: number }
declare module 'fastify' {
  interface FastifyInstance {
    agentdeckAuth: { issueBootstrapTicket(): string };
    agentdeckEvents: { publish<T>(event: Omit<SseEvent<T>, 'id' | 'timestamp' | 'revision'> & Partial<Pick<SseEvent<T>, 'id' | 'timestamp' | 'revision'>>): SseEvent<T> };
  }
}

const COOKIE_NAME = 'agentdeck_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 2 * 60 * 1000;
const API = API_PREFIX;

export function createApp(options: AppOptions = {}): FastifyInstance {
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir());
  const homeDir = path.resolve(options.homeDir ?? defaultHomeDir());
  mkdirSync(dataDir, { recursive: true });
  const store = options.store ?? createStore(dataDir);
  const registry = resolveRegistry(options.adapterRegistry ?? options.adapters);
  const demoDir = options.demoDir ?? (process.env.AGENTDECK_HOME ? path.join(dataDir, 'demo') : path.join(workspaceRoot(), 'work', 'demo'));
  const discoveryEnv = options.discoveryEnv ?? (options.homeDir !== undefined ? {} : process.env);
  const manager = new ManagerService({ store, adapters: registry, homeDir, demoDir, env: discoveryEnv, ...(options.now ? { now: options.now } : {}) });
  const engine = options.changeEngine ?? defaultChangeEngine as unknown as ChangeEngine;
  const app = Fastify({ logger: options.logger ?? false, genReqId: () => randomUUID() });
  const tickets = new Map<string, BootstrapTicket>();
  const sessions = new Map<string, LocalSession>();
  const listeners = new Set<(event: SseEvent) => void>();
  const streamResponses = new Set<import('node:http').ServerResponse>();
  let revision = Number(store.getMetadata('eventRevision') ?? 0);
  let resolvedPort = options.port ?? 0;

  app.decorate('agentdeckAuth', {
    issueBootstrapTicket(): string {
      const now = Date.now();
      for (const [oldTicket, record] of tickets) if (record.expiresAt < now) tickets.delete(oldTicket);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { expiresAt: now + BOOTSTRAP_TTL_MS });
      return ticket;
    },
  });
  app.decorate('agentdeckEvents', {
    publish<T>(partial: Omit<SseEvent<T>, 'id' | 'timestamp' | 'revision'> & Partial<Pick<SseEvent<T>, 'id' | 'timestamp' | 'revision'>>): SseEvent<T> {
      revision += 1;
      const event = { ...partial, id: partial.id ?? String(revision), timestamp: partial.timestamp ?? new Date().toISOString(), revision } as SseEvent<T>;
      store.setMetadata('eventRevision', String(revision));
      store.saveEvent(event.id, event);
      for (const listener of listeners) listener(event as SseEvent);
      return event;
    },
  });

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  if (options.allowedOrigins === undefined && options.devMode === true) {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }

  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    const actualPort = address && typeof address !== 'string' ? address.port : resolvedPort;
    if (actualPort) resolvedPort = actualPort;
    if (!isLoopbackRequest(request, resolvedPort)) {
      return sendError(reply, 403, 'LOOPBACK_ONLY', 'AgentDeck accepts requests only from its local service address.', request.id);
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowed(origin, allowedOrigins, resolvedPort)) {
      return sendError(reply, 403, 'ORIGIN_REJECTED', 'This browser origin is not allowed to access the local service.', request.id);
    }
    if (request.url === '/health' || request.url.startsWith('/health?') || request.url === `${API}/session/bootstrap`) return;
    if (!request.url.startsWith(API)) return;
    reply.header('Cache-Control', 'no-store');
    const sessionId = readCookie(request.headers.cookie, COOKIE_NAME);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      if (sessionId) sessions.delete(sessionId);
      return sendError(reply, 401, 'AUTH_REQUIRED', 'Connect this browser to the local AgentDeck service first.', request.id);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf !== session.csrfToken) {
        return sendError(reply, 403, 'CSRF_REJECTED', 'The request is missing a valid local-session CSRF token.', request.id);
      }
    }
  });

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.post(`${API}/session/bootstrap`, async (request, reply) => {
    const parsed = BootstrapSchema.safeParse(request.body);
    if (!parsed.success) throw new ManagerError(400, 'INVALID_REQUEST', 'A valid one-time bootstrap ticket is required.');
    const ticket = parsed.data.ticket;
    const record = tickets.get(ticket);
    tickets.delete(ticket);
    if (!record || record.expiresAt < Date.now()) throw new ManagerError(401, 'BOOTSTRAP_EXPIRED', 'The local startup ticket is invalid or expired.');
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    sessions.set(sessionId, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    reply.header('Set-Cookie', `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    reply.header('Cache-Control', 'no-store');
    return { csrfToken };
  });
  app.get(`${API}/session`, async (request) => {
    const sessionId = readCookie(request.headers.cookie, COOKIE_NAME)!;
    return { csrfToken: sessions.get(sessionId)!.csrfToken };
  });

  app.get(`${API}/adapters`, async () => manager.adapterInfos());
  app.get(`${API}/catalog`, async () => manager.catalog());
  app.post(`${API}/instances`, async (request, reply) => {
    const input = RegisterInstanceSchema.safeParse(request.body);
    if (!input.success) throw new ManagerError(400, 'INVALID_REQUEST', input.error.issues[0]?.message ?? 'Invalid instance registration.');
    const result = manager.registerInstance({
      agentId: input.data.agentId,
      configRoot: input.data.configRoot,
      writable: input.data.writable,
      ...(input.data.name === undefined ? {} : { name: input.data.name }),
    });
    reply.code(201);
    app.agentdeckEvents.publish({ type: 'catalog.changed', payload: { kind: 'instance', id: result.id } });
    return result;
  });
  app.post(`${API}/projects`, async (request, reply) => {
    const input = RegisterProjectSchema.safeParse(request.body);
    if (!input.success) throw new ManagerError(400, 'INVALID_REQUEST', input.error.issues[0]?.message ?? 'Invalid project registration.');
    const result = manager.registerProject({
      rootPath: input.data.rootPath,
      ...(input.data.name === undefined ? {} : { name: input.data.name }),
    });
    reply.code(201);
    app.agentdeckEvents.publish({ type: 'catalog.changed', payload: { kind: 'project', id: result.id } });
    return result;
  });
  app.post(`${API}/scans`, async (request) => {
    const input = ScanRequestSchema.safeParse(request.body ?? {});
    if (!input.success) throw new ManagerError(400, 'INVALID_REQUEST', 'Invalid scan request.');
    const catalog = await manager.scan({
      discover: input.data.discover || input.data.discoverUserHome,
      ...(input.data.discoverUserHome ? { discoveryContext: {
        homeDir: path.resolve(options.userHomeDir ?? options.homeDir ?? process.env.AGENTDECK_USER_HOME ?? process.env.USER_HOME ?? os.homedir()),
        env: options.userDiscoveryEnv ?? options.discoveryEnv ?? process.env,
      } } : {}),
      ...(input.data.instanceId === undefined ? {} : { instanceId: input.data.instanceId }),
      ...(input.data.projectId === undefined ? {} : { projectId: input.data.projectId }),
    });
    app.agentdeckEvents.publish({ type: 'catalog.changed', payload: { kind: 'scan', lastScanAt: catalog.lastScanAt } });
    return catalog;
  });
  app.post(`${API}/demo`, async (_request, reply) => {
    const catalog = await manager.initializeDemo();
    reply.code(200);
    app.agentdeckEvents.publish({ type: 'catalog.changed', payload: { kind: 'demo' } });
    return catalog;
  });

  app.post(`${API}/plans`, async (request, reply) => {
    const input = CreatePlanSchema.safeParse(request.body);
    if (!input.success) throw new ManagerError(400, 'INVALID_REQUEST', 'A binding ID and desired enabled state are required.');
    const binding = store.getBinding(input.data.bindingId);
    if (!binding) throw new ManagerError(404, 'BINDING_NOT_FOUND', 'The selected resource binding no longer exists.');
    const instance = store.getInstance(binding.instanceId);
    if (!instance || binding.kind !== 'mcp' || instance.agentId !== 'codex') throw new ManagerError(403, 'UNSUPPORTED_OPERATION', 'Only a Codex MCP binding can be changed in this release.');
    const isolatedDemo = instance.discovery === 'demo' && isWithin(binding.sourcePath, manager.demoDir);
    if (!isolatedDemo && (instance.discovery !== 'manual' || !instance.writable || !binding.writable)) {
      throw new ManagerError(403, 'POLICY_LOCKED', binding.readOnlyReason ?? 'Write access requires an explicitly registered writable Codex instance.');
    }
    if (!isWithin(binding.sourcePath, instance.configRoot)) throw new ManagerError(403, 'PATH_OUTSIDE_SCOPE', 'The binding file is outside the registered Codex configuration root.');
    let enginePlan: PreparedChange;
    try {
      enginePlan = await engine.prepareToggle({ configPath: binding.sourcePath, serverName: binding.name, enabled: input.data.enabled, ...(options.now ? { now: options.now() } : {}) });
    } catch (error) {
      const mapped = sanitizedEngineError(error);
      throw new ManagerError(mapped.status, mapped.code, mapped.message);
    }
    const plan: ChangePlan = { ...enginePlan.plan, instanceId: instance.id, bindingId: binding.id, status: 'ready' };
    store.putPlan({ dto: plan, privateData: enginePlan });
    reply.code(201);
    return plan;
  });
  app.post(`${API}/plans/:id/apply`, async (request) => {
    const { id } = request.params as { id: string };
    const input = ApplyPlanSchema.safeParse(request.body);
    if (!input.success) throw new ManagerError(400, 'INVALID_REQUEST', 'The plan digest is required.');
    const stored = store.getPlan(id);
    if (!stored) throw new ManagerError(404, 'PLAN_NOT_FOUND', 'The change plan does not exist.');
    if (input.data.digest !== stored.dto.afterHash) throw new ManagerError(409, 'PLAN_DIGEST_MISMATCH', 'The submitted plan digest does not match the reviewed plan.');
    if (stored.dto.status === 'applied') {
      const previous = store.listOperations().find(operation => operation.planId === id);
      if (previous) return previous;
    }
    if (stored.dto.expiresAt && Date.parse(stored.dto.expiresAt) < Date.now()) {
      store.updatePlanStatus(id, 'expired');
      throw new ManagerError(410, 'PLAN_EXPIRED', 'The change plan expired; create a new plan from the current configuration.');
    }
    let applied: ApplyResult;
    const priorBinding = store.getBinding(stored.dto.bindingId);
    try {
      applied = await engine.applyPrepared(stored.privateData as PreparedChange, { dataDir, ...(options.now ? { now: options.now() } : {}) });
    } catch (error) {
      if (isConflict(error)) {
        const operation = conflictOperation(stored.dto, sanitizedEngineError(error).message, options.now?.() ?? new Date());
        store.putOperation(operation);
        const mapped = sanitizedEngineError(error);
        throw new ManagerError(mapped.status, mapped.code, operation.error ?? mapped.message);
      }
      const mapped = sanitizedEngineError(error);
      if (mapped.code !== 'INTERNAL_ERROR') throw new ManagerError(mapped.status, mapped.code, mapped.message);
      throw error;
    }
    const plan = { ...applied.plan, instanceId: stored.dto.instanceId, bindingId: stored.dto.bindingId, status: 'applied' as const };
    const fullPrepared = stored.privateData as PreparedChange;
    store.putPlan({ dto: plan, privateData: { ...fullPrepared, plan } });
    store.putOperation(applied.operation);
    await manager.scan({ instanceId: plan.instanceId, ...(priorBinding?.projectId ? { projectId: priorBinding.projectId } : {}) });
    const refreshedBinding = store.getBinding(plan.bindingId);
    if (refreshedBinding && plan.desiredEnabled !== null) {
      store.putBinding({ ...refreshedBinding, enabled: plan.desiredEnabled, runtime: 'pending', updatedAt: (options.now?.() ?? new Date()).toISOString() });
    }
    app.agentdeckEvents.publish({ type: 'operation.completed', operationId: applied.operation.id, instanceId: plan.instanceId, payload: { operation: applied.operation } });
    app.agentdeckEvents.publish({ type: 'catalog.changed', instanceId: plan.instanceId, payload: { kind: 'operation', operationId: applied.operation.id } });
    return applied.operation;
  });
  app.get(`${API}/operations`, async () => store.listOperations());
  app.post(`${API}/operations/:id/restore-plan`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getOperation(id)) throw new ManagerError(404, 'OPERATION_NOT_FOUND', 'The selected operation does not exist.');
    let prepared: PreparedChange;
    const operation = store.getOperation(id)!;
    const originalPlan = store.getPlan(operation.planId);
    if (!originalPlan) throw new ManagerError(409, 'RECOVERY_CONFLICT', 'The original plan metadata is unavailable for recovery.');
    try {
      prepared = await engine.prepareRestore({ operationId: id, dataDir, ...(options.now ? { now: options.now() } : {}) });
    } catch (error) {
      const mapped = sanitizedEngineError(error);
      throw new ManagerError(mapped.status, mapped.code, mapped.message);
    }
    const plan = {
      ...prepared.plan,
      instanceId: originalPlan.dto.instanceId,
      bindingId: originalPlan.dto.bindingId,
      status: 'ready' as const,
    };
    store.putPlan({ dto: plan, privateData: { ...prepared, plan } });
    reply.code(201);
    return plan;
  });

  app.get(`${API}/events`, async (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n: connected\n\n');
    streamResponses.add(raw);
    const after = Number(request.headers['last-event-id'] ?? 0);
    for (const record of store.listEvents(Number.isFinite(after) ? after : 0)) writeEvent(raw, record.event as SseEvent);
    const listener = (event: SseEvent) => writeEvent(raw, event);
    listeners.add(listener);
    const heartbeat = setInterval(() => { if (!raw.destroyed) raw.write(': keep-alive\n\n'); }, 20_000);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      listeners.delete(listener);
      streamResponses.delete(raw);
    };
    raw.on('close', cleanup);
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const managerError = error instanceof ManagerError ? error : null;
    const status = managerError?.statusCode ?? (Number.isInteger((error as { statusCode?: number }).statusCode) ? (error as { statusCode: number }).statusCode : 500);
    const code = managerError?.code ?? (status === 400 ? 'INVALID_REQUEST' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');
    const message = managerError?.message ?? 'The local service could not complete this request.';
    sendError(reply, status, code, message, request.id);
  });

  const staticDir = options.staticDir ?? path.join(workspaceRoot(), 'apps', 'web', 'dist');
  if (existsSync(staticDir)) {
    void app.register(fastifyStatic, { root: staticDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith(API)) return sendError(reply, 404, 'NOT_FOUND', 'The requested API route does not exist.', request.id);
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith(API)) return sendError(reply, 404, 'NOT_FOUND', 'The requested API route does not exist.', request.id);
      return reply.type('text/html').send('<!doctype html><html><body><h1>AgentDeck</h1><p>The web application has not been built yet. Run <code>pnpm dev</code> in development.</p></body></html>');
    });
  }

  app.addHook('onClose', async () => {
    if (options.closeStoreOnClose !== false && !options.store) store.close();
    listeners.clear();
  });
  app.addHook('preClose', async () => {
    for (const response of streamResponses) response.end();
    streamResponses.clear();
    listeners.clear();
  });
  app.addHook('onReady', async () => {
    const address = app.server.address();
    if (address && typeof address !== 'string') resolvedPort = address.port;
    if (engine.recoverIncomplete) {
      try {
        const report = await engine.recoverIncomplete({ dataDir });
        const verifiedOperations = [
          ...(report.items ?? []).filter(item => item.status === 'completed' && item.operation).map(item => item.operation!),
          ...(report.operations ?? []),
        ].filter(isVerifiedRecoveredOperation);
        for (const operation of verifiedOperations) {
          const originalPlan = store.getPlan(operation.planId);
          if (!originalPlan) continue;
          const missingFromManagerStore = store.getOperation(operation.id) === null;
          if (missingFromManagerStore) {
            store.putOperation(operation);
          }
          store.updatePlanStatus(operation.planId, 'applied');
          if (!missingFromManagerStore) continue;

          const instance = store.getInstance(originalPlan.dto.instanceId);
          if (!instance) continue;
          const priorBinding = store.getBinding(originalPlan.dto.bindingId);
          await manager.scan({
            instanceId: instance.id,
            ...(priorBinding?.projectId ? { projectId: priorBinding.projectId } : {}),
          });
          const refreshedBinding = store.getBinding(originalPlan.dto.bindingId);
          if (refreshedBinding && originalPlan.dto.desiredEnabled !== null) {
            store.putBinding({
              ...refreshedBinding,
              enabled: originalPlan.dto.desiredEnabled,
              runtime: 'pending',
              updatedAt: (options.now?.() ?? new Date()).toISOString(),
            });
          }
          app.agentdeckEvents.publish({ type: 'operation.completed', operationId: operation.id, instanceId: instance.id, payload: { operation } });
          app.agentdeckEvents.publish({ type: 'catalog.changed', instanceId: instance.id, payload: { kind: 'operation-recovered', operationId: operation.id } });
        }
        store.setMetadata('lastRecoveryReport', JSON.stringify(report));
        const needsReviewCount = (report.items ?? []).filter(item => item.status === 'conflict' || item.status === 'ignored').length;
        if (needsReviewCount > 0) {
          app.agentdeckEvents.publish({ type: 'catalog.changed', payload: { kind: 'recovery-review-required', itemCount: needsReviewCount } });
        }
      } catch {
        // A failed journal audit does not mutate client files; keep a generic local status for diagnosis.
        store.setMetadata('lastRecoveryReport', JSON.stringify({ status: 'failed', message: 'Startup recovery audit failed.' }));
      }
    }
  });
  return app;
}

function isVerifiedRecoveredOperation(operation: Operation): boolean {
  return Boolean(operation && typeof operation.id === 'string' && operation.id.length > 0
    && typeof operation.planId === 'string' && operation.planId.length > 0
    && operation.status === 'succeeded'
    && (operation.kind === 'toggle' || operation.kind === 'restore')
    && typeof operation.targetPath === 'string'
    && typeof operation.createdAt === 'string');
}

export function issueBootstrapTicket(app: FastifyInstance): string { return app.agentdeckAuth.issueBootstrapTicket(); }

export async function startLocalServer(app: FastifyInstance, port = Number(process.env.PORT ?? 4780)): Promise<string> {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  const ticket = issueBootstrapTicket(app);
  const url = `http://127.0.0.1:${actualPort}/#ticket=${ticket}`;
  process.stdout.write(`AgentDeck is listening locally. Open ${url}\n`);
  const isDevelopment = process.env.NODE_ENV === 'development';
  if (isDevelopment) process.stdout.write(`Vite UI: http://127.0.0.1:5173/#ticket=${ticket}\n`);
  return url;
}

function resolveRegistry(input: AppOptions['adapterRegistry'] | AppOptions['adapters']): AgentAdapter[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input.createAdapterRegistry === 'function') return input.createAdapterRegistry();
  return createAdapterRegistry();
}
function defaultDataDir(): string {
  if (process.env.AGENTDECK_HOME) return path.resolve(process.env.AGENTDECK_HOME);
  if (process.env.NODE_ENV !== 'production') return path.join(workspaceRoot(), 'work', 'dev-data');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'AgentDeck');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AgentDeck');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'agentdeck');
}
function defaultHomeDir(): string {
  if (process.env.USER_HOME) return path.resolve(process.env.USER_HOME);
  if (process.env.AGENTDECK_USER_HOME) return path.resolve(process.env.AGENTDECK_USER_HOME);
  if (process.env.NODE_ENV !== 'production') return path.resolve(process.env.AGENTDECK_DEV_HOME ?? path.join(workspaceRoot(), 'work', 'dev-data', 'home'));
  return os.homedir();
}
function workspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
function readCookie(header: string | undefined, name: string): string | null {
  for (const item of (header ?? '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return value.join('=') || null;
  }
  return null;
}
function sendError(reply: { code(status: number): unknown; send(payload: unknown): unknown }, status: number, code: string, message: string, requestId?: string): unknown {
  const body: ApiError = { error: { code, message, ...(requestId ? { requestId } : {}) } };
  // Fastify Reply is structurally compatible; set the status separately to keep this helper testable.
  return (reply as unknown as { code(statusCode: number): { send(payload: unknown): unknown } }).code(status).send(body);
}
function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function isLoopbackRequest(request: FastifyRequest, port: number): boolean {
  const remote = request.raw.socket.remoteAddress;
  // Fastify.inject has no TCP peer; it cannot be reached from a browser or the network.
  if (!remote) return true;
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const host = request.headers.host?.toLowerCase() ?? '';
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return loopback && allowed.has(host);
}
function originAllowed(origin: string, configured: Set<string>, port: number): boolean {
  if (configured.has(origin)) return true;
  if (!port) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}
function writeEvent(raw: import('node:http').ServerResponse, event: SseEvent): void {
  if (raw.destroyed) return;
  raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function isConflict(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'CONFIG_CHANGED' || code === 'PATH_CHANGED' || code === 'RECOVERY_CONFLICT' || code === 'LOCKED';
}
function conflictOperation(plan: ChangePlan, errorMessage: string, now: Date): Operation {
  return {
    id: randomUUID(), planId: plan.id, status: 'conflict', kind: plan.action,
    targetPath: plan.targetPath, createdAt: now.toISOString(),
    error: errorMessage, backupId: null,
  };
}
function sanitizedEngineError(error: unknown): { status: number; code: string; message: string } {
  const value = error as { code?: unknown; safeMessage?: unknown; message?: unknown };
  const code = typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR';
  const message = typeof value?.safeMessage === 'string' ? value.safeMessage : 'The change could not be completed safely.';
  const statuses: Record<string, number> = {
    CONFIG_CHANGED: 409, PATH_CHANGED: 409, RECOVERY_CONFLICT: 409, LOCKED: 409,
    PLAN_EXPIRED: 410, AMBIGUOUS_TARGET: 422, INVALID_CONFIG: 422, IO_ERROR: 500,
  };
  return { status: statuses[code] ?? 500, code: statuses[code] ? code : 'INTERNAL_ERROR', message };
}
