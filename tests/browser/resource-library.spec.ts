import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('resource library layout and scale', () => {
  let server: ChildProcess;
  let directory: string;
  let startupUrl: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('library-browser-');
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

  test('captures display policy, detail dialogs and both window sizes with 1,000 isolated records', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(startupUrl);
    await page.getByRole('button', { name: '载入隔离演示数据', exact: true }).click();
    await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
    await mkdir('work/browser-proof', { recursive: true });

    // Display policy row: default hides verified built-ins; switches persist via preferences.
    await page.getByTestId('display-options').click();
    await expect(page.getByTestId('display-policy')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.screenshot({ path: 'work/browser-proof/library-1920x1080.png', fullPage: false });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(300);
    // Notebook width: core name, state and actions stay usable without horizontal scrolling.
    const tableScroll = page.locator('.table-scroll');
    await expect(tableScroll).toBeVisible();
    const horizontalOverflow = await tableScroll.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(horizontalOverflow).toBe(false);
    await page.screenshot({ path: 'work/browser-proof/library-1366x768.png', fullPage: false });

    // Long paths and full evidence live in the detail dialog, not the main table.
    await page.getByLabel('搜索资源').fill('');
    const firstRow = page.locator('.resource-table tbody tr').first();
    await firstRow.locator('.resource-detail-link').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'work/browser-proof/library-detail-1366x768.png', fullPage: false });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();

    // Scale: 1,000 isolated records through the same entity pipeline with pagination.
    const baseline = await page.evaluate(async () => (await fetch('/api/v1/catalog')).json());
    const template = baseline.bindings.find((binding: { kind: string }) => binding.kind === 'skill');
    const generated = () => ({ ...baseline, skillSources: [], bindings: Array.from({ length: 1000 }, (_, index) => ({
      ...template, id: `scale-${index}`, name: `scale-${String(index).padStart(4, '0')}`, displayName: `scale-${String(index).padStart(4, '0')}`,
      sourcePath: `D:\\isolated\\${index}\\SKILL.md`, discoveryPath: `D:\\isolated\\${index}`,
      parentId: null, projectId: null, writable: false, diagnostics: [],
    })) });
    await page.route('**/api/v1/catalog', route => route.fulfill({ json: generated() }));
    const started = Date.now();
    await page.getByRole('button', { name: '刷新当前页面数据', exact: true }).click();
    await expect(page.locator('.resource-table tbody tr')).toHaveCount(50);
    const refreshMs = Date.now() - started;
    await expect(page.getByRole('button', { name: '全部' })).toContainText('1000');
    await page.screenshot({ path: 'work/browser-proof/library-scale-1366x768.png', fullPage: false });
    // Search across the isolated records stays responsive and paginated rows stay stable.
    await page.getByLabel('搜索资源').fill('scale-0999');
    await expect(page.locator('.resource-table tbody tr').filter({ hasText: 'scale-0999' })).toHaveCount(1);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'work/browser-proof/library-scale-1920x1080.png', fullPage: false });
    console.log(`library-scale: refresh-to-50-rows=${refreshMs}ms at 1366x768`);
  });
});
