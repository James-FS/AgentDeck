import type { Binding } from '@agentdeck/contracts';

/**
 * Pure display-policy judgments over scanner-provided evidence.
 *
 * `sourceKind: 'builtin'` is only set by adapters that verified a bundled source
 * (zcode-builtin, dsh-builtin, codex skills/.system). Configuration directories,
 * agent-global categories, official marketplaces and unknown states are never
 * treated as built-in evidence on their own.
 */

export interface DisplayPolicy { showBuiltin: boolean; showCacheOnly: boolean }

export const defaultDisplayPolicy: DisplayPolicy = { showBuiltin: false, showCacheOnly: false };

/** Requires a verified `builtin` source marker on the record or a verified built-in ancestor. */
export function hasBuiltinEvidence(binding: Binding, byId: Map<string, Binding>): boolean {
  let current: Binding | undefined = binding;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.sourceKind === 'builtin') return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/**
 * A configuration reference, explicit install record or linked parent configuration
 * counts as an association. Explicitly disabled configurations still count —
 * disabled does not mean cache-only. `enabled` values are never used to infer
 * an association in either direction.
 */
export function hasConfigurationAssociation(binding: Binding, byId: Map<string, Binding>): boolean {
  let current: Binding | undefined = binding;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.origin === 'configuration'
      || Boolean(current.configurationSourcePath)
      || Boolean(current.configurationKey)
      || (current.configurationEnabled !== undefined && current.configurationEnabled !== null)
      || Boolean(current.classification?.installationEvidence)) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/** Cache origin plus the absence of any configuration or installation association. */
export function isCacheOnlyRecord(binding: Binding, byId: Map<string, Binding>): boolean {
  return binding.origin === 'cache' && !hasConfigurationAssociation(binding, byId);
}

/**
 * Why a record is hidden under the display policy. Returns the first matching
 * reason; a record can satisfy both reasons — callers that need exact overlap
 * should test both predicates directly.
 */
export function hiddenRecordReason(binding: Binding, byId: Map<string, Binding>, policy: DisplayPolicy): 'builtin' | 'cache' | null {
  if (!policy.showBuiltin && hasBuiltinEvidence(binding, byId)) return 'builtin';
  if (!policy.showCacheOnly && isCacheOnlyRecord(binding, byId)) return 'cache';
  return null;
}
