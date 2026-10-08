import { ref } from 'vue';
import { api } from '../api';
import { useOperations } from './useOperations';
import { useScanActions } from './useScanActions';

const eventStatus = ref<'connecting' | 'connected' | 'offline'>('connecting');
let eventSource: EventSource | undefined;

export function useEventStream() {
  function openEvents() {
    if (eventSource) return;
    const source = new EventSource(api.eventsUrl(), { withCredentials: true });
    const { refresh } = useScanActions();
    const { loadOperations } = useOperations();
    source.onopen = () => { eventStatus.value = 'connected'; };
    source.addEventListener('catalog.changed', () => { void refresh(); });
    source.addEventListener('operation.completed', () => { void refresh(); void loadOperations(); });
    source.onerror = () => { eventStatus.value = 'offline'; };
    eventStatus.value = 'connecting';
    eventSource = source;
  }
  function closeEvents() { eventSource?.close(); eventSource = undefined; }
  return { eventStatus, openEvents, closeEvents };
}
