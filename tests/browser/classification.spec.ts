import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from '../helpers';
import { addPluginCacheFixture } from '../plugin-fixtures';

test('combines scope and owning Agent for Skill, MCP and plugin inventory', async ({ page }) => {
  test.setTimeout(60_000);
  const directory = await createTestDirectory('classification-browser');
  const { home, project } = await copyCatalogFixture(directory);
  await addPluginCacheFixture(home, project);
  const zcodeSettingsPath = path.join(home, '.zcode/cli/config.json');
  const zcodeSettings = JSON.parse(await readFile(zcodeSettingsPath, 'utf8')) as Record<string, unknown>;
  await writeFile(zcodeSettingsPath, JSON.stringify({ ...zcodeSettings, plugins: { enabledPlugins: { 'computer-use@official': true } },
    skills: { [path.join(home, '.agents/skills/user-library/SKILL.md')]: { enable: false } },
    mcp: { servers: { ...((zcodeSettings.mcp as { servers: Record<string, unknown> }).servers), 'status-probe-on': { command: 'fixture-only' },
      'status-probe-off': { command: 'fixture-only', enable: false }, 'status-probe-unknown': { command: 'fixture-only', enable: 'invalid' } } } }));
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
    await page.getByRole('button', { name: '扫描本机配置（只读）', exact: true }).click();
    await expect(page.locator('.resource-detail-link').first()).toBeVisible();
    const csrfToken = await page.evaluate(async () => (await (await fetch('/api/v1/session')).json()).csrfToken as string);
    await page.evaluate(async ({ rootPath, csrfToken }) => {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: '分类验收项目', rootPath }) });
      if (!response.ok) throw new Error(`Project registration ${response.status}`);
      await response.json();
      const scan = await fetch('/api/v1/scans', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ scanRegisteredProjects: true }) });
      if (!scan.ok) throw new Error(`Project scan ${scan.status}`);
    }, { rootPath: project, csrfToken });
    await page.getByRole('button', { name: '刷新资源', exact: true }).click();
    await expect(page.getByTestId('resource-category-filter')).toBeVisible();
    async function select(index: number, label: string) {
      const input = page.locator('.skill-filters .el-select').nth(index).getByRole('combobox');
      await input.focus();
      await input.press('ArrowDown');
      await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
      await page.getByRole('option', { name: label, exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByRole('columnheader', { name: '客户端适用性', exact: true })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: '运行状态', exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder('客户端适用性')).toHaveCount(0);
    await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('status-probe');
    for (const label of ['已启用', '已禁用', '未确定']) {
      await page.getByPlaceholder('搜索名称或来源路径').fill('status-probe');
      await select(5, label);
      const states = await page.locator('.config-state').allTextContents();
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state.trim() === label)).toBe(true);
      if (label === '未确定') await expect(page.locator('.config-state.unknown').first()).toHaveCSS('color', 'rgb(138, 150, 143)');
      await page.getByRole('button', { name: '清除全部', exact: true }).click();
      await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    }
    await page.getByPlaceholder('搜索名称或来源路径').fill('');
    await select(1, 'ZCode');
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('computer-use');
    const versionsGroup = page.locator('tr.plugin-group');
    await expect(versionsGroup).toHaveCount(1);
    await expect(versionsGroup).toContainText('4 个缓存版本');
    await expect(versionsGroup).toContainText('当前使用版本未确定');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await versionsGroup.getByRole('button', { name: '展开插件版本', exact: true }).click();
    await expect(page.locator('tr.child').filter({ has: page.locator('.kind-icon.skill') })).toHaveCount(4);
    for (const version of ['0.5.13', '0.5.14', '0.6.1', '0.6.3']) await expect(page.getByRole('button', { name: `computer-use · 缓存 v${version}`, exact: true })).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/plugin-versions.png', fullPage: true });
    await page.getByRole('button', { name: 'computer-use · 缓存 v0.6.3', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(path.join(home, '.zcode/cli/plugins/cache/official/computer-use/0.6.3/.zcode-plugin/plugin.json'), { exact: true }).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await versionsGroup.getByRole('button', { name: '收起插件版本', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByPlaceholder('搜索名称或来源路径').fill('');
    await select(1, 'ZCode');
    await select(0, '用户全局');
    await select(1, 'Codex');
    for (const kind of ['Skill', 'MCP', '插件']) {
      await page.locator('.tabs').getByRole('button', { name: kind, exact: true }).click();
      await expect(page.getByRole('columnheader', { name: '资源归类', exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '范围', exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '所属 Agent', exact: true })).toBeVisible();
      await expect(page.locator('.agent-cell').first()).toHaveText('Codex');
      const labels = await page.locator('.scope-cell .tag').allTextContents();
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every(label => label === '用户全局')).toBe(true);
    }
    await select(1, 'Codex');
    await select(1, 'Claude Code');
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('manual-only');
    await expect(page.locator('.config-state').first()).toHaveText('已启用');
    await page.locator('.resource-detail-link').first().click();
    await expect(page.getByRole('dialog').getByText('可见性配置记录', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('user-invocable-only', { exact: true })).toBeVisible();
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await page.screenshot({ path: 'work/browser-proof/skill-visibility.png', fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('name-only');
    await expect(page.locator('.config-state').first()).toHaveText('已启用');
    await page.getByPlaceholder('搜索名称或来源路径').fill('');
    await select(1, 'Claude Code');
    await select(1, 'Codex');
    await select(1, 'Codex');
    await select(1, '公共来源（无 Agent 归属）');
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('user-library');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tr.public-group')).toContainText('有禁用记录：ZCode');
    await page.screenshot({ path: 'work/browser-proof/public-resource.png', fullPage: true });
    await expect(page.locator('.agent-cell').first()).toHaveText('公共来源');
    await expect(page.locator('.config-state').first()).toHaveText('已启用');
    await page.locator('.resource-detail-link').first().click();
    await expect(page.getByRole('dialog').locator('.public-agent-states')).toContainText('Codex');
    await expect(page.getByRole('dialog').locator('.public-agent-states')).toContainText('ZCode');
    await expect(page.getByRole('dialog').locator('.public-agent-states')).toContainText('已禁用');
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await page.screenshot({ path: 'work/browser-proof/public-resource-detail.png', fullPage: true });
    await expect(page.getByRole('dialog').getByText('发现适配器（不代表客户端已加载）', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('配置状态依据与限制', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('');
    await select(1, '公共来源（无 Agent 归属）');
    await select(1, 'Codex');
    await select(0, '用户全局');
    await select(0, '使用范围未知');
    await select(4, 'Agent 全局资源');
    await page.locator('.tabs').getByRole('button', { name: 'Skill', exact: true }).click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('unconfigured-review');
    await expect(page.locator('.resource-category').first()).toHaveText('Agent 全局资源');
    await expect(page.locator('.scope-cell .tag').first()).toHaveText('使用范围未知');
    await page.getByRole('button', { name: '展开插件组件', exact: true }).click();
    await page.getByRole('button', { name: 'unconfigured-review', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('实际存放范围与依据', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('安装登记证据', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByPlaceholder('搜索名称或来源路径').fill('');
    await select(4, 'Agent 全局资源');
    await select(0, '使用范围未知');
    await select(0, '项目级');
    await select(1, 'Codex');
    await select(1, 'Claude Code');
    await page.locator('.tabs').getByRole('button', { name: 'MCP', exact: true }).click();
    await expect(page.locator('.scope-cell').first()).toContainText('项目级');
    await expect(page.locator('.scope-cell').first()).toContainText('分类验收项目');
    await expect(page.locator('.agent-cell').first()).toHaveText('Claude Code');
    await page.locator('.resource-detail-link').first().click();
    await expect(page.getByRole('dialog').getByText('内容适用性', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('运行证据说明', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('分类依据', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('项目级 · Claude Code', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(project, { exact: true }).first()).toBeVisible();
    await page.getByRole('dialog').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await page.screenshot({ path: 'work/browser-proof/classification.png', fullPage: true });
    expect(await fileTreeDigests(home)).toEqual(before);
    expect(await fileTreeDigests(project)).toEqual(beforeProject);
    expect(errors).toEqual([]);
  } finally {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server!.once('exit', resolve)); }
    await removeTestDirectory(directory);
  }
});
