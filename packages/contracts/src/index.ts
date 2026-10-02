import { z } from 'zod';

export const AGENT_IDS = ['codex', 'claude-code', 'zcode', 'deepseek-harness'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type ResourceKind = 'skill' | 'plugin' | 'mcp';
export type SkillScope = 'user-global' | 'project' | 'project-directory' | 'native';
export type SourceKind = 'user' | 'repository' | 'plugin' | 'builtin' | 'organization' | 'account-sync' | 'unknown';
export type CompatibilityClass = 'portable' | 'agent-specific' | 'conditional' | 'unknown';
export type RuntimeState = 'unknown' | 'pending' | 'active' | 'inactive';
export type DiscoveryKind = 'auto' | 'manual' | 'demo';

export interface AgentInstance {
  id: string;
  agentId: string;
  name: string;
  configRoot: string;
  version: string | null;
  executable: string | null;
  discovery: DiscoveryKind;
  writable: boolean;
  checkedAt: string;
  diagnostics: string[];
}

export interface Project { id: string; name: string; rootPath: string }

export interface Binding {
  id: string;
  resourceId: string;
  instanceId: string;
  projectId: string | null;
  kind: ResourceKind;
  name: string;
  description: string;
  scope: SkillScope;
  sourceKind: SourceKind;
  compatibilityClass: CompatibilityClass;
  parentId: string | null;
  sourcePath: string;
  nativeKey: string;
  enabled: boolean | null;
  runtime: RuntimeState;
  writable: boolean;
  readOnlyReason: string | null;
  diagnostics: string[];
  updatedAt: string;
}

export interface Catalog {
  instances: AgentInstance[];
  projects: Project[];
  bindings: Binding[];
  lastScanAt: string | null;
}

export interface AdapterInfo {
  id: string;
  name: string;
  description: string;
  supportedKinds: ResourceKind[];
  writeSupport: string[];
}

export interface ScanContext { instance: AgentInstance; project?: Project }
export interface ScanReport { bindings: Binding[]; diagnostics: string[] }
export interface ChangeRequest { bindingId: string; enabled: boolean }

export type ChangePlanStatus = 'ready' | 'applied' | 'expired';
export interface ChangePlan {
  id: string;
  instanceId: string;
  bindingId: string;
  action: 'toggle' | 'restore';
  targetPath: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  desiredEnabled: boolean | null;
  createdAt: string;
  expiresAt: string;
  restoreOf?: string;
  status: ChangePlanStatus;
}

export interface Operation {
  id: string;
  planId: string;
  status: 'succeeded' | 'failed' | 'conflict';
  kind: 'toggle' | 'restore';
  targetPath: string;
  createdAt: string;
  error: string | null;
  backupId: string | null;
}

export interface ApiError { error: { code: string; message: string; requestId?: string } }

export interface AgentAdapter {
  id: string;
  name: string;
  info: AdapterInfo;
  discover(context: { homeDir: string; env: NodeJS.ProcessEnv }): Promise<AgentInstance[]>;
  scan(context: ScanContext): Promise<ScanReport>;
}

export const AgentIdSchema = z.enum(AGENT_IDS);
export const RegisterInstanceSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  configRoot: z.string().trim().min(1),
  writable: z.boolean().optional().default(false),
});
export const RegisterProjectSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  rootPath: z.string().trim().min(1),
});
export const ScanRequestSchema = z.object({
  discover: z.boolean().optional().default(false),
  instanceId: z.string().optional(),
  projectId: z.string().optional(),
});
export const CreatePlanSchema = z.object({ bindingId: z.string().min(1), enabled: z.boolean() });
export const ApplyPlanSchema = z.object({ digest: z.string().min(1) });
export const BootstrapSchema = z.object({ ticket: z.string().min(1) });

export interface SessionResponse { csrfToken: string }
export interface SseEvent<T = unknown> {
  id: string;
  type: string;
  operationId?: string;
  instanceId?: string;
  revision: number;
  timestamp: string;
  payload: T;
}

export const API_PREFIX = '/api/v1';
