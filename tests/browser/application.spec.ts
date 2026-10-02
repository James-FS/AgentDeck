import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { copyCatalogFixture, createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('built application on loopback', () => {
  let processHandle: ChildProcess;
  let directory: string;
  let startupUrl: string;
  let home: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('browser-');
    ({ home } = await copyCatalogFixture(directory));
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
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/ticket=/);
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
    await expect(row.getByText('等待生效', { exact: true })).toBeVisible();
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
  });
});
