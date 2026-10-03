import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { copyCatalogFixture, createTestDirectory, removeTestDirectory } from '../helpers';
import { addPluginCacheFixture } from '../plugin-fixtures';

test.describe.serial('built application on loopback', () => {
  let processHandle: ChildProcess;
  let directory: string;
  let startupUrl: string;
  let home: string;
  let projectRoot: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('browser-');
    ({ home, project: projectRoot } = await copyCatalogFixture(directory));
    await addPluginCacheFixture(home, projectRoot);
    await mkdir(path.join(directory, 'data'), { recursive: true });
    processHandle = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env, PORT: '0', AGENTDECK_HOME: path.join(directory, 'data'), AGENTDECK_USER_HOME: home,
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        ZCODE_HOME: path.join(home, '.zcode'), DSH_HOME: path.join(home, '.dsh'),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startupUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Built service did not become ready')), 15_000);
      processHandle.once('error', error => { clearTimeout(timeout); reject(error); });
      processHandle.once('exit', code => { clearTimeout(timeout); reject(new Error(`Built service exited (${code}): ${output}`)); });
      processHandle.stderr?.on('data', chunk => { output += chunk.toString(); });
      processHandle.stdout?.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
    });
  });

  test.afterAll(async () => {
    if (processHandle && processHandle.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { processHandle.kill('SIGKILL'); resolve(); }, 3000);
        processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
        processHandle.kill('SIGTERM');
      });
    }
    if (directory) await removeTestDirectory(directory);
  });

  test('shows a connection explanation without a session', async ({ page }) => {
    await page.goto(startupUrl.split('#')[0]!);
    await expect(page.getByRole('heading', { name: '连接你的本机工作区' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  });

  test('uses the ticket, loads demo, previews and applies MCP change, and restores it', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/ticket=/);
    await expect(page.getByRole('button', { name: '扫描本机配置（只读）', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '载入隔离演示数据', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'agentdeck-demo' });
    await expect(row).toBeVisible();
    await expect(row.getByText('已启用', { exact: true })).toBeVisible();
    const filePath = path.join(directory, 'data', 'demo', 'codex', 'config.toml');
    const original = await readFile(filePath);
    await row.getByRole('button', { name: '计划停用', exact: true }).click();
    await expect(page.getByText('脱敏差异', { exact: true })).toBeVisible();
    expect((await readFile(filePath)).equals(original)).toBe(true);
    await page.getByRole('button', { name: '确认应用计划', exact: true }).click();
    await expect(page.getByText('操作结果：succeeded')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认应用计划', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(row.getByText('已停用', { exact: true })).toBeVisible();
    await expect(row.getByText('暂未检测', { exact: true })).toBeVisible();
    await mkdir('work/browser-proof', { recursive: true });
    await page.screenshot({ path: 'work/browser-proof/resources.png', fullPage: true });
    await page.getByRole('button', { name: /^操作记录/ }).click();
    await page.getByRole('button', { name: '创建恢复计划', exact: true }).first().click();
    await expect(page.getByText('配置恢复计划', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认应用计划', exact: true }).click();
    await expect(page.getByText('操作结果：succeeded')).toBeVisible();
    expect((await readFile(filePath)).equals(original)).toBe(true);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await expect(row.getByText('已启用', { exact: true })).toBeVisible();
    await expect(page.getByText('实时事件已连接', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'work/browser-proof/restored.png', fullPage: true });

    await page.getByRole('button', { name: '发现并扫描本机资源', exact: true }).click();
    const docs = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'docs', exact: true }) }).first();
    await expect(docs).toBeVisible();
    await docs.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('来源路径', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(path.join(home, '.codex', 'config.toml'), { exact: true }).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByRole('button', { name: 'Agent 实例', exact: true }).click();
    await page.getByRole('button', { name: '发现客户端', exact: true }).click();
    await expect(page.locator('.instance-card')).toHaveCount(8);
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    const dshGroup = page.getByRole('row').filter({ hasText: '@deepseek-ai/dsh-mcp-client' }).first();
    await expect(dshGroup).toBeVisible();
    await dshGroup.getByRole('button', { name: /展开/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'dsh-docs' })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'work/browser-proof/mcp-filter.png', fullPage: true });

    const search = page.getByPlaceholder('搜索名称或来源路径');
    await search.fill('cached-docs');
    const cachedPlugin = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'fixture-tools', exact: true }) }).first();
    await expect(cachedPlugin).toBeVisible();
    await cachedPlugin.getByRole('button', { name: /展开/ }).click();
    const cachedMcp = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-docs', exact: true }) }).first();
    await expect(cachedMcp).toBeVisible();
    await expect(cachedMcp.getByText('已停用', { exact: true })).toBeVisible();
    await expect(cachedMcp.getByText('暂未检测', { exact: true })).toBeVisible();
    await cachedMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('所属插件', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools/1.0.0/.mcp.json'), { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('fixture-tools@fixture-market', { exact: true }).first()).toBeVisible();
    await expect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(1440);
    await page.screenshot({ path: 'work/browser-proof/cache-source-detail.png', fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await search.fill('locally-disabled');
    const localParent = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'local-mcp-tools', exact: true }) }).first();
    await localParent.getByRole('button', { name: /展开/ }).click();
    const localChild = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'locally-disabled', exact: true }) }).first();
    await expect(localChild.getByText('已停用', { exact: true })).toBeVisible();
    await localChild.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('配置已停用', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('配置已启用', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByRole('button', { name: 'Skill', exact: true }).click();
    await search.fill('cached-review-1.0.0');
    await page.locator('.skill-filters .el-select').nth(3).click();
    await page.getByRole('option', { name: '插件附带', exact: true }).click();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-review-1.0.0', exact: true }) })).toBeVisible();
    await search.fill('unconfigured-review');
    const unconfiguredPlugin = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'fixture-tools', exact: true }) }).first();
    await unconfiguredPlugin.getByRole('button', { name: /展开/ }).click();
    const unconfigured = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'unconfigured-review', exact: true }) });
    await expect(unconfigured).toBeVisible();
    await expect(unconfigured.getByText('未知', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/cache-skill-filter.png', fullPage: true });
    const originSelect = page.locator('.skill-filters .el-select').nth(4);
    await originSelect.click();
    await page.getByRole('option', { name: '配置记录', exact: true }).click();
    await expect(page.getByText('当前筛选没有匹配项', { exact: false })).toBeVisible();
    await originSelect.hover();
    await originSelect.locator('.el-select__clear').click();
    await expect(unconfigured).toBeVisible();

    await page.getByRole('button', { name: '项目空间', exact: true }).click();
    await page.getByRole('button', { name: '登记项目', exact: true }).first().click();
    await page.getByPlaceholder('留空时由服务端生成显示名称').fill('Browser project');
    await page.getByPlaceholder('例如：D:\\work\\my-project').fill(projectRoot);
    await page.getByRole('dialog').getByRole('button', { name: '登记项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: '扫描项目', exact: true }).click();
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await search.fill('project-docs');
    const projectMcp = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'project-docs', exact: true }) }).first();
    await expect(projectMcp).toBeVisible();
    await expect(projectMcp.getByText('项目级', { exact: true })).toBeVisible();
    await projectMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(path.join(projectRoot, '.codex/config.toml'), { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText('项目仓库提供', { exact: true })).toBeVisible();
    await expect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(1440);
    await page.screenshot({ path: 'work/browser-proof/project-source-detail.png', fullPage: true });
    expect(errors).toEqual([]);
  });
});
