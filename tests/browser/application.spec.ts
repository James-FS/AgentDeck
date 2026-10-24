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
    await expect(page.locator('.empty').getByRole('button', { name: '发现客户端' })).toBeVisible();
    await page.getByRole('button', { name: '载入隔离演示数据', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'agentdeck-demo' });
    await expect(row).toBeVisible();
    await expect(row.getByText('已启用', { exact: true })).toBeVisible();
    const filePath = path.join(directory, 'data', 'demo', 'codex', 'config.toml');
    const original = await readFile(filePath);
    await row.getByRole('button', { name: '预览修改', exact: true }).click();
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
    await page.getByRole('button', { name: /^配置操作记录/ }).click();
    await page.getByRole('button', { name: '恢复此修改', exact: true }).first().click();
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

    await page.getByRole('button', { name: '发现客户端' }).first().click();
    await page.getByRole('menuitem', { name: '发现本机客户端并扫描用户级配置' }).click();
    const docs = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'docs', exact: true }) }).first();
    await expect(docs).toBeVisible();
    await docs.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(`配置文件：${path.join(home, '.codex', 'config.toml')}`, { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByRole('button', { name: 'Agent 实例', exact: true }).click();
    await page.getByRole('button', { name: '发现客户端', exact: true }).click();
    await expect(page.locator('.instance-card')).toHaveCount(8);
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    // The bundled DSH plugin is verified built-in: enable the display switch to inspect it.
    await page.getByTestId('display-options').click();
    await page.getByTestId('show-builtin-switch').click();
    const dshGroup = page.getByRole('row').filter({ hasText: '@deepseek-ai/dsh-mcp-client' }).first();
    await expect(dshGroup).toBeVisible();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'dsh-docs', exact: true }) })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'work/browser-proof/mcp-filter.png', fullPage: true });
    await page.getByTestId('display-options').click();
    await page.getByTestId('show-builtin-switch').click();
    await page.keyboard.press('Escape');

    const search = page.getByLabel('搜索资源');
    // fixture-tools has a (disabled) configuration record, so it and its attached
    // components stay visible; the cache origin and disabled state are shown as badges/states.
    await search.fill('cached-docs');
    const cachedMcp = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-docs', exact: true }) }).first();
    await expect(cachedMcp).toBeVisible();
    await expect(cachedMcp.getByText('已禁用', { exact: true })).toBeVisible();
    await cachedMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(/所属插件/).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText(path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools/1.0.0/.mcp.json'), { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/fixture-tools@fixture-market/).first()).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/cache-source-detail.png', fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await search.fill('locally-disabled');
    const localChild = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'locally-disabled', exact: true }) }).first();
    await expect(localChild.getByText('已禁用', { exact: true })).toBeVisible();
    await localChild.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText('已禁用', { exact: true }).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).first().click();
    await page.getByRole('button', { name: 'Skill', exact: true }).click();
    await search.fill('cached-review-1.0.0');
    await page.getByTestId('resource-source-filter').click();
    await page.getByRole('option', { name: '插件附带', exact: true }).click();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-review-1.0.0', exact: true }) })).toBeVisible();
    await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: 'cached-review-1.0.0', exact: true }) }).getByText('已禁用', { exact: true })).toBeVisible();
    // The orphan cache copy has no configuration or installation association: the unified
    // search offers an explicit include-hidden entry instead of leaking it silently.
    await search.fill('unconfigured-review');
    await expect(page.getByTestId('include-hidden-search')).toBeVisible();
    await page.getByTestId('include-hidden-search').click();
    const unconfigured = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'unconfigured-review', exact: true }) });
    await expect(unconfigured).toBeVisible();
    await expect(unconfigured.getByText('未确定', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/cache-skill-filter.png', fullPage: true });

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
    await page.getByRole('button',{name:'项目可用性',exact:true}).click();
    const clientPicker = page.getByRole('combobox',{name:'可用性客户端'});
    await clientPicker.press('ArrowDown');
    await page.getByRole('option', { name: /Codex/ }).first().click();
    const projectPicker = page.getByRole('combobox',{name:'可用性项目'});
    await projectPicker.press('ArrowDown');
    await page.getByRole('option', { name: 'Browser project', exact: true }).click();
    // The form only asks the server when the check button is clicked.
    await expect(page.getByText('请选择客户端实例')).toBeHidden();
    await page.getByRole('button', { name: '检查可用性' }).click();
    const projectAvailability = page.locator('.availability-panel').getByText('Project Browser Review', { exact: true }).locator('..');
    await expect(projectAvailability).toContainText('配置状态未知');
    await projectAvailability.locator('details summary').click();
    await expect(projectAvailability).toContainText('格式：有效');
    await page.getByLabel('可用性工作目录').fill(path.join(directory, 'outside-project'));
    await expect(page.getByTestId('availability-stale')).toBeVisible();
    await page.getByRole('button', { name: '检查可用性' }).click();
    await expect(projectAvailability).toContainText('范围不匹配');
    await expect(page.getByTestId('availability-stale')).toBeHidden();
    await page.getByLabel('可用性工作目录').clear();
    await page.getByRole('button',{name:'资源库',exact:true}).click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    // The project scan no longer clears filters; remove the leftover source chip explicitly.
    await page.locator('.active-filters').getByRole('button', { name: '插件附带', exact: true }).click();
    await search.fill('project-docs');
    const projectMcp = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'project-docs', exact: true }) }).first();
    await expect(projectMcp).toBeVisible();
    await expect(projectMcp.getByText('Browser project', { exact: true })).toBeVisible();
    await projectMcp.locator('.resource-detail-link').click();
    await expect(page.getByRole('dialog').getByText(`配置文件：${path.join(projectRoot, '.codex/config.toml')}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/项目仓库提供/)).toBeVisible();
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
    await page.getByRole('button', { name: '扫描客户端', exact: true }).click();
    await expect(page.getByTestId('scan-warning')).toContainText('扫描部分失败');
    await expect(page.locator('.el-message--warning')).toContainText('当前资源状态可能已过期');
    await expect(page.locator('.el-message--success')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('scan-warning')).toContainText('扫描部分失败');
    await expect(page.getByRole('row').filter({ hasText: 'agentdeck-demo' })).toBeVisible();
    status = 'failed';
    await page.getByRole('button', { name: '扫描客户端', exact: true }).click();
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

    const sources = () => page.getByRole('button',{name:'来源与扫描',exact:true}).click();
    const library = async () => {
      await page.getByRole('button',{name:'资源库',exact:true}).click();
      const picker = page.getByTestId('resource-source-filter');
      if (!(await picker.innerText()).includes('独立来源')) {
        await picker.click(); await page.getByRole('option',{name:'独立来源',exact:true}).click(); await page.keyboard.press('Escape');
      }
    };
    await sources();
    await page.getByRole('textbox', { name: 'Skill 目录路径' }).fill(sourceRoot);
    await page.getByRole('button', { name: '添加并扫描', exact: true }).click();
    const report = page.locator('.source-report').filter({ hasText: sourceRoot }).first();
    await expect(report).toContainText('扫描部分完成');
    await expect(report).toContainText('继续扫描');
    await library();
    await expect(page.locator('.resource-table')).toContainText('source-root-probe');
    await expect(page.locator('.resource-table')).not.toContainText('nested-probe');
    await page.locator('.resource-table').getByRole('button', { name: 'independent-skill-library',exact:true }).click();
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
    await sources();
    await page.getByRole('textbox', { name: 'Skill 目录路径' }).fill(paginationRoot);
    await page.locator('.source-entry summary').click();
    const scanDepth = page.getByRole('combobox', { name: '扫描深度' });
    await scanDepth.press('ArrowDown');
    await scanDepth.press('Enter');
    await page.getByRole('button', { name: '添加并扫描', exact: true }).click();
    await library();
    await expect(page.locator('.resource-table')).toContainText('pagination-late-skill');
    await page.getByLabel('搜索资源').fill('PAGINATION_NEEDLE_493');
    const searchResults = page.locator('.skill-search-results');
    await expect(searchResults).toContainText('已检查 30/');
    await expect(searchResults.getByRole('button', { name: '继续搜索后续资源' })).toBeVisible();
    for (let pageIndex = 0; pageIndex < 5 && !await page.locator('.resource-table').getByRole('button',{name:'pagination-late-skill',exact:true}).count(); pageIndex += 1) {
      const continueSearch = searchResults.getByRole('button', { name: '继续搜索后续资源' });
      if (!await continueSearch.count()) break;
      await continueSearch.click();
    }
    await expect(page.locator('.resource-table')).toContainText('pagination-late-skill');
    await expect(page.locator('.resource-table')).toContainText('PAGINATION_NEEDLE_493');
    await page.getByLabel('搜索资源').clear();

    await sources();
    await report.getByRole('button', { name: '继续扫描' }).click();
    const nestedSourcePath = path.join(sourceRoot, 'group', 'real');
    const nestedReport = page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) });
    await expect(nestedReport).toContainText('扫描完整');
    await library();
    await expect(page.locator('.resource-table')).toContainText('nested-probe');
    await mkdir(path.join(nestedSourcePath, 'later'), { recursive: true });
    await writeFile(path.join(nestedSourcePath, 'later', 'SKILL.md'), '---\nname: later-probe\ndescription: Added after first scan.\n---');
    await sources();
    await nestedReport.getByRole('button', { name: '重新扫描' }).click();
    await library();
    await expect(page.locator('.resource-table')).toContainText('later-probe');
    await page.reload();
    await library();
    await expect(page.locator('.resource-table')).toContainText('later-probe');
    await sources();
    await page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) }).locator('.row-menu').click();
    await page.getByRole('menuitem', { name: '取消登记（不删除文件）' }).click();
    await expect(page.locator('.source-report').filter({ has: page.locator('strong').getByText(nestedSourcePath, { exact: true }) })).toHaveCount(0);
    await library();
    await expect(page.locator('.resource-table')).not.toContainText('later-probe');
  });
});
