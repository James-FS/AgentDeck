import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function addPluginCacheFixture(home: string, project: string): Promise<void> {
  for (const client of ['.codex', '.claude']) {
    for (const name of ['data', 'marketplaces', '.plugin-appserver']) await mkdir(path.join(home, client, 'plugins', name), { recursive: true });
  }
  async function json(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2));
  }
  async function skill(root: string, name: string) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\nFixture skill.\n`);
  }
  for (const version of ['1.0.0', '2.0.0']) {
    const root = path.join(home, '.codex/plugins/cache/fixture-market/fixture-tools', version);
    await json(path.join(root, '.codex-plugin/plugin.json'), {
      name: 'fixture-tools', version, skills: './skills/', mcpServers: './.mcp.json',
    });
    await skill(path.join(root, 'skills'), `cached-review-${version}`);
    await json(path.join(root, '.mcp.json'), {
      mcpServers: { 'cached-docs': { command: 'fixture-only', env: { TOKEN: 'AGENTDECK_SECRET_SENTINEL' } } },
    });
  }
  const orphan = path.join(home, '.codex/plugins/cache/other-market/fixture-tools/3.0.0');
  await json(path.join(orphan, '.codex-plugin/plugin.json'), { name: 'fixture-tools', version: '3.0.0' });
  await skill(path.join(orphan, 'skills'), 'unconfigured-review');
  const invalid = path.join(home, '.codex/plugins/cache/fixture-market/escape-tools/1.0.0');
  await json(path.join(invalid, '.codex-plugin/plugin.json'), {
    name: 'escape-tools', skills: '../../../../../../outside-skills', mcpServers: '../../../../../../outside-mcp.json',
  });
  await skill(path.join(home, 'outside-skills'), 'must-not-import');
  await json(path.join(home, 'outside-mcp.json'), { mcpServers: { 'must-not-import': {} } });
  const localMcp = path.join(home, '.codex/plugins/cache/fixture-market/local-mcp-tools/1.0.0');
  await json(path.join(localMcp, '.codex-plugin/plugin.json'), { name: 'local-mcp-tools', version: '1.0.0', mcpServers: './.mcp.json' });
  await json(path.join(localMcp, '.mcp.json'), { mcpServers: { 'locally-disabled': { command: 'fixture-only', enabled: false } } });
  const config = path.join(home, '.codex/config.toml');
  await writeFile(config, `${await readFile(config, 'utf8')}\n[plugins."fixture-tools@fixture-market"]\nenabled = false\n[plugins."local-mcp-tools@fixture-market"]\nenabled = true\n`);
  await mkdir(path.join(project, '.codex'), { recursive: true });
  await writeFile(path.join(project, '.codex/config.toml'), '[mcp_servers.project-docs]\ncommand = "fixture-only"\n[plugins."fixture-tools@fixture-market"]\nenabled = true\n');

  const claudeRoot = path.join(home, '.claude/plugins/cache/fixture-market/claude-tools/1.0.0');
  await json(path.join(claudeRoot, '.claude-plugin/plugin.json'), {
    name: 'claude-tools', version: '1.0.0', skills: './skills', mcpServers: './.mcp.json',
  });
  await skill(path.join(claudeRoot, 'skills'), 'claude-cache-review');
  await json(path.join(claudeRoot, '.mcp.json'), {
    mcpServers: { 'claude-cache-docs': { command: 'fixture-only', env: { TOKEN: 'AGENTDECK_SECRET_SENTINEL' } } },
  });
  await json(path.join(home, '.claude/plugins/installed_plugins.json'), {
    version: 2, plugins: { 'claude-tools@fixture-market': [{ scope: 'user', installPath: claudeRoot, version: '1.0.0' }] },
  });
  const settingsFile = path.join(home, '.claude/settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  await json(settingsFile, { ...settings, enabledPlugins: { ...settings.enabledPlugins, 'claude-tools@fixture-market': false } });
  await json(path.join(project, '.claude/settings.json'), { enabledPlugins: { 'claude-tools@fixture-market': true } });
}
