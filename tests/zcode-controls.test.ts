import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../apps/server/src/app';
import { createStore } from '../packages/storage/src/index';
import { editJsonEnabled, prepareToggle, applyPrepared, prepareRestore, recoverIncomplete } from '../packages/change-engine/src/index';
import type { AgentInstance, Catalog, ChangePlan, Operation } from '../packages/contracts/src/index';
import { createTestDirectory, removeTestDirectory, fileTreeDigests } from './helpers';

describe('ZCode boolean-only resource controls', () => {
  let directory: string, home: string, configRoot: string, config: string, origin: string, cookie: string, csrf: string;
  let app: ReturnType<typeof createApp>;
  async function file(p: string, value: string) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, value); }
  const dataDir = () => path.join(directory, 'data');
  async function call<T = Record<string, unknown>>(url: string, body?: unknown, status = 200) {
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url:'/api/v1'+url,
      headers:{ host:new URL(origin).host, origin, cookie, 'x-csrf-token':csrf }, ...(body === undefined ? {} : {payload:body}) });
    expect(response.statusCode, url+' '+response.body).toBe(status);
    expect(response.body).not.toContain('PRIVATE_CONTROL_SENTINEL');
    return response.json<T>();
  }
  async function register(writable = true) {
    const instance = await call<AgentInstance>('/instances',{agentId:'zcode',configRoot,writable},201);
    return {instance,catalog:await call<Catalog>('/scans',{instanceId:instance.id})};
  }
  beforeEach(async () => {
    directory = await createTestDirectory('zcode-toggle 中文'); home = path.join(directory,'home'); configRoot = path.join(home,'.zcode'); config = path.join(configRoot,'cli/config.json');
    await file(path.join(configRoot,'skills/local/SKILL.md'),'fixture');
    await file(path.join(home,'.agents/skills/public/SKILL.md'),'fixture');
    for (const name of ['tools','unconfigured']) {
      const pkg = path.join(configRoot,'cli/plugins/cache/official',name,'1.0.0');
      await file(path.join(pkg,'.zcode-plugin/plugin.json'),JSON.stringify({name,skills:'skills'}));
      await file(path.join(pkg,'skills/child/SKILL.md'),'fixture');
    }
    await file(config,JSON.stringify({models:{token:'PRIVATE_CONTROL_SENTINEL',temperature:0.7},mcp:{servers:{docs:{command:'never-execute',args:['keep'],env:{TOKEN:'PRIVATE_CONTROL_SENTINEL'}}}},plugins:{enabledPlugins:{'tools@official':true}},skills:{[path.join(configRoot,'skills/local/SKILL.md')]:{enable:true,custom:'preserve'}}},null,2));
    app = createApp({dataDir:dataDir(),homeDir:home,userHomeDir:home,discoveryEnv:{},userDiscoveryEnv:{}});
    origin = await app.listen({host:'127.0.0.1',port:0});
    const response = await app.inject({method:'POST',url:'/api/v1/session/bootstrap',headers:{host:new URL(origin).host,origin},payload:{ticket:app.agentdeckAuth.issueBootstrapTicket()}});
    cookie=String(response.headers['set-cookie']).split(';')[0]!; csrf=response.json().csrfToken;
  });
  afterEach(async () => { await app?.close(); await removeTestDirectory(directory); });
  it('defaults discovery and registration to switchable, migrates old automatic indexes without editing config', async () => {
    const original = await readFile(config);
    const catalog = await call<Catalog>('/scans', { discover: true });
    const instance = catalog.instances.find(row => row.agentId === 'zcode')!;
    const skill = catalog.bindings.find(row => row.instanceId === instance.id && row.name === 'local')!;
    expect(instance.discovery).toBe('auto');
    expect(instance.writable).toBe(true); expect(skill.writable).toBe(true);
    const store = createStore(dataDir());
    const legacy = { ...instance, writable: false }; delete legacy.togglePolicy;
    store.putInstance(legacy); store.close();
    const refreshed = await call<Catalog>('/scans', { instanceId: instance.id });
    expect(refreshed.instances.find(row => row.id === instance.id)?.writable).toBe(true);
    const plan = await call<ChangePlan>('/plans', { bindingId: skill.id, enabled: false }, 201);
    expect(await readFile(config)).toEqual(original);
    await call(`/plans/${plan.id}/apply`, { digest: plan.afterHash });
    expect((await call<Catalog>('/catalog')).bindings.find(row => row.id === skill.id)?.enabled).toBe(false);
    const restore = await call<ChangePlan>(`/operations/${(await call<Operation[]>('/operations'))[0]!.id}/restore-plan`, {}, 201);
    await call(`/plans/${restore.id}/apply`, { digest: restore.afterHash });
    expect(await readFile(config)).toEqual(original);
    expect((await call<AgentInstance>('/instances', { agentId: 'zcode', configRoot }, 201)).writable).toBe(true);
    const legacyManual = { ...instance, discovery: 'manual' as const, writable: false }; delete legacyManual.togglePolicy;
    const reopened = createStore(dataDir()); reopened.putInstance(legacyManual); reopened.close();
    expect((await call<Catalog>('/scans', { instanceId: instance.id })).instances.find(row => row.id === instance.id)?.writable).toBe(true);
  });
  it.each(['skill','plugin','mcp'] as const)('changes only the %s flag and restores exact bytes', async kind => {
    const original = await readFile(config);
    const sourceBefore = await fileTreeDigests(home);
    const {instance,catalog} = await register();
    const binding = catalog.bindings.find(b=>b.instanceId===instance.id && b.kind===kind && b.name===({skill:'local',plugin:'tools',mcp:'docs'}[kind]))!;
    expect(binding.writable).toBe(true);
    const plan = await call<ChangePlan>('/plans',{bindingId:binding.id,enabled:false},201);
    expect(await readFile(config)).toEqual(original);
    const operation = await call<Operation>(`/plans/${plan.id}/apply`,{digest:plan.afterHash});
    const changed = JSON.parse(await readFile(config,'utf8')); const expected = JSON.parse(original.toString());
    if(kind==='skill') expected.skills[path.join(configRoot,'skills/local/SKILL.md')].enable=false;
    if(kind==='plugin') expected.plugins.enabledPlugins['tools@official']=false;
    if(kind==='mcp') expected.mcp.servers.docs.enable=false;
    expect(changed).toEqual(expected);
    expect((await call<Catalog>('/catalog')).bindings.find(b=>b.id===binding.id)?.enabled).toBe(false);
    const restored = await call<ChangePlan>(`/operations/${operation.id}/restore-plan`,{},201);
    await call(`/plans/${restored.id}/apply`,{digest:restored.afterHash});
    expect(await readFile(config)).toEqual(original);
    expect(await fileTreeDigests(home)).toEqual(sourceBefore);
  });
  it('disables a public Skill only for ZCode and never edits shared content', async () => {
    const shared=path.join(home,'.agents/skills/public'); const before=await fileTreeDigests(shared);
    const {catalog}=await register(); const binding=catalog.bindings.find(b=>b.name==='public')!;
    const plan=await call<ChangePlan>('/plans',{bindingId:binding.id,enabled:false},201);
    await call(`/plans/${plan.id}/apply`,{digest:plan.afterHash});
    expect((await call<Catalog>('/catalog')).bindings.find(b=>b.id===binding.id)?.enabled).toBe(false);
    expect(await fileTreeDigests(shared)).toEqual(before);
    const next=await call<ChangePlan>('/plans',{bindingId:binding.id,enabled:true},201);
    await call(`/plans/${next.id}/apply`,{digest:next.afterHash});
    expect((await call<Catalog>('/catalog')).bindings.find(b=>b.id===binding.id)?.enabled).toBe(true);
  });
  it('keeps opt-out, project resources and cache-only plugins read-only, and rechecks revoked permission', async () => {
    const {instance,catalog}=await register(false); const skill=catalog.bindings.find(b=>b.name==='local')!;
    expect(skill.toggleTarget).toBeDefined(); expect(skill.writable).toBe(false);
    await call('/plans',{bindingId:skill.id,enabled:false},403);
    await register();
    const rows=(await call<Catalog>('/catalog')).bindings;
    expect(rows.find(b=>b.kind==='plugin'&&b.name==='unconfigured')?.toggleTarget).toBeUndefined();
    const unconfigured=rows.find(b=>b.kind==='plugin'&&b.name==='unconfigured')!;
    await call('/plans',{bindingId:unconfigured.id,enabled:true},403);
    const projectRoot = path.join(directory, 'registered-project');
    await file(path.join(projectRoot, '.zcode/skills/project-only/SKILL.md'), 'fixture');
    const project = await call<{ id: string }>('/projects', { rootPath: projectRoot, name: 'explicit project' }, 201);
    const projectCatalog = await call<Catalog>('/scans', { instanceId: instance.id, projectId: project.id });
    const projectSkill = projectCatalog.bindings.find(b => b.projectId === project.id && b.name === 'project-only')!;
    expect(projectSkill.toggleTarget).toBeUndefined();
    await call('/plans', { bindingId: projectSkill.id, enabled: false }, 403);
    const plan=await call<ChangePlan>('/plans',{bindingId:skill.id,enabled:false},201);
    const store=createStore(dataDir()); store.putInstance({...store.getInstance(instance.id)!,writable:false}); store.close();
    await call(`/plans/${plan.id}/apply`,{digest:plan.afterHash},403);
  });
  it('rejects outside changes and supports restart recovery with JSON targets', async () => {
    const {catalog}=await register(); const binding=catalog.bindings.find(b=>b.kind==='mcp')!;
    const plan=await call<ChangePlan>('/plans',{bindingId:binding.id,enabled:false},201);
    await writeFile(config,(await readFile(config,'utf8')).replace('0.7','0.8'));
    await call(`/plans/${plan.id}/apply`,{digest:plan.afterHash},409);
    const prepared=await prepareToggle({configPath:config,serverName:'docs',enabled:false,target:{kind:'json',path:['mcp','servers','docs','enable'],defaultEnabled:true}});
    const applied=await applyPrepared(prepared,{dataDir:dataDir()});
    expect((await recoverIncomplete({dataDir:dataDir()})).items.some(item=>item.operationId===applied.operation.id&&item.status==='completed')).toBe(true);
    const restore=await prepareRestore({operationId:applied.operation.id,dataDir:dataDir()});
    await applyPrepared(restore,{dataDir:dataDir()});
    expect(JSON.parse(await readFile(config,'utf8')).models.temperature).toBe(0.8);
  });
  it('preserves comments/BOM/CRLF for boolean replacement and refuses duplicate or non-boolean config', () => {
    const original='\uFEFF{\r\n  // retain\r\n  "mcp": {"servers": {"docs": {"enable": true, "token": "preserve"}}}\r\n}\r\n';
    const target={kind:'json' as const,path:['mcp','servers','docs','enable'],defaultEnabled:true};
    expect(editJsonEnabled(original,false,target).text).toBe(original.replace('true','false'));
    expect(()=>editJsonEnabled('{"mcp":{},"mcp":{}}',false,target)).toThrow();
    expect(()=>editJsonEnabled('{"mcp":{"servers":{"docs":{"enable":"false"}}}}',true,target)).toThrow();
    expect(()=>editJsonEnabled('{"mcp":0}',false,target)).toThrow();
  });
});
