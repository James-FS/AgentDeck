import { z } from 'zod';

export const AGENT_IDS = ['codex', 'claude-code', 'zcode', 'deepseek-harness'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type ResourceKind = 'skill' | 'plugin' | 'mcp';
export type SkillScope = 'user-global' | 'project' | 'project-directory' | 'native';
export type SourceKind = 'user' | 'repository' | 'plugin' | 'builtin' | 'organization' | 'account-sync' | 'unknown';
export type CompatibilityClass = 'portable' | 'agent-specific' | 'conditional' | 'unknown';
export type RuntimeState = 'unknown' | 'pending' | 'active' | 'inactive';
export type DiscoveryKind = 'auto' | 'manual' | 'demo';
export type ClientCompatibilityStatus = 'verified-client' | 'executable-unverified' | 'configuration-only' | 'not-found' | 'demo';
export type CapabilityEvidenceArea = 'static-scan' | 'fixture-validation' | 'native-config' | 'runtime';
export type CapabilityEvidenceStatus = 'verified' | 'partial' | 'unverified' | 'unsupported';
export type CapabilityControlScope = 'standalone-user-mcp' | 'user-config-skill' | 'local-marketplace-plugin';

export interface ExecutableIdentity {
  path: string;
  realPath: string;
  fileIdentity: string;
  checkedAt: string;
}

/** Persisted only after an exact CLI-specific version output signature is recognized. */
export interface ClientVersionEvidence {
  version: string;
  signature: 'codex-cli-version' | 'claude-code-version';
  executable: ExecutableIdentity;
  platform: string;
  checkedAt: string;
}

export interface CapabilityEvidence {
  area: CapabilityEvidenceArea;
  resourceKind: ResourceKind | null;
  scope: SkillScope | null;
  sourceKind?: SourceKind | null;
  controlScope?: CapabilityControlScope;
  mcpTransport?: 'stdio' | 'http' | 'unknown';
  operations?: Array<'scan' | 'toggle' | 'restore' | 'runtime-observation'>;
  status: CapabilityEvidenceStatus;
  readable: boolean;
  writable: boolean;
  reason: string;
  evidenceReference?: string;
  clientVersion?: string;
  platform?: string;
}

export interface ClientCompatibilityReport {
  id: string;
  agentId: string;
  agentName: string;
  instanceId: string | null;
  instanceName: string | null;
  configRoot: string | null;
  status: ClientCompatibilityStatus;
  configurationState: 'present' | 'missing';
  executableCandidate: ExecutableIdentity | null;
  versionEvidence: ClientVersionEvidence | null;
  capabilities: CapabilityEvidence[];
  checkedAt: string | null;
  diagnostics: string[];
}

export interface CompatibilityReport {
  generatedAt: string;
  clients: ClientCompatibilityReport[];
}

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
  /** Optional for compatibility with older persisted instance JSON. */
  versionEvidence?: ClientVersionEvidence | null;
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
  /** Optional provenance fields; older persisted Binding JSON remains valid. */
  origin?: 'configuration' | 'cache' | 'filesystem';
  pluginId?: string;
  pluginVersion?: string;
  marketplace?: string;
  configurationSourcePath?: string;
  configurationKey?: string;
  configurationEnabled?: boolean | null;
  cacheState?: 'present' | 'missing' | 'unknown';
  mcpTransport?: 'stdio' | 'http' | 'unknown';
  controlScope?: CapabilityControlScope;
}

export interface Catalog {
  instances: AgentInstance[];
  projects: Project[];
  bindings: Binding[];
  lastScanAt: string | null;
}

/** A read-only assessment of evidence available to this manager, not a client probe. */
export interface RuntimeObservation {
  bindingId: string;
  instanceId: string;
  kind: ResourceKind;
  configurationEnabled: boolean | null;
  indexUpdatedAt: string;
  sessionLoad: 'not-checked' | 'not-applicable';
  mcpConnection: 'not-checked' | 'not-applicable';
  clientSessionId: null;
  evidenceSource: null;
  observedAt: null;
  reason: string;
}

export interface RuntimeReport {
  assessedAt: string;
  observations: RuntimeObservation[];
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
  discoverUserHome: z.boolean().optional().default(false),
  instanceId: z.string().optional(),
  projectId: z.string().optional(),
});
export const VersionCheckRequestSchema = z.object({}).strict();
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
