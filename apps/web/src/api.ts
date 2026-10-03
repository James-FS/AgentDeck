import type {
  AdapterInfo,
  AgentInstance,
  ApiError,
  CapabilityEvidence,
  Catalog,
  ChangePlan,
  ClientCompatibilityReport,
  ClientVersionEvidence,
  CompatibilityReport,
  ExecutableIdentity,
  Operation,
  Project,
  RuntimeReport,
  SessionResponse,
} from '@agentdeck/contracts';

const API = '/api/v1';
let csrfToken: string | null = null;

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiFailure('无法连接本机服务，请确认 AgentDeck 后台正在运行。', 0, 'SERVICE_UNREACHABLE');
  }

  const payload: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = payload as ApiError | undefined;
    const error = apiError && typeof apiError === 'object' && 'error' in apiError ? apiError.error : undefined;
    const message = error?.message || (response.status === 401
      ? '本机网页会话尚未授权，请从 AgentDeck 服务提供的本机链接打开。'
      : `请求失败（${response.status}）。`);
    throw new ApiFailure(message, response.status, error?.code ?? 'HTTP_ERROR');
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCatalog(value: unknown): Catalog {
  if (!isRecord(value) || !Array.isArray(value.instances) || !Array.isArray(value.projects) || !Array.isArray(value.bindings)) {
    throw new ApiFailure('服务返回的资源目录格式不符合当前界面契约。', 200, 'INVALID_RESPONSE');
  }
  const validInstances = value.instances.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.agentId === 'string' && typeof entry.name === 'string'
    && typeof entry.configRoot === 'string' && typeof entry.writable === 'boolean'
    && typeof entry.discovery === 'string' && Array.isArray(entry.diagnostics)
    && entry.diagnostics.every((item) => typeof item === 'string')
    && typeof entry.checkedAt === 'string'
    && (entry.version === null || typeof entry.version === 'string')
    && (entry.executable === null || typeof entry.executable === 'string'));
  const validProjects = value.projects.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.rootPath === 'string');
  const validBindings = value.bindings.every((entry) => isRecord(entry)
    && typeof entry.id === 'string' && typeof entry.resourceId === 'string'
    && typeof entry.instanceId === 'string' && (entry.projectId === null || typeof entry.projectId === 'string')
    && ['skill', 'plugin', 'mcp'].includes(String(entry.kind)) && typeof entry.name === 'string'
    && typeof entry.description === 'string'
    && (entry.displayName === undefined || typeof entry.displayName === 'string')
    && (entry.discoveryOnly === undefined || typeof entry.discoveryOnly === 'boolean')
    && (entry.discoveryPath === undefined || typeof entry.discoveryPath === 'string')
    && ['user-global', 'project', 'project-directory', 'native'].includes(String(entry.scope))
    && ['user', 'repository', 'plugin', 'builtin', 'organization', 'account-sync', 'unknown'].includes(String(entry.sourceKind))
    && ['portable', 'agent-specific', 'conditional', 'unknown'].includes(String(entry.compatibilityClass))
    && (entry.parentId === null || typeof entry.parentId === 'string')
    && typeof entry.sourcePath === 'string' && typeof entry.nativeKey === 'string'
    && (entry.enabled === null || typeof entry.enabled === 'boolean')
    && ['unknown', 'pending', 'active', 'inactive'].includes(String(entry.runtime))
    && typeof entry.writable === 'boolean'
    && (entry.readOnlyReason === null || typeof entry.readOnlyReason === 'string')
    && (entry.origin === undefined || ['configuration', 'cache', 'filesystem'].includes(String(entry.origin)))
    && (entry.pluginId === undefined || typeof entry.pluginId === 'string')
    && (entry.pluginVersion === undefined || typeof entry.pluginVersion === 'string')
    && (entry.marketplace === undefined || typeof entry.marketplace === 'string')
    && (entry.configurationSourcePath === undefined || typeof entry.configurationSourcePath === 'string')
    && (entry.configurationKey === undefined || typeof entry.configurationKey === 'string')
    && (entry.configurationEnabled === undefined || entry.configurationEnabled === null || typeof entry.configurationEnabled === 'boolean')
    && (entry.cacheState === undefined || ['present', 'missing', 'unknown'].includes(String(entry.cacheState)))
    && (entry.mcpTransport === undefined || ['stdio', 'http', 'unknown'].includes(String(entry.mcpTransport)))
    && Array.isArray(entry.diagnostics) && entry.diagnostics.every((item) => typeof item === 'string')
    && typeof entry.updatedAt === 'string');
  if (!validInstances || !validProjects || !validBindings) {
    throw new ApiFailure('服务返回的目录条目缺少必要字段，无法安全显示。', 200, 'INVALID_RESPONSE');
  }
  if (value.lastScanAt !== null && typeof value.lastScanAt !== 'string') {
    throw new ApiFailure('服务返回的目录扫描时间格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as Catalog;
}

function validateRuntimeReport(value: unknown): RuntimeReport {
  if (!isRecord(value) || typeof value.assessedAt !== 'string' || !Array.isArray(value.observations)
    || !value.observations.every((entry) => isRecord(entry)
      && typeof entry.bindingId === 'string' && typeof entry.instanceId === 'string'
      && ['skill', 'plugin', 'mcp'].includes(String(entry.kind))
      && (entry.configurationEnabled === null || typeof entry.configurationEnabled === 'boolean')
      && typeof entry.indexUpdatedAt === 'string'
      && ['not-checked', 'not-applicable'].includes(String(entry.sessionLoad))
      && ['not-checked', 'not-applicable', 'not-started', 'starting', 'connected', 'authentication-required', 'failed', 'cancelled', 'disabled'].includes(String(entry.mcpConnection))
      && (entry.clientSessionId === null || typeof entry.clientSessionId === 'string')
      && (entry.threadId === null || typeof entry.threadId === 'string')
      && (entry.evidenceSource === null || entry.evidenceSource === 'codex-app-server-session')
      && (entry.observedAt === null || typeof entry.observedAt === 'string')
      && typeof entry.reason === 'string')) {
    throw new ApiFailure('服务返回的运行证据报告格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as RuntimeReport;
}

function validatePlan(value: unknown): ChangePlan {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.instanceId !== 'string'
    || typeof value.bindingId !== 'string' || !['toggle', 'restore'].includes(String(value.action))
    || typeof value.targetPath !== 'string' || typeof value.beforeHash !== 'string'
    || typeof value.afterHash !== 'string' || typeof value.diff !== 'string'
    || (value.desiredEnabled !== null && typeof value.desiredEnabled !== 'boolean')
    || typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string'
    || !['ready', 'applied', 'expired'].includes(String(value.status))) {
    throw new ApiFailure('服务返回的变更计划格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as ChangePlan;
}

function validateOperation(value: unknown): Operation {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.planId !== 'string'
    || !['succeeded', 'failed', 'conflict'].includes(String(value.status))
    || !['toggle', 'restore'].includes(String(value.kind)) || typeof value.targetPath !== 'string'
    || typeof value.createdAt !== 'string' || (value.error !== null && typeof value.error !== 'string')
    || (value.backupId !== null && typeof value.backupId !== 'string')) {
    throw new ApiFailure('服务返回的操作记录格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as Operation;
}

function validateExecutableIdentity(value: unknown): value is ExecutableIdentity {
  return isRecord(value) && typeof value.path === 'string' && typeof value.realPath === 'string'
    && typeof value.fileIdentity === 'string' && typeof value.checkedAt === 'string';
}

function validateVersionEvidence(value: unknown): value is ClientVersionEvidence {
  return isRecord(value) && typeof value.version === 'string'
    && ['codex-cli-version', 'claude-code-version'].includes(String(value.signature))
    && validateExecutableIdentity(value.executable) && typeof value.platform === 'string'
    && typeof value.checkedAt === 'string';
}

function validateCapabilityEvidence(value: unknown): value is CapabilityEvidence {
  return isRecord(value)
    && ['static-scan', 'fixture-validation', 'native-config', 'runtime'].includes(String(value.area))
    && (value.resourceKind === null || ['skill', 'plugin', 'mcp'].includes(String(value.resourceKind)))
    && (value.scope === null || ['user-global', 'project', 'project-directory', 'native'].includes(String(value.scope)))
    && (value.sourceKind === undefined || value.sourceKind === null || ['user', 'repository', 'plugin', 'builtin', 'organization', 'account-sync', 'unknown'].includes(String(value.sourceKind)))
    && (value.controlScope === undefined || ['standalone-user-mcp', 'user-config-skill', 'local-marketplace-plugin'].includes(String(value.controlScope)))
    && (value.mcpTransport === undefined || ['stdio', 'http', 'unknown'].includes(String(value.mcpTransport)))
    && (value.operations === undefined || (Array.isArray(value.operations) && value.operations.every(operation => ['scan', 'toggle', 'restore', 'runtime-observation'].includes(String(operation)))) )
    && ['verified', 'partial', 'unverified', 'unsupported'].includes(String(value.status))
    && typeof value.readable === 'boolean' && typeof value.writable === 'boolean' && typeof value.reason === 'string'
    && (value.evidenceReference === undefined || typeof value.evidenceReference === 'string')
    && (value.clientVersion === undefined || typeof value.clientVersion === 'string')
    && (value.platform === undefined || typeof value.platform === 'string');
}

function validateClientCompatibility(value: unknown): value is ClientCompatibilityReport {
  return isRecord(value) && typeof value.id === 'string' && typeof value.agentId === 'string' && typeof value.agentName === 'string'
    && (value.instanceId === null || typeof value.instanceId === 'string')
    && (value.instanceName === null || typeof value.instanceName === 'string')
    && (value.configRoot === null || typeof value.configRoot === 'string')
    && ['verified-client', 'executable-unverified', 'configuration-only', 'not-found', 'demo'].includes(String(value.status))
    && ['present', 'missing'].includes(String(value.configurationState))
    && (value.executableCandidate === null || validateExecutableIdentity(value.executableCandidate))
    && (value.versionEvidence === null || validateVersionEvidence(value.versionEvidence))
    && Array.isArray(value.capabilities) && value.capabilities.every(validateCapabilityEvidence)
    && (value.checkedAt === null || typeof value.checkedAt === 'string')
    && Array.isArray(value.diagnostics) && value.diagnostics.every(item => typeof item === 'string');
}

function validateCompatibilityReport(value: unknown): CompatibilityReport {
  if (!isRecord(value) || typeof value.generatedAt !== 'string' || !Array.isArray(value.clients)
    || !value.clients.every(validateClientCompatibility)) {
    throw new ApiFailure('服务返回的客户端兼容报告格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as CompatibilityReport;
}

function validateInstance(value: unknown): AgentInstance {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.agentId !== 'string'
    || typeof value.name !== 'string' || typeof value.configRoot !== 'string'
    || (value.version !== null && typeof value.version !== 'string')
    || (value.executable !== null && typeof value.executable !== 'string')
    || !['auto', 'manual', 'demo'].includes(String(value.discovery))
    || typeof value.writable !== 'boolean' || typeof value.checkedAt !== 'string'
    || (value.versionEvidence !== undefined && value.versionEvidence !== null && !validateVersionEvidence(value.versionEvidence))
    || !Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => typeof item === 'string')) {
    throw new ApiFailure('服务返回的 Agent 实例格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as AgentInstance;
}

function validateProject(value: unknown): Project {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.rootPath !== 'string') {
    throw new ApiFailure('服务返回的项目格式无效。', 200, 'INVALID_RESPONSE');
  }
  return value as unknown as Project;
}

export const api = {
  async session(): Promise<SessionResponse> {
    const session = await request<SessionResponse>(`${API}/session`);
    if (!session || typeof session.csrfToken !== 'string' || !session.csrfToken) {
      throw new ApiFailure('服务未返回有效的本机会话凭据。', 200, 'INVALID_RESPONSE');
    }
    csrfToken = session.csrfToken;
    return session;
  },

  bootstrap(ticket: string): Promise<void> {
    return request<void>(`${API}/session/bootstrap`, {
      method: 'POST',
      body: JSON.stringify({ ticket }),
    });
  },

  async catalog(): Promise<Catalog> {
    return validateCatalog(await request<unknown>(`${API}/catalog`));
  },

  async runtime(): Promise<RuntimeReport> {
    return validateRuntimeReport(await request<unknown>(`${API}/runtime`));
  },

  async adapters(): Promise<AdapterInfo[]> {
    const response = await request<unknown>(`${API}/adapters`);
    const list = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.adapters) ? response.adapters : null;
    if (!list || !list.every((entry) => isRecord(entry)
      && typeof entry.id === 'string' && typeof entry.name === 'string'
      && Array.isArray(entry.supportedKinds) && Array.isArray(entry.writeSupport))) {
      throw new ApiFailure('服务返回的客户端能力列表格式无效。', 200, 'INVALID_RESPONSE');
    }
    return list as AdapterInfo[];
  },

  async compatibility(): Promise<CompatibilityReport> {
    return validateCompatibilityReport(await request<unknown>(`${API}/compatibility`));
  },

  async checkVersion(instanceId: string): Promise<CompatibilityReport> {
    return validateCompatibilityReport(await request<unknown>(`${API}/instances/${encodeURIComponent(instanceId)}/version-check`, {
      method: 'POST',
      body: JSON.stringify({}),
    }));
  },

  async scan(options: { discover?: boolean; discoverUserHome?: boolean; instanceId?: string; projectId?: string }): Promise<Catalog> {
    return validateCatalog(await request<unknown>(`${API}/scans`, {
      method: 'POST',
      body: JSON.stringify(options),
    }));
  },

  async initializeDemo(): Promise<Catalog> {
    return validateCatalog(await request<unknown>(`${API}/demo`, { method: 'POST', body: '{}' }));
  },

  async registerInstance(input: { agentId: string; name?: string; configRoot: string; writable?: boolean }): Promise<AgentInstance> {
    return validateInstance(await request<unknown>(`${API}/instances`, { method: 'POST', body: JSON.stringify(input) }));
  },

  async registerProject(input: { name?: string; rootPath: string }): Promise<Project> {
    return validateProject(await request<unknown>(`${API}/projects`, { method: 'POST', body: JSON.stringify(input) }));
  },

  async createPlan(input: { bindingId: string; enabled: boolean }): Promise<ChangePlan> {
    return validatePlan(await request<unknown>(`${API}/plans`, { method: 'POST', body: JSON.stringify(input) }));
  },

  async applyPlan(id: string, digest: string): Promise<Operation> {
    return validateOperation(await request<unknown>(`${API}/plans/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ digest }),
    }));
  },

  async operations(): Promise<Operation[]> {
    const response = await request<unknown>(`${API}/operations`);
    const operations = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.operations) ? response.operations : null;
    if (!operations || !operations.every((entry) => isRecord(entry) && typeof entry.id === 'string' && typeof entry.status === 'string')) {
      throw new ApiFailure('服务返回的操作记录格式无效。', 200, 'INVALID_RESPONSE');
    }
    return operations.map(validateOperation);
  },

  async createRestorePlan(operationId: string): Promise<ChangePlan> {
    return validatePlan(await request<unknown>(`${API}/operations/${encodeURIComponent(operationId)}/restore-plan`, { method: 'POST', body: '{}' }));
  },

  eventsUrl(): string {
    return `${API}/events`;
  },
};
