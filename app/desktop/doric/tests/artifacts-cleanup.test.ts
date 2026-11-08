// PC22 (papercraft-openui.md D25): stage 4 removes the artifacts bundle, and
// the desktop app stops serving `/artifacts/`. The old cache at
// `userData/artifacts/` is deleted at each start, when it exists; nothing else
// under `userData` is touched, and without it nothing is deleted or written.
//
// Over a real temporary `userData` directory.

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { type DesktopPaths, desktopPaths } from '../src/platform/paths.js';

/** What `src/platform/artifacts-cleanup.ts` exports. */
interface ArtifactsCleanup {
  removeArtifactsCache(paths: Pick<DesktopPaths, 'artifacts'>): Promise<void>;
}

// Loaded by path so the rest of the suite compiles while the module is absent.
const loadCleanup = async (): Promise<ArtifactsCleanup> =>
  (await import(
    join(__dirname, '../src/platform/artifacts-cleanup.js')
  )) as ArtifactsCleanup;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'doric-pc22-'));
  roots.push(root);
  return root;
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Every path under `root`, relative and sorted, with each file's content. */
const listing = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const relative = path.slice(root.length + 1);
      return entry.isFile()
        ? `${relative} = ${await readFile(path, 'utf8')}`
        : `${relative}/`;
    }),
  );
  return lines.sort();
};

/** A `userData` with the other directories the app keeps there. */
const userDataWithSiblings = async (): Promise<string> => {
  const userData = await tempDir();
  await mkdir(join(userData, 'papercraft', 'abc'), { recursive: true });
  await writeFile(join(userData, 'papercraft', 'abc', 'm.js'), 'module');
  await mkdir(join(userData, 'doric'), { recursive: true });
  await writeFile(join(userData, 'doric', 'state.json'), '{}');
  await mkdir(join(userData, 'bundle-cache', 'chat'), { recursive: true });
  await writeFile(join(userData, 'bundle-cache', 'chat', 'x'), 'cached');
  return userData;
};

test('PC22: an existing userData/artifacts/ is deleted, and papercraft/, doric/ and bundle-cache/ stay as they were', async () => {
  const { removeArtifactsCache } = await loadCleanup();
  const userData = await userDataWithSiblings();
  await mkdir(join(userData, 'artifacts', 'a@1'), { recursive: true });
  await writeFile(join(userData, 'artifacts', 'a@1', 'index.js'), 'old');
  const before = (await listing(userData)).filter(
    (line) => !line.startsWith('artifacts'),
  );

  await removeArtifactsCache(desktopPaths(userData));

  assert.equal(await exists(join(userData, 'artifacts')), false);
  assert.deepEqual(await listing(userData), before);
});

test('PC22: without userData/artifacts/ nothing is deleted or written, and it does not throw', async () => {
  const { removeArtifactsCache } = await loadCleanup();
  const userData = await userDataWithSiblings();
  const before = await listing(userData);

  await removeArtifactsCache(desktopPaths(userData));

  assert.deepEqual(await listing(userData), before);
});

test('PC22: an artifacts symlink is removed without following it', async () => {
  const { removeArtifactsCache } = await loadCleanup();
  const userData = await userDataWithSiblings();
  const elsewhere = await tempDir();
  await writeFile(join(elsewhere, 'keep.txt'), 'kept');
  await symlink(elsewhere, join(userData, 'artifacts'), 'dir');

  await removeArtifactsCache(desktopPaths(userData));

  assert.equal(await exists(join(userData, 'artifacts')), false);
  assert.deepEqual(await listing(elsewhere), ['keep.txt = kept']);
});
