import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test.describe.serial('interaction simplification: centered filters, fixed scans, separated records', () => {
  let server: ChildProcess;
  let directory: string;
  let startupUrl: string;

  test.beforeAll(async () => {
    directory = await createTestDirectory('interaction-browser-');
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

  test('keeps library filters on the page, scan range fixed, and records separated', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(startupUrl);
    await page.getByRole('button', { name: '载入隔离演示数据', exact: true }).click();
    await expect(page.locator('.resource-table tbody tr').first()).toBeVisible();
    await mkdir('work/browser-proof', { recursive: true });

    // Topbar keeps navigation and one refresh entry; no client/project context pickers.
    await expect(page.getByRole('combobox', { name: '客户端上下文' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '项目上下文' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '刷新当前页面数据', exact: true })).toBeVisible();
    await expect(page.locator('.panel-tools').getByRole('button', { name: '刷新当前页面数据' })).toHaveCount(0);
    await expect(page.getByTestId('library-help')).toBeVisible();
    await expect(page.locator('.filter-row .el-select')).toHaveCount(4);

    // Register one project so the scope select offers it.
    await page.getByRole('button', { name: '项目空间', exact: true }).click();
    await page.getByRole('button', { name: '登记项目', exact: true }).first().click();
    await page.getByPlaceholder('留空时由服务端生成显示名称').fill('Ctx Project');
    await page.getByPlaceholder('例如：D:\\work\\my-project').fill(path.join(directory, 'ctx-project'));
    await page.getByRole('dialog').getByRole('button', { name: '登记项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Deterministic catalog: one user-global, one project, one unknown-scope Skill,
    // one native MCP and one independent source finding.
    const base = await page.evaluate(async () => (await fetch('/api/v1/catalog')).json()) as { instances: Array<{ id: string }>; bindings: Array<Record<string, unknown>> };
    const instanceId = base.instances[0]!.id;
    const projectResponse = await page.evaluate(async () => (await fetch('/api/v1/catalog')).json()) as { projects: Array<{ id: string; name: string }> };
    const projectId = projectResponse.projects[0]!.id;
    const skill = base.bindings.find((binding) => binding.kind === 'skill')!;
    const mcp = base.bindings.find((binding) => binding.kind === 'mcp')!;
    const record = (id: string, template: Record<string, unknown>, scope: string, boundProjectId: string | null) => ({
      ...template, id, name: id, displayName: id, instanceId, projectId: boundProjectId, scope,
      sourcePath: `D:\\iso\\${id}\\SKILL.md`, discoveryPath: `D:\\iso\\${id}`, parentId: null, writable: false, diagnostics: [],
    });
    const generated = () => ({ ...base, bindings: [
      record('ctx-global', skill, 'user-global', null),
      record('ctx-proj', skill, 'project', projectId),
      record('ctx-unknown', skill, 'project', null),
      record('ctx-mcp', mcp, 'native', null),
    ], skillSources: [{ id: 'src-iso', path: path.join(directory, 'iso-lib'), mode: 'quick', followLinks: false, watchEnabled: false, watchStatus: 'disabled', scannedAt: new Date().toISOString(),
      report: { status: 'complete', rootPath: path.join(directory, 'iso-lib'), candidateCount: 1, recognizedCount: 1, skippedCount: 0, visitedDirectories: 1, truncatedAt: null, continuationPath: null,
        limits: { maxDepth: 1, maxDirectories: 10, maxEntriesPerDirectory: 100, maxManifestBytes: 1048576, maxFrontmatterBytes: 1024 }, diagnostics: [],
        findings: [{ logicalPath: path.join(directory, 'iso-lib', 'ctx-independent'), actualPath: path.join(directory, 'iso-lib', 'ctx-independent'), name: 'ctx-independent', description: null, status: 'recognized', reason: '' }] } }] });
    await page.route('**/api/v1/catalog', route => route.fulfill({ json: generated() }));
    const scanBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/v1/scans', async route => { scanBodies.push(route.request().postDataJSON() as Record<string, unknown>); await route.fulfill({ json: generated() }); });
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.getByRole('button', { name: '刷新当前页面数据', exact: true }).click();
    const rows = page.locator('.resource-table tbody tr');
    await expect(rows.filter({ hasText: 'ctx-global' })).toBeVisible();
    await expect(rows.filter({ hasText: 'ctx-independent' })).toBeVisible();
    await expect(rows.filter({ hasText: 'ctx-unknown' })).toBeVisible();

    // Global-only scope: reliable user-global evidence only; a null projectId and
    // native MCP records never masquerade as global.
    await page.getByTestId('library-project-scope').click();
    await page.getByRole('option', { name: '仅全局', exact: true }).click();
    await expect(rows.filter({ hasText: 'ctx-global' })).toBeVisible();
    await expect(rows.filter({ hasText: 'ctx-proj' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ctx-unknown' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ctx-mcp' })).toHaveCount(0);
    await expect(page.locator('.active-filters')).toContainText('仅全局资源');
    await expect(page.getByTestId('independent-excluded')).toBeVisible();

    // Specific project: project records plus user-global while "include global" is on.
    await page.getByTestId('library-project-scope').click();
    await page.getByRole('option', { name: '项目：Ctx Project', exact: true }).click();
    await expect(rows.filter({ hasText: 'ctx-global' })).toBeVisible();
    await expect(rows.filter({ hasText: 'ctx-proj' })).toBeVisible();
    await expect(page.getByTestId('include-global-switch')).toBeChecked();
    await page.getByTestId('include-global-switch').uncheck();
    await expect(rows.filter({ hasText: 'ctx-global' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ctx-proj' })).toBeVisible();
    await expect(page.locator('.active-filters')).toContainText('不含全局资源');
    await page.getByTestId('include-global-switch').check();

    // The client filter combines on the same records and excludes independent sources
    // with an explicit recovery action that grants no binding.
    await page.getByTestId('library-client-filter').click();
    await page.getByRole('option', { name: /Codex Demo/ }).first().click();
    await expect(rows.filter({ hasText: 'ctx-independent' })).toHaveCount(0);
    await expect(page.getByTestId('independent-excluded')).toBeVisible();
    await page.getByTestId('view-independent').click();
    await expect(page.getByTestId('independent-excluded')).toBeHidden();
    await expect(rows.filter({ hasText: 'ctx-independent' })).toBeVisible();
    await expect(page.locator('.active-filters').filter({ hasText: '独立来源' })).toBeVisible();

    // Scanning stays fixed regardless of the library context: no narrowing to the
    // selected client or project, no project scan attached, filters stay applied.
    await page.getByTestId('library-client-filter').click();
    await page.getByRole('option', { name: /Codex Demo/ }).first().click();
    await page.getByTestId('library-project-scope').click();
    await page.getByRole('option', { name: '项目：Ctx Project', exact: true }).click();
    await expect(page.locator('.active-filters')).toContainText('客户端：');
    await page.getByTestId('scan-clients').click();
    await expect(scanBodies.length).toBeGreaterThan(0);
    for (const body of scanBodies) {
      expect(body.instanceId).toBeUndefined();
      expect(body.projectId).toBeUndefined();
      expect(body.scanRegisteredProjects).toBe(false);
    }
    await expect(page.locator('.active-filters')).toContainText('客户端：');
    await expect(page.getByTestId('library-project-scope')).toContainText('项目：Ctx Project');

    // Records pages keep their own scope: the scan changes tab is renamed and shows
    // a pointer to sources instead of duplicating source management buttons.
    await page.getByRole('button', { name: '扫描变化', exact: true }).click();
    await expect(page.getByRole('button', { name: '来源与扫描', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^配置操作记录/ })).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/interaction-simplification.png', fullPage: true });
  });
});
