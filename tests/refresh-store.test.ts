import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from '../apps/web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../apps/web/src/api';
import { useAppStore } from '../apps/web/src/store';
import type { Catalog } from '@agentdeck/contracts';

vi.mock('../apps/web/src/api', () => ({ api: {
  catalog: vi.fn(), adapters: vi.fn().mockResolvedValue([]), compatibility: vi.fn().mockResolvedValue({clients:[]}),
  resourcePreferences: vi.fn().mockResolvedValue({favorites:[],savedFilters:[]}), saveResourcePreferences: vi.fn(async value=>value),
}, ApiFailure: class extends Error {} }));
const catalog = (id:string) => ({instances:[],projects:[],bindings:[],skillSources:[],lastScanAt:id}) as unknown as Catalog;
describe('catalog refresh boundaries', () => {
  beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});
  it('does not fetch stable metadata during event refresh, and does so on explicit refresh',async()=>{
    vi.mocked(api.catalog).mockResolvedValue(catalog('initial'));
    const store=useAppStore();
    await store.refresh(); await store.refresh();
    expect(api.adapters).not.toHaveBeenCalled(); expect(api.resourcePreferences).not.toHaveBeenCalled();
    await store.refresh(true); expect(api.adapters).toHaveBeenCalledTimes(1);
  });
  it('keeps a newer explicit catalog and preferences when an older refresh returns',async()=>{
    let resolve!: (value:Catalog)=>void;
    vi.mocked(api.catalog).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const store=useAppStore(); const pending=store.refresh(true);
    store.setCatalog(catalog('newer'));
    await store.mutatePreferences(current=>({...current,savedFilters:[],favorites:[{kind:'binding',bindingId:'new'}]}));
    resolve(catalog('older')); await pending;
    expect(store.catalog?.lastScanAt).toBe('newer'); expect(store.resourcePreferences.favorites).toHaveLength(1);
  });
  it('serializes concurrent preference mutations without losing either favorite',async()=>{
    const store=useAppStore();
    const add = (id:string) => store.mutatePreferences(current=>({...current,favorites:[...current.favorites,{kind:'binding',bindingId:id}]}));
    await Promise.all([add('first'),add('second')]);
    expect(store.resourcePreferences.favorites).toEqual([{kind:'binding',bindingId:'first'},{kind:'binding',bindingId:'second'}]);
    expect(vi.mocked(api.saveResourcePreferences).mock.calls[1]?.[0].favorites).toHaveLength(2);
  });

});

