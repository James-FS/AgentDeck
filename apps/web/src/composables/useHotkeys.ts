import { onBeforeUnmount, onMounted } from 'vue';
import { useUiStore } from '../ui-store';

export function useHotkeys() {
  const ui = useUiStore();
  // The search input is still located through its panel-tools class because the input
  // lives inside ResourcesPage; switch to a template ref if that selector ever breaks.
  function onGlobalKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    const search = document.querySelector<HTMLElement>('.panel-tools .el-input__inner');
    if (event.key === '/') {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')) return;
      if (!search || ui.drawer !== null) return;
      event.preventDefault();
      search.focus();
      return;
    }
    if (event.key === 'Escape' && search && document.activeElement === search && ui.searchText) ui.searchText = '';
  }
  onMounted(() => { window.addEventListener('keydown', onGlobalKeydown); });
  onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKeydown); });
}
