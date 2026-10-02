import type { AgentAdapter } from '@agentdeck/contracts';
import { codexAdapter } from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';
import { zcodeAdapter } from './zcode.js';
import { deepSeekHarnessAdapter } from './deepseek-harness.js';

export { codexAdapter, claudeCodeAdapter, zcodeAdapter, deepSeekHarnessAdapter };

export function createAdapterRegistry(): AgentAdapter[] {
  return [codexAdapter, claudeCodeAdapter, zcodeAdapter, deepSeekHarnessAdapter];
}
