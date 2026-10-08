import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Catalog, CompatibilityReport } from '../../packages/contracts/src/index';
import { createTestDirectory, removeTestDirectory } from '../helpers';

test('verifies installed client sources through the built UI without modifying them', async ({ page }) => {
  test.skip(process.env.AGENTDECK_VERIFY_REAL_CLIENTS !== '1', 'Explicit opt-in required for real-client read-only verification.');
  test.setTimeout(90_000);
  const home = os.homedir();
  const codexRoot = path.resolve(process.env.CODEX_HOME ?? path.join(home, '.codex'));
  const claudeRoot = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'));
  const zcodeRoot = path.resolve(process.env.ZCODE_HOME ?? path.join(home, '.zcode'));
  const dshRoot = path.resolve(process.env.DSH_HOME ?? path.join(home, '.dsh'));
  const roots = [path.join(home, '.agents/skills'), path.join(codexRoot, 'skills'), path.join(codexRoot, 'plugins'), path.join(claudeRoot, 'skills'), path.join(claudeRoot, 'plugins/cache'), path.join(zcodeRoot, 'skills'), path.join(zcodeRoot, 'plugins'), path.join(dshRoot, 'skills'), path.join(dshRoot, 'profiles')];
  const files = [path.join(codexRoot, 'config.toml'), path.join(claudeRoot, 'settings.json'), path.join(home, '.claude.json'), path.join(claudeRoot, 'plugins/installed_plugins.json'), path.join(zcodeRoot, 'cli/config.json')];
  async function snapshot() {
    const result: Record<string, string> = {};
    async function visit(candidate: string, depth: number) {
      // The adapters read shallow resource sources, not deeply nested package assets.
      if (depth > 8) return;
      const info = await lstat(candidate).catch(() => null);
      if (!info || info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        if (['node_modules', '.git'].includes(path.basename(candidate))) return;
        if (candidate.startsWith(path.join(dshRoot, 'profiles') + path.sep) && depth > 1) return;
        if (path.basename(candidate).startsWith('.')) {
          const parent = path.dirname(candidate);
          if ((parent === path.join(codexRoot, 'plugins') || parent === path.join(claudeRoot, 'plugins')) && !['.codex-plugin', '.claude-plugin'].includes(path.basename(candidate))) return;
        }
        for (const name of await readdir(candidate)) await visit(path.join(candidate, name), depth + 1);
      } else if (info.isFile() && (files.includes(candidate) || ['SKILL.md', 'skill.md', 'plugin.json', '.mcp.json'].includes(path.basename(candidate)) || (candidate.startsWith(path.join(dshRoot, 'profiles') + path.sep) && /\.ya?ml$/i.test(candidate)))) {
        result[candidate] = createHash('sha256').update(await readFile(candidate)).digest('hex');
      }
    }
    for (const candidate of [...roots, ...files]) await visit(candidate, 0);
    return result;
  }
  const before = await snapshot();
  const directory = await createTestDirectory('real-client-browser');
  let server: ChildProcess | undefined;
  try {
    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: path.resolve('.'), env: { ...process.env, NODE_ENV: 'production', PORT: '0', AGENTDECK_HOME: path.join(directory, 'data'), AGENTDECK_USER_HOME: home },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startupUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Real-client proof server did not start')), 15_000);
      server!.once('error', error => { clearTimeout(timer); reject(error); });
      server!.once('exit', code => { clearTimeout(timer); reject(new Error(`Proof server exited (${code})`)); });
      server!.stdout?.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#ticket=[A-Za-z0-9_-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(startupUrl);
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '扫描本机配置（只读）', exact: true }).click();
    await expect(page.locator('.resource-detail-link').first()).toBeVisible();
    const response = await page.request.get(new URL('/api/v1/catalog', startupUrl).href);
    expect(response.ok()).toBe(true);
    const catalog = await response.json() as Catalog;
    expect(catalog.instances.every(item => !item.writable)).toBe(true);
    expect(catalog.bindings.every(item => !item.writable)).toBe(true);
    expect(catalog.bindings.every(item => ['configuration', 'cache', 'filesystem'].includes(item.origin ?? ''))).toBe(true);
    expect(new Set(catalog.bindings.map(item => item.id)).size).toBe(catalog.bindings.length);
    const session = await page.request.get(new URL('/api/v1/session', startupUrl).href);
    const { csrfToken } = await session.json() as { csrfToken: string };
    const versionObservations: Record<string, string> = {};
    for (const instance of catalog.instances.filter(item => ['codex', 'claude-code'].includes(item.agentId) && item.executable)) {
      const checked = await page.request.post(new URL(`/api/v1/instances/${instance.id}/version-check`, startupUrl).href, {
        data: {}, headers: { Origin: new URL(startupUrl).origin, 'X-CSRF-Token': csrfToken },
      });
      expect(checked.ok()).toBe(true);
      const report = await checked.json() as CompatibilityReport;
      const client = report.clients.find(item => item.instanceId === instance.id)!;
      expect(client.status).toBe('verified-client');
      expect(client.versionEvidence?.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(client.capabilities.every(item => !item.writable)).toBe(true);
      versionObservations[instance.agentId] = client.versionEvidence!.version;
    }
    const expectedSkills = Object.keys(before).filter(file => file.includes(`${path.sep}plugins${path.sep}cache${path.sep}`) && path.basename(file) === 'SKILL.md');
    const expectedPlugins = Object.keys(before).filter(file => file.endsWith(path.join('.codex-plugin', 'plugin.json')));
    for (const file of expectedSkills) expect(catalog.bindings.some(item => item.kind === 'skill' && item.sourcePath === path.dirname(file)), file).toBe(true);
    for (const file of expectedPlugins) expect(catalog.bindings.some(item => item.kind === 'plugin' && item.sourcePath === file), file).toBe(true);
    for (const child of catalog.bindings.filter(item => item.parentId)) expect(catalog.bindings.some(parent => parent.kind === 'plugin' && parent.id === child.parentId), child.name).toBe(true);
    for (const file of Object.keys(before).filter(file => path.basename(file) === '.mcp.json')) {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      for (const name of Object.keys(raw.mcpServers ?? {})) expect(catalog.bindings.some(item => item.kind === 'mcp' && item.name === name && item.sourcePath === file), `${file}:${name}`).toBe(true);
    }
    const zcodeFile = path.join(zcodeRoot, 'cli/config.json');
    if (before[zcodeFile]) {
      const zcode = JSON.parse(await readFile(zcodeFile, 'utf8'));
      for (const [identity, state] of Object.entries(zcode.plugins?.enabledPlugins ?? {})) {
        const plugin = catalog.bindings.find(item => item.kind === 'plugin' && item.pluginId === identity && item.sourcePath === zcodeFile);
        expect(plugin, identity).toBeDefined();
        expect(plugin?.enabled).toBe(typeof state === 'boolean' ? state : null);
      }
    }
    await mkdir('work/browser-proof', { recursive: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Agent 实例/ }).click();
    for (const version of Object.values(versionObservations)) await expect(page.getByText(version, { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: 'work/browser-proof/real-compatibility-matrix.png', fullPage: true });
    await page.getByRole('button', { name: '资源管理', exact: true }).click();
    await page.screenshot({ path: 'work/browser-proof/real-resources.png', fullPage: true });
    if (catalog.bindings.some(item => item.name === 'sites-building' && item.parentId)) {
      await page.getByRole('button', { name: 'Skill', exact: true }).click();
      await page.getByPlaceholder('搜索名称或来源路径').fill('sites-building');
      const parent = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'sites', exact: true }) }).first();
      await parent.getByRole('button', { name: /展开/ }).click();
      const child = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'sites-building', exact: true }) });
      await expect(child).toBeVisible();
      await child.locator('.resource-detail-link').click();
      await expect(page.getByRole('dialog').getByText('sites@openai-curated-remote', { exact: true }).first()).toBeVisible();
      await expect.poll(async () => { const box = await page.getByRole('dialog').boundingBox(); return box ? Math.round(box.x + box.width) : 0; }).toBe(1440);
      await page.screenshot({ path: 'work/browser-proof/real-source-detail.png', fullPage: true });
    }
    expect(errors).toEqual([]);
    const after = await snapshot();
    expect(after).toEqual(before);
    const counts = Object.fromEntries(['skill', 'plugin', 'mcp'].map(kind => [kind, catalog.bindings.filter(item => item.kind === kind).length]));
    await mkdir('work/scan-proof', { recursive: true });
    await writeFile('work/scan-proof/real-client-proof.json', JSON.stringify({ verifiedAt: new Date().toISOString(), expectedCacheSkills: expectedSkills.length, expectedCachePlugins: expectedPlugins.length, scannedSourceFiles: Object.keys(before).length, sourcesUnchanged: true, counts, versionObservations, instances: catalog.instances.map(({ agentId, executable, version }) => ({ agentId, executable, version })), bindings: catalog.bindings, digests: before }, null, 2));
    console.log(JSON.stringify({ expectedCacheSkills: expectedSkills.length, expectedCachePlugins: expectedPlugins.length, scannedSourceFiles: Object.keys(before).length, counts, sourcesUnchanged: true }));
  } finally {
    if (server && server.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { server!.kill('SIGKILL'); resolve(); }, 3000);
        server!.once('exit', () => { clearTimeout(timer); resolve(); });
        server!.kill('SIGTERM');
      });
    }
    expect(await snapshot()).toEqual(before);
    await removeTestDirectory(directory);
  }
});
