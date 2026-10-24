import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from '../helpers';
import { addPluginCacheFixture } from '../plugin-fixtures';

test('combines scope and owning Agent for Skill, MCP and plugin inventory', async ({ page }) => {
  test.setTimeout(90_000);
  const directory = await createTestDirectory('classification-browser');
  const { home, project } = await copyCatalogFixture(directory);
  await addPluginCacheFixture(home, project);
  const zcodeSettingsPath = path.join(home, '.zcode/cli/config.json');
  const zcodeSettings = JSON.parse(await readFile(zcodeSettingsPath, 'utf8')) as Record<string, unknown>;
  await writeFile(zcodeSettingsPath, JSON.stringify({ ...zcodeSettings, plugins: { enabledPlugins: { 'computer-use@official': true } },
    skills: { [path.join(home, '.agents/skills/user-library/SKILL.md')]: { enable: false } },
    mcp: { servers: { ...((zcodeSettings.mcp as { servers: Record<string, unknown> }).servers), 'status-probe-on': { command: 'fixture-only-on' },
      'status-probe-off': { command: 'fixture-only-off', enable: false }, 'status-probe-unknown': { command: 'fixture-only-unknown', enable: 'invalid' } } } }));
  for (const version of ['0.5.13', '0.5.14', '0.6.1', '0.6.3']) {
    const pkg = path.join(home, '.zcode/cli/plugins/cache/official/computer-use', version);
    await mkdir(path.join(pkg, '.zcode-plugin'), { recursive: true });
    await writeFile(path.join(pkg, '.zcode-plugin/plugin.json'), JSON.stringify({ name: 'computer-use', version }));
    await mkdir(path.join(pkg, 'skills/computer-use'), { recursive: true });
    await writeFile(path.join(pkg, 'skills/computer-use/SKILL.md'), 'fixture');
  }
  const claudeSettingsPath = path.join(home, '.claude/settings.json');
  const claudeSettings = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as Record<string, unknown>;
  await writeFile(claudeSettingsPath, JSON.stringify({ ...claudeSettings, skillOverrides: { 'manual-only': 'user-invocable-only', 'name-only': 'name-only' } }));
  for (const name of ['manual-only', 'name-only']) {
    await mkdir(path.join(home, '.claude/skills', name), { recursive: true });
    await writeFile(path.join(home, '.claude/skills', name, 'SKILL.md'), 'fixture');
  }
  await mkdir(path.join(home, '.agents', 'skills', 'user-library'), { recursive: true });
  await writeFile(path.join(home, '.agents', 'skills', 'user-library', 'SKILL.md'), 'fixture');
  await writeFile(path.join(home, '.codex', 'plugins', 'cache', 'other-market', 'fixture-tools', '.codex-remote-plugin-install.json'), JSON.stringify({ schema_version: 1, remote_plugin_id: 'synthetic-plugin-id' }));
  const before = await fileTreeDigests(home);
  const beforeProject = await fileTreeDigests(project);
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '', PORT: '0', AGENTDECK_HOME: path.join(directory, 'data'), AGENTDECK_USER_HOME: home,
        CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        ZCODE_HOME: path.join(home, '.zcode'), DSH_HOME: path.join(home, '.dsh') },
    });
    const startupUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Classification server timeout')), 15_000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code})`)); });
      server!.stdout?.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(startupUrl);
    await page.locator('.empty').getByRole('button', { name: '发现客户端' }).click();
    await expect(page.locator('.resource-detail-link').first()).toBeVisible();
    const csrfToken = await page.evaluate(async () => (await (await fetch('/api/v1/session')).json()).csrfToken as string);
    await page.evaluate(async ({ rootPath, csrfToken }) => {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: '分类验收项目', rootPath }) });
      if (!response.ok) throw new Error(`Project registration ${response.status}`);
      await response.json();
      const scan = await fetch('/api/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ scanRegisteredProjects: true }) });
      if (!scan.ok) throw new Error(`Project scan ${scan.status}`);
    }, { rootPath: project, csrfToken });
    await page.getByRole('button', { name: '刷新当前页面数据', exact: true }).click();
    await expect(page.getByTestId('resource-source-filter')).toBeVisible();
    // Only four filters remain: 0 关联客户端, 1 项目范围, 2 资源来源, 3 配置状态.
    async function select(index: number, label: string) {
      const input = page.locator('.filter-row .el-select').nth(index).getByRole('combobox');
      await input.focus();
      await input.press('ArrowDown');
      await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
      await page.getByRole('option', { name: label, exact: true }).click();
      await page.keyboard.press('Escape');
    }
    // Configuration states stay per real binding: filtering by a state shows exactly
    // the matching rows, including the grouped MCP entry only when it matches.
    await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    for (const [probe, label] of [['status-probe-on', '已启用'], ['status-probe-off', '已禁用'], ['status-probe-unknown', '未确定']] as const) {
      await page.getByLabel('搜索资源').fill(probe);
      await select(3, label);
      const states = await page.locator('.config-state').allTextContents();
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state.trim() === label)).toBe(true);
      if (label === '未确定') await expect(page.locator('.config-state.unknown').first()).toHaveCSS('color', 'rgb(96, 110, 102)');
      await page.getByRole('button', { name: '清除筛选', exact: true }).click();
      await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    }
    // Plugin identity row: configuration record visible, cache versions in detail.
    await page.getByLabel('搜索资源').fill('');
    await select(0, /ZCode · /);
    await page.locator('.tabs').getByRole('button', { name: '插件', exact: true }).click();
    await page.getByLabel('搜索资源').fill('computer-use');
    const pluginRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'computer-use', exact: true }) });
    await expect(pluginRow).toHaveCount(1);
    await expect(pluginRow.getByText('4 条缓存记录', { exact: false })).toBeVisible();
    await expect(pluginRow.getByText('当前使用版本未确认', { exact: false })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await pluginRow.locator('.resource-detail-link').click();
    const pluginDialog = page.getByRole('dialog');
    await expect(pluginDialog.getByText(/缓存版本 0\.5\.13、0\.5\.14、0\.6\.1、0\.6\.3/)).toBeVisible();
    // ZCode records an explicit enable switch for this plugin, so its cache versions
    // keep that association and stay visible; the current version stays unconfirmed.
    await expect(pluginDialog.locator('.entity-binding')).toHaveCount(5);
    for (const version of ['0.5.13', '0.5.14', '0.6.1', '0.6.3']) {
      await expect(pluginDialog.getByText(`缓存版本：${version} · official`, { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: 'work/browser-proof/plugin-versions.png', fullPage: true });
    await pluginDialog.getByRole('button', { name: '关闭', exact: true }).click();
    // Per-Agent records remain reachable through search and detail evidence even
    // though the owner-Agent/scope/category filters left the toolbar.
    await page.getByLabel('搜索资源').fill('');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    await page.getByLabel('搜索资源').fill('manual-only');
    await expect(page.locator('.config-state').first()).toHaveText('已启用');
    await page.locator('.resource-detail-link').first().click();
    await expect(page.getByRole('dialog').getByText('可见性配置记录', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('user-invocable-only', { exact: true })).toBeVisible();
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))); });
    await page.screenshot({ path: 'work/browser-proof/skill-visibility.png', fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    // Public .agents resource: one entity row, per-Agent disable records preserved.
    await page.getByLabel('搜索资源').fill('');
    await page.getByLabel('搜索资源').fill('user-library');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr').first()).toContainText('公共资源');
    await page.screenshot({ path: 'work/browser-proof/public-resource.png', fullPage: true });
    await expect(page.locator('.agent-cell span').first()).toHaveText('公共来源');
    await expect(page.locator('.config-state').first()).toHaveText('已启用');
    await page.locator('.resource-detail-link').first().click();
    const publicDialog = page.getByRole('dialog');
    await expect(publicDialog).toContainText('Codex');
    await expect(publicDialog).toContainText('ZCode');
    await expect(publicDialog.locator('.binding-evidence').getByText('已禁用', { exact: true }).first()).toBeVisible();
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))); });
    await page.screenshot({ path: 'work/browser-proof/public-resource-detail.png', fullPage: true });
    await expect(page.getByRole('dialog').getByText('发现适配器（不代表客户端已加载）', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('配置状态依据与限制', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    // Agent-global unconfigured cache Skill: hidden by policy, reachable through the
    // explicit include-hidden search entry, classification reasons in detail.
    await page.getByLabel('搜索资源').fill('');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    // The synthetic remote-plugin install record gives this cache copy an installation
    // association: it stays visible (unconfirmed state) instead of being treated as pure cache.
    await page.getByLabel('搜索资源').fill('unconfigured-review');
    const unconfigured = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'unconfigured-review', exact: true }) });
    await expect(unconfigured).toBeVisible();
    await expect(unconfigured.getByText('未确定', { exact: true })).toBeVisible();
    await unconfigured.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('实际存放范围与依据', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('安装登记证据', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    // Project MCP keeps project scope evidence per binding.
    await page.getByLabel('搜索资源').fill('');
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await select(1, '项目：分类验收项目');
    await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    const projectMcp = page.locator('tbody tr').filter({ hasText: 'Claude Code' }).first();
    await expect(projectMcp).toContainText('分类验收项目');
    await projectMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('分类依据', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/归属 Claude Code/)).toBeVisible();
    await expect(page.getByRole('dialog').getByText('分类依据：', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText(project, { exact: false }).first()).toBeVisible();
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))); });
    await page.screenshot({ path: 'work/browser-proof/classification.png', fullPage: true });
    expect(await fileTreeDigests(home)).toEqual(before);
    expect(await fileTreeDigests(project)).toEqual(beforeProject);
    expect(errors).toEqual([]);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server!.once('exit', resolve)); }
    await removeTestDirectory(directory);
  }
});
