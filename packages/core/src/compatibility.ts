import type {
  AgentId, CapabilityEvidence, CapabilityEvidenceArea, ClientVersionEvidence, ResourceKind, SkillScope, SourceKind,
} from '@agentdeck/contracts';

interface Coverage { kind: ResourceKind; scope: SkillScope; sourceKind?: SourceKind }

const coverage: Record<AgentId, Coverage[]> = {
  codex: [
    { kind: 'skill', scope: 'user-global', sourceKind: 'user' }, { kind: 'skill', scope: 'user-global', sourceKind: 'builtin' },
    { kind: 'skill', scope: 'project', sourceKind: 'repository' }, { kind: 'skill', scope: 'native', sourceKind: 'plugin' },
    { kind: 'plugin', scope: 'native', sourceKind: 'user' }, { kind: 'plugin', scope: 'native', sourceKind: 'plugin' }, { kind: 'plugin', scope: 'project', sourceKind: 'repository' },
    { kind: 'mcp', scope: 'native', sourceKind: 'user' }, { kind: 'mcp', scope: 'native', sourceKind: 'plugin' },
    { kind: 'mcp', scope: 'project', sourceKind: 'repository' },
  ],
  'claude-code': [
    { kind: 'skill', scope: 'user-global', sourceKind: 'user' }, { kind: 'skill', scope: 'project', sourceKind: 'repository' }, { kind: 'skill', scope: 'native', sourceKind: 'plugin' },
    { kind: 'plugin', scope: 'native', sourceKind: 'user' }, { kind: 'plugin', scope: 'native', sourceKind: 'plugin' }, { kind: 'plugin', scope: 'project', sourceKind: 'repository' },
    { kind: 'mcp', scope: 'native', sourceKind: 'user' }, { kind: 'mcp', scope: 'native', sourceKind: 'plugin' },
    { kind: 'mcp', scope: 'project', sourceKind: 'repository' },
  ],
  zcode: [
    { kind: 'skill', scope: 'user-global', sourceKind: 'user' }, { kind: 'skill', scope: 'project-directory', sourceKind: 'repository' }, { kind: 'skill', scope: 'native', sourceKind: 'plugin' },
    { kind: 'plugin', scope: 'native', sourceKind: 'user' }, { kind: 'plugin', scope: 'native', sourceKind: 'plugin' }, { kind: 'plugin', scope: 'project', sourceKind: 'repository' },
    { kind: 'mcp', scope: 'native', sourceKind: 'user' }, { kind: 'mcp', scope: 'native', sourceKind: 'plugin' },
    { kind: 'mcp', scope: 'project', sourceKind: 'repository' },
  ],
  'deepseek-harness': [
    { kind: 'skill', scope: 'user-global', sourceKind: 'user' }, { kind: 'skill', scope: 'project-directory', sourceKind: 'repository' },
    { kind: 'plugin', scope: 'native', sourceKind: 'user' }, { kind: 'plugin', scope: 'project', sourceKind: 'repository' },
    { kind: 'mcp', scope: 'native', sourceKind: 'user' }, { kind: 'mcp', scope: 'project', sourceKind: 'repository' },
  ],
};

function isVerifiedNativeCodexMcp(agentId: AgentId, evidence: ClientVersionEvidence | null, coverageRow: Coverage): boolean {
  return agentId === 'codex' && evidence?.version === '0.159.2' && evidence.platform === 'win32'
    && coverageRow.kind === 'mcp' && coverageRow.scope === 'native' && coverageRow.sourceKind === 'user';
}

function evidence(args: {
  area: CapabilityEvidenceArea;
  row: Coverage;
  status: CapabilityEvidence['status'];
  readable: boolean;
  writable: boolean;
  reason: string;
  reference?: string;
  version?: string;
  platform?: string;
  operations?: CapabilityEvidence['operations'];
  controlScope?: CapabilityEvidence['controlScope'];
  mcpTransport?: CapabilityEvidence['mcpTransport'];
}): CapabilityEvidence {
  return {
    area: args.area,
    resourceKind: args.row.kind,
    scope: args.row.scope,
    ...(args.row.sourceKind !== undefined ? { sourceKind: args.row.sourceKind } : {}),
    operations: args.operations ?? (args.area === 'static-scan' || args.area === 'fixture-validation' ? ['scan'] : args.area === 'runtime' ? ['runtime-observation'] : ['toggle', 'restore']),
    ...(args.controlScope ? { controlScope: args.controlScope } : {}),
    ...(args.mcpTransport ? { mcpTransport: args.mcpTransport } : {}),
    status: args.status,
    readable: args.readable,
    writable: args.writable,
    reason: args.reason,
    ...(args.reference ? { evidenceReference: args.reference } : {}),
    ...(args.version ? { clientVersion: args.version } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
  };
}

export function buildCapabilityEvidence(args: {
  agentId: AgentId;
  versionEvidence: ClientVersionEvidence | null;
  optedInCodexWrite: boolean;
  optedInZCodeWrite?: boolean;
  optedInProfileWrite?: boolean;
}): CapabilityEvidence[] {
  const result: CapabilityEvidence[] = [];
  const rows = coverage[args.agentId];
  if (!rows) return result;
  for (const row of rows) {
    const partialCoverage = args.agentId === 'zcode' || args.agentId === 'deepseek-harness';
    const reference = args.agentId === 'codex' || args.agentId === 'claude-code'
      ? 'tests/adapters.test.ts; tests/plugin-cache.test.ts'
      : 'tests/adapters.test.ts; tests/plugin-cache.test.ts';
    result.push(evidence({
      area: 'static-scan', row, status: partialCoverage ? 'partial' : 'verified', readable: true, writable: false, reference,
      reason: partialCoverage
        ? '静态扫描覆盖该声明来源，但覆盖为部分：官方配置语义与其他候选路径尚未验证。'
        : '适配器已实现该资源类型、范围与来源的有限静态扫描；这不代表客户端已加载该资源。',
    }));
    const codexUserMcp = args.agentId === 'codex' && row.kind === 'mcp' && row.scope === 'native' && row.sourceKind === 'user';
    const codexSkill = args.agentId === 'codex' && row.kind === 'skill' && row.scope === 'user-global' && row.sourceKind === 'user';
    const codexPlugin = args.agentId === 'codex' && row.kind === 'plugin' && row.scope === 'native' && row.sourceKind === 'plugin';
    const basicControl = codexSkill ? 'user-config-skill' as const : codexPlugin ? 'local-marketplace-plugin' as const : undefined;
    const basicNativeVerified = Boolean(basicControl && args.versionEvidence?.version === '0.159.2' && args.versionEvidence.platform === 'win32');
    const zcodeSwitch = args.agentId === 'zcode' && (row.kind === 'skill' && (row.scope === 'user-global' || row.scope === 'native')
      || row.kind === 'plugin' && row.scope === 'native' || row.kind === 'mcp' && row.scope === 'native' && row.sourceKind === 'user');
    const profileSwitch = ['claude-code', 'deepseek-harness'].includes(args.agentId)
      && row.kind === 'plugin' && row.scope === 'native' && (row.sourceKind === 'user' || args.agentId === 'claude-code' && row.sourceKind === 'plugin');
    result.push(evidence({
      area: 'fixture-validation', row, status: partialCoverage ? 'partial' : 'verified', readable: true,
      writable: ((codexUserMcp || basicNativeVerified) && args.optedInCodexWrite) || zcodeSwitch && args.optedInZCodeWrite === true || profileSwitch && args.optedInProfileWrite === true,
      operations: codexUserMcp || basicControl || zcodeSwitch || profileSwitch ? ['scan', 'toggle', 'restore'] : ['scan'],
      ...(codexUserMcp ? { controlScope: 'standalone-user-mcp' as const } : basicControl ? { controlScope: basicControl } : {}),
      reference: profileSwitch ? 'tests/profile-controls.test.ts; tests/browser/profile-controls.spec.ts' : zcodeSwitch ? 'tests/zcode-controls.test.ts; tests/browser/zcode-controls.spec.ts' : basicControl ? 'tests/codex-controls.test.ts' : codexUserMcp ? 'tests/adapters.test.ts; tests/change-engine.test.ts; tests/server.test.ts' : reference,
      reason: profileSwitch ? '仅控制已有用户设置中的 Claude 插件身份开关或 DSH 唯一静态插件行的 disabled 布尔值；绑定须通过路径和结构校验，项目、动态层、必需组件及安装原文只读，不证明最终层叠或会话生效。' : zcodeSwitch ? '隔离测试覆盖现有 ZCode 用户配置的单个布尔开关及备份恢复；默认开放受支持实例且绑定有可验证开关地址时可写，显式只读除外，不创建配置文件、不启动客户端、不修改其他设置。' : basicControl ? '隔离测试覆盖配置根独立 Skill 的按路径覆盖，以及已配置本地市场插件的身份级开关；其他来源保持只读。' : codexUserMcp
        ? '夹具与隔离变更引擎测试验证了独立用户级 MCP 的扫描、启停与恢复；客户端原生加载行为另行验证。'
        : partialCoverage
          ? '夹具测试仅覆盖声明静态来源的有限部分；不代表官方运行时语义。'
          : '夹具测试针对该资源类型、范围与来源执行静态适配器路径；原生运行时行为另行验证。',
    }));
    const nativeVerified = isVerifiedNativeCodexMcp(args.agentId, args.versionEvidence, row);
    result.push(evidence({
      area: 'native-config', row, status: nativeVerified || basicNativeVerified ? 'verified' : 'unverified',
      readable: nativeVerified || basicNativeVerified, writable: (nativeVerified || basicNativeVerified) && args.optedInCodexWrite,
      reason: basicNativeVerified ? 'Codex 0.159.2 / Windows 的隔离原生复读仅覆盖已登记配置根 skills 目录下的独立 SKILL.md，以及已配置本地市场插件身份；这是配置证据，不代表当前会话运行状态。' : nativeVerified
        ? 'STDIO 原生配置往返仅在 Codex 0.159.2 / Windows 的用户级独立 MCP 启停与恢复上验收；该证据不改变实例写入策略。'
        : '该客户端、资源类型、范围与来源组合的原生配置行为尚未验证。',
      ...(nativeVerified ? { controlScope: 'standalone-user-mcp' as const } : basicControl ? { controlScope: basicControl } : {}),
      ...(nativeVerified ? { mcpTransport: 'stdio' as const } : {}),
      ...(nativeVerified || basicNativeVerified ? {
        reference: basicNativeVerified ? 'tests/native-codex-controls.test.ts' : 'tests/native-codex.test.ts',
        version: args.versionEvidence!.version, platform: args.versionEvidence!.platform,
      } : {}),
    }));
    result.push(evidence({
      area: 'runtime', row, status: 'unverified', readable: false, writable: false,
      reason: 'AgentDeck 未观察客户端是否已加载或正在运行该资源。',
    }));
  }
  return result;
}
