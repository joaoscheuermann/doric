// The host's composition overrides (HR-6): the file the splash recovery
// actions persist, how a catalog read applies it, and the platform's
// `doric.catalog/v1.disable` / `resetComposition`.

import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyCompositionOverrides,
  buildCatalog,
  clearCompositionOverrides,
  compositionOverridesPath,
  discoverBundles,
  readCompositionOverrides,
  writeCompositionOverrides,
} from '../src/index.js';
import { createPlatformCompositionActions } from '../src/platform/composition-actions.js';
import {
  createHopCall,
  PLATFORM_VERSION,
  type ResolvedEnvironment,
} from '../src/runtime/index.js';
import {
  captureLog,
  descriptorFor,
  manifest,
  withRoot,
  writeBundle,
} from './support/fixtures.js';

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

/** The composition as written: a core and one probe bundle, both installed. */
const written = {
  core: 'mincore',
  enabled: ['mincore', 'probe'],
  providers: {},
};

/** Installs the two bundles of `written` under `<root>/bundles`. */
const install = async (root: string) => {
  for (const id of written.enabled) {
    const source = manifest(id);

    await writeBundle(join(root, 'bundles'), id, {
      manifest: source,
      descriptor: descriptorFor(source),
    });
  }
};

/**
 * The host's catalog read of generation `generation`, as the host makes it:
 * the installed bundles with `written` and its overrides applied; an
 * overrides file that cannot be read becomes an issue.
 */
const readCatalog = async (
  root: string,
  generation: number,
): Promise<ResolvedEnvironment> => {
  const issues: string[] = [];
  let composition = written;

  try {
    composition = applyCompositionOverrides(
      written,
      await readCompositionOverrides(join(root, 'composition.overrides.json')),
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  return buildCatalog({
    installed: await discoverBundles(join(root, 'bundles')),
    embedded: [],
    composition,
    platformVersion: PLATFORM_VERSION,
    generation,
    issues,
  });
};

const stateOf = (resolved: ResolvedEnvironment, id: string) =>
  resolved.entries.find((entry) => entry.id === id)?.state;

/** The platform's recovery actions over `readCatalog`, with a recording publish. */
const actionsOver = async (root: string) => {
  let current = await readCatalog(root, 1);
  const published: ResolvedEnvironment[] = [];
  const actions = createPlatformCompositionActions(
    {
      overridesPath: join(root, 'composition.overrides.json'),
      read: async () => written,
      resolve: (generation) => readCatalog(root, generation),
    },
    {
      current: () => current,
      publish: async (next) => {
        published.push(next);
        current = next;

        return { status: 'published', bundles: [] };
      },
      log: captureLog(),
    },
  );
  const call = createHopCall({
    caller: { bundleId: 'doric', version: PLATFORM_VERSION, generation: 1 },
    generationSignal: new AbortController().signal,
  });

  return { actions, published, call };
};

void test('a catalog read over the overrides lists the bundle disabled; a malformed file is refused on read and the read records it as an issue', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    await install(root);
    await writeFile(path, '{"disabled":["probe"]}');

    const disabled = await readCatalog(root, 1);

    assert.equal(stateOf(disabled, 'probe'), 'disabled');
    assert.equal(stateOf(disabled, 'mincore'), 'scheduled');
    assert.deepEqual(disabled.issues, []);

    await writeFile(path, 'not json');
    await assert.rejects(readCompositionOverrides(path));

    const malformed = await readCatalog(root, 1);

    assert.equal(stateOf(malformed, 'probe'), 'scheduled');
    assert.equal(malformed.issues.length, 1);
  });
});

void test('disable writes the overrides and publishes a resolution without the bundle; reset clears them', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    await install(root);

    const { actions, published, call } = await actionsOver(root);

    await actions.disable({ bundleId: 'probe' }, call);

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      disabled: ['probe'],
    });
    assert.equal(published.length, 1);
    assert.equal(published[0]?.generation, 2);
    assert.equal(
      stateOf(published[0] as ResolvedEnvironment, 'probe'),
      'disabled',
    );

    await actions.resetComposition(call);

    assert.equal(await readCompositionOverrides(path), undefined);
    assert.equal(published.length, 2);
    assert.equal(published[1]?.generation, 3);
    assert.equal(
      stateOf(published[1] as ResolvedEnvironment, 'probe'),
      'scheduled',
    );
  });
});

void test('disable refuses the core (invalid_input) and an unknown bundle (not_found) without publishing', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.overrides.json');

    await install(root);

    const { actions, published, call } = await actionsOver(root);

    await assert.rejects(actions.disable({ bundleId: 'mincore' }, call), {
      code: 'invalid_input',
    });
    await assert.rejects(actions.disable({ bundleId: 'nowhere' }, call), {
      code: 'not_found',
    });
    assert.deepEqual(published, []);
    assert.equal(await readCompositionOverrides(path), undefined);
  });
});
