// The host's view of the staged bundles (spec `docs/designs/grpc-processes.md`,
// section 7 "Spawn", section 8 "Descriptors", section 14 "Staging"):
// `stagedCommandOf` (A64) and `readStagedCatalogIndex`, read from
// `<bundles dir>/<id>/`, and their export as `bundle/platform`.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import test, { describe } from 'node:test';

import * as platform from 'bundle/platform';

import { buildBundle, stageBundles } from '../../src/index.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  readStagedCatalogIndex,
  stagedCommandOf,
} from '../../src/platform/staged.js';
import {
  importDemoFile,
  summarize,
  writeContractBundle,
} from '../support/descriptor-sets.js';
import { withRoot } from '../support/fixtures.js';

const writeCommand = async (
  bundlesDir: string,
  id: string,
  content: string,
) => {
  await mkdir(join(bundlesDir, id, 'host'), { recursive: true });
  await writeFile(join(bundlesDir, id, 'host', 'command.json'), content);
};

const emptySummary = { files: [], services: [], desktop: [] };

describe('stagedCommandOf', () => {
  test('a staged command.json answers its first element as the command and the rest as args', async () => {
    await withRoot(async (root) => {
      await writeCommand(
        root,
        'demo',
        JSON.stringify(['node', '/x/main.mjs', '--flag']),
      );

      assert.deepEqual(stagedCommandOf(root)('demo'), {
        command: 'node',
        args: ['/x/main.mjs', '--flag'],
      });
    });
  });

  test('without command.json it answers host/doric-<id> with no arguments, whether or not it exists', async () => {
    await withRoot(async (root) => {
      assert.deepEqual(stagedCommandOf(root)('demo'), {
        command: join(root, 'demo', 'host', 'doric-demo'),
        args: [],
      });
    });
  });

  test('a relative bundles directory answers an absolute command', async () => {
    await withRoot(async (root) => {
      const answered = stagedCommandOf(relative(process.cwd(), root))('demo');

      assert.ok(isAbsolute(answered.command), answered.command);
      assert.deepEqual(answered, {
        command: join(root, 'demo', 'host', 'doric-demo'),
        args: [],
      });
    });
  });

  for (const [name, content] of [
    ['not JSON', 'node main.mjs'],
    ['an empty array', '[]'],
    ['an array of a number', '[1]'],
    ['an object', '{"command":"node"}'],
  ] as const) {
    test(`a command.json that is ${name} throws an Error naming its path`, async () => {
      await withRoot(async (root) => {
        await writeCommand(root, 'demo', content);

        const commandOf = stagedCommandOf(root);

        assert.throws(
          () => commandOf('demo'),
          (error: unknown) => {
            assert.ok(error instanceof Error, String(error));
            assert.ok(
              error.message.includes(
                join(root, 'demo', 'host', 'command.json'),
              ),
              error.message,
            );

            return true;
          },
        );
      });
    });
  }

  test('the staged files are read again on each call', async () => {
    await withRoot(async (root) => {
      const commandOf = stagedCommandOf(root);

      assert.deepEqual(commandOf('demo').args, []);

      await writeCommand(root, 'demo', JSON.stringify(['node', '/a.mjs']));
      assert.deepEqual(commandOf('demo'), {
        command: 'node',
        args: ['/a.mjs'],
      });

      await writeCommand(
        root,
        'demo',
        JSON.stringify(['deno', 'run', '/b.ts']),
      );
      assert.deepEqual(commandOf('demo'), {
        command: 'deno',
        args: ['run', '/b.ts'],
      });
    });
  });
});

describe('readStagedCatalogIndex', () => {
  test('the index of a staged bundle answers what its generated files answer', async () => {
    await withRoot(async (root) => {
      const dir = await writeContractBundle(root);
      const staged = join(root, 'staged');

      await buildBundle(dir);
      await stageBundles(staged, [dir]);

      const index = await readStagedCatalogIndex(staged, ['demo']);

      assert.deepEqual(
        summarize(index),
        summarize(createCatalogIndex([await importDemoFile(dir)])),
      );
      assert.equal(index.contract('demo.api/v1')?.cardinality, 'one');
    });
  });

  test('a repeated id counts once', async () => {
    await withRoot(async (root) => {
      const dir = await writeContractBundle(root);
      const staged = join(root, 'staged');

      await buildBundle(dir);
      await stageBundles(staged, [dir]);

      assert.deepEqual(
        summarize(await readStagedCatalogIndex(staged, ['demo', 'demo'])),
        summarize(await readStagedCatalogIndex(staged, ['demo'])),
      );
    });
  });

  test('no ids answer an empty index', async () => {
    await withRoot(async (root) => {
      assert.deepEqual(
        summarize(await readStagedCatalogIndex(root, [])),
        emptySummary,
      );
    });
  });

  test('a missing descriptors.binpb rejects with an Error naming its path', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'absent'), { recursive: true });

      await assert.rejects(
        readStagedCatalogIndex(root, ['absent']),
        (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          assert.ok(
            error.message.includes(join(root, 'absent', 'descriptors.binpb')),
            error.message,
          );

          return true;
        },
      );
    });
  });

  test('a descriptors.binpb that is not a FileDescriptorSet rejects with an Error naming its path', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'broken'), { recursive: true });
      await writeFile(
        join(root, 'broken', 'descriptors.binpb'),
        new Uint8Array([0x0a, 0x05, 0x01]),
      );

      await assert.rejects(
        readStagedCatalogIndex(root, ['broken']),
        (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          assert.ok(
            error.message.includes(join(root, 'broken', 'descriptors.binpb')),
            error.message,
          );

          return true;
        },
      );
    });
  });
});

describe('the package export bundle/platform', () => {
  test('exposes stagedCommandOf, readStagedCatalogIndex and catalogIndexFromDescriptors', async () => {
    assert.equal(typeof platform.stagedCommandOf, 'function');
    assert.equal(typeof platform.readStagedCatalogIndex, 'function');
    assert.equal(typeof platform.catalogIndexFromDescriptors, 'function');
    assert.equal(typeof platform.startPlatform, 'function');
    assert.deepEqual(
      summarize(platform.catalogIndexFromDescriptors([])),
      emptySummary,
    );
    await withRoot(async (root) => {
      assert.deepEqual(platform.stagedCommandOf(root)('demo'), {
        command: join(root, 'demo', 'host', 'doric-demo'),
        args: [],
      });
    });
  });
});
