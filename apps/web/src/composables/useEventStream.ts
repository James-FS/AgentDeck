import { ref } from 'vue';
import { api } from '../api';
import { useOperations } from './useOperations';
import { useAppStore } from '../store';

const eventStatus = ref<'connecting' | 'connected' | 'offline'>('connecting');
let eventSource: EventSource | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let operationsPending = false;

export function useEventStream() {
  function openEvents() {
    if (eventSource) return;
    const source = new EventSource(api.eventsUrl(), { withCredentials: true });
    const store = useAppStore();
    const { loadOperations } = useOperations();
    source.onopen = () => { eventStatus.value = 'connected'; };
    function schedule(operations = false) {
      operationsPending ||= operations;
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        const updateOperations = operationsPending; operationsPending = false;
        void store.refresh().catch(() => undefined);
        if (updateOperations) void loadOperations();
      }, 100);
    }
    source.addEventListener('catalog.changed', () => schedule());
    source.addEventListener('operation.completed', () => schedule(true));
    source.onerror = () => { eventStatus.value = 'offline'; };
    eventStatus.value = 'connecting';
    eventSource = source;
  }
  function closeEvents() { eventSource?.close(); eventSource = undefined; if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = undefined; operationsPending = false; }
  return { eventStatus, openEvents, closeEvents };
}
