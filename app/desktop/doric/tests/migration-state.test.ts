// The desktop state's migration record: a bounded set of markers that are
// done. Existing profiles keep their `selectionOrigin` marker as it is stored.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DesktopState } from '../src/platform/state';

describe('desktop state migration markers', () => {
  let root: string;
  let counter = 0;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'doric-state-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const open = async (migrations: unknown) => {
    counter += 1;
    const path = join(root, `state-${counter}.json`);

    await writeFile(path, JSON.stringify({ migrations }));

    return (await DesktopState.open(path)).data.migrations;
  };

  test('a profile written before this change still reads its selectionOrigin marker', async () => {
    assert.deepEqual(await open({ selectionOrigin: true }), {
      selectionOrigin: true,
    });
  });

  test('any well-formed marker name is kept as it is stored', async () => {
    assert.deepEqual(await open({ exampleMigration: true, 'a.b-c_d': true }), {
      exampleMigration: true,
      'a.b-c_d': true,
    });
  });

  test('a marker must be a true flag with a bounded name', async () => {
    assert.deepEqual(await open({ exampleMigration: false }), {});
    assert.deepEqual(await open({ '1marker': true }), {});
    assert.deepEqual(await open({ ['a'.repeat(65)]: true }), {});
  });

  test('a state with more than 32 markers is refused', async () => {
    const full = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`marker${index}`, true]),
    );

    assert.equal(Object.keys(await open(full)).length, 32);
    assert.deepEqual(await open({ ...full, extra: true }), {});
  });
});
