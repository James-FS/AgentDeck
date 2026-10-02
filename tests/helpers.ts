import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const fixtureRoot = path.resolve('fixtures/catalog');
const testRoot = path.resolve('work/tests');

export async function createTestDirectory(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  return mkdtemp(path.join(testRoot, `${prefix}-`));
}

export async function removeTestDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const relative = path.relative(testRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a directory outside work/tests');
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function copyCatalogFixture(directory: string): Promise<{ home: string; project: string }> {
  await cp(fixtureRoot, directory, { recursive: true });
  return { home: path.join(directory, 'home'), project: path.join(directory, 'project') };
}

export async function fileTreeDigests(directory: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) {
        digests[path.relative(directory, entryPath)] = createHash('sha256')
          .update(await readFile(entryPath)).digest('hex');
      }
    }
  }
  await visit(directory);
  return digests;
}
