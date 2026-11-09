// The theme preference in `userData/doric/appearance.json` (§4.1, T-4.1.4,
// T-4.1.8): a file that cannot be used reads as `dark`, a choice survives a
// new open, and a write that fails keeps the previous value.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { AppearanceStore } from '../src/platform/appearance-store';
import { desktopPaths } from '../src/platform/paths';

describe('the appearance store', () => {
  let root: string;
  let counter = 0;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'doric-appearance-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A fresh `userData/doric` with a `state.json` the store must not touch. */
  const profile = async () => {
    counter += 1;
    const paths = desktopPaths(join(root, `profile-${counter}`));
    const state = '{ "migrations": [] }\n';

    await mkdir(join(paths.userData, 'doric'), { recursive: true });
    await writeFile(paths.state, state);

    return { paths, state };
  };

  test('keeps the preference in doric/appearance.json under userData', () => {
    assert.equal(
      desktopPaths('/u').appearance,
      join('/u', 'doric', 'appearance.json'),
    );
  });

  test('a missing, corrupt or unknown file reads as dark and leaves state.json untouched', async () => {
    const contents: readonly (string | undefined)[] = [
      undefined,
      '{ not json',
      JSON.stringify({ theme: 'blue' }),
      JSON.stringify({ theme: 'light', extra: true }),
    ];

    for (const content of contents) {
      const { paths, state } = await profile();

      if (content !== undefined) {
        await writeFile(paths.appearance, content);
      }

      const store = await AppearanceStore.open(paths.appearance);

      assert.equal(store.get(), 'dark', String(content));
      assert.equal(await readFile(paths.state, 'utf8'), state);
    }
  });

  test('a saved choice is what a new open reads', async () => {
    const { paths, state } = await profile();
    const store = await AppearanceStore.open(paths.appearance);

    await store.set('light');

    assert.equal(store.get(), 'light');
    assert.equal(
      (await AppearanceStore.open(paths.appearance)).get(),
      'light',
    );
    assert.deepEqual(JSON.parse(await readFile(paths.appearance, 'utf8')), {
      theme: 'light',
    });
    assert.equal(await readFile(paths.state, 'utf8'), state);
  });

  test('a write that fails rejects and keeps the previous value', async () => {
    const { paths } = await profile();
    const store = await AppearanceStore.open(paths.appearance);

    await store.set('light');
    // The file's place is taken by a non-empty directory, so the atomic
    // rename fails even for root, which a read-only directory would not stop.
    await rm(paths.appearance, { force: true });
    await mkdir(join(paths.appearance, 'occupied'), { recursive: true });

    await assert.rejects(store.set('system'));
    assert.equal(store.get(), 'light');
  });
});
