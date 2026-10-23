import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyCatalogFixture, createTestDirectory, removeTestDirectory } from '../helpers';
import { addPluginCacheFixture } from '../plugin-fixtures';
import type { Catalog } from '@agentdeck/contracts';

test.describe.serial('built application on loopback', () => {
  let processHandle: ChildProcess;
  let directory: string;
  let startupUrl: string;
  let home: string;
  let projectRoot: string;
  let sessionCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];

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
    await expect(row.getByText('已禁用', { exact: true })).toBeVisible();
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
    await expect(cachedMcp.getByText('已禁用', { exact: true })).toBeVisible();
    await cachedMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('所属插件', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools/1.0.0/.mcp.json'), { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText('fixture-tools@fixture-market', { exact: true }).first()).toBeVisible();
    await expect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(1440);
    await page.screenshot({ path: 'work/browser-proof/cache-source-detail.png', fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await search.fill('locally-disabled');
    const localParent = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'local-mcp-tools', exact: true }) }).first();
    await localParent.getByRole('button', { name: /展开/ }).click();
    const localChild = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'locally-disabled', exact: true }) }).first();
    await expect(localChild.getByText('已禁用', { exact: true })).toBeVisible();
    await localChild.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('已禁用', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('已启用', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByRole('button', { name: 'Skill', exact: true }).click();
    await search.fill('cached-review-1.0.0');
    await page.getByTestId('resource-source-filter').click();
    await page.getByRole('option', { name: '插件附带', exact: true }).click();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-review-1.0.0', exact: true }) })).toBeVisible();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-review-1.0.0', exact: true }) }).getByText('已禁用', { exact: true })).toBeVisible();
    await search.fill('unconfigured-review');
    const unconfiguredPlugin = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'fixture-tools', exact: true }) }).first();
    await unconfiguredPlugin.getByRole('button', { name: /展开/ }).click();
    const unconfigured = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'unconfigured-review', exact: true }) });
    await expect(unconfigured).toBeVisible();
    await expect(unconfigured.getByText('未确定', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/cache-skill-filter.png', fullPage: true });
    const originSelect = page.getByTestId('resource-origin-filter');
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
    const projectSkillDirectory = path.join(projectRoot, '.agents', 'skills', 'project-browser-review');
    await mkdir(projectSkillDirectory, { recursive: true });
    await writeFile(path.join(projectSkillDirectory, 'SKILL.md'), '---\nname: Project Browser Review\ndescription: Browser availability fixture.\n---\n# Project Browser Review');
    await page.getByRole('button', { name: '扫描项目', exact: true }).click();
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    const clientPicker = page.locator('.availability-panel .el-select').nth(0);
    await clientPicker.click();
    await page.getByRole('option', { name: /Codex/ }).first().click();
    const projectPicker = page.locator('.availability-panel .el-select').nth(1);
    await projectPicker.click();
    await page.getByRole('option', { name: 'Browser project', exact: true }).click();
    const projectAvailability = page.locator('.availability-panel').getByText('Project Browser Review', { exact: true }).locator('..');
    await expect(projectAvailability).toContainText('格式：有效');
    await expect(projectAvailability).toContainText('配置状态未知');
    await page.getByLabel('可用性工作目录').fill(path.join(directory, 'outside-project'));
    await expect(projectAvailability).toContainText('范围不匹配');
    await page.getByLabel('可用性工作目录').clear();
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
    sessionCookies = await page.context().cookies();
  });

  test('shows partial and failed scan results without a success toast, including after refresh', async ({ page }) => {
    if (sessionCookies.length) {
      await page.context().addCookies(sessionCookies);
      await page.goto(startupUrl.split('#')[0]!);
    } else await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    const catalog = await page.evaluate(async () => (await fetch('/api/v1/catalog')).json()) as Catalog;
    const instance = catalog.instances.find(item => item.agentId === 'codex')!;
    let status: 'partial' | 'failed' = 'partial';
    const response = (): Catalog => ({ ...catalog, lastScan: {
      status, completedAt: new Date().toISOString(), succeeded: status === 'partial' ? 1 : 0,
      failures: [{ agentId: 'codex', instanceId: instance.id, projectId: null, stage: 'scan',
        message: '扫描失败；保留上一次的索引，当前资源状态可能已过期。' }],
    } });
    await page.route('**/api/v1/catalog', route => route.fulfill({ json: response() }));
    await page.route('**/api/v1/scans', route => route.fulfill({ json: response() }));
    await page.getByRole('button', { name: '重新扫描已登记实例', exact: true }).click();
    await expect(page.getByTestId('scan-warning')).toContainText('扫描部分失败');
    await expect(page.locator('.el-message--warning')).toContainText('当前资源状态可能已过期');
    await expect(page.locator('.el-message--success')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('scan-warning')).toContainText('扫描部分失败');
    await expect(page.getByRole('row').filter({ hasText: 'agentdeck-demo' })).toBeVisible();
    status = 'failed';
    await page.getByRole('button', { name: '重新扫描已登记实例', exact: true }).click();
    await expect(page.getByTestId('scan-warning')).toContainText('扫描失败');
    await expect(page.locator('.el-message--error')).toContainText('当前资源状态可能已过期');
    await expect(page.locator('.el-message--success')).toHaveCount(0);
  });

  test('registers, deepens, refreshes, and removes an independent Skill source', async ({ page }) => {
    test.setTimeout(60_000);
    if (sessionCookies.length) {
      await page.context().addCookies(sessionCookies);
      await page.goto(startupUrl.split('#')[0]!);
    } else await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    const sourceRoot = path.join(directory, 'independent-skill-library');
    await mkdir(path.join(sourceRoot, 'group', 'real'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'SKILL.md'), '---\nname: source-root-probe\ndescription: Registered root.\nauthor: Browser tester\n---\n# Searchable preview token\n\n- list item\n\n```js\nconst safe = true;\n```\n\n<script>window.__xss = true</script>\n[unsafe](javascript:alert(1))\n![tracker](https://tracker.example/pixel.png)');
    await writeFile(path.join(sourceRoot, 'group', 'real', 'SKILL.md'), '---\nname: nested-probe\ndescription: Nested resource.\n---');

    await page.getByRole('textbox', { name: '自定义资源目录' }).fill(sourceRoot);
    await page.getByRole('button', { name: '登记并扫描', exact: true }).click();
    const report = page.locator('.source-report').filter({ hasText: sourceRoot }).first();
    await expect(report).toContainText('扫描部分完成');
    await expect(report).toContainText('继续深扫截断目录');
    await expect(page.locator('.source-inventory')).toContainText('source-root-probe');
    await expect(page.locator('.source-inventory')).not.toContainText('nested-probe');
    await page.locator('.source-inventory').getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('Browser tester');
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Searchable preview token' })).toBeVisible();
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview ul')).toContainText('list item');
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview pre code')).toContainText('const safe = true;');
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview script')).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview img')).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('#skill-markdown-preview')).toContainText('window.__xss = true');
    await page.getByRole('button', { name: '查看原文' }).click();
    await expect(page.getByRole('dialog').locator('.markdown-source')).toContainText('<script>');
    await page.getByRole('button', { name: '显示安全渲染' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    const paginationRoot = path.join(directory, 'pagination-skill-library');
    for (let index = 0; index < 30; index += 1) {
      const skillPath = path.join(paginationRoot, `skill-${String(index).padStart(2, '0')}`);
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: pagination-skill-${index}\ndescription: Earlier candidate.\n---\nNo match here.`);
    }
    const lateSkillPath = path.join(paginationRoot, 'skill-zz-last');
    await mkdir(lateSkillPath, { recursive: true });
    await writeFile(path.join(lateSkillPath, 'SKILL.md'), '---\nname: pagination-late-skill\ndescription: Last candidate.\n---\nPAGINATION_NEEDLE_493');
    await page.getByRole('textbox', { name: '自定义资源目录' }).fill(paginationRoot);
    const scanDepth = page.getByRole('combobox', { name: '扫描深度' });
    await scanDepth.press('ArrowDown');
    await scanDepth.press('Enter');
    await page.getByRole('button', { name: '登记并扫描', exact: true }).click();
    await expect(page.locator('.source-inventory')).toContainText('pagination-late-skill');
    await page.getByPlaceholder('搜索名称或来源路径').fill('PAGINATION_NEEDLE_493');
    const searchResults = page.locator('.skill-search-results');
    await expect(searchResults).toContainText('已检查 30/');
    await expect(searchResults.getByRole('button', { name: '继续搜索后续资源' })).toBeVisible();
    for (let pageIndex = 0; pageIndex < 5 && !await searchResults.getByText('pagination-late-skill', { exact: true }).count(); pageIndex += 1) {
      const continueSearch = searchResults.getByRole('button', { name: '继续搜索后续资源' });
      if (!await continueSearch.count()) break;
      await continueSearch.click();
    }
    await expect(searchResults).toContainText('pagination-late-skill');
    await expect(searchResults).toContainText('PAGINATION_NEEDLE_493');
    await page.getByPlaceholder('搜索名称或来源路径').clear();

    await report.getByRole('button', { name: '继续深扫截断目录' }).click();
    const nestedSourcePath = path.join(sourceRoot, 'group', 'real');
    const nestedReport = page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) });
    await expect(nestedReport).toContainText('扫描完整');
    await expect(page.locator('.source-inventory')).toContainText('nested-probe');
    await mkdir(path.join(nestedSourcePath, 'later'), { recursive: true });
    await writeFile(path.join(nestedSourcePath, 'later', 'SKILL.md'), '---\nname: later-probe\ndescription: Added after first scan.\n---');
    await nestedReport.getByRole('button', { name: '重扫' }).click();
    await expect(page.locator('.source-inventory')).toContainText('later-probe');
    await page.reload();
    await expect(page.locator('.source-inventory')).toContainText('later-probe');
    await page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) }).getByRole('button', { name: '移除入口' }).click();
    await expect(page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) })).toHaveCount(0);
    await expect(page.locator('.source-inventory')).not.toContainText('later-probe');
  });
});
