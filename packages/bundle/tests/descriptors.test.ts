// A bundle's descriptors (spec `docs/designs/grpc-processes.md`, section 8,
// "Descriptors", section 14 "Staging"): `buildBundle` writes
// `dist/descriptors.binpb`, the binary `FileDescriptorSet` of the bundle's
// own `.proto` files and their imports, and `stageBundles` stages a version 2
// manifest.

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';

import { BuildError, buildBundle, stageBundles } from '../src/index.js';
import {
  catalogIndexFromDescriptors,
  createCatalogIndex,
} from '../src/platform/catalog-index.js';
import {
  importDemoFile,
  summarize,
  writeContractBundle,
} from './support/descriptor-sets.js';
import { manifest, withRoot, writeBundle } from './support/fixtures.js';

const descriptorsPath = (dir: string) => join(dir, 'dist', 'descriptors.binpb');

const exists = async (path: string) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

void test('a build writes descriptors.binpb, whose index answers what the generated files answer', async () => {
  await withRoot(async (root) => {
    const dir = await writeContractBundle(root);

    await buildBundle(dir);

    const bytes = await readFile(descriptorsPath(dir));
    const fromSet = catalogIndexFromDescriptors([bytes]);
    const fromFiles = createCatalogIndex([await importDemoFile(dir)]);

    assert.deepEqual(summarize(fromSet), summarize(fromFiles));
    assert.equal(fromSet.contract('demo.api/v1')?.environment, 'HOST');
    assert.deepEqual(
      fromSet.desktopMethods().map((entry) => entry.path),
      ['/demo.v1.DemoService/Ping'],
    );
  });
});

void test("descriptors.binpb holds the bundle's files and their imports, each once, imports first", async () => {
  await withRoot(async (root) => {
    const dir = await writeContractBundle(root);

    await buildBundle(dir);

    const set = fromBinary(
      FileDescriptorSetSchema,
      await readFile(descriptorsPath(dir)),
    );
    const names = set.file.map((file) => file.name);

    assert.equal(names.at(-1), 'demo/v1/demo.proto');
    assert.ok(names.includes('doric/platform/v1/options.proto'), String(names));
    assert.ok(
      names.includes('google/protobuf/descriptor.proto'),
      String(names),
    );
    // This package's own contracts are not the bundle's and not imported by it.
    assert.ok(!names.includes('doric/tools/v1/tools.proto'), String(names));
    assert.equal(new Set(names).size, names.length, String(names));

    for (const [position, file] of set.file.entries()) {
      for (const dependency of file.dependency) {
        assert.ok(
          names.indexOf(dependency) > -1 &&
            names.indexOf(dependency) < position,
          `${file.name} imports ${dependency}: ${String(names)}`,
        );
      }
    }
  });
});

void test('a bundle without generated contracts writes an empty descriptors.binpb', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'plain', {
      manifest: manifest('plain'),
    });

    await buildBundle(dir);

    const bytes = await readFile(descriptorsPath(dir));

    assert.equal(bytes.length, 0);
    assert.deepEqual(summarize(catalogIndexFromDescriptors([bytes])), {
      files: [],
      services: [],
      desktop: [],
    });
  });
});

void test('a failed build leaves no descriptors.binpb of an earlier build', async () => {
  await withRoot(async (root) => {
    const dir = await writeContractBundle(root);

    await buildBundle(dir);
    assert.equal(await exists(descriptorsPath(dir)), true);

    // A host part without `activate` fails the dry activation.
    await writeBundle(root, 'demo', {
      manifest: manifest('demo'),
      files: { 'dist/host/index.js': 'export const notActivate = 1;\n' },
    });

    await assert.rejects(buildBundle(dir), BuildError);
    assert.equal(await exists(descriptorsPath(dir)), false);
  });
});

void test('staging accepts a bundle of a version 2 manifest', async () => {
  await withRoot(async (root) => {
    const document = {
      manifestVersion: 2,
      id: 'demo',
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      provides: [],
    };
    const dir = await writeBundle(root, 'demo', {
      manifest: document,
      files: { 'dist/manifest.json': JSON.stringify(document) },
    });
    const destination = join(root, 'staged');

    await stageBundles(destination, [dir]);

    assert.deepEqual(
      JSON.parse(
        await readFile(join(destination, 'demo', 'manifest.json'), 'utf8'),
      ),
      document,
    );
  });
});
