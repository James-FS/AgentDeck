import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from '../helpers';

test('shows client evidence and keeps native validation separate from permissions and transport', async ({ page }) => {
  test.skip(process.platform !== 'win32', 'Uses a Windows CMD fixture, not an installed-client assertion.');
  test.setTimeout(60_000);
  const directory = await createTestDirectory('compatibility-browser-');
  const { home } = await copyCatalogFixture(directory);
  const bin = path.join(directory, 'shim bin 中文');
  const shim = path.join(bin, 'codex.cmd');
  const configFile = path.join(home, '.codex/config.toml');
  await mkdir(bin, { recursive: true });
  await writeFile(shim, '@echo off\r\necho codex-cli 0.159.2\r\n');
  await writeFile(configFile, Buffer.concat([await readFile(configFile), Buffer.from('\n[mcp_servers.compatibility-stdio]\ncommand = "node"\nargs = ["never-start.cjs"]\nenabled = true\n')]));
  const before = await fileTreeDigests(home);
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: bin, PATHEXT: '.CMD', PORT: '0', AGENTDECK_HOME: path.join(directory, 'data'), AGENTDECK_USER_HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ZCODE_HOME: path.join(home, '.zcode'), DSH_HOME: path.join(home, '.dsh') },
    });
    const startupUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Compatibility UI server did not start')), 15_000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.once('exit', code => { clearTimeout(timer); reject(new Error(`Compatibility server exited (${code})`)); });
      server!.stdout?.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(startupUrl);
    await page.getByRole('button', { name: '扫描本机配置（只读）', exact: true }).click();
    await expect(page.locator('.resource-detail-link').first()).toBeVisible();
    await page.getByRole('button', { name: /^Agent 实例/ }).click();
    const codex = page.locator('.instance-card').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) });
    await expect(codex).toBeVisible();
    await codex.getByRole('button', { name: /检查.*版本/ }).click();
    await expect(codex.getByText('0.159.2', { exact: false }).first()).toBeVisible();
    await codex.locator('summary').click();
    await codex.locator('summary').click();
    const response = await page.request.get(new URL('/api/v1/compatibility', startupUrl).href);
    const report = await response.json();
    const client = report.clients.find((row: { agentId: string; instanceId: string | null }) => row.agentId === 'codex' && row.instanceId);
    expect(client.status).toBe('verified-client');
    expect(client.capabilities.filter((item: { area: string; status: string; resourceKind: string }) => item.area === 'native-config' && item.status === 'verified' && item.resourceKind === 'mcp')).toHaveLength(1);
    expect(client.capabilities.some((item: { area: string; writable: boolean }) => item.area === 'fixture-validation' && item.writable)).toBe(true);
    expect(report.clients.find((row: { agentId: string }) => row.agentId === 'zcode').status).toBe('configuration-only');
    await page.reload();
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Agent 实例/ }).click();
    await expect(codex.getByText('0.159.2', { exact: false }).first()).toBeVisible();
    await mkdir('work/browser-proof', { recursive: true });
    await page.screenshot({ path: 'work/browser-proof/compatibility-matrix.png', fullPage: true });
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('compatibility-stdio');
    const stdio = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'compatibility-stdio', exact: true }) });
    await expect(stdio).toBeVisible();
    await stdio.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(/STDIO/).first()).toBeVisible();
    await expect(page.getByRole('dialog').locator('.evidence-head b').filter({ hasText: /^原生配置复读 · 已验证/ })).toBeVisible();
    await expect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(1440);
    await page.screenshot({ path: 'work/browser-proof/compatibility-source-detail.png', fullPage: true });
    await page.getByRole('button', { name: /Close|关闭此对话框|关闭/ }).last().click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByPlaceholder('搜索名称或来源路径').fill('docs');
    const http = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'docs', exact: true }) }).first();
    await http.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(configFile, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('dialog').locator('.evidence-head b').filter({ hasText: /^夹具验证 · 已验证/ })).toBeVisible();
    await expect(page.getByRole('dialog').locator('.evidence-head b').filter({ hasText: /^原生配置复读 · 未验证/ })).toBeVisible();
    await expect(page.getByRole('dialog').locator('.evidence-head b').filter({ hasText: /^原生配置复读 · 已验证/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Close|关闭此对话框|关闭/ }).last().click();
    await page.getByRole('button', { name: /^Agent 实例/ }).click();
    await writeFile(shim, '@echo off\r\necho unrelated-client PRIVATE_STDOUT_SENTINEL\r\n');
    await codex.getByRole('button', { name: /检查.*版本/ }).click();
    await expect(codex.getByText(/版本未知/).first()).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_STDOUT_SENTINEL');
    expect(await page.locator('body').innerText()).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect(await fileTreeDigests(home)).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    if (server && server.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { server!.kill('SIGKILL'); resolve(); }, 3000);
        server!.once('exit', () => { clearTimeout(timer); resolve(); });
        server!.kill('SIGTERM');
      });
    }
    expect(await fileTreeDigests(home)).toEqual(before);
    await removeTestDirectory(directory);
  }
});
