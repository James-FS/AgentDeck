import { z } from 'zod';

export const AGENT_IDS = ['codex', 'claude-code', 'zcode', 'deepseek-harness'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type ResourceKind = 'skill' | 'plugin' | 'mcp';
export const ConfigurationControlSchema = z.object({
  mode: z.enum(['independent', 'parent', 'none', 'unknown']),
  reason: z.string().min(1),
  visibility: z.enum(['on', 'name-only', 'user-invocable-only', 'off']).optional(),
});
export type ConfigurationControl = z.infer<typeof ConfigurationControlSchema>;
export type SkillScope = 'user-global' | 'project' | 'project-directory' | 'native';
export type SourceKind = 'user' | 'repository' | 'plugin' | 'builtin' | 'organization' | 'account-sync' | 'unknown';
export type CompatibilityClass = 'portable' | 'agent-specific' | 'conditional' | 'unknown';
export type DiscoveryKind = 'auto' | 'manual' | 'demo';
export type ClientCompatibilityStatus = 'verified-client' | 'executable-unverified' | 'configuration-only' | 'not-found' | 'demo';
export type CapabilityEvidenceArea = 'static-scan' | 'fixture-validation' | 'native-config';
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
  operations?: Array<'scan' | 'toggle' | 'restore'>;
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
  /** Distinguishes the current switch default / explicit read-only choice from legacy permissions. */
  togglePolicy?: 'default' | 'read-only';
  /** Tracks migration when additional adapters gain default switch support. */
  togglePolicyVersion?: 1;
  /** Read-only installation metadata, separate from the writable configuration root. */
  desktopResourceRoot?: string;
  checkedAt: string;
  diagnostics: string[];
  /** Optional for compatibility with older persisted instance JSON. */
  versionEvidence?: ClientVersionEvidence | null;
}

export interface Project { id: string; name: string; rootPath: string }

/** Inventory evidence is independent of native control scope and content compatibility. */
export type ResourceInventoryCategory = 'user-global' | 'project' | 'agent-global' | 'agent-project' | 'unknown';
export interface ResourceClassification {
  /** Resource binding classification; physical cache location may differ for project references. */
  category?: ResourceInventoryCategory;
  scope: 'user-global' | 'project' | 'project-directory' | 'unknown';
  agentId: string | null;
  /** AgentDeck reader identity; never evidence of native client loading or ownership. */
  discoveredByAgentId?: string;
  relationship: 'configured' | 'discovered' | 'unknown';
  projectName: string | null;
  projectRoot: string | null;
  evidencePath: string;
  sourceIdentity?: string;
  reason: string;
  /** Same physical source observed under multiple Agents; never inferred from its name. */
  sharedSource?: { path: string; agentIds: string[]; bindingIds: string[] };
  contentCompatibility: 'unknown';
  /** Inventory location is not the effective configuration or installation scope. */
  location?: {
    category: ResourceInventoryCategory;
    rootPath: string | null;
    evidencePath: string;
    reason: string;
  };
  installationEvidence?: { path: string; scope: 'user-global' | 'project' | 'unknown'; reason: string };
}

export interface Binding {
  /** Verified bundled file proving built-in origin; never a write target. */
  builtinSourcePath?: string;
  /** Absent on older indexes: rescan to obtain classification evidence. */
  classification?: ResourceClassification;
  id: string;
  resourceId: string;
  instanceId: string;
  projectId: string | null;
  kind: ResourceKind;
  name: string;
  description: string;
  /** Optional SKILL.md title for display; name remains the native configuration identity. */
  displayName?: string;
  /** Grouped Skill found on disk without verified client visibility. */
  discoveryOnly?: boolean;
  /** Relative path below the registered Skill root, for grouped inventory rows. */
  discoveryPath?: string;
  scope: SkillScope;
  sourceKind: SourceKind;
  compatibilityClass: CompatibilityClass;
  parentId: string | null;
  sourcePath: string;
  nativeKey: string;
  enabled: boolean | null;
  /** Static inventory rule or native setting evidence, never proof of session loading. */
  configurationStateReason?: string;
  /** Derived static toggle address; never accepted from a client request. */
  toggleTarget?: { agentId: 'zcode' | 'claude-code'; path: string[]; defaultEnabled: boolean }
    | { agentId: 'deepseek-harness'; kind: 'dsh-yaml'; configPath: string; id: string; name: string };
  /** Evidence of the switch mechanism, independent of whether it is currently enabled. */
  configurationControl?: ConfigurationControl;
  writable: boolean;
  readOnlyReason: string | null;
  diagnostics: string[];
  updatedAt: string;
  /** Optional provenance fields; older persisted Binding JSON remains valid. */
  origin?: 'configuration' | 'cache' | 'filesystem';
  pluginId?: string;
  pluginVersion?: string;
  /** True only when a cached manifest name exactly matches its package identity. */
  pluginIdentityVerified?: boolean;
  marketplace?: string;
  configurationSourcePath?: string;
  configurationKey?: string;
  configurationEnabled?: boolean | null;
  cacheState?: 'present' | 'missing' | 'unknown';
  mcpTransport?: 'stdio' | 'http' | 'unknown';
  controlScope?: CapabilityControlScope;
  /** Scanner evidence of a referenced service, separate from configuration scope/ownership. */
  mcpService?: { identity: string; kind: 'local-entry' | 'endpoint' | 'package'; location: string;
    packageName?: string; packageVersion?: string | null; launchMode?: string; packageEvidencePath?: string; entryPath?: string;
    configurationIdentity: string; evidencePath: string; reason: string };
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
const InventoryCategorySchema = z.enum(['user-global', 'project', 'agent-global', 'agent-project', 'unknown']);
export const ResourceClassificationSchema = z.object({
  scope: z.enum(['user-global', 'project', 'project-directory', 'unknown']),
  agentId: z.string().nullable(), discoveredByAgentId: z.string().optional(), relationship: z.enum(['configured', 'discovered', 'unknown']),
  projectName: z.string().nullable(), projectRoot: z.string().nullable(),
  evidencePath: z.string(), reason: z.string(), sourceIdentity: z.string().optional(),
  contentCompatibility: z.literal('unknown'), category: InventoryCategorySchema.optional(),
  location: z.object({ category: InventoryCategorySchema, rootPath: z.string().nullable(), evidencePath: z.string(), reason: z.string() }).optional(),
  installationEvidence: z.object({ path: z.string(), scope: z.enum(['user-global', 'project', 'unknown']), reason: z.string() }).optional(),
  sharedSource: z.object({ path: z.string(), agentIds: z.array(z.string()), bindingIds: z.array(z.string()) }).optional(),
});
export const RegisterInstanceSchema = z.object({
  agentId: z.string().min(1, '请选择客户端'),
  name: z.string().trim().min(1).max(120, '实例名称不能超过 120 个字符').optional(),
  configRoot: z.string().trim().min(1, '请填写配置根目录'),
  writable: z.boolean().optional().default(true),
});
export const RegisterProjectSchema = z.object({
  name: z.string().trim().min(1).max(160, '项目名称不能超过 160 个字符').optional(),
  rootPath: z.string().trim().min(1, '请填写项目根目录'),
});
export const ScanRequestSchema = z.object({
  discover: z.boolean().optional().default(false),
  discoverUserHome: z.boolean().optional().default(false),
  instanceId: z.string().optional(),
  projectId: z.string().optional(),
  scanRegisteredProjects: z.boolean().optional().default(false),
});
export const VersionCheckRequestSchema = z.object({}).strict();
export const CreatePlanSchema = z.object({ bindingId: z.string().min(1, '缺少资源绑定 ID'), enabled: z.boolean() });
export const ApplyPlanSchema = z.object({ digest: z.string().min(1, '需要提交计划摘要') });
export const BootstrapSchema = z.object({ ticket: z.string().min(1, '需要一次性启动票据') });

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
