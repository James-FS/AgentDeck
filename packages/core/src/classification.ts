import type { Binding, Catalog } from '@agentdeck/contracts';

/** Builds a read-only cross-Agent index from scanner evidence, including retained project bindings. */
export function classifyCatalog(catalog: Catalog): Catalog {
  const groups = new Map<string, Binding[]>();
  for (const binding of catalog.bindings) {
    const key = binding.classification?.sourceIdentity;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(binding);
    groups.set(key, group);
  }
  return { ...catalog, bindings: catalog.bindings.map(binding => {
    if (!binding.classification) return binding;
    const classification = { ...binding.classification };
    delete classification.sharedSource;
    const group = groups.get(classification.sourceIdentity ?? '') ?? [];
    const agentIds = [...new Set(group.flatMap(row => row.classification?.agentId ? [row.classification.agentId] : []))].sort();
    return { ...binding, classification: { ...classification,
      ...(agentIds.length > 1 ? { sharedSource: {
        path: binding.sourcePath, agentIds, bindingIds: group.map(row => row.id).sort(),
      } } : {}),
    } };
  }) };
}
