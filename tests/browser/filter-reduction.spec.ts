import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('resource filter reduction', () => {
  let server: ChildProcess;
  let directory: string;
  let startupUrl: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('filter-reduction-browser-');
    const home = path.join(directory, 'home');
    await mkdir(home, { recursive: true });
    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: process.cwd(),
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

  test('keeps four filters, compresses the toolbar and converts legacy views explicitly', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(startupUrl);
    await page.getByRole('button', { name: '载入隔离演示数据', exact: true }).click();
    await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
    await mkdir('work/browser-proof', { recursive: true });

    // Exactly four resident filter selects; the technical filters are gone from the
    // toolbar, not hidden, and no standalone display-policy row remains.
    await expect(page.locator('.filter-row .el-select')).toHaveCount(4);
    for (const gone of ['作用范围', '所属 Agent', '配置或文件来源', '资源归类']) {
      await expect(page.locator('.filter-row').getByRole('combobox', { name: gone })).toHaveCount(0);
    }
    await expect(page.getByTestId('saved-views')).toBeVisible();
    await expect(page.getByTestId('display-options')).toContainText('显示选项');
    await expect(page.getByTestId('library-help')).toBeVisible();
    await expect(page.locator('.filter-row .favorites-toggle')).toBeVisible();
    await expect(page.locator('.filter-row').getByRole('textbox', { name: '搜索资源' })).toBeVisible();
    await expect(page.getByText('资源库按唯一资源实体展示', { exact: false })).toHaveCount(0);

    // Seed a legacy saved view carrying conditions the reduced library no longer
    // executes; the record is written directly through the preferences API.
    const csrfToken = await page.evaluate(async () => (await (await fetch('/api/v1/session')).json()).csrfToken as string);
    await page.evaluate(async ({ csrfToken }) => {
      const response = await fetch('/api/v1/resource-preferences', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ favorites: [], display: { showBuiltin: false, showCacheOnly: false }, savedFilters: [{ id: 'legacy-view', name: 'Legacy 技术条件视图',
          filters: { kind: 'all', search: '', scope: ['project'], owner: ['codex'], category: ['agent-global'], origin: 'cache',
            source: [], configuration: [], instanceId: null, projectId: null, favoritesOnly: false, showBuiltin: false, showCacheOnly: false } }] }) });
      if (!response.ok) throw new Error(`Preferences PUT ${response.status}`);
    }, { csrfToken });
    await page.reload();
    await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
    await expect(page.locator('.resource-table tbody tr')).toHaveCount(5);

    // Applying the legacy view keeps every record visible, explains the omitted
    // conditions once, and never rewrites the stored record.
    await page.getByTestId('saved-views').click();
    await page.getByRole('button', { name: 'Legacy 技术条件视图', exact: true }).click();
    await expect(page.getByTestId('saved-views')).toContainText('已保存视图');
    await page.keyboard.press('Escape');
    await expect(page.locator('.resource-table tbody tr')).toHaveCount(5);
    await expect(page.locator('.taxonomy-note').filter({ hasText: '已取消的筛选条件' })).toContainText('使用范围');
    await expect(page.locator('.taxonomy-note').filter({ hasText: '已取消的筛选条件' })).toContainText('所属 Agent');
    await expect(page.locator('.taxonomy-note').filter({ hasText: '已取消的筛选条件' })).toContainText('来源类型');
    const stored = await page.evaluate(async () => (await (await fetch('/api/v1/resource-preferences')).json())) as { savedFilters: Array<{ id: string; filters: { scope: string[]; owner: string[]; origin: string } }> };
    expect(stored.savedFilters).toHaveLength(1);
    expect(stored.savedFilters[0]!.id).toBe('legacy-view');
    expect(stored.savedFilters[0]!.filters.scope).toEqual(['project']);
    expect(stored.savedFilters[0]!.filters.owner).toEqual(['codex']);
    expect(stored.savedFilters[0]!.filters.origin).toBe('cache');

    // Save, apply and delete a view inside the same compact menu; the saved
    // conditions only cover the retained filters with neutral legacy values.
    page.once('dialog', dialog => dialog.accept('My reduced view'));
    await page.getByTestId('saved-views').click();
    await page.getByRole('button', { name: '保存当前视图' }).click();
    await expect(page.getByRole('button', { name: 'My reduced view（当前）', exact: true })).toBeVisible();
    const savedViews = await page.evaluate(async () => (await (await fetch('/api/v1/resource-preferences')).json())) as { savedFilters: Array<{ name: string; filters: Record<string, unknown> }> };
    const reduced = savedViews.savedFilters.find(item => item.name === 'My reduced view')!;
    expect(reduced.filters.scope).toEqual([]);
    expect(reduced.filters.owner).toEqual([]);
    expect(reduced.filters.category).toEqual([]);
    expect(reduced.filters.origin).toBe('all');
    // Manual adjustments clear the current marker without overwriting the view.
    await page.locator('.filter-row .favorites-toggle').click();
    await expect(page.getByRole('button', { name: /^My reduced view$/ })).toBeVisible();
    await page.locator('.filter-row .favorites-toggle').click();
    await page.getByRole('button', { name: '删除视图 My reduced view', exact: true }).click();
    await expect(page.getByRole('button', { name: /^My reduced view/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Display options: two switches, state visible on the button, persisted, and
    // clear-filters leaves the preference untouched.
    await page.getByTestId('display-options').click();
    await page.getByTestId('show-builtin-switch').click();
    await expect(page.getByTestId('display-options')).toContainText('显示选项 · 内置');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('display-options')).toContainText('显示选项 · 内置');
    await page.getByTestId('library-client-filter').click();
    await page.getByRole('option', { name: /Codex Demo/ }).first().click();
    await expect(page.locator('.active-filters')).toContainText('客户端：');
    await page.getByLabel('搜索资源').fill('agentdeck-demo');
    await page.locator('.active-filters').getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.locator('.active-filters')).toHaveCount(0);
    await expect(page.getByTestId('display-options')).toContainText('显示选项 · 内置');
    await page.reload();
    await expect(page.getByTestId('display-options')).toContainText('显示选项 · 内置');

    // Keyboard access: the saved-views menu opens from the keyboard and exposes
    // named save/apply/delete actions.
    await page.getByTestId('display-options').click();
    await page.getByTestId('show-builtin-switch').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('saved-views').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu', { name: '已保存视图菜单' })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存当前视图' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Both window sizes: the reduced toolbar wraps naturally without horizontal scroll.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator('.filter-row .el-select')).toHaveCount(4);
    await page.screenshot({ path: 'work/browser-proof/filter-reduction-1920x1080.png', fullPage: false });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(300);
    await expect(page.locator('.filter-row .el-select')).toHaveCount(4);
    const toolbarScroll = await page.locator('.filter-row').evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    expect(toolbarScroll).toBe(false);
    await page.screenshot({ path: 'work/browser-proof/filter-reduction-1366x768.png', fullPage: false });
  });
});
