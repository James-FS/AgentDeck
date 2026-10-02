export { prepareToggle, applyPrepared, prepareRestore, recoverIncomplete } from './engine.js';
export { ChangeEngineError } from './types.js';
export type {
  AppliedChange,
  ChangeErrorCode,
  EngineOptions,
  PathIdentity,
  PathIdentityEntry,
  PreparedChange,
  PreparedChangePrivate,
  PrepareToggleInput,
  CodexToggleTarget,
  RecoveryItem,
  RecoveryReport,
} from './types.js';
export { serializePreparedChange, deserializePreparedChange } from './serialization.js';
export { editCodexEnabled } from './toml-edit.js';
