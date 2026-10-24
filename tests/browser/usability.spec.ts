import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('usability and performance', () => {
  let server: ChildProcess;
  let directory: string;
  let startupUrl: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('phase-three-browser-');
    const home = path.join(directory, 'home');
    await mkdir(home, { recursive: true });
    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, PORT: '0', AGENTDECK_HOME: path.join(directory, 'data'), AGENTDECK_USER_HOME: home,
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZCODE_HOME: path.join(home, '.zcode'), DSH_HOME: path.join(home, '.dsh') },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    startupUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Built AgentDeck server did not start')), 15_000);
      server.stdout?.on('data', chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
      server.stderr?.on('data', chunk => { output += chunk.toString(); });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null) await new Promise<void>(resolve => { server.once('exit', () => resolve()); server.kill('SIGTERM'); setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); resolve(); }, 4_000); });
    if (directory) await removeTestDirectory(directory);
  });


  test('measures isolated records and captures responsive layouts', async ({page, browserName}) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      const Native = window.EventSource;
      class ObservableEvents extends Native {
        constructor(url: string | URL, options?: EventSourceInit) { super(url,options); Object.assign(window,{__catalogEvents:this}); }
      }
      window.EventSource = ObservableEvents;
    });
    const metadataReads:string[]=[];
    page.on('request',request=>{if (/\/(adapters|compatibility|resource-preferences)$/.test(request.url())) metadataReads.push(request.url());});
    await page.goto(startupUrl);
    await page.getByRole('button',{name:'载入隔离演示数据',exact:true}).click();
    await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
    const baseline = await page.evaluate(async()=> (await fetch('/api/v1/catalog')).json());
    const template = baseline.bindings.find((binding:{kind:string})=>binding.kind==='skill');
    let count=100;
    let reads=0;
    let holdNext=false;
    let releaseCatalog: (()=>void) | undefined;
    const generated = () => ({...baseline, skillSources:[], bindings:Array.from({length:count},(_,index)=>({
      ...template, id:`performance-${index}`,name:`perf-${String(index).padStart(4,'0')}`,displayName:`perf-${String(index).padStart(4,'0')}`,
      sourcePath:`D:\\isolated\\${index}\\SKILL.md`,discoveryPath:`D:\\isolated\\${index}`,physicalSource:undefined,
      parentId:null,projectId:null,writable:false,diagnostics:[],
    }))});
    await page.route('**/api/v1/catalog', async route=>{reads++; if(holdNext){holdNext=false; await new Promise<void>(resolve=>{releaseCatalog=resolve;});} return route.fulfill({json:generated()});});
    await page.route('**/api/v1/skills/search?*',route=>route.fulfill({json:{query:'perf',offset:0,pageSize:30,nextOffset:30,totalCandidates:count,examined:30,failures:0,truncated:true,matches:[]}}));
    const measures=[];
    await mkdir('work/browser-proof',{recursive:true});
    for (count of [100,1000]) {
      await page.getByLabel('搜索资源').fill('');
      const started=Date.now();
      await page.getByRole('button',{name:'刷新当前页面数据',exact:true}).click();
      await expect(page.locator('.resource-table tbody tr')).toHaveCount(Math.min(count,50));
      const refreshMs=Date.now()-started;
      const filterMs=await page.evaluate(async()=>{
        const input=document.querySelector<HTMLInputElement>('input[aria-label="搜索资源"]')!;
        const start=performance.now(); input.value='perf-0000'; input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return performance.now()-start;
      });
      await expect(page.locator('.resource-table tbody tr')).toHaveCount(1);
      await page.getByLabel('搜索资源').fill('');
      await expect(page.locator('.resource-table tbody tr')).toHaveCount(Math.min(count,50));
      const scroll=await page.evaluate(async()=>{
        const container=document.querySelector('.content')!; const frames:number[]=[];
        let previous=performance.now();
        for(let index=0;index<30;index++) {
          container.scrollTop=index*160;
          await new Promise(requestAnimationFrame); const now=performance.now(); frames.push(now-previous); previous=now;
        }
        container.scrollTop=0; frames.sort((a,b)=>a-b); return {median:frames[15],p95:frames[28]};
      });
      measures.push({records:count,refreshMs,filterMs,scroll});
    }
    // Each screenshot uses the CSS viewport available at the stated browser zoom.
    for (const [width,height] of [[1280,800],[1440,900]]) for (const zoom of [1,1.25]) {
      await page.setViewportSize({width:Math.round(width!/zoom),height:Math.round(height!/zoom)});
      await page.locator('.content').evaluate(element=>{element.scrollTop=0;});
      await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await page.locator('.resource-table .tag').evaluateAll(tags=>tags.every(tag=>{
        const cell=tag.closest('td'); return !cell || tag.getBoundingClientRect().right <= cell.getBoundingClientRect().right;
      }))).toBe(true);
      await page.screenshot({path:`work/browser-proof/usability-${width}x${height}-${zoom}.png`});
    }
    const beforeEvents=reads; const beforeMetadata=metadataReads.length;
    const emit = () => page.evaluate(()=>{
      const events=(window as unknown as {__catalogEvents:EventSource}).__catalogEvents;
      events.dispatchEvent(new Event('catalog.changed')); events.dispatchEvent(new Event('operation.completed'));
    });
    await emit(); await expect.poll(()=>reads).toBe(beforeEvents+1);
    // Hold a read, deliver another event while it is running, then release it.
    holdNext=true; await emit(); await expect.poll(()=>reads).toBe(beforeEvents+2);
    await emit(); await new Promise(resolve=>setTimeout(resolve,150));
    releaseCatalog?.(); await expect.poll(()=>reads).toBe(beforeEvents+3);
    expect(metadataReads.length).toBe(beforeMetadata);
    await page.unroute('**/api/v1/skills/search?*');
    let oldRequested!:()=>void; const requested=new Promise<void>(resolve=>{oldRequested=resolve;});
    let oldFinished!:()=>void; const finished=new Promise<void>(resolve=>{oldFinished=resolve;});
    await page.route('**/api/v1/skills/search?*',async route=>{
      const query=new URL(route.request().url()).searchParams.get('q') ?? '';
      const old=query==='older-query';
      if(old){oldRequested();await new Promise(resolve=>setTimeout(resolve,700));}
      await route.fulfill({json:{query,offset:0,pageSize:30,nextOffset:30,totalCandidates:1000,examined:30,failures:0,truncated:true,
        matches:[{key:`binding:performance-${old?9:7}`,bindingId:`performance-${old?9:7}`,name:old?'old':'new',snippet:query}]}}).catch(()=>undefined);
      if(old)oldFinished();
    });
    await page.getByLabel('搜索资源').fill('older-query'); await requested;
    await page.getByLabel('搜索资源').fill('newer-query');
    await expect(page.locator('.resource-table')).toContainText('perf-0007');
    await finished;
    await expect(page.locator('.resource-table')).not.toContainText('perf-0009');
    await expect(page.locator('.skill-search-results')).toContainText('已检查 30/1000');
    await mkdir('work/browser-proof',{recursive:true});
    await writeFile('work/browser-proof/usability-performance.json',JSON.stringify({browserName,version:page.context().browser()?.version(),viewport:page.viewportSize(),measures,reads},null,2));
  });
});
