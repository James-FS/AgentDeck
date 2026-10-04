import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, copyCatalogFixture, removeTestDirectory, fileTreeDigests } from '../helpers';

test('uses ZCode switches without a plan dialog, changes only flags and isolates public disablement', async ({page}) => {
  test.setTimeout(90_000);
  const directory=await createTestDirectory('zcode-switch-browser');
  const {home}=await copyCatalogFixture(directory);
  const root=path.join(home,'.zcode'); const config=path.join(root,'cli/config.json');
  const desktop=path.join(directory,'ZCode-install');
  await mkdir(path.join(desktop,'resources/glm/packages/bundled-skills/skills/bundled-readonly'),{recursive:true});
  await writeFile(path.join(desktop,'ZCode.exe'),'never-execute');
  await writeFile(path.join(desktop,'resources/glm/zcode.cjs'),'never-execute');
  await writeFile(path.join(desktop,'resources/glm/.node-bundle-meta.json'),JSON.stringify({runtime:'electron-node',entry:'zcode.cjs'}));
  await writeFile(path.join(desktop,'resources/glm/packages/bundled-skills/skills/bundled-readonly/SKILL.md'),'fixture');
  await mkdir(path.join(root,'skills/toggle-local'),{recursive:true});
  await writeFile(path.join(root,'skills/toggle-local/SKILL.md'),'fixture');
  await mkdir(path.join(home,'.agents/skills/toggle-public'),{recursive:true});
  await writeFile(path.join(home,'.agents/skills/toggle-public/SKILL.md'),'fixture');
  for(const name of ['toggle-tools','cache-only']) {
    const pkg=path.join(root,'cli/plugins/cache/official',name,'1.0.0');
    await mkdir(path.join(pkg,'.zcode-plugin'),{recursive:true});
    await writeFile(path.join(pkg,'.zcode-plugin/plugin.json'),JSON.stringify({name}));
  }
  await writeFile(config,JSON.stringify({models:{token:'PRIVATE_UI_SENTINEL',temperature:0.7},mcp:{servers:{'toggle-mcp':{command:'never-execute',env:{TOKEN:'PRIVATE_UI_SENTINEL'}}}},plugins:{enabledPlugins:{'toggle-tools@official':true}}},null,2));
  const initial=await readFile(config); const sourceBefore=await fileTreeDigests(path.join(root,'skills'));
  let server:ChildProcess|undefined;
  try {
    server=spawn(process.execPath,['apps/server/dist/index.js'],{cwd:path.resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,PATH:'',PORT:'0',AGENTDECK_HOME:path.join(directory,'data'),AGENTDECK_USER_HOME:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ZCODE_HOME:root,ZCODE_DESKTOP_ROOT:desktop,DSH_HOME:path.join(home,'.dsh')}});
    const startupUrl=await new Promise<string>((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('startup timeout')),15_000);
      server!.once('error',error=>{clearTimeout(timer);reject(error)});
      server!.stdout?.on('data',chunk=>{output+=chunk.toString();const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    });
    const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.goto(startupUrl);
    await page.getByRole('button',{name:'扫描本机配置（只读）',exact:true}).click();
    await page.locator('.tabs').getByRole('button',{name:'Skill',exact:true}).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('bundled-readonly');
    await expect(page.locator('tbody tr')).toContainText('Agent 内置');
    await expect(page.locator('tbody tr').getByRole('switch')).toHaveCount(0);
    await page.getByRole('button',{name:'bundled-readonly',exact:true}).click();
    await expect(page.getByRole('dialog').getByText('Agent 内置来源证据',{exact:true})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:/Close|关闭/}).first().click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('toggle-local');
    const local=page.locator('tbody tr').filter({has:page.getByRole('button',{name:'toggle-local',exact:true})});
    await expect(page.getByRole('button',{name:'开放启停',exact:true})).toHaveCount(0);
    const localSwitch=local.getByRole('switch',{name:'toggle-local启停',exact:true});
    await expect(localSwitch).toBeAttached();
    expect(await readFile(config)).toEqual(initial);
    for(const [kind,name] of [['Skill','toggle-local'],['MCP','toggle-mcp'],['插件','toggle-tools']]) {
      await page.locator('.tabs').getByRole('button',{name:kind,exact:true}).click();
      await page.getByPlaceholder('搜索名称或来源路径').fill(name!);
      const row=page.locator('tbody tr').filter({has:page.getByRole('button',{name:name!,exact:true})});
      const control=row.getByRole('switch',{name:name+'启停',exact:true});
      await expect(control).toBeChecked(); await control.locator('..').click();
      await expect(row.locator('.config-state')).toHaveText('已禁用');
      await expect(control).not.toBeChecked(); await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(JSON.parse(await readFile(config,'utf8')).models).toEqual({token:'PRIVATE_UI_SENTINEL',temperature:0.7});
      await control.locator('..').click(); await expect(row.locator('.config-state')).toHaveText('已启用');
    }
    await page.getByPlaceholder('搜索名称或来源路径').fill('cache-only');
    await expect(page.locator('tbody tr').getByRole('switch')).toHaveCount(0);
    await expect(page.locator('tbody tr')).toContainText('只读');
    await page.locator('.tabs').getByRole('button',{name:'Skill',exact:true}).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('toggle-public');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button',{name:'toggle-public',exact:true}).click();
    const publicSwitch=page.getByRole('dialog').getByRole('switch',{name:'ZCode公共资源启停',exact:true});
    await publicSwitch.locator('..').click(); await expect(publicSwitch).not.toBeChecked();
    await expect(page.getByRole('dialog').locator('.public-agent-states')).toContainText('有禁用记录：ZCode');
    await expect(page.getByRole('dialog').locator('.detail-grid .config-state')).toHaveText('已启用');
    expect(await fileTreeDigests(path.join(root,'skills'))).toEqual(sourceBefore);
    expect(await readFile(path.join(home,'.agents/skills/toggle-public/SKILL.md'),'utf8')).toBe('fixture');
    expect(errors).toEqual([]);
    await page.screenshot({path:'work/browser-proof/zcode-switches.png',fullPage:true});
  } finally {
    if(server&&server.exitCode===null){server.kill();await new Promise(resolve=>server!.once('exit',resolve));}
    await removeTestDirectory(directory);
  }
});
