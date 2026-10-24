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
  /** User home associated with this configuration root; persisted independently of discovery IDs. */
  userHomeDir?: string;
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
  /** Exact scan root and physical root observed by the adapter; authorizes read-only Skill details. */
  skillRootPath?: string;
  skillRootRealPath?: string;
}

export const ScanOutcomeSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed']),
  completedAt: z.string(),
  succeeded: z.number().int().nonnegative(),
  failures: z.array(z.object({
    agentId: z.string(),
    instanceId: z.string().nullable(),
    projectId: z.string().nullable(),
    stage: z.enum(['discovery', 'scan']),
    message: z.string(),
  })),
});
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;

export interface Catalog {
  instances: AgentInstance[];
  projects: Project[];
  bindings: Binding[];
  lastScanAt: string | null;
  /** Latest attempt, including failures; lastScanAt only advances after a fully successful attempt. */
  lastScan?: ScanOutcome | null;
  skillSources?: SkillSource[];
  bindingChanges?: BindingChangeSet[];
}
export interface BindingChangeSet {
  id: string;
  scannedAt: string;
  instanceId: string;
  projectId: string | null;
  baseline: boolean;
  partial: boolean;
  truncated: boolean;
  totals: { added: number; removed: number; statusChanged: number };
  added: BindingChangeItem[];
  removed: BindingChangeItem[];
  statusChanged: BindingChangeItem[];
}
export interface BindingChangeItem { id: string; name: string; path: string; kind: ResourceKind; before?: string | null; after?: string | null }
export const BindingChangeItemSchema = z.object({ id: z.string(), name: z.string(), path: z.string(), kind: z.enum(['skill', 'plugin', 'mcp']),
  before: z.string().nullable().optional(), after: z.string().nullable().optional() });
export const BindingChangeSetSchema = z.object({ id: z.string(), scannedAt: z.string(), instanceId: z.string(), projectId: z.string().nullable(), baseline: z.boolean(),
  partial: z.boolean(), truncated: z.boolean(), totals: z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), statusChanged: z.number().int().nonnegative() }),
  added: z.array(BindingChangeItemSchema), removed: z.array(BindingChangeItemSchema), statusChanged: z.array(BindingChangeItemSchema) });

export interface SkillSource {
  id: string;
  path: string;
  mode: 'quick' | 'deep';
  followLinks: boolean;
  scannedAt: string | null;
  report: SkillSourceReport | null;
  watchEnabled?: boolean;
  watchStatus?: 'disabled' | 'watching' | 'unsupported' | 'error' | 'root-changed';
  watchError?: string | null;
  changes?: SkillChangeSet | null;
  fingerprints?: Record<string, string | { hash: string; status: 'recognized' | 'candidate' }>;
}
export interface SkillChangeSet {
  scannedAt: string;
  baseline: boolean;
  truncated: boolean;
  added: string[];
  removed: string[];
  modified: string[];
}
export interface SkillSourceFinding {
  logicalPath: string;
  actualPath: string;
  name: string;
  status: 'recognized' | 'candidate' | 'skipped';
  reason: string;
  description: string | null;
  contentHash?: string;
}
export interface SkillSourceReport {
  status: 'complete' | 'partial' | 'failed';
  rootPath: string;
  /** Physical identity captured when this report was produced, for revalidation before reading details. */
  rootRealPath?: string;
  candidateCount: number;
  recognizedCount: number;
  skippedCount: number;
  visitedDirectories: number;
  limits: { maxDepth: number; maxDirectories: number; maxEntriesPerDirectory: number; maxManifestBytes: number; maxFrontmatterBytes: number };
  truncatedAt: string | null;
  /** Directory path that can be registered as a new scan root to continue bounded traversal. */
  continuationPath: string | null;
  diagnostics: string[];
  findings: SkillSourceFinding[];
  cache?: { reused: number; read: number; force: boolean };
}
export const SkillSourceSchema = z.object({
  id: z.string().min(1), path: z.string().min(1), mode: z.enum(['quick', 'deep']), followLinks: z.boolean(),
  scannedAt: z.string().nullable(),
  watchEnabled: z.boolean().optional(),
  watchStatus: z.enum(['disabled', 'watching', 'unsupported', 'error', 'root-changed']).optional(),
  watchError: z.string().nullable().optional(),
  changes: z.object({ scannedAt: z.string(), baseline: z.boolean(), truncated: z.boolean(),
    added: z.array(z.string()), removed: z.array(z.string()), modified: z.array(z.string()) }).nullable().optional(),
  fingerprints: z.record(z.string(), z.union([z.string().max(80), z.object({ hash: z.string().max(80), status: z.enum(['recognized', 'candidate']) })])).optional(),
  report: z.object({
    status: z.enum(['complete', 'partial', 'failed']), rootPath: z.string(), rootRealPath: z.string().optional(),
    candidateCount: z.number().int().nonnegative(), recognizedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(), visitedDirectories: z.number().int().nonnegative(),
    limits: z.object({ maxDepth: z.number().int().positive(), maxDirectories: z.number().int().positive(),
      maxEntriesPerDirectory: z.number().int().positive(), maxManifestBytes: z.number().int().positive(),
      maxFrontmatterBytes: z.number().int().positive() }),
    truncatedAt: z.string().nullable(), continuationPath: z.string().nullable(), diagnostics: z.array(z.string()),
    cache: z.object({ reused: z.number().int().nonnegative(), read: z.number().int().nonnegative(), force: z.boolean() }).optional(),
    findings: z.array(z.object({ logicalPath: z.string(), actualPath: z.string(), name: z.string(),
      status: z.enum(['recognized', 'candidate', 'skipped']), reason: z.string(), description: z.string().nullable(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() })),
  }).nullable(),
});

export const SkillDetailsSchema = z.object({
  name: z.string(), description: z.string().nullable(), author: z.string().nullable(), version: z.string().nullable(),
  license: z.string().nullable(), environment: z.string().nullable(), invocation: z.string().nullable(),
  dependencies: z.array(z.string()), supports: z.array(z.string()), body: z.string(),
  formatStatus: z.enum(['valid', 'invalid']), metadataIssues: z.array(z.string()),
});
export type SkillDetails = z.infer<typeof SkillDetailsSchema>;
export const SkillSearchResponseSchema = z.object({
  query: z.string(), offset: z.number().int().nonnegative(), pageSize: z.number().int().positive(),
  examined: z.number().int().nonnegative(), totalCandidates: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(), truncated: z.boolean(), failures: z.number().int().nonnegative(),
  matches: z.array(z.object({ key: z.string(), bindingId: z.string().optional(), sourceId: z.string().optional(), findingPath: z.string().optional(), name: z.string(), snippet: z.string() })),
});
export type SkillSearchResponse = z.infer<typeof SkillSearchResponseSchema>;
export const SkillFileInspectionSchema = z.object({
  disk: z.enum(['present', 'missing', 'unreadable', 'configuration-only']),
  format: z.enum(['valid', 'invalid', 'unavailable']), reason: z.string(), checkedAt: z.string(),
});
export const SkillAvailabilityResponseSchema = z.object({
  checkedAt: z.string(), totalBindings: z.number().int().nonnegative(), inspectedBindings: z.number().int().nonnegative(),
  totalIndependent: z.number().int().nonnegative(), inspectedIndependent: z.number().int().nonnegative(), truncated: z.boolean(),
  bindings: z.record(z.string(), SkillFileInspectionSchema),
  independent: z.array(z.object({ sourceId: z.string(), findingPath: z.string(), name: z.string(), status: z.enum(['present', 'missing', 'unreadable']), format: z.enum(['valid', 'invalid', 'unavailable']), reason: z.string(), bound: z.literal(false) })),
});
export type SkillAvailabilityResponse = z.infer<typeof SkillAvailabilityResponseSchema>;

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
export const RegisterSkillSourceSchema = z.object({
  path: z.string().trim().min(1, '请填写资源目录'),
  mode: z.enum(['quick', 'deep']).optional().default('quick'),
  followLinks: z.boolean().optional().default(false),
});
export const SkillSourceScanSchema = z.object({ force: z.boolean().optional().default(false) }).strict();
export const SkillSourceWatchSchema = z.object({ enabled: z.boolean() }).strict();
export const ResourceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('binding'), bindingId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('source'), sourceId: z.string().min(1).max(200), findingPath: z.string().min(1).max(4_096) }).strict(),
]);
export type ResourceReference = z.infer<typeof ResourceReferenceSchema>;
export const ResourceReferenceListSchema = z.array(ResourceReferenceSchema).max(500);
export const ResourceDisplayPolicySchema = z.object({
  showBuiltin: z.boolean(), showCacheOnly: z.boolean(),
});
export type ResourceDisplayPolicy = z.infer<typeof ResourceDisplayPolicySchema>;
export const ResourcePreferencesSchema = z.object({
  favorites: ResourceReferenceListSchema,
  /** Library display policy; absent on data saved before the policy existed and defaults to both switches off. */
  display: ResourceDisplayPolicySchema.optional(),
  savedFilters: z.array(z.object({
    id: z.string().min(1).max(80), name: z.string().trim().min(1).max(60),
    filters: z.object({ kind: z.enum(['all', 'skill', 'plugin', 'mcp']), search: z.string().max(200),
      scope: z.array(z.string().max(80)).max(20), owner: z.array(z.string().max(80)).max(20),
      category: z.array(z.string().max(80)).max(20), source: z.array(z.string().max(80)).max(20),
      configuration: z.array(z.enum(['on', 'off', 'unknown'])).max(3), origin: z.enum(['all', 'cache', 'configuration', 'filesystem']),
      instanceId: z.string().max(200).nullable(), projectId: z.string().max(200).nullable(), favoritesOnly: z.boolean(),
      /** Project scope of the saved library view; absent on old filters, which read as "all" unless projectId is set. */
      projectScope: z.enum(['all', 'global-only', 'project']).optional(),
      /** Whether user-global records are included when a specific project is selected; old filters read as true. */
      includeGlobal: z.boolean().optional(),
      /** Saved display switches; old filters without these fields read as both off. */
      showBuiltin: z.boolean().optional(), showCacheOnly: z.boolean().optional() }).strict(),
  }).strict()).max(30),
}).strict();
export type ResourcePreferences = z.infer<typeof ResourcePreferencesSchema>;
export function withDefaultDisplayPolicy(preferences: ResourcePreferences): ResourcePreferences {
  return { ...preferences, display: preferences.display ?? { showBuiltin: false, showCacheOnly: false } };
}
export const SkillCompareRequestSchema = z.object({ left: ResourceReferenceSchema, right: ResourceReferenceSchema }).strict();
export const SkillCompareResponseSchema = z.object({
  samePhysicalSource: z.boolean(), sameName: z.boolean(), manifestIdentical: z.boolean(),
  left: z.object({ name: z.string(), description: z.string().nullable(), author: z.string().nullable(), version: z.string().nullable(), path: z.string() }),
  right: z.object({ name: z.string(), description: z.string().nullable(), author: z.string().nullable(), version: z.string().nullable(), path: z.string() }),
  bodyEqual: z.boolean(), bodyTruncated: z.boolean(), leftBody: z.string(), rightBody: z.string(),
}).strict();
export type SkillCompareResponse = z.infer<typeof SkillCompareResponseSchema>;
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
