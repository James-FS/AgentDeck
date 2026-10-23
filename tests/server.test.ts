import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app.ts';
import { createStore } from '../packages/storage/src/index.ts';
import { applyPrepared, type PreparedChange } from '../packages/change-engine/src/index.ts';
import type { AgentInstance, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index.ts';
import { copyCatalogFixture, createTestDirectory, fileTreeDigests, removeTestDirectory } from './helpers.ts';

describe('local API with actual network peers and isolated configuration', () => {
  let directory: string;
  let home: string;
  let app: ReturnType<typeof createApp>;
  let origin: string;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    directory = await createTestDirectory('server-');
    ({ home } = await copyCatalogFixture(directory));
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, userHomeDir: home, userDiscoveryEnv: {}, demoDir: path.join(directory, 'demo'), discoveryEnv: {}, allowedOrigins: [] });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    expect(response.status).toBe(200);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
  });

  afterEach(async () => {
    await app?.close();
    if (directory) await removeTestDirectory(directory);
  });

  async function call<T = Record<string, unknown>>(method: string, endpoint: string, body?: unknown, authenticated = true, extraHeaders: Record<string, string> = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Origin: origin,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      ...(authenticated ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...extraHeaders,
    };
    return await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: T }>((resolve, reject) => {
      const request = httpRequest(new URL(endpoint, origin), { method, headers }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode!, headers: response.headers, body: text ? JSON.parse(text) : null });
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }

  async function writableCodex() {
    const registration = await call<AgentInstance>('POST', '/api/v1/instances', { agentId: 'codex', configRoot: path.join(home, '.codex'), writable: true });
    expect(registration.status).toBe(201);
    const instance = registration.body as AgentInstance;
    const scan = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id });
    expect(scan.status).toBe(200);
    const binding = (scan.body as Catalog).bindings.find(item => item.instanceId === instance.id && item.kind === 'mcp' && item.name === 'docs')!;
    expect(binding).toBeDefined();
    return { instance, binding };
  }

  it('keeps configured discovery isolated until the explicit user-home scan, without changing source files', async () => {
    await app.close();
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: path.join(directory, 'empty-home'), userHomeDir: home, userDiscoveryEnv: {}, discoveryEnv: {}, allowedOrigins: [] });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const session = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(session.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(session.body.csrfToken);
    const before = await fileTreeDigests(home);
    const isolated = await call<Catalog>('POST', '/api/v1/scans', { discover: true });
    expect(isolated.body.instances).toHaveLength(0);
    expect((await call('POST', '/api/v1/scans', { discoverUserHome: true }, false)).status).toBe(401);
    expect((await call('POST', '/api/v1/scans', { discoverUserHome: true }, true, { 'X-CSRF-Token': '' })).status).toBe(403);
    const actual = await call<Catalog>('POST', '/api/v1/scans', { discoverUserHome: true });
    expect(actual.status).toBe(200);
    expect(actual.body.instances).toHaveLength(4);
    expect(actual.body.bindings.length).toBeGreaterThan(5);
    expect(actual.body.instances.every(item => item.writable)).toBe(true);
    expect(actual.body.bindings.filter(item => item.writable && item.toggleTarget).every(item => item.toggleTarget?.agentId === actual.body.instances.find(instance => instance.id === item.instanceId)!.agentId)).toBe(true);
    expect(await fileTreeDigests(home)).toEqual(before);
    expect(JSON.stringify(actual.body)).not.toContain('AGENTDECK_SECRET_SENTINEL');
  });

  it('requires a session and CSRF token and consumes bootstrap tickets once', async () => {
    expect((await call('GET', '/api/v1/catalog', undefined, false)).status).toBe(401);
    expect((await call('GET', '/api/v1/runtime', undefined, false)).status).toBe(401);
    expect((await call('POST', '/api/v1/demo', {}, true, { 'X-CSRF-Token': '' })).status).toBe(403);
    const ticket = app.agentdeckAuth.issueBootstrapTicket();
    expect((await call('POST', '/api/v1/session/bootstrap', { ticket }, false)).status).toBe(200);
    expect((await call('POST', '/api/v1/session/bootstrap', { ticket }, false)).status).toBe(401);
  });

  it('serves details and full-text search only for registered, scanned Skills', async () => {
    const skillRoot = path.join(directory, 'independent-skills', 'long-description');
    await mkdir(skillRoot, { recursive: true });
    const description = 'A complete description. '.repeat(35);
    await writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: long-description\ndescription: "${description.trim()}"\nauthor: Grace\n---\n# Searchable body\nneedlephrase`);
    const root = path.dirname(skillRoot);
    const registration = await call<{ id: string }>('POST', '/api/v1/skill-sources', { path: root });
    expect(registration.status).toBe(201);
    const findingPath = path.join(skillRoot, 'SKILL.md');
    const details = await call('GET', `/api/v1/skills/details?sourceId=${encodeURIComponent(registration.body.id)}&findingPath=${encodeURIComponent(findingPath)}`);
    expect(details.status, JSON.stringify(details.body)).toBe(200);
    expect(details.body.description).toBe(description.trim());
    expect(details.body.author).toBe('Grace');
    expect(details.body.body).toContain('needlephrase');
    const search = await call('GET', `/api/v1/skills/search?q=needlephrase`);
    expect(search.body.matches).toHaveLength(1);
    expect(search.body).toMatchObject({ totalCandidates: 1, examined: 1, truncated: false, nextOffset: null });
    expect((await call('GET', `/api/v1/skills/details?sourceId=missing&findingPath=${encodeURIComponent(findingPath)}`)).status).toBe(404);
    expect((await call('GET', `/api/v1/skills/details?sourceId=${encodeURIComponent(registration.body.id)}&findingPath=${encodeURIComponent(path.join(directory, 'README.md'))}`)).status).toBe(404);
    expect((await call('GET', `/api/v1/skills/details?sourceId=${encodeURIComponent(registration.body.id)}&findingPath=${encodeURIComponent(findingPath)}`, undefined, false)).status).toBe(401);
  });

  it('searches the parsed manifest name when it differs from the containing folder', async () => {
    const root = path.join(directory, 'manifest-name-search');
    const skillDir = path.join(root, 'folder-name');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: metadata-unique-name-472\ndescription: A helpful utility.\n---\n# Guide');
    const registration = await call<{ id: string }>('POST', '/api/v1/skill-sources', { path: root });
    expect(registration.status).toBe(201);
    const search = await call('GET', '/api/v1/skills/search?q=metadata-unique-name-472');
    expect(search.body).toMatchObject({ examined: 1, failures: 0, matches: [{ name: 'metadata-unique-name-472' }] });
    expect(search.body.matches[0].snippet).toContain('metadata-unique-name-472');
  });

  it('paginates a bounded full-text search and reports every candidate through a continuation offset', async () => {
    const root = path.join(directory, 'paged-search-library');
    for (let index = 0; index < 31; index += 1) {
      const skillDir = path.join(root, `skill-${String(index).padStart(2, '0')}`);
      await mkdir(skillDir, { recursive: true });
      const marker = index === 30 ? 'PAGED_LATE_NEEDLE_552' : `ordinary-${index}`;
      await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: skill-${index}\ndescription: Search page ${index}.\n---\n${marker}`);
    }
    const registration = await call<{ id: string }>('POST', '/api/v1/skill-sources', { path: root, mode: 'deep' });
    expect(registration.status).toBe(201);
    const first = await call('GET', '/api/v1/skills/search?q=PAGED_LATE_NEEDLE_552&offset=0');
    expect(first.body.matches).toHaveLength(0);
    expect(first.body).toMatchObject({ totalCandidates: 31, examined: 30, truncated: true, nextOffset: 30 });
    const second = await call('GET', `/api/v1/skills/search?q=PAGED_LATE_NEEDLE_552&offset=${first.body.nextOffset}`);
    expect(second.body.matches).toHaveLength(1);
    expect(second.body).toMatchObject({ totalCandidates: 31, examined: 1, truncated: false, nextOffset: null });
  });

  it('reports independent candidates as unbound and rechecks their current format and disk presence', async () => {
    const { instance } = await writableCodex();
    const root = path.join(directory, 'independent-status-library');
    const malformed = path.join(root, 'malformed');
    await mkdir(malformed, { recursive: true });
    const manifest = path.join(malformed, 'SKILL.md');
    await writeFile(manifest, '---\nname: [broken\n---\n# candidate');
    const registration = await call<{ id: string }>('POST', '/api/v1/skill-sources', { path: root, mode: 'deep' });
    const availability = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(instance.id)}`);
    const candidate = availability.body.independent.find((item: { sourceId: string }) => item.sourceId === registration.body.id);
    expect(candidate).toMatchObject({ status: 'present', format: 'invalid', bound: false });
    await rm(manifest);
    const afterRemoval = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(instance.id)}`);
    expect(afterRemoval.body.independent.find((item: { sourceId: string }) => item.sourceId === registration.body.id))
      .toMatchObject({ status: 'missing', format: 'unavailable', bound: false });
  });

  it('rejects an independent source root replaced by a junction to another same-home directory', async () => {
    const { instance } = await writableCodex();
    const sourceRoot = path.join(directory, 'replaceable-skill-root');
    const outsideRoot = path.join(directory, 'outside-private-root');
    const skillDir = path.join(sourceRoot, 'scanned-skill');
    await mkdir(skillDir, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: scanned-skill\ndescription: safe.\n---');
    await writeFile(path.join(outsideRoot, 'SKILL.md'), '---\nname: private.\ndescription: private.\n---\nPRIVATE_SOURCE_JUNCTION_184');
    const source = await call<{ id: string }>('POST', '/api/v1/skill-sources', { path: sourceRoot, mode: 'deep' });
    const findingPath = path.join(skillDir, 'SKILL.md');
    await rm(sourceRoot, { recursive: true });
    await symlink(outsideRoot, sourceRoot, 'junction');
    const detail = await call('GET', `/api/v1/skills/details?sourceId=${encodeURIComponent(source.body.id)}&findingPath=${encodeURIComponent(findingPath)}`);
    expect(detail.status).toBe(403);
    const search = await call('GET', '/api/v1/skills/search?q=PRIVATE_SOURCE_JUNCTION_184');
    expect(search.body.matches).toHaveLength(0);
    const availability = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(instance.id)}`);
    expect(availability.body.independent.find((item: { sourceId: string }) => item.sourceId === source.body.id))
      .toMatchObject({ status: 'unreadable', bound: false });
  });

  it('keeps configuration-only Skill records inspectable without exposing the config file as Markdown', async () => {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ skillOverrides: { 'manual-only-skill': 'off' } }));
    const registered = await call<AgentInstance>('POST', '/api/v1/instances', { agentId: 'claude-code', configRoot: path.join(home, '.claude') });
    await call('POST', '/api/v1/scans', { instanceId: registered.body.id });
    const catalog = await call<Catalog>('GET', '/api/v1/catalog');
    const override = catalog.body.bindings.find(item => item.kind === 'skill' && item.name === 'manual-only-skill')!;
    expect(override).toBeDefined();
    const details = await call('GET', `/api/v1/skills/details?bindingId=${encodeURIComponent(override.id)}`);
    expect(details.status).toBe(200);
    expect(details.body.body).toBe('');
    expect(details.body.metadataIssues[0]).toContain('配置项');
    expect(details.body.body).not.toContain('skillOverrides');
    const availability = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(registered.body.id)}`);
    expect(availability.body.bindings[override.id]).toMatchObject({ disk: 'configuration-only', format: 'unavailable' });
    const search = await call('GET', '/api/v1/skills/search?q=manual-only-skill');
    expect(search.body.matches.some((item: { bindingId: string }) => item.bindingId === override.id)).toBe(true);
  });

  it('locates user-home and project Skill bindings through trusted registered roots for details and search', async () => {
    const globalDir = path.join(home, '.agents', 'skills', 'global-needle');
    const projectRoot = path.join(directory, 'registered-project');
    const projectDir = path.join(projectRoot, '.agents', 'skills', 'project-needle');
    await mkdir(globalDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(globalDir, 'SKILL.md'), '---\nname: global-needle\ndescription: Global skill.\n---\nGLOBAL_NEEDLE_738');
    await writeFile(path.join(projectDir, 'SKILL.md'), '---\nname: project-needle\ndescription: Project skill.\n---\nPROJECT_NEEDLE_941');
    const registeredInstance = await call<AgentInstance>('POST', '/api/v1/instances', { agentId: 'codex', configRoot: path.join(home, '.codex') });
    const registeredProject = await call<{ id: string }>('POST', '/api/v1/projects', { rootPath: projectRoot });
    const projectId = registeredProject.body.id;
    const scanned = await call<Catalog>('POST', '/api/v1/scans', { instanceId: registeredInstance.body.id, projectId });
    const globalBinding = scanned.body.bindings.find(item => item.kind === 'skill' && item.name === 'global-needle')!;
    const projectBinding = scanned.body.bindings.find(item => item.kind === 'skill' && item.name === 'project-needle')!;
    expect(globalBinding).toBeDefined();
    expect(projectBinding).toBeDefined();
    const globalDetail = await call('GET', `/api/v1/skills/details?bindingId=${encodeURIComponent(globalBinding.id)}`);
    const projectDetail = await call('GET', `/api/v1/skills/details?bindingId=${encodeURIComponent(projectBinding.id)}`);
    expect(globalDetail.status, JSON.stringify(globalDetail.body)).toBe(200);
    expect(projectDetail.status, JSON.stringify(projectDetail.body)).toBe(200);
    expect(globalDetail.body.body).toContain('GLOBAL_NEEDLE_738');
    expect(projectDetail.body.body).toContain('PROJECT_NEEDLE_941');
    const globalSearch = await call('GET', '/api/v1/skills/search?q=GLOBAL_NEEDLE_738');
    const projectSearch = await call('GET', '/api/v1/skills/search?q=PROJECT_NEEDLE_941');
    expect(globalSearch.body.matches.some((item: { bindingId: string }) => item.bindingId === globalBinding.id)).toBe(true);
    expect(projectSearch.body.matches.some((item: { bindingId: string }) => item.bindingId === projectBinding.id)).toBe(true);
    const availability = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(registeredInstance.body.id)}&projectId=${encodeURIComponent(projectId)}&workdir=${encodeURIComponent(projectRoot)}`);
    expect(availability.status).toBe(200);
    expect(availability.body.bindings[globalBinding.id]).toMatchObject({ disk: 'present', format: 'valid' });
    expect(availability.body.bindings[projectBinding.id]).toMatchObject({ disk: 'present', format: 'valid' });
    await rm(path.join(projectDir, 'SKILL.md'));
    const missingFileState = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(registeredInstance.body.id)}&projectId=${encodeURIComponent(projectId)}`);
    expect(missingFileState.body.bindings[projectBinding.id]).toMatchObject({ disk: 'missing', format: 'unavailable' });
  });

  it('rejects a same-home junction that replaces a scanned Skill with an unrelated private directory', async () => {
    const { instance } = await writableCodex();
    const skillDir = path.join(home, '.agents', 'skills', 'junction-probe');
    const privateDir = path.join(home, 'unrelated-private-dir');
    await mkdir(skillDir, { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: junction-probe\ndescription: Scanned skill.\n---\nOriginal content.');
    await writeFile(path.join(privateDir, 'SKILL.md'), '---\nname: unrelated-private\ndescription: Private.\n---\nPRIVATE_JUNCTION_BODY_763');
    const scan = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id });
    const binding = scan.body.bindings.find(item => item.kind === 'skill' && item.name === 'junction-probe')!;
    expect(binding).toBeDefined();
    expect(binding.skillRootRealPath).toBe(path.join(home, '.agents', 'skills'));
    await rm(skillDir, { recursive: true });
    await symlink(privateDir, skillDir, 'junction');
    const detail = await call('GET', `/api/v1/skills/details?bindingId=${encodeURIComponent(binding.id)}`);
    expect(detail.status).toBe(403);
    expect(JSON.stringify(detail.body)).not.toContain('PRIVATE_JUNCTION_BODY_763');
    const searchMatches: Array<{ bindingId?: string }> = [];
    let offset = 0;
    while (true) {
      const page = await call('GET', `/api/v1/skills/search?q=PRIVATE_JUNCTION_BODY_763&offset=${offset}`);
      searchMatches.push(...page.body.matches);
      if (page.body.nextOffset === null) break;
      offset = page.body.nextOffset;
    }
    expect(searchMatches.some(item => item.bindingId === binding.id)).toBe(false);
    const availability = await call('GET', `/api/v1/skills/availability?instanceId=${encodeURIComponent(instance.id)}`);
    expect(availability.body.bindings[binding.id].disk).toBe('unreadable');
    expect(availability.body.bindings[binding.id].reason).toContain('物理身份');
  });

  it('rejects hostile Host and browser Origin even after the server has started', async () => {
    expect((await call('GET', '/health', undefined, false, { Host: 'attacker.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/catalog', undefined, true, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/catalog', undefined, true, { Origin: 'http://localhost:5173' })).status).toBe(403);
  });

  it('discovers four fixture clients without exposing configuration credentials', async () => {
    const response = await call<Catalog>('POST', '/api/v1/scans', { discover: true });
    expect(response.status).toBe(200);
    const catalog = response.body as Catalog;
    expect(new Set(catalog.instances.map(item => item.agentId)).size).toBe(4);
    expect(catalog.bindings.length).toBeGreaterThan(5);
    expect(JSON.stringify(catalog)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect(catalog.instances.every(item => item.writable)).toBe(true);
    const binding = catalog.bindings.find(item => item.kind === 'mcp' && item.name === 'docs')!;
    expect((await call('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).status).toBe(201);
  });

  it('keeps explicit instance registration when rediscovering the same root', async () => {
    const { instance } = await writableCodex();
    const response = await call<Catalog>('POST', '/api/v1/scans', { discover: true });
    const saved = (response.body as Catalog).instances.find(item => path.resolve(item.configRoot) === path.resolve(instance.configRoot));
    expect(saved?.id).toBe(instance.id);
    expect(saved?.discovery).toBe('manual');
    expect(saved?.writable).toBe(true);
  });

  it('upgrades a discovered root to manual registration without creating a second instance', async () => {
    const initial = (await call<Catalog>('POST', '/api/v1/scans', { discover: true })).body;
    const discovered = initial.instances.find(item => item.agentId === 'codex')!;
    const { instance } = await writableCodex();
    expect(instance.id).toBe(discovered.id);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.instances.filter(item => item.agentId === 'codex')).toHaveLength(1);
    expect(catalog.instances.find(item => item.id === instance.id)?.discovery).toBe('manual');
  });

  it('merges project and user bindings without duplicates and keeps another project scan', async () => {
    const { instance } = await writableCodex();
    const projectRoot = path.join(directory, 'project');
    const registered = await call('POST', '/api/v1/projects', { rootPath: projectRoot });
    expect(registered.status).toBe(201);
    const projectId = registered.body.id;
    const scanned = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id, projectId });
    expect(scanned.status).toBe(200);
    const rows = (scanned.body as Catalog).bindings;
    expect(rows.some(item => item.name === 'project-review' && item.projectId === projectId)).toBe(true);
    expect(rows.some(item => item.name === 'docs' && item.projectId === null)).toBe(true);
    expect(new Set(rows.map(item => item.id)).size).toBe(rows.length);
    const rescanned = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id });
    expect((rescanned.body as Catalog).bindings.some(item => item.name === 'project-review' && item.projectId === projectId)).toBe(true);
  });

  it('removes the cancelled runtime endpoint while retaining configuration capability evidence', async () => {
    await writableCodex();
    const before = await fileTreeDigests(home);
    const response = await call('GET', '/api/v1/runtime');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect((await call('GET', '/api/v1/compatibility')).status).toBe(200);
    expect((await call('GET', '/api/v1/catalog')).status).toBe(200);
    expect(await fileTreeDigests(home)).toEqual(before);
  });

  it('refreshes removed global and selected-project sources while retaining another project', async () => {
    const { instance } = await writableCodex();
    const firstRoot = path.join(directory, 'project');
    const secondRoot = path.join(directory, 'other-project');
    await mkdir(path.join(secondRoot, '.agents/skills/second-review'), { recursive: true });
    await writeFile(path.join(secondRoot, '.agents/skills/second-review/SKILL.md'), 'fixture');
    const first = await call<{ id: string }>('POST', '/api/v1/projects', { rootPath: firstRoot });
    const second = await call<{ id: string }>('POST', '/api/v1/projects', { rootPath: secondRoot });
    await call('POST', '/api/v1/scans', { instanceId: instance.id, projectId: first.body.id });
    const secondScan = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id, projectId: second.body.id });
    const global = secondScan.body.bindings.find(item => item.kind === 'skill' && item.projectId === null && item.sourceKind === 'user')!;
    expect(global).toBeDefined();
    await rm(global.sourcePath, { recursive: true });
    await rm(path.join(firstRoot, '.agents/skills/project-review'), { recursive: true });
    const refreshed = await call<Catalog>('POST', '/api/v1/scans', { instanceId: instance.id, projectId: first.body.id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.bindings.some(item => item.id === global.id)).toBe(false);
    expect(refreshed.body.bindings.some(item => item.name === 'project-review' && item.projectId === first.body.id)).toBe(false);
    expect(refreshed.body.bindings.some(item => item.name === 'second-review' && item.projectId === second.body.id)).toBe(true);
    expect(new Set(refreshed.body.bindings.map(item => item.id)).size).toBe(refreshed.body.bindings.length);
  });

  it('persists a prepared plan, applies once, refreshes the catalog, and restores exact bytes', async () => {
    const { binding } = await writableCodex();
    const before = await readFile(binding.sourcePath);
    const prepared = await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false });
    expect(prepared.status).toBe(201);
    const plan = prepared.body as ChangePlan;
    expect(JSON.stringify(plan)).not.toContain('AGENTDECK_SECRET_SENTINEL');
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(true);
    const applied = await call<Operation>('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(applied.status).toBe(200);
    const operation = applied.body as Operation;
    expect(operation.status).toBe('succeeded');
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(false);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
    const replay = await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(operation.id);
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: 'incorrect-digest' })).status).toBe(409);
    const restoration = await call<ChangePlan>('POST', `/api/v1/operations/${operation.id}/restore-plan`, {});
    expect(restoration.status).toBe(201);
    const restorePlan = restoration.body as ChangePlan;
    expect((await call('POST', `/api/v1/plans/${restorePlan.id}/apply`, { digest: restorePlan.afterHash })).status).toBe(200);
    expect((await readFile(binding.sourcePath)).equals(before)).toBe(true);
    const restoredCatalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(restoredCatalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(true);
  });

  it('refuses stale plans and records a conflict without overwriting external edits', async () => {
    const { binding } = await writableCodex();
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    const externallyEdited = Buffer.concat([await readFile(binding.sourcePath), Buffer.from('\n# edited externally\n')]);
    await writeFile(binding.sourcePath, externallyEdited);
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash })).status).toBe(409);
    expect((await readFile(binding.sourcePath)).equals(externallyEdited)).toBe(true);
    const operations = (await call<Operation[]>('GET', '/api/v1/operations')).body;
    expect(operations.some(item => item.status === 'conflict')).toBe(true);
  });

  it.each(['toggle', 'restore'] as const)('rechecks revoked standalone MCP permission before applying a %s plan, including after restart', async action => {
    const { instance, binding } = await writableCodex();
    let plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    if (action === 'restore') {
      const operation = (await call<Operation>('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash })).body;
      plan = (await call<ChangePlan>('POST', `/api/v1/operations/${operation.id}/restore-plan`, {})).body;
    }
    const before = await readFile(binding.sourcePath);
    const revoked = await call<AgentInstance>('POST', '/api/v1/instances', { agentId: 'codex', configRoot: instance.configRoot, writable: false });
    expect(revoked.body.writable).toBe(false);
    await app.close();
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, discoveryEnv: {} });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const session = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(session.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(session.body.csrfToken);
    const result = await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(result.status).toBe(403);
    expect(result.body.error).toMatchObject({ code: 'POLICY_LOCKED' });
    expect(await readFile(binding.sourcePath)).toEqual(before);
    expect((await call<Operation[]>('GET', '/api/v1/operations')).body.filter(operation => operation.planId === plan.id)).toEqual([]);
  });

  it('reinitializes demo from actual state instead of resetting the displayed toggle', async () => {
    const first = await call<Catalog>('POST', '/api/v1/demo', {});
    expect(first.status).toBe(200);
    const binding = (first.body as Catalog).bindings.find(item => item.kind === 'mcp' && item.writable)!;
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    expect((await call('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash })).status).toBe(200);
    const second = await call<Catalog>('POST', '/api/v1/demo', {});
    expect(second.status).toBe(200);
    expect((second.body as Catalog).bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
  });

  it('retains registrations and scan results across server restart', async () => {
    const { instance, binding } = await writableCodex();
    await app.close();
    app = createApp({ dataDir: path.join(directory, 'data'), homeDir: home, demoDir: path.join(directory, 'demo') });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.instances.find(item => item.id === instance.id)?.writable).toBe(true);
    expect(catalog.bindings.find(item => item.id === binding.id)?.name).toBe('docs');
  });

  it('recovers a completed native write whose manager database commit was interrupted', async () => {
    const { binding } = await writableCodex();
    const original = await readFile(binding.sourcePath);
    const plan = (await call<ChangePlan>('POST', '/api/v1/plans', { bindingId: binding.id, enabled: false })).body;
    await app.close();
    const dataDir = path.join(directory, 'data');
    const store = createStore(dataDir);
    let operation: Operation;
    try {
      const prepared = store.getPlan(plan.id)!.privateData as PreparedChange;
      // Exercise the engine phase, then omit the manager commit to simulate this crash boundary.
      operation = (await applyPrepared(prepared, { dataDir })).operation;
      expect(store.getOperation(operation.id)).toBeNull();
      expect(store.getPlan(plan.id)?.dto.status).toBe('ready');
    } finally { store.close(); }
    app = createApp({ dataDir, homeDir: home, demoDir: path.join(directory, 'demo'), discoveryEnv: {} });
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await call('POST', '/api/v1/session/bootstrap', { ticket: app.agentdeckAuth.issueBootstrapTicket() }, false);
    cookie = String(response.headers['set-cookie']?.[0]).split(';')[0]!;
    csrf = String(response.body.csrfToken);
    const operations = (await call<Operation[]>('GET', '/api/v1/operations')).body;
    expect(operations.find(item => item.id === operation!.id)?.status).toBe('succeeded');
    const catalog = (await call<Catalog>('GET', '/api/v1/catalog')).body;
    expect(catalog.bindings.find(item => item.id === binding.id)?.enabled).toBe(false);
    const replay = await call<Operation>('POST', `/api/v1/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(operation!.id);
    const restoration = await call<ChangePlan>('POST', `/api/v1/operations/${operation!.id}/restore-plan`, {});
    expect(restoration.status).toBe(201);
    expect((await call('POST', `/api/v1/plans/${restoration.body.id}/apply`, { digest: restoration.body.afterHash })).status).toBe(200);
    expect((await readFile(binding.sourcePath)).equals(original)).toBe(true);
  });

  it('delivers live catalog events over an authenticated SSE connection', async () => {
    let stream: import('node:http').IncomingMessage | undefined;
    let text = '';
    let notify: (() => void) | undefined;
    const connection = await new Promise<import('node:http').ClientRequest>((resolve, reject) => {
      const request = httpRequest(new URL('/api/v1/events', origin), { headers: { Origin: origin, Cookie: cookie } }, response => {
        stream = response;
        expect(response.statusCode).toBe(200);
        response.on('data', chunk => { text += chunk.toString(); notify?.(); });
        resolve(request);
      });
      request.on('error', reject);
      request.end();
    });
    try {
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSE catalog event was not delivered')), 5000);
        notify = () => { if (text.includes('event: catalog.changed')) { clearTimeout(timer); resolve(); } };
        notify();
      });
      expect((await call('POST', '/api/v1/projects', { rootPath: path.join(directory, 'project') })).status).toBe(201);
      await received;
      expect(text).toMatch(/id: \d+/);
      expect(text).not.toContain('AGENTDECK_SECRET_SENTINEL');
    } finally {
      notify = undefined;
      stream?.destroy();
      connection.destroy();
    }
  });
});
