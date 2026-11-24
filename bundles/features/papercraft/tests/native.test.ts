// N1–N2 (phase 3, S57; D4, spec "Native code", T3.11): the process loads
// esbuild, tailwindcss and @tailwindcss/oxide through `context.assets.require`
// (resolved from the bundle directory), never through `import()`. From the
// bundle's own directory an `Export` with no lease compiles on the host; from
// a directory that cannot resolve them it answers `failed` naming esbuild.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BADGE_PATH,
  badgeProject,
  bundleRoot,
  FONT,
  routerWorld,
} from './support/router.js';

void test('N1: without a native option and from the bundle’s directory, an Export with no lease compiles on the host', async (t) => {
  const world = routerWorld({ bundleDir: bundleRoot });
  t.after(() => world.stop());
  world.files = badgeProject(FONT);
  await world.activate();

  const answer = await world.programs().export({ path: BADGE_PATH });

  assert.equal(answer.status.case, 'ready', JSON.stringify(answer));
  if (answer.status.case !== 'ready') return;
  assert.ok(
    answer.status.value.module?.files.some(({ path }) => path === 'index.css'),
  );
});

void test('N2: from a directory outside the repository holding only package.json, the same Export answers failed naming esbuild', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'papercraft-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'papercraft', version: '0.0.1', type: 'module' }),
  );
  const world = routerWorld({ bundleDir: directory });
  t.after(() => world.stop());
  world.files = badgeProject(FONT);
  await world.activate();

  const answer = await world.programs().export({ path: BADGE_PATH });

  assert.equal(answer.status.case, 'failed', JSON.stringify(answer));
  if (answer.status.case !== 'failed') return;
  assert.match(answer.status.value.error, /esbuild/u);
  assert.match(answer.status.value.error, /Cannot find module/u);
});
