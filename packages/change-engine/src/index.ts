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
  ConfigToggleTarget,
  JsonToggleTarget,
  DshToggleTarget,
  RecoveryItem,
  RecoveryReport,
} from './types.js';
export { serializePreparedChange, deserializePreparedChange } from './serialization.js';
export { editCodexEnabled } from './toml-edit.js';
export { editJsonEnabled } from './json-edit.js';
export { editDshEnabled } from './yaml-edit.js';
