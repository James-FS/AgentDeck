import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { zcodeAdapter } from '../packages/adapters/src/zcode';
import { createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers';

describe('ZCode bundled provenance without running the client', () => {
  let directory: string, desktop: string, home: string, cache: string, bundled: string;
  const manifest = JSON.stringify({ name: 'computer-use', version: '1.0.0', skills: 'skills' });
  async function file(p: string, value: string) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, value); }
  beforeEach(async () => {
    directory = await createTestDirectory('zcode-builtins'); desktop = path.join(directory, 'ZCode install'); home = path.join(directory, 'home');
    cache = path.join(home, '.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/1.0.0');
    bundled = path.join(desktop, 'resources/glm/packages/zcode-cua-plugin');
    await file(path.join(desktop, 'ZCode.exe'), 'never execute');
    await file(path.join(desktop, 'resources/glm/zcode.cjs'), 'throw new Error("must not run")');
    await file(path.join(desktop, 'resources/glm/.node-bundle-meta.json'), JSON.stringify({ runtime: 'electron-node', entry: 'zcode.cjs' }));
    await file(path.join(bundled, 'package.json'), JSON.stringify({ name: '@zcode/zcode-cua-plugin', version: '1.0.0' }));
    for (const root of [cache, bundled]) {
      await file(path.join(root, '.zcode-plugin/plugin.json'), manifest);
      await file(path.join(root, 'skills/computer-use/SKILL.md'), 'same bundled guidance');
      await file(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { builtin: { command: 'never-execute' } } }));
    }
    await file(path.join(desktop, 'resources/glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md'), 'bundled standalone');
    await file(path.join(home, '.zcode/cli/config.json'), JSON.stringify({ plugins: { enabledPlugins: { 'computer-use@zcode-plugins-official': false } } }));
  });
  afterEach(async () => removeTestDirectory(directory));
  async function scan() {
    const instances = await zcodeAdapter.discover({ homeDir: home, env: { ZCODE_DESKTOP_ROOT: desktop } });
    expect(instances[0]?.desktopResourceRoot).toBe(desktop);
    return zcodeAdapter.scan({ instance: { ...instances[0]!, writable: true } });
  }
  it('labels exact cache copies and config identity as built-in, scans omitted standalone skills and preserves disablement', async () => {
    const before = await fileTreeDigests(directory);
    const report = await scan();
    const cacheParent = report.bindings.find(b => b.kind === 'plugin' && b.origin === 'cache')!;
    expect(cacheParent.sourceKind).toBe('builtin'); expect(cacheParent.enabled).toBe(false);
    expect(report.bindings.find(b => b.origin === 'configuration')?.sourceKind).toBe('builtin');
    const children = report.bindings.filter(b => b.parentId === cacheParent.id);
    expect(children).toHaveLength(2); expect(children.every(b => b.sourceKind === 'builtin' && b.enabled === false)).toBe(true);
    const standalone = report.bindings.find(b => b.name === 'dynamic-workflows')!;
    expect(standalone.sourceKind).toBe('builtin'); expect(standalone.enabled).toBe(null); expect(standalone.writable).toBe(false);
    expect(standalone.classification?.location?.category).toBe('agent-global');
    expect(await fileTreeDigests(directory)).toEqual(before);
  });
  it('does not call an altered skill or an older cache a built-in copy just because the market is official', async () => {
    await file(path.join(cache, 'skills/computer-use/SKILL.md'), 'altered content');
    const older = path.join(path.dirname(cache), '0.9.0');
    await file(path.join(older, '.zcode-plugin/plugin.json'), JSON.stringify({ name: 'computer-use', version: '0.9.0' }));
    const report = await scan();
    expect(report.bindings.find(b => b.sourcePath === path.join(cache, 'skills/computer-use'))?.sourceKind).toBe('plugin');
    expect(report.bindings.find(b => b.kind === 'plugin' && b.pluginVersion === '0.9.0')?.sourceKind).toBe('plugin');
    expect(report.bindings.filter(b => b.name === 'computer-use' && b.kind === 'skill')).toHaveLength(2);
  });
  it('rejects an unverified installation root and still inventories normal user resources', async () => {
    await file(path.join(desktop, 'resources/glm/.node-bundle-meta.json'), JSON.stringify({ runtime: 'unknown', entry: 'zcode.cjs' }));
    const instances = await zcodeAdapter.discover({ homeDir: home, env: { ZCODE_DESKTOP_ROOT: desktop } });
    expect(instances[0]?.desktopResourceRoot).toBeUndefined();
    expect((await zcodeAdapter.scan({ instance: instances[0]! })).bindings.every(b => !b.builtinSourcePath)).toBe(true);
  });
});
