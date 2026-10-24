import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ignored = new Set(['node_modules', 'dist', 'dist-types', '.git', 'work', 'coverage']);
function files(root, directory = '') {
  const target = path.join(root, directory);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Cannot fingerprint linked source: ${name}`);
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : files(root, name);
    return entry.name.endsWith('.tsbuildinfo') ? [] : [name];
  });
}
function digest(root, names, salt = '') {
  const hash = createHash('sha256').update(salt);
  for (const name of [...names].sort()) {
    hash.update(name.replaceAll('\\', '/')); hash.update('\0'); hash.update(readFileSync(path.join(root, name))); hash.update('\0');
  }
  return hash.digest('hex');
}
function workspaceManifests(root) {
  return ['package.json', ...['apps','packages'].flatMap(base => existsSync(path.join(root,base)) ? readdirSync(path.join(root,base)).map(name=>path.join(base,name,'package.json')).filter(name=>existsSync(path.join(root,name))) : [])];
}
function installation(root, manifests) {
  const result = ['node_modules/.modules.yaml'];
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(path.join(root, manifest), 'utf8'));
    for (const [dependency, specification] of Object.entries({...pkg.dependencies,...pkg.devDependencies})) {
      const name = path.join(path.dirname(manifest),'node_modules',dependency,'package.json');
      // Validate pnpm links and targets, not just node_modules directory existence.
      realpathSync(path.join(root,name)); result.push(name);
      if (!String(specification).startsWith('workspace:')) {
        const installedPackage = JSON.parse(readFileSync(path.join(root,name),'utf8'));
        const entries = [
          ...[installedPackage.main, installedPackage.module]
            .filter(entry => typeof entry === 'string' && entry.length > 0)
            .map(entry => ({entry})),
          ...[installedPackage.types, installedPackage.typings]
            .filter(entry => typeof entry === 'string' && entry.length > 0)
            .map(entry => ({entry, declaration: true})),
          ...(typeof installedPackage.bin === 'string' ? [installedPackage.bin] : Object.values(installedPackage.bin ?? {}))
            .filter(entry => typeof entry === 'string' && entry.length > 0)
            .map(entry => ({entry})),
        ];
        for (const {entry, declaration} of entries) {
          const entryPath = path.join(path.dirname(name),entry);
          let resolvedEntryPath = entryPath;
          try {
            realpathSync(path.join(root,resolvedEntryPath));
          } catch (error) {
            // Some ESM packages publish .d.mts declarations while their legacy
            // `types` field still points at the equivalent .d.ts filename.
            // Accept the module declaration when it is present, and fingerprint
            // that actual file so later changes still invalidate the install.
            const moduleDeclaration = declaration && entry.endsWith('.d.ts')
              ? entry.slice(0,-'.d.ts'.length) + '.d.mts'
              : null;
            if (!moduleDeclaration || error?.code !== 'ENOENT') throw error;
            resolvedEntryPath = path.join(path.dirname(name),moduleDeclaration);
            realpathSync(path.join(root,resolvedEntryPath));
          }
          result.push(resolvedEntryPath);
        }
      }
    }
  }
  return digest(root,result);
}
const expected = ['apps/server/dist/index.js','apps/cli/dist/index.js','apps/web/dist/index.html',
  ...['adapters','change-engine','contracts','core','storage'].map(name=>`packages/${name}/dist/index.js`)];
function outputs(root) {
  if (expected.some(name=>!existsSync(path.join(root,name)))) return null;
  const names = [...['apps','packages'].flatMap(base => readdirSync(path.join(root,base)).flatMap(name => {
    const directory = path.join(base,name,'dist');
    // Walk dist separately because the source walker excludes it.
    return files(path.join(root,directory)).map(file=>path.join(directory,file));
  }))];
  return digest(root,names);
}
/** Injection is for isolated branch tests; production always uses the repository root. */
export function prepareStartup(root, run, force = false) {
  const statePath = path.join(root,'work','startup-state.json');
  let state = {};
  try {
    const saved = JSON.parse(readFileSync(statePath,'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)
      && ['dependencies','installed','source','outputs'].every(key => saved[key] === undefined || typeof saved[key] === 'string')) state = saved;
  } catch { /* unverifiable => rebuild */ }
  const manifests = workspaceManifests(root);
  const dependencyInputs = [...manifests,'pnpm-lock.yaml','pnpm-workspace.yaml',...['.npmrc','.pnpmfile.cjs'].filter(name=>existsSync(path.join(root,name)))];
  const dependencies = digest(root,dependencyInputs,`${process.version}/${process.platform}/${process.arch}/v1`);
  let installed;
  try { installed = installation(root,manifests); } catch { installed = null; }
  const save = () => { mkdirSync(path.dirname(statePath),{recursive:true}); writeFileSync(statePath,JSON.stringify(state)); };
  const actions = [];
  if (force || dependencies !== state.dependencies || !installed || installed !== state.installed) {
    state = {}; save();
    run('install'); actions.push('install');
    installed = installation(root,manifests);
    state.dependencies = dependencies; state.installed = installed; save();
  }
  const sourceNames = [...files(path.join(root,'apps')).map(name=>path.join('apps',name)),
    ...files(path.join(root,'packages')).map(name=>path.join('packages',name)),
    ...files(path.join(root,'scripts')).map(name=>path.join('scripts',name)),
    ...readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isFile() && (/\.(json|yaml|yml|ts|js|mjs|cjs|cmd|ps1)$/.test(entry.name) || entry.name === '.nvmrc' || entry.name.startsWith('.env'))).map(entry=>entry.name)];
  const source = digest(root,sourceNames,dependencies);
  if (force || source !== state.source || !state.outputs || outputs(root) !== state.outputs) {
    delete state.source; delete state.outputs; save();
    run('build'); actions.push('build');
    const built = outputs(root);
    if (!built) throw new Error('Build completed without required outputs');
    state.source = source; state.outputs = built; save();
  }
  return actions;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  try {
    const actions = prepareStartup(root, step => {
      const command = step === 'install' ? 'pnpm install --frozen-lockfile --prefer-offline' : 'pnpm build';
      console.log(`[AgentDeck] ${command}`);
      const result = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d','/s','/c',command], {cwd:root,stdio:'inherit',windowsHide:true})
        : spawnSync('pnpm', step === 'install' ? ['install','--frozen-lockfile','--prefer-offline'] : ['build'], {cwd:root,stdio:'inherit'});
      if (result.error || result.status !== 0) throw result.error ?? new Error(`${step} failed (${result.status})`);
    }, process.argv.includes('--rebuild'));
    console.log(actions.length ? '[AgentDeck] Ready.' : '[AgentDeck] Dependencies and build verified; starting immediately.');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
