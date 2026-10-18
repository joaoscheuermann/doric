// The host's composition overrides (HR-6): the file the splash recovery
// actions persist, how a catalog read applies it, and the kernel's
// `doric.catalog/v1.disable` / `resetComposition`.

import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DoricCatalogV1 } from '../src/contracts/index.js';
import {
  applyCompositionOverrides,
  clearCompositionOverrides,
  compositionOverridesPath,
  readCompositionOverrides,
  writeCompositionOverrides,
} from '../src/index.js';
import { withRoot } from './support/fixtures.js';
import { bootKernel, writeProbe } from './support/generation-fixtures.js';

const composition = {
  core: 'core',
  enabled: ['core', 'files', 'git'],
  providers: { 'storage.backend/v1': 'postgres' },
};

void test('the overrides file lives beside the composition', () => {
  assert.equal(
    compositionOverridesPath('/srv/doric/composition.json'),
    '/srv/doric/composition.overrides.json',
  );
});

void test('overrides round-trip through the file, leave no temporary file, and clear to none', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    assert.equal(await readCompositionOverrides(path), undefined);

    await writeCompositionOverrides(path, { disabled: ['git'] });
    await writeCompositionOverrides(path, { disabled: ['git', 'files'] });

    assert.deepEqual(await readCompositionOverrides(path), {
      disabled: ['git', 'files'],
    });
    assert.deepEqual(await readdir(root), ['composition.overrides.json']);

    await clearCompositionOverrides(path);
    await clearCompositionOverrides(path);

    assert.equal(await readCompositionOverrides(path), undefined);
  });
});

void test('a malformed overrides file is refused on read', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    for (const content of ['{', '{"disabled":"git"}', '{"enabled":[]}']) {
      await writeFile(path, content);
      await assert.rejects(readCompositionOverrides(path));
    }
  });
});

void test('disabled bundles leave enabled; the core and providers stay', () => {
  assert.deepEqual(
    applyCompositionOverrides(composition, { disabled: ['git', 'absent'] }),
    { ...composition, enabled: ['core', 'files'] },
  );
  assert.deepEqual(
    applyCompositionOverrides(composition, undefined),
    composition,
  );
});

const stateOf = (kernel: Awaited<ReturnType<typeof bootKernel>>, id: string) =>
  kernel.platform.catalog().bundles.find((bundle) => bundle.id === id)?.state;

void test('a host boot applies the overrides, and ignores a malformed file', async () => {
  for (const [content, expected] of [
    ['{"disabled":["probe"]}', 'disabled'],
    ['not json', 'active'],
  ] as const) {
    await withRoot(async (root) => {
      const path = join(root, 'composition.overrides.json');

      await writeProbe(root);
      await writeFile(path, content);

      const kernel = await bootKernel(root, ['probe'], {
        compositionOverrides: path,
      });

      try {
        assert.equal(stateOf(kernel, 'probe'), expected);
      } finally {
        await kernel.platform.stop();
      }
    });
  }
});

void test('disable publishes a generation without the bundle, and resetComposition one with it again', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    await writeProbe(root);

    const kernel = await bootKernel(root, ['probe'], {
      compositionOverrides: path,
    });
    const catalog = kernel.platform.services.use(DoricCatalogV1);

    try {
      await catalog.disable({ bundleId: 'probe' });

      assert.equal(kernel.platform.generation, 2);
      assert.equal(stateOf(kernel, 'probe'), 'disabled');
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
        disabled: ['probe'],
      });

      // The composition file itself is not rewritten.
      assert.deepEqual(
        JSON.parse(await readFile(kernel.compositionPath, 'utf8')).enabled,
        ['mincore', 'probe'],
      );

      await catalog.resetComposition();

      assert.equal(kernel.platform.generation, 3);
      assert.equal(stateOf(kernel, 'probe'), 'active');
      assert.equal(await readCompositionOverrides(path), undefined);
    } finally {
      await kernel.platform.stop();
    }
  });
});

void test('disable refuses the core and a bundle outside the composition without publishing', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    await writeProbe(root);

    const kernel = await bootKernel(root, ['probe'], {
      compositionOverrides: path,
    });
    const catalog = kernel.platform.services.use(DoricCatalogV1);

    try {
      await assert.rejects(catalog.disable({ bundleId: 'mincore' }), {
        code: 'invalid_input',
      });
      await assert.rejects(catalog.disable({ bundleId: 'nowhere' }), {
        code: 'not_found',
      });
      assert.equal(kernel.platform.generation, 1);
      assert.equal(await readCompositionOverrides(path), undefined);
    } finally {
      await kernel.platform.stop();
    }
  });
});
