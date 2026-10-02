import path from 'node:path';
import { mkdir, readFile, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareToggle, applyPrepared, prepareRestore, recoverIncomplete } from '../packages/change-engine/src/index.ts';
import { createTestDirectory, removeTestDirectory } from './helpers.ts';

describe('Codex MCP changes preserve user configuration', () => {
  let directory: string;
  let configPath: string;
  let dataDir: string;

  beforeEach(async () => {
    directory = await createTestDirectory('changes');
    configPath = path.join(directory, 'config.toml');
    dataDir = path.join(directory, 'data');
  });
  afterEach(async () => removeTestDirectory(directory));

  async function save(content: string): Promise<void> { await writeFile(configPath, content, 'utf8'); }
  async function toggle(enabled: boolean, serverName = 'docs') {
    const prepared = await prepareToggle({ configPath, serverName, enabled });
    return applyPrepared(prepared, { dataDir });
  }

  it('changes only an enabled value and preserves BOM, CRLF, comments and unrelated secrets', async () => {
    const source = '\uFEFF# keep this\r\n[mcp_servers.docs]\r\nurl = "https://example.invalid/mcp"\r\nenabled = true # retain\r\nhttp_headers = { Authorization = "Bearer AGENTDECK_SECRET_SENTINEL" }\r\n\r\n[unrelated]\r\nvalue = 42\r\n';
    await save(source);
    const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    expect(JSON.stringify(prepared.plan)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    await applyPrepared(prepared, { dataDir });
    expect(await readFile(configPath, 'utf8')).toBe(source.replace('enabled = true', 'enabled = false'));
  });

  it('inserts an absent enabled field into the intended table only', async () => {
    await save('# keep\n[mcp_servers.docs]\nurl = "https://example.invalid"\n\n[mcp_servers.other]\nenabled = true\n');
    await toggle(false);
    const content = await readFile(configPath, 'utf8');
    const target = content.split('[mcp_servers.docs]')[1]!.split('[mcp_servers.other]')[0]!;
    expect(target).toMatch(/enabled\s*=\s*false/);
    expect(content.split('[mcp_servers.other]')[1]).toContain('enabled = true');
    expect(content).toContain('# keep');
  });

  it('supports a quoted server name containing dots without changing another table', async () => {
    const source = '[mcp_servers."server.with-dot"]\nenabled = false\n\n[mcp_servers.docs]\nenabled = true\n';
    await save(source);
    await toggle(true, 'server.with-dot');
    expect(await readFile(configPath, 'utf8')).toBe(source.replace('enabled = false', 'enabled = true'));
  });

  it('does not treat a fake table inside a multiline string as the edit target', async () => {
    const source = 'notes = """\n[mcp_servers.docs]\nenabled = true\n"""\n\n[mcp_servers.docs]\nenabled = true # actual target\n';
    await save(source);
    try {
      const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
      await applyPrepared(prepared, { dataDir });
      expect(await readFile(configPath, 'utf8')).toBe(source.replace('enabled = true # actual target', 'enabled = false # actual target'));
    } catch {
      // Conservative rejection of this uncommon structure is acceptable, but partial edits are not.
      expect(await readFile(configPath, 'utf8')).toBe(source);
    }
  });

  it('inserts enabled before a child table rather than in its headers', async () => {
    const source = '[mcp_servers.docs]\nurl = "https://example.invalid"\n\n[mcp_servers.docs.http_headers]\nAuthorization = "Bearer AGENTDECK_SECRET_SENTINEL"\n';
    await save(source);
    const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    expect(JSON.stringify(prepared.plan)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    await applyPrepared(prepared, { dataDir });
    const changed = await readFile(configPath, 'utf8');
    expect(changed.split('[mcp_servers.docs.http_headers]')[0]).toContain('enabled = false');
    expect(changed.split('[mcp_servers.docs.http_headers]')[1]).toBe(source.split('[mcp_servers.docs.http_headers]')[1]);
  });

  it('never edits an unrelated array table while locating the target enabled field', async () => {
    const source = '[mcp_servers.docs]\nurl = "https://example.invalid"\n\n[[unrelated]]\nenabled = true\n';
    await save(source);
    let prepared;
    try { prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false }); }
    catch { expect(await readFile(configPath, 'utf8')).toBe(source); return; }
    await applyPrepared(prepared, { dataDir });
    const changed = await readFile(configPath, 'utf8');
    expect(changed.split('[[unrelated]]')[0]).toContain('enabled = false');
    expect(changed.split('[[unrelated]]')[1]).toBe(source.split('[[unrelated]]')[1]);
  });

  it('refuses inline tables and duplicate declarations instead of rewriting the whole file', async () => {
    for (const source of [
      'mcp_servers = { docs = { enabled = true } }\n',
      '[mcp_servers.docs]\nenabled = true\n[mcp_servers.docs]\nenabled = false\n',
    ]) {
      await save(source);
      await expect(prepareToggle({ configPath, serverName: 'docs', enabled: false })).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(source);
    }
  });

  it('rejects a stale plan after an external edit', async () => {
    await save('[mcp_servers.docs]\nenabled = true\n');
    const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    const edited = '[mcp_servers.docs]\nenabled = true\n# externally added\n';
    await save(edited);
    await expect(applyPrepared(prepared, { dataDir })).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(edited);
  });

  it('rejects an expired plan before writing', async () => {
    const source = '[mcp_servers.docs]\nenabled = true\n';
    await save(source);
    const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false,
      now: new Date('2026-10-02T00:00:00Z'), ttlMs: 1000 });
    await expect(applyPrepared(prepared, { dataDir, now: new Date('2026-10-02T00:00:02Z') })).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });

  it('restores the exact original bytes', async () => {
    const source = '# original\r\n[mcp_servers.docs]\r\nenabled = true\r\n';
    await save(source);
    const applied = await toggle(false);
    const restoration = await prepareRestore({ operationId: applied.operation.id, dataDir });
    await applyPrepared(restoration, { dataDir });
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });

  it('refuses a restoration that would overwrite a later edit', async () => {
    await save('[mcp_servers.docs]\nenabled = true\n');
    const applied = await toggle(false);
    const edited = '[mcp_servers.docs]\nenabled = false\n# edit after apply\n';
    await save(edited);
    await expect(prepareRestore({ operationId: applied.operation.id, dataDir })).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(edited);
  });

  it('releases its target lock when creating the data directory fails', async () => {
    await save('[mcp_servers.docs]\nenabled = true\n');
    const prepared = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    const invalidDataDir = path.join(directory, 'regular-file');
    await writeFile(invalidDataDir, 'this is a file');
    await expect(applyPrepared(prepared, { dataDir: invalidDataDir })).rejects.toThrow();
    const applied = await applyPrepared(prepared, { dataDir });
    expect(applied.operation.status).toBe('succeeded');
  });

  it('coordinates concurrent changes even when managers use different data directories', async () => {
    await save('[mcp_servers.docs]\nenabled = true\n');
    const first = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    const second = await prepareToggle({ configPath, serverName: 'docs', enabled: false });
    const outcomes = await Promise.allSettled([
      applyPrepared(first, { dataDir }),
      applyPrepared(second, { dataDir: path.join(directory, 'another-manager') }),
    ]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(await readFile(configPath, 'utf8')).toBe('[mcp_servers.docs]\nenabled = false\n');
  });

  it('completes a journal interrupted after replacement without writing the target again', async () => {
    await save('[mcp_servers.docs]\nenabled = true\n');
    const applied = await toggle(false);
    const journal = JSON.parse(await readFile(applied.journalPath, 'utf8'));
    journal.stage = 'writing';
    delete journal.appliedIdentity;
    journal.operation.status = 'failed';
    await writeFile(applied.journalPath, JSON.stringify(journal));
    await rm(path.join(dataDir, 'change-engine', 'operations', `${applied.operation.id}.json`));
    const beforeRecovery = await readFile(configPath);
    const report = await recoverIncomplete({ dataDir });
    expect(report.items.find(item => item.operationId === applied.operation.id)?.status).toBe('completed');
    expect((await readFile(configPath)).equals(beforeRecovery)).toBe(true);
    const restoration = await prepareRestore({ operationId: applied.operation.id, dataDir });
    await applyPrepared(restoration, { dataDir });
    expect(await readFile(configPath, 'utf8')).toBe('[mcp_servers.docs]\nenabled = true\n');
  });

  it('does not modify plugin MCP tables through the standalone-server API', async () => {
    const source = '[plugins."example@local".mcp_servers.docs]\nenabled = true\n';
    await save(source);
    await expect(prepareToggle({ configPath, serverName: 'docs', enabled: false })).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(source);
  });

  it('rejects a directory junction retargeted after planning', async () => {
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    const link = path.join(directory, 'linked');
    await mkdir(first); await mkdir(second);
    const source = '[mcp_servers.docs]\nenabled = true\n';
    await writeFile(path.join(first, 'config.toml'), source);
    await writeFile(path.join(second, 'config.toml'), source);
    await symlink(first, link, process.platform === 'win32' ? 'junction' : 'dir');
    const prepared = await prepareToggle({ configPath: path.join(link, 'config.toml'), serverName: 'docs', enabled: false });
    await unlink(link);
    await symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(applyPrepared(prepared, { dataDir })).rejects.toThrow();
    expect(await readFile(path.join(first, 'config.toml'), 'utf8')).toBe(source);
    expect(await readFile(path.join(second, 'config.toml'), 'utf8')).toBe(source);
  });
});
