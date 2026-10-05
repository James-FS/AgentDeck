import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mcpServiceEvidence } from '../packages/adapters/src/mcp-service';
import { codexAdapter, claudeCodeAdapter, zcodeAdapter, deepSeekHarnessAdapter } from '../packages/adapters/src/index';
import { resourceRows } from '../apps/web/src/resource-tree';
import { createTestDirectory, removeTestDirectory, fileTreeDigests } from './helpers';
import type { AgentInstance } from '../packages/contracts/src/index';

describe('scanner MCP service provenance', () => {
  it('shares literal real entry identity, keeps argument/env differences opaque and never executes scripts', async () => {
    const directory = await createTestDirectory('mcp-evidence');
    try {
      const entry = path.join(directory, 'server.mjs'); await writeFile(entry, 'throw new Error("must never execute")');
      const config = { command: 'node', args: [entry], env: { TOKEN: 'PRIVATE_MCP_SECRET', PROJECT: 'one' } };
      const first = await mcpServiceEvidence(config, 'one.json');
      const same = await mcpServiceEvidence({ env: { PROJECT: 'one', TOKEN: 'PRIVATE_MCP_SECRET' }, args: [entry], enabled: false, command: 'node' }, 'two.toml');
      const changed = await mcpServiceEvidence({ ...config, env: { TOKEN: 'OTHER_SECRET' }, args: [entry, '--other'] }, 'three.json');
      expect(first?.kind).toBe('local-entry'); expect(first?.identity).toBe(same?.identity); expect(first?.identity).toBe(changed?.identity);
      expect(first?.configurationIdentity).toBe(same?.configurationIdentity); expect(first?.configurationIdentity).not.toBe(changed?.configurationIdentity);
      expect(JSON.stringify([first, same, changed])).not.toContain('PRIVATE_MCP_SECRET');
      expect(JSON.stringify(changed)).not.toContain('OTHER_SECRET');
      for (const raw of [ {command:'npx',args:['package']}, {command:'node',args:['relative.mjs']}, {command:'node',args:['${ROOT}/server.mjs']},
        {command:'node',args:[path.join(directory,'missing.mjs')]}, {command:'node',args:['-e','process.exit()']}, {command:'python',args:['-m','server']} ]) {
        expect(await mcpServiceEvidence(raw, 'config')).toBeUndefined();
      }
    } finally { await removeTestDirectory(directory); }
  });
  it('compares full HTTP endpoints privately, preserves path/query distinction and never makes requests', async () => {
    const first = await mcpServiceEvidence({ url:'https://user:PRIVATE_URL_PASSWORD@example.invalid/mcp?token=PRIVATE_QUERY', headers:{Authorization:'PRIVATE_HEADER'} }, 'config');
    const same = await mcpServiceEvidence({ url:'https://user:PRIVATE_URL_PASSWORD@example.invalid/mcp?token=PRIVATE_QUERY', headers:{Authorization:'different'} }, 'other');
    const different = await mcpServiceEvidence({ url:'https://user:PRIVATE_URL_PASSWORD@example.invalid/other?token=PRIVATE_QUERY' }, 'config');
    expect(first?.identity).toBe(same?.identity); expect(first?.configurationIdentity).not.toBe(same?.configurationIdentity);
    expect(first?.identity).not.toBe(different?.identity);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|Authorization|user:|token=/);
    expect(await mcpServiceEvidence({ url:'${SERVER_URL}' }, 'config')).toBeUndefined();
  });
  it('does not mistake absolute launcher executables for MCP services', async () => {
    const directory = await createTestDirectory('mcp-launchers');
    try {
      for (const name of ['uvx', 'uv', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'pip', 'pipx',
        'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'docker']) {
        const launcher = path.join(directory, `${name}.exe`);
        await writeFile(launcher, 'must never execute');
        for (const packageName of ['unrelated-mcp', 'another-mcp']) {
          expect(await mcpServiceEvidence({command:launcher,args:[packageName]}, 'config')).toBeUndefined();
        }
      }
      const entry = path.join(directory, 'mcp-for-blender.exe');
      await writeFile(entry, 'must never execute');
      expect((await mcpServiceEvidence({command:entry,args:[]}, 'config'))?.kind).toBe('local-entry');
    } finally { await removeTestDirectory(directory); }
  });
  it('folds verified installed Blender and its uvx compatibility name, retaining versions and bindings', async () => {
    const directory = await createTestDirectory('blender-alias');
    async function file(p: string, value: string) { await mkdir(path.dirname(p), {recursive:true}); await writeFile(p,value); }
    try {
      const entry = path.join(directory, 'venv/Scripts/mcp-for-blender.exe');
      const metadata = path.join(directory, 'venv/Lib/site-packages/mcp_for_blender-2.0.4.dist-info/METADATA');
      await file(entry,'must never execute');
      await file(metadata,'Name: mcp-for-blender\nVersion: 2.0.4\nProject-URL: Homepage, https://github.com/ahujasid/blender-mcp\n');
      await file(path.join(path.dirname(metadata),'entry_points.txt'),'[console_scripts]\nmcp-for-blender = blender_mcp.server:main\n');
      const projectRoot = path.join(directory,'project'), zcodeRoot = path.join(directory,'zcode');
      await file(path.join(projectRoot,'.codex/config.toml'),`[mcp_servers.blender]\ncommand = ${JSON.stringify(entry)}\nargs = []\n`);
      await file(path.join(zcodeRoot,'cli/config.json'),JSON.stringify({mcp:{servers:{blender:{command:'uvx',args:['blender-mcp'],enable:false}}}}));
      const before = await fileTreeDigests(directory);
      const instance = (agentId: string, configRoot: string): AgentInstance => ({id:agentId,agentId,name:agentId,configRoot,executable:null,version:null,discovery:'manual',writable:true,checkedAt:null,diagnostics:[]});
      const codex = (await codexAdapter.scan({instance:instance('codex',path.join(directory,'codex')),project:{id:'project',rootPath:projectRoot,name:'fixture'}})).bindings.find(b=>b.kind==='mcp' && b.name==='blender')!;
      const zcode = (await zcodeAdapter.scan({instance:instance('zcode',zcodeRoot)})).bindings.find(b=>b.kind==='mcp' && b.name==='blender')!;
      expect(codex.mcpService?.identity).toBe(zcode.mcpService?.identity);
      expect(codex.mcpService?.packageVersion).toBe('2.0.4'); expect(zcode.mcpService?.packageVersion).toBeNull();
      expect(codex.projectId).toBe('project'); expect(zcode.projectId).toBeNull(); expect(zcode.enabled).toBe(false);
      expect(resourceRows([codex,zcode],()=>true,new Set(),'mcp')[0]?.mcpGroup?.members).toHaveLength(2);
      expect(await fileTreeDigests(directory)).toEqual(before);
      for (const config of [{command:'uvx',args:['blender-mcp==1.9.4']}, {command:'uvx',args:['--from','private-package','blender-mcp']},
        {command:'uvx',args:['blender-mcp'],env:{UV_INDEX_URL:'https://private.invalid'}}]) expect(await mcpServiceEvidence(config,'config')).toBeUndefined();
      await file(metadata,'Name: mcp-for-blender\nVersion: 2.0.4\nProject-URL: Homepage, https://github.com/unrelated/project\n');
      expect((await mcpServiceEvidence({command:entry,args:[]},'config'))?.kind).toBe('local-entry');
    } finally { await removeTestDirectory(directory); }
  });
  it('four adapters attach evidence without changing classification, credentials, config or bindings', async () => {
    const directory = await createTestDirectory('mcp-multi-agent');
    const home = path.join(directory, 'home'), projectRoot = path.join(directory, 'project');
    async function file(p: string, text: string) { await mkdir(path.dirname(p), {recursive:true}); await writeFile(p,text); }
    try {
      const entry = path.join(directory, 'services/codely-unity/server.mjs'); await file(entry,'never execute');
      const config = {command:'node',args:[entry],env:{TOKEN:'PRIVATE_MCP_SECRET'}};
      await file(path.join(projectRoot,'.codex/config.toml'),`[mcp_servers.codely-unity]\ncommand = "node"\nargs = [${JSON.stringify(entry)}]\n`);
      await file(path.join(projectRoot,'.mcp.json'), JSON.stringify({mcpServers:{'codely-unity':config}}));
      await file(path.join(projectRoot,'.zcode/cli/config.json'), JSON.stringify({mcp:{servers:{'codely-unity':config}}}));
      await file(path.join(projectRoot,'.dsh/profiles/main/cordis.patch.yml'),`- id: test\n  name: "@deepseek-ai/dsh-mcp-client"\n  disabled: false\n  config:\n    serverName: codely-unity\n    command: node\n    args: [${JSON.stringify(entry)}]\n`);
      const before = await fileTreeDigests(directory);
      const bindings = [];
      for (const adapter of [codexAdapter, claudeCodeAdapter, zcodeAdapter, deepSeekHarnessAdapter]) {
        const instance: AgentInstance = {id:adapter.id,agentId:adapter.id,name:adapter.name,configRoot:path.join(home,adapter.id),
          executable:null,version:null,discovery:'manual',writable:true,checkedAt:null,diagnostics:[]};
        const scanned = await adapter.scan({instance,project:{id:'project',rootPath:projectRoot,name:'explicit'}});
        const binding = scanned.bindings.find(b=>b.kind==='mcp' && b.name==='codely-unity')!;
        expect(binding,adapter.id).toBeDefined();
        expect(binding.mcpService?.kind).toBe('local-entry'); expect(binding.projectId).toBe('project');
        expect(binding.classification?.scope).toBe('project'); expect(binding.classification?.agentId).toBe(adapter.id);
        bindings.push(binding);
      }
      expect(new Set(bindings.map(b=>b.id)).size).toBe(4); expect(new Set(bindings.map(b=>b.mcpService?.identity)).size).toBe(1);
      const rows = resourceRows(bindings,()=>true,new Set(),'mcp');
      expect(rows).toHaveLength(1); expect(rows[0]?.mcpGroup?.members).toHaveLength(3); // DSH component retains its parent relationship.
      expect(JSON.stringify(bindings)).not.toContain('PRIVATE_MCP_SECRET'); expect(await fileTreeDigests(directory)).toEqual(before);
    } finally { await removeTestDirectory(directory); }
  });
});
