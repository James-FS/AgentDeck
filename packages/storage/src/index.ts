import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentInstance, Binding, Catalog, ChangePlan, Operation, Project } from '@agentdeck/contracts';

export interface StoredPlan { dto: ChangePlan; privateData: unknown }

export class AgentDeckStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bindings_instance_id ON bindings(instance_id);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL, private_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
    `);
  }

  catalog(): Catalog {
    return {
      instances: (this.db.prepare('SELECT json FROM instances ORDER BY rowid').all() as Array<{ json: string }>).map(row => parse<AgentInstance>(row.json)),
      projects: (this.db.prepare('SELECT json FROM projects ORDER BY rowid').all() as Array<{ json: string }>).map(row => parse<Project>(row.json)),
      bindings: (this.db.prepare('SELECT json FROM bindings ORDER BY rowid').all() as Array<{ json: string }>).map(row => parse<Binding>(row.json)),
      lastScanAt: this.getMetadata('lastScanAt'),
    };
  }

  getMetadata(key: string): string | null {
    return (this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMetadata(key: string, value: string): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  getInstance(id: string): AgentInstance | null {
    const row = this.db.prepare('SELECT json FROM instances WHERE id=?').get(id) as { json: string } | undefined;
    return row ? parse<AgentInstance>(row.json) : null;
  }
  putInstance(value: AgentInstance): void {
    this.db.prepare('INSERT INTO instances(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, JSON.stringify(value));
  }
  putProject(value: Project): void {
    this.db.prepare('INSERT INTO projects(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, JSON.stringify(value));
  }
  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT json FROM projects WHERE id=?').get(id) as { json: string } | undefined;
    return row ? parse<Project>(row.json) : null;
  }
  replaceBindings(instanceId: string, values: Binding[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM bindings WHERE instance_id=?').run(instanceId);
      const insert = this.db.prepare('INSERT INTO bindings(id,instance_id,json) VALUES(?,?,?)');
      for (const value of values) insert.run(value.id, instanceId, JSON.stringify(value));
    });
    tx();
  }
  putBinding(value: Binding): void {
    this.db.prepare('INSERT INTO bindings(id,instance_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id,json=excluded.json').run(value.id, value.instanceId, JSON.stringify(value));
  }
  getBinding(id: string): Binding | null {
    const row = this.db.prepare('SELECT json FROM bindings WHERE id=?').get(id) as { json: string } | undefined;
    return row ? parse<Binding>(row.json) : null;
  }
  putPlan(plan: StoredPlan): void {
    this.db.prepare('INSERT INTO plans(id,status,json,private_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json,private_json=excluded.private_json')
      .run(plan.dto.id, plan.dto.status, JSON.stringify(plan.dto), JSON.stringify(encodePrivate(plan.privateData)));
  }
  getPlan(id: string): StoredPlan | null {
    const row = this.db.prepare('SELECT json,private_json FROM plans WHERE id=?').get(id) as { json: string; private_json: string } | undefined;
    return row ? { dto: parse<ChangePlan>(row.json), privateData: decodePrivate(JSON.parse(row.private_json) as unknown) } : null;
  }
  updatePlanStatus(id: string, status: ChangePlan['status']): void {
    const current = this.getPlan(id);
    if (!current) return;
    current.dto.status = status;
    this.putPlan(current);
  }
  putOperation(value: Operation): void {
    this.db.prepare('INSERT INTO operations(id,plan_id,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id, value.planId, JSON.stringify(value));
  }
  getOperation(id: string): Operation | null {
    const row = this.db.prepare('SELECT json FROM operations WHERE id=?').get(id) as { json: string } | undefined;
    return row ? parse<Operation>(row.json) : null;
  }
  listOperations(): Operation[] {
    return (this.db.prepare('SELECT json FROM operations ORDER BY rowid DESC').all() as Array<{ json: string }>).map(row => parse<Operation>(row.json));
  }
  saveEvent(id: string, event: unknown): number {
    const result = this.db.prepare('INSERT OR IGNORE INTO events(id,json) VALUES(?,?)').run(id, JSON.stringify(event));
    if (result.changes === 0) return Number((this.db.prepare('SELECT seq FROM events WHERE id=?').get(id) as { seq: number }).seq);
    return Number(result.lastInsertRowid);
  }
  listEvents(after = 0, limit = 500): Array<{ seq: number; event: unknown }> {
    return (this.db.prepare('SELECT seq,json FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit) as Array<{ seq: number; json: string }>)
      .map(row => ({ seq: Number(row.seq), event: JSON.parse(row.json as string) as unknown }));
  }
  close(): void { this.db.close(); }
}

function parse<T>(json: unknown): T { return JSON.parse(String(json)) as T; }

function encodePrivate(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $agentdeckBuffer: value.toString('base64') };
  if (Array.isArray(value)) return value.map(encodePrivate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodePrivate(item)]));
  return value;
}
function decodePrivate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePrivate);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.$agentdeckBuffer === 'string' && Object.keys(record).length === 1) return Buffer.from(record.$agentdeckBuffer, 'base64');
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodePrivate(item)]));
  }
  return value;
}

export function createStore(dataDir: string): AgentDeckStore {
  return new AgentDeckStore(`${dataDir.replace(/[\\/]$/, '')}/state.sqlite`);
}
