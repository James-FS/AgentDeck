import type { ChangePlan, Operation } from '@agentdeck/contracts';

export type ChangeErrorCode =
  | 'AMBIGUOUS_TARGET'
  | 'INVALID_CONFIG'
  | 'CONFIG_CHANGED'
  | 'PLAN_EXPIRED'
  | 'PATH_CHANGED'
  | 'RECOVERY_CONFLICT'
  | 'LOCKED'
  | 'IO_ERROR';

export class ChangeEngineError extends Error {
  readonly code: ChangeErrorCode;
  readonly safeMessage: string;
  constructor(code: ChangeErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'ChangeEngineError';
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export interface PathIdentityEntry {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  symbolicLink: boolean;
  linkTarget: string | null;
}

export interface PathIdentity { realPath: string; entries: PathIdentityEntry[] }

export interface PreparedChangePrivate {
  configPath: string;
  serverName: string;
  originalBytes: Buffer;
  updatedBytes: Buffer;
  pathIdentity: PathIdentity;
  beforeEnabled: boolean | null;
  desiredEnabled: boolean | null;
}

export interface PreparedChange {
  plan: ChangePlan;
  /** Server-only material. Never include this property in an API response. */
  private: PreparedChangePrivate;
}

export interface AppliedChange {
  plan: ChangePlan;
  operation: Operation;
  /** Internal manager data paths; do not expose through the API. */
  journalPath: string;
  snapshotPath: string | null;
}

export interface RecoveryItem {
  operationId: string;
  status: 'completed' | 'not-applied' | 'conflict' | 'ignored';
  message: string;
  /** Verified public audit DTO for a completed operation; never includes private plan/config bytes. */
  operation?: Operation;
}

export interface RecoveryReport { items: RecoveryItem[]; diagnostics: string[] }

export interface PrepareToggleInput {
  configPath: string;
  serverName: string;
  enabled: boolean;
  now?: Date;
  ttlMs?: number;
}

export interface EngineOptions { dataDir: string; now?: Date }
