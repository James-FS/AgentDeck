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
        ? 'A bounded static scanner covers this declared source. Coverage is partial because official configuration semantics and other paths remain unverified.'
        : 'The bounded adapter scan is implemented for this resource type, scope, and source. This does not establish that the client loaded it.',
    }));
    const codexUserMcp = args.agentId === 'codex' && row.kind === 'mcp' && row.scope === 'native' && row.sourceKind === 'user';
    const codexSkill = args.agentId === 'codex' && row.kind === 'skill' && row.scope === 'user-global' && row.sourceKind === 'user';
    const codexPlugin = args.agentId === 'codex' && row.kind === 'plugin' && row.scope === 'native' && row.sourceKind === 'plugin';
    const basicControl = codexSkill ? 'user-config-skill' as const : codexPlugin ? 'local-marketplace-plugin' as const : undefined;
    const basicNativeVerified = Boolean(basicControl && args.versionEvidence?.version === '0.159.2' && args.versionEvidence.platform === 'win32');
    result.push(evidence({
      area: 'fixture-validation', row, status: partialCoverage ? 'partial' : 'verified', readable: true,
      writable: (codexUserMcp || basicNativeVerified) && args.optedInCodexWrite,
      operations: codexUserMcp || basicControl ? ['scan', 'toggle', 'restore'] : ['scan'],
      ...(codexUserMcp ? { controlScope: 'standalone-user-mcp' as const } : basicControl ? { controlScope: basicControl } : {}),
      reference: basicControl ? 'tests/codex-controls.test.ts' : codexUserMcp ? 'tests/adapters.test.ts; tests/change-engine.test.ts; tests/server.test.ts' : reference,
      reason: basicControl ? 'Isolated tests cover config-root standalone Skill path overrides or configured local marketplace plugin identity toggles. Other sources remain read-only.' : codexUserMcp
        ? 'Fixtures and isolated change-engine tests validate standalone user MCP scan, toggle, and restore behavior; native client loading is separate.'
        : partialCoverage
          ? 'Fixture tests cover a bounded portion of the declared static source; they do not establish official runtime semantics.'
          : 'Fixture tests exercise the static adapter path for this declared resource type, scope, and source; native runtime behavior remains separate.',
    }));
    const nativeVerified = isVerifiedNativeCodexMcp(args.agentId, args.versionEvidence, row);
    result.push(evidence({
      area: 'native-config', row, status: nativeVerified || basicNativeVerified ? 'verified' : 'unverified',
      readable: nativeVerified || basicNativeVerified, writable: (nativeVerified || basicNativeVerified) && args.optedInCodexWrite,
      reason: basicNativeVerified ? 'Codex 0.159.2/win32 isolated native reread covers only standalone SKILL.md under the registered config-root skills directory or a configured local marketplace plugin identity. This is configuration evidence, not current-session runtime observation.' : nativeVerified
        ? 'STDIO native configuration round-trip verified only for Codex 0.159.2 on win32 and standalone user MCP toggle/restore. This evidence never changes instance write policy.'
        : 'Native configuration behavior has not been verified for this client, resource type, scope, and source combination.',
      ...(nativeVerified ? { controlScope: 'standalone-user-mcp' as const } : basicControl ? { controlScope: basicControl } : {}),
      ...(nativeVerified ? { mcpTransport: 'stdio' as const } : {}),
      ...(nativeVerified || basicNativeVerified ? {
        reference: basicNativeVerified ? 'tests/native-codex-controls.test.ts; docs/基础版使用与验收.md' : 'tests/native-codex.test.ts; docs/compatibility.json; docs/客户端兼容与原生验收.md',
        version: args.versionEvidence!.version, platform: args.versionEvidence!.platform,
      } : {}),
    }));
    result.push(evidence({
      area: 'runtime', row, status: 'unverified', readable: false, writable: false,
      reason: 'AgentDeck has not observed whether the client loaded or is currently running this resource.',
    }));
  }
  return result;
}
