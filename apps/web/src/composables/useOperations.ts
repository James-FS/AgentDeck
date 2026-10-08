import { ref } from 'vue';
import type { Operation } from '@agentdeck/contracts';
import { api } from '../api';
import type { Page } from '../navigation';
import { useUiStore } from '../ui-store';

const operations = ref<Operation[]>([]);
const operationsError = ref('');
const restoreBusy = ref('');

export function useOperations() {
  async function loadOperations() {
    operationsError.value = '';
    try { operations.value = await api.operations(); }
    catch (error) { operationsError.value = error instanceof Error ? error.message : '无法读取操作记录'; }
  }
  function goTo(next: Page) {
    const ui = useUiStore();
    ui.page = next;
    if (next === 'operations' || next === 'overview') void loadOperations();
  }
  return { operations, operationsError, restoreBusy, loadOperations, goTo };
}
