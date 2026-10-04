import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, copyCatalogFixture, removeTestDirectory } from '../helpers';

test('switches Claude and DSH user plugins directly while preserving unrelated configuration', async ({ page }) => {
  test.setTimeout(90_000);
  const directory = await createTestDirectory('profile-switch-browser');
  const { home } = await copyCatalogFixture(directory);
  const claude = path.join(home, '.claude/settings.json');
  const dsh = path.join(home, '.dsh/profiles/switches/cordis.patch.yml');
  const claudeText = '{"enabledPlugins":{"claude-toggle@fixture":true},"env":{"TOKEN":"PRIVATE_UI_SENTINEL"}}\n';
  const dshText = '# retain\r\n- id: browser-toggle\r\n  name: dsh-toggle\r\n  disabled: false # keep\r\n  config: {token: PRIVATE_UI_SENTINEL}\r\n';
  await mkdir(path.dirname(dsh), { recursive: true });
  await writeFile(claude, claudeText); await writeFile(dsh, dshText);
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, ['apps/server/dist/index.js'], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'], windowsHide: true,
      env: { ...process.env, PATH: '', PORT: '0', AGENTDECK_HOME: path.join(directory,'data'), AGENTDECK_USER_HOME: home,
        CODEX_HOME: path.join(home,'.codex'), CLAUDE_CONFIG_DIR: path.join(home,'.claude'), ZCODE_HOME: path.join(home,'.zcode'), DSH_HOME: path.join(home,'.dsh'),
        ZCODE_DESKTOP_ROOT: path.join(directory, 'absent-desktop') } });
    const url = await new Promise<string>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('startup timeout')), 15_000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.stdout?.on('data', chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: '扫描本机配置（只读）', exact: true }).click();
    await page.locator('.tabs').getByRole('button', { name: '插件', exact: true }).click();
    for (const name of ['claude-toggle', 'dsh-toggle']) {
      await page.getByPlaceholder('搜索名称或来源路径').fill(name);
      const row = page.locator('tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });
      const control = row.getByRole('switch', { name: name+'启停', exact: true });
      await expect(control).toBeChecked(); await control.locator('..').click();
      await expect(row.locator('.config-state')).toHaveText('已禁用');
      await expect(control).not.toBeChecked(); await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await readFile(name === 'claude-toggle' ? claude : dsh, 'utf8')).toBe(name === 'claude-toggle'
        ? claudeText.replace('true','false') : dshText.replace('disabled: false','disabled: true'));
      await control.locator('..').click(); await expect(control).toBeChecked();
    }
    expect(await readFile(claude,'utf8')).toBe(claudeText); expect(await readFile(dsh,'utf8')).toBe(dshText);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'work/browser-proof/profile-switches.png', fullPage: true });
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server!.once('exit',resolve)); }
    await removeTestDirectory(directory);
  }
});
