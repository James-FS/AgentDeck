import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { prepareStartup } from '../scripts/prepare-startup.mjs';
import { createTestDirectory, removeTestDirectory } from './helpers';

const outputs = ['apps/server/dist/index.js','apps/cli/dist/index.js','apps/web/dist/index.html',
  ...['adapters','change-engine','contracts','core','storage'].map(name=>`packages/${name}/dist/index.js`)];
describe('isolated Windows startup preparation', () => {
  it('invalidates dependencies, source deletions/config changes, outputs, force and failed builds', async () => {
    const root = await createTestDirectory('startup-');
    const put = (name:string,value='fixture') => { mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); writeFileSync(path.join(root,name),value); };
    const calls:string[] = [];
    const run = (step:string) => {
      calls.push(step);
      if(step==='install') put('node_modules/.modules.yaml');
      else { outputs.forEach(name=>put(name)); put('apps/web/dist/assets/chunk.js'); }
    };
    try {
      put('package.json','{}'); put('pnpm-lock.yaml'); put('pnpm-workspace.yaml'); put('scripts/test.ps1'); put('apps/web/src/file.ts');
      outputs.forEach(name=>put(name.replace('/dist/index.js','/package.json').replace('/dist/index.html','/package.json'),'{}'));
      expect(prepareStartup(root,run)).toEqual(['install','build']);
      expect(prepareStartup(root,run)).toEqual([]);
      put('work/startup-state.json','null'); expect(prepareStartup(root,run)).toEqual(['install','build']);
      put('work/startup-state.json','{"source":42}'); expect(prepareStartup(root,run)).toEqual(['install','build']);
      put('apps/web/src/file.ts','changed'); expect(prepareStartup(root,run)).toEqual(['build']);
      rmSync(path.join(root,'apps/web/src/file.ts')); expect(prepareStartup(root,run)).toEqual(['build']);
      put('apps/web/vite.config.ts'); expect(prepareStartup(root,run)).toEqual(['build']);
      put('apps/web/package.json','{"version":"2"}'); expect(prepareStartup(root,run)).toEqual(['install','build']);
      put('pnpm-lock.yaml','changed'); expect(prepareStartup(root,run)).toEqual(['install','build']);
      rmSync(path.join(root,'node_modules/.modules.yaml')); expect(prepareStartup(root,run)).toEqual(['install','build']);
      rmSync(path.join(root,outputs[0]!)); expect(prepareStartup(root,run)).toEqual(['build']);
      rmSync(path.join(root,'apps/web/dist/assets/chunk.js')); expect(prepareStartup(root,run)).toEqual(['build']);
      put('apps/web/dist/assets/chunk.js','tampered'); expect(prepareStartup(root,run)).toEqual(['build']);
      expect(prepareStartup(root,run,true)).toEqual(['install','build']);
      put('apps/web/src/file.ts','failure');
      expect(()=>prepareStartup(root,()=>{throw new Error('isolated build failure');})).toThrow('isolated build failure');
      const state=JSON.parse(readFileSync(path.join(root,'work/startup-state.json'),'utf8'));
      expect(state.source).toBeUndefined(); expect(state.outputs).toBeUndefined();
      expect(prepareStartup(root,run)).toEqual(['build']);
      put('apps/web/package.json','{"dependencies":{"missing":"1"}}');
      expect(()=>prepareStartup(root,()=>{throw new Error('install failed');})).toThrow('install failed');
      expect(JSON.parse(readFileSync(path.join(root,'work/startup-state.json'),'utf8')).dependencies).toBeUndefined();
      expect(calls.length).toBeGreaterThan(10);
    } finally { await removeTestDirectory(root); }
  });
});
