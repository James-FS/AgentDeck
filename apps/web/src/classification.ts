import type { Binding } from '@agentdeck/contracts';

export function inventoryScope(binding: Binding): string { return binding.classification?.scope ?? 'unknown'; }
export function inventoryAgent(binding: Binding): string {
  if (binding.classification?.agentId === null && ['user-global', 'project'].includes(binding.classification.category ?? '')) return 'public';
  return binding.classification?.agentId ?? 'unknown';
}
export function inventoryCategory(binding: Binding): string { return binding.classification?.category ?? 'unknown'; }
export function matchesClassification(binding: Binding, scopes: string[], agents: string[], categories: string[] = []): boolean {
  return (!scopes.length || scopes.includes(inventoryScope(binding)))
    && (!categories.length || categories.includes(inventoryCategory(binding)))
    && (!agents.length || agents.includes(inventoryAgent(binding))
      || (agents.includes('shared') && Boolean(binding.classification?.sharedSource)));
}
export function diskOnly(binding: Binding): boolean {
  return binding.discoveryOnly === true || binding.classification?.relationship === 'discovered';
}
