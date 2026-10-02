import type { PreparedChange } from './types.js';

interface SerializedPreparedChange {
  schemaVersion: 1;
  plan: PreparedChange['plan'];
  private: Omit<PreparedChange['private'], 'originalBytes' | 'updatedBytes'> & {
    originalBytesBase64: string;
    updatedBytesBase64: string;
  };
}

export function serializePreparedChange(prepared: PreparedChange): string {
  const value: SerializedPreparedChange = {
    schemaVersion: 1,
    plan: prepared.plan,
    private: {
      configPath: prepared.private.configPath,
      serverName: prepared.private.serverName,
      originalBytesBase64: prepared.private.originalBytes.toString('base64'),
      updatedBytesBase64: prepared.private.updatedBytes.toString('base64'),
      pathIdentity: prepared.private.pathIdentity,
      beforeEnabled: prepared.private.beforeEnabled,
      desiredEnabled: prepared.private.desiredEnabled,
      ...(prepared.private.target ? { target: prepared.private.target } : {}),
    },
  };
  return JSON.stringify(value);
}

export function deserializePreparedChange(serialized: string): PreparedChange {
  const value = JSON.parse(serialized) as SerializedPreparedChange;
  if (value.schemaVersion !== 1 || !value.plan || !value.private
    || typeof value.private.originalBytesBase64 !== 'string'
    || typeof value.private.updatedBytesBase64 !== 'string') throw new Error('Invalid serialized prepared change.');
  return {
    plan: value.plan,
    private: {
      configPath: value.private.configPath,
      serverName: value.private.serverName,
      originalBytes: Buffer.from(value.private.originalBytesBase64, 'base64'),
      updatedBytes: Buffer.from(value.private.updatedBytesBase64, 'base64'),
      pathIdentity: value.private.pathIdentity,
      beforeEnabled: value.private.beforeEnabled,
      desiredEnabled: value.private.desiredEnabled,
      ...(value.private.target ? { target: value.private.target } : {}),
    },
  };
}
