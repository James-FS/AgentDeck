import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, copyCatalogFixture, removeTestDirectory } from '../helpers';

test('folds one MCP service across Agent/project bindings and switches only the chosen binding', async ({page}) => {
  test.setTimeout(90_000);
  const directory = await createTestDirectory('mcp-group-browser');
  const { home, project } = await copyCatalogFixture(directory);
  const entry = path.join(directory,'services/codely-unity/server.mjs');
  const blenderEntry = path.join(directory,'blender/Scripts/mcp-for-blender.exe');
  const blenderMetadata = path.join(directory,'blender/Lib/site-packages/mcp_for_blender-2.0.4.dist-info');
  await mkdir(path.dirname(blenderEntry),{recursive:true}); await writeFile(blenderEntry,'never execute Blender');
  await mkdir(blenderMetadata,{recursive:true});
  await writeFile(path.join(blenderMetadata,'METADATA'),'Name: mcp-for-blender\nVersion: 2.0.4\nProject-URL: Homepage, https://github.com/ahujasid/blender-mcp\n');
  await writeFile(path.join(blenderMetadata,'entry_points.txt'),'[console_scripts]\nmcp-for-blender = blender_mcp.server:main\n');
  const codex = path.join(home,'.codex/config.toml'), zcode = path.join(home,'.zcode/cli/config.json');
  const claude = path.join(project,'.mcp.json');
  await mkdir(path.dirname(entry),{recursive:true}); await writeFile(entry,'never execute');
  const declaration = {command:'node',args:[entry],env:{TOKEN:'PRIVATE_GROUP_SECRET'}};
  const codexText = `[mcp_servers.codely-unity]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n[mcp_servers.codely-unity.env]\nTOKEN = "PRIVATE_GROUP_SECRET"\n[mcp_servers.blender]\ncommand = ${JSON.stringify(blenderEntry)}\nargs = []\n`;
  await writeFile(codex,codexText);
  await writeFile(zcode,JSON.stringify({mcp:{servers:{'codely-unity':declaration,blender:{command:'uvx',args:['blender-mcp'],enable:false}}}}));
  const claudeText = JSON.stringify({mcpServers:{'codely-unity':{...declaration,env:{TOKEN:'DIFFERENT_GROUP_SECRET'}}}});
  await writeFile(claude,claudeText);
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath,['apps/server/dist/index.js'],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,PATH:'',PORT:'0',AGENTDECK_HOME:path.join(directory,'data'),AGENTDECK_USER_HOME:home,
        CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ZCODE_HOME:path.join(home,'.zcode'),DSH_HOME:path.join(home,'.dsh'),ZCODE_DESKTOP_ROOT:path.join(directory,'absent')}});
    const url = await new Promise<string>((resolve,reject)=>{
      let output=''; const timer=setTimeout(()=>reject(new Error('startup timeout')),15_000);
      server!.once('error',error=>{clearTimeout(timer);reject(error)});
      server!.stdout?.on('data',chunk=>{output+=chunk.toString(); const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/); if(match){clearTimeout(timer);resolve(match[0]);}});
    });
    const session = page.waitForResponse(response=>response.url().endsWith('/api/v1/session/bootstrap') && response.ok());
    await page.goto(url); const csrfToken=(await (await session).json()).csrfToken as string;
    await page.getByRole('button',{name:'扫描本机配置（只读）',exact:true}).click();
    await page.evaluate(async ({rootPath,csrfToken})=>{
      const headers={'content-type':'application/json','x-csrf-token':csrfToken};
      const registered=await fetch('/api/v1/projects',{method:'POST',headers,body:JSON.stringify({rootPath,name:'MCP project'})});
      if(!registered.ok)throw new Error('registration failed');
      const scan=await fetch('/api/v1/scans',{method:'POST',headers,body:JSON.stringify({scanRegisteredProjects:true})});
      if(!scan.ok)throw new Error('scan failed');
    },{rootPath:project,csrfToken});
    await page.getByRole('button',{name:'刷新资源',exact:true}).click();
    await page.locator('.tabs').getByRole('button',{name:'MCP',exact:true}).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('codely-unity');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody')).toContainText('3 条绑定');
    await expect(page.locator('tbody')).toContainText('配置不同（2 组）');
    await expect(page.locator('tbody')).toContainText('Claude Code');
    await expect(page.locator('tbody')).toContainText('项目级');
    await expect(page.locator('tbody tr').getByRole('switch')).toHaveCount(0);
    await page.getByRole('button',{name:'codely-unity服务详情',exact:true}).click();
    await expect(page.getByRole('dialog').locator('.mcp-agent-bindings .plan-path')).toHaveCount(3);
    await expect(page.getByRole('dialog')).toContainText(entry);
    await expect(page.getByRole('dialog')).not.toContainText('PRIVATE_GROUP_SECRET');
    await expect(page.getByRole('dialog')).not.toContainText('DIFFERENT_GROUP_SECRET');
    await page.getByRole('dialog').getByRole('button',{name:/Close|关闭/}).first().click();
    await page.getByRole('button',{name:'展开 MCP 绑定',exact:true}).click();
    await expect(page.locator('tbody tr')).toHaveCount(4);
    const zcodeRow=page.locator('tbody tr').filter({has:page.getByRole('button',{name:'codely-unity · ZCode · 配置绑定',exact:true})});
    const control=zcodeRow.getByRole('switch',{name:'codely-unity启停',exact:true});
    await expect(control).toBeChecked(); await control.locator('..').click(); await expect(control).not.toBeChecked();
    expect(await readFile(codex,'utf8')).toBe(codexText); expect(await readFile(claude,'utf8')).toBe(claudeText);
    expect(await readFile(entry,'utf8')).toBe('never execute');
    expect(JSON.parse(await readFile(zcode,'utf8')).mcp.servers['codely-unity']).toEqual({...declaration,enable:false});
    const header=page.locator('tbody tr').filter({has:page.getByRole('button',{name:'codely-unity',exact:true})});
    await expect(header.locator('.config-state')).toHaveText('未确定');
    await page.getByRole('button',{name:'收起 MCP 绑定',exact:true}).click();
    await page.locator('.table-scroll').evaluate(element=>{element.scrollLeft=0;});
    await page.screenshot({path:'work/browser-proof/mcp-service-group.png',fullPage:true});
    await page.getByPlaceholder('搜索名称或来源路径').fill('blender');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody')).toContainText('2 条绑定');
    await page.getByRole('button',{name:'blender服务详情',exact:true}).click();
    const blenderDialog = page.getByRole('dialog');
    await expect(blenderDialog.locator('.mcp-agent-bindings .plan-path')).toHaveCount(2);
    await expect(blenderDialog).toContainText('2.0.4');
    await expect(blenderDialog).toContainText('实际解析版本未验证');
    await expect(blenderDialog).toContainText(blenderEntry);
    await expect(blenderDialog.locator('.plan-path').filter({hasText:'ZCode'}).locator('.config-state')).toHaveText('已禁用');
    await expect(blenderDialog.locator('.plan-path').filter({hasText:'Codex'}).locator('.config-state')).toHaveText('已启用');
    expect(await readFile(blenderEntry,'utf8')).toBe('never execute Blender');
  } finally {
    if(server&&server.exitCode===null){server.kill();await new Promise(resolve=>server!.once('exit',resolve));}
    await removeTestDirectory(directory);
  }
});
