// P4 (phase 3, S57; D14): `papercraft.programs/v1.Read` streams the files of
// a module the host memo holds, as `doric.cache/v1`'s `EnsureRequest` takes
// them: each file in path order, cut in chunks of at most 1 MiB with
// increasing offsets, each item carrying the file's `<dir>/<file>` path and
// the SHA-256 of the whole file. A `dir` the memo does not hold fails
// `not_found` before the first item.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadResponse } from '../src/contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import {
  BADGE_PATH,
  badgeProject,
  failureOf,
  MIB,
  type RouterWorld,
  routerWorld,
  sha256,
} from './support/router.js';

const activated = async (t: test.TestContext): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.activate();
  return world;
};

const itemsOf = async (
  world: RouterWorld,
  dir: string,
): Promise<ReadResponse[]> => {
  const items: ReadResponse[] = [];
  for await (const item of world.programs().read({ dir })) items.push(item);
  return items;
};

/** A font of 2.5 MiB whose bytes differ along it. */
const bigFont = (): Uint8Array =>
  Uint8Array.from({ length: Math.floor(2.5 * MIB) }, (_, index) => index % 251);

void test('P4: Read of a dir the memo does not hold fails not_found', async (t) => {
  const world = await activated(t);

  const failure = await failureOf(() => itemsOf(world, 'f'.repeat(64)));

  assert.equal(failure.code, 'not_found');
});

void test('P4: after an Export, Read streams each module file in path order, in chunks of at most 1 MiB whose concatenation is the file', async (t) => {
  const world = await activated(t);
  const font = bigFont();
  world.files = badgeProject(font);
  const answer = await world.programs().export({ path: BADGE_PATH });
  assert.equal(answer.status.case, 'ready', JSON.stringify(answer));
  if (answer.status.case !== 'ready') return;
  const built = answer.status.value.module;
  assert.ok(built !== undefined);
  const { dir, files } = built;

  const items = await itemsOf(world, dir);

  const paths = [...new Set(items.map(({ path }) => path))];
  assert.deepEqual(paths, files.map(({ path }) => `${dir}/${path}`).sort());
  for (const file of files) {
    const own: ReadResponse[] = items.filter(
      ({ path }) => path === `${dir}/${file.path}`,
    );
    const bytes = Buffer.concat(own.map((item) => item.bytes));
    assert.deepEqual(
      own.map(({ offset }) => offset),
      own.map((_, index) => index * MIB),
      file.path,
    );
    assert.ok(
      own.every((item) => item.bytes.length <= MIB),
      file.path,
    );
    assert.ok(
      own.every((item) => item.sha256 === file.sha256),
      file.path,
    );
    assert.equal(sha256(bytes), file.sha256, file.path);
  }
  const asset = items.filter(({ path }) =>
    path.endsWith(`assets/${sha256(font)}.woff2`),
  );
  assert.equal(asset.length, 3);
  assert.deepEqual(
    Buffer.concat(asset.map((item) => item.bytes)),
    Buffer.from(font),
  );
});
