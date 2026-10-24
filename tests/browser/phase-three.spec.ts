import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('third phase resource workflow', () => {
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

  test('scans, watches, favorites, saves filters, and compares isolated Skills', async ({ page }) => {
    test.setTimeout(90_000);
    const library = path.join(directory, 'library');
    const first = path.join(library, 'first', 'SKILL.md');
    await mkdir(path.dirname(first), { recursive: true });
    await writeFile(first, '---\nname: first-skill\ndescription: First sample.\n---\nfirst body');
    await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await page.getByRole('button',{name:'来源与扫描',exact:true}).click();
    await page.getByLabel('Skill 目录路径').fill(library);
    await page.getByRole('button', { name: '添加并扫描', exact: true }).click();
    const source = page.locator('.source-report').filter({ hasText: library });
    await expect(source).toContainText('1 项资源');
    await source.locator('.el-switch').click();
    await expect(source).toContainText('自动更新：已开启');

    const second = path.join(library, 'second', 'SKILL.md');
    const third = path.join(library, 'third', 'SKILL.md');
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(second, '---\nname: second-skill\ndescription: Second sample.\n---\nsecond body');
    await mkdir(path.dirname(third), { recursive: true });
    await writeFile(third, '---\nname: third-skill\ndescription: Third sample.\n---\nthird body');
    await page.getByRole('button',{name:'资源库',exact:true}).click();
    const inventory = page.locator('.resource-table');
    await expect(inventory).toContainText('second-skill', { timeout: 8_000 });
    const firstEntry = inventory.locator('tbody tr').filter({ hasText: 'first-skill' });
    const secondEntry = inventory.locator('tbody tr').filter({ hasText: 'second-skill' });
    await expect(inventory).toContainText('third-skill');
    await firstEntry.getByRole('button', {name:'收藏资源'}).click();
    await secondEntry.getByRole('button', {name:'收藏资源'}).click();
    await page.locator('.filter-row .favorites-toggle').click();
    await expect(inventory).toContainText('first-skill');
    await expect(inventory).toContainText('second-skill');
    await expect(inventory).not.toContainText('third-skill');

    const viewsButton = page.getByTestId('saved-views');
    page.once('dialog', dialog => dialog.accept('Phase three saved filter'));
    await viewsButton.click();
    await page.getByRole('button', { name: '保存当前视图' }).click();
    const savedItem = page.getByRole('button', { name: 'Phase three saved filter（当前）', exact: true });
    await expect(savedItem).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await viewsButton.click();
    await page.getByRole('button', { name: 'Phase three saved filter', exact: true }).click();
    await expect(page.locator('.resource-table')).toContainText('first-skill');
    await expect(page.locator('.resource-table')).toContainText('second-skill');
    await expect(page.locator('.resource-table')).not.toContainText('third-skill');
    await page.getByRole('button', { name: '删除视图 Phase three saved filter', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Phase three saved filter/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('.filter-row .favorites-toggle').click();

    const refreshedInventory = page.locator('.resource-table');
    await refreshedInventory.locator('tbody tr').filter({ hasText:'first-skill' }).getByRole('button',{name:'first更多操作'}).press('Enter');
    await page.getByRole('menuitem',{name:'加入对比'}).last().click();
    await refreshedInventory.locator('tbody tr').filter({ hasText:'second-skill' }).getByRole('button',{name:'second更多操作'}).click();
    await page.getByRole('menuitem',{name:'加入对比'}).last().click();
    await page.getByRole('button', { name: '对比已选 Skill' }).click();
    const comparison = page.getByRole('dialog', { name: 'Skill 对比' });
    await expect(comparison).toContainText('manifest 内容相同：否');
    await expect(comparison).toContainText('first body');
    await expect(comparison).toContainText('second body');
    await expect(comparison.locator('.line-diff .changed')).toHaveCount(1);
    await comparison.getByRole('button',{name:'下一处差异'}).click();
    await page.screenshot({path:'work/browser-proof/usability-compare.png',animations:'disabled'});
    await comparison.getByRole('button',{name:'关闭',exact:true}).click();
    await expect(comparison).toBeHidden();
    const name = refreshedInventory.getByRole('button',{name:'first',exact:true});
    await name.press('Enter');
    await expect(page.getByRole('dialog',{name:'Skill 详情'})).toContainText('first body');
    await page.screenshot({path:'work/browser-proof/usability-detail.png',animations:'disabled'});
    await page.keyboard.press('Escape');
    await expect(name).toBeFocused();
  });
});
