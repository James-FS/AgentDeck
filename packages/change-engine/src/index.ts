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
  RecoveryItem,
  RecoveryReport,
} from './types.js';
export { serializePreparedChange, deserializePreparedChange } from './serialization.js';
