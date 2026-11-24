import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  findProvideVersionDrift,
  protoHeaders,
} from './support/provide-versions.mjs';
import { root } from './support/workspace.mjs';

// Plan Q5 (group D, grpc-processes S62c): a `provides` entry of a contract
// whose `.proto` header says `host` carries the header's version.

const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();

/** The `.proto` files under `dir` (absolute), with paths relative to the root. */
const protoFilesUnder = (dir) =>
  isDirectory(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((name) => name.endsWith('.proto'))
        .sort()
        .map((name) => {
          const absolute = join(dir, name);

          return {
            path: absolute.slice(root.length).replace(/^[\\/]/, ''),
            source: readFileSync(absolute, 'utf8'),
          };
        })
    : [];

/** Every bundle directory `bundles/<group>/<id>` that has a manifest. */
const bundleDirectories = () =>
  readdirSync(join(root, 'bundles'))
    .sort()
    .filter((group) => isDirectory(join(root, 'bundles', group)))
    .flatMap((group) =>
      readdirSync(join(root, 'bundles', group))
        .sort()
        .map((name) => join(root, 'bundles', group, name))
        .filter((dir) => existsSync(join(dir, 'manifest.json'))),
    );

const header = (id, words) => `// \`${id}\` (${words}): A contract.\n`;

test('(a) the real repository: every host provides entry carries its .proto header version', () => {
  const directories = bundleDirectories();
  const bundles = directories.map((dir) => {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    );

    return { id: manifest.id, manifest };
  });
  const headers = protoHeaders([
    ...directories.flatMap((dir) =>
      protoFilesUnder(join(dir, 'proto', 'doric')),
    ),
    ...protoFilesUnder(join(root, 'packages', 'bundle', 'proto', 'doric')),
  ]);

  assert.ok(bundles.length > 0);
  assert.ok(
    headers.some(({ id }) => id === 'runtime.threads/v1'),
    'the headers include runtime.threads/v1',
  );
  assert.deepEqual(findProvideVersionDrift(bundles, headers), []);
});

test('(b) a manifest providing a host contract below its header answers one finding naming bundle, id and both versions', () => {
  const headers = protoHeaders([
    {
      path: 'bundles/features/demo/proto/doric/demo/v1/demo.proto',
      source: `${header('demo/v1', 'host, 1.2.0')}syntax = "proto3";\n`,
    },
    {
      path: 'bundles/features/demo/proto/doric/demo/events/v1/events.proto',
      source: `${header('demo.events/v1', 'host event, 1.1.0, D10')}syntax = "proto3";\n`,
    },
    {
      path: 'bundles/features/demo/proto/doric/demo/notes.proto',
      source: 'syntax = "proto3";\n',
    },
  ]);

  assert.deepEqual(headers, [
    {
      id: 'demo/v1',
      environment: 'host',
      version: '1.2.0',
      path: 'bundles/features/demo/proto/doric/demo/v1/demo.proto',
    },
    {
      id: 'demo.events/v1',
      environment: 'host',
      version: '1.1.0',
      path: 'bundles/features/demo/proto/doric/demo/events/v1/events.proto',
    },
  ]);
  assert.deepEqual(
    findProvideVersionDrift(
      [
        {
          id: 'demo',
          manifest: {
            provides: ['demo/v1@1.1.0', 'demo.events/v1@1.1.0'],
          },
        },
      ],
      headers,
    ),
    [{ bundle: 'demo', id: 'demo/v1', provides: '1.1.0', header: '1.2.0' }],
  );
});

test('(c) a client header and a "(host, until phase 4)" header are not checked', () => {
  const headers = protoHeaders([
    {
      path: 'bundles/desktop/demo/proto/doric/demo/views/v1/views.proto',
      source: `${header('demo.views/v1', 'client, 1.3.0')}syntax = "proto3";\n`,
    },
    {
      path: 'packages/bundle/proto/doric/demo/backend/v1/backend.proto',
      source: `${header('demo.backend/v1', 'host, until phase 4')}syntax = "proto3";\n`,
    },
  ]);

  assert.deepEqual(
    headers.map(({ id, environment, version }) => [id, environment, version]),
    [
      ['demo.views/v1', 'client', '1.3.0'],
      ['demo.backend/v1', 'host', undefined],
    ],
  );
  assert.deepEqual(
    findProvideVersionDrift(
      [
        {
          id: 'demo',
          manifest: {
            provides: ['demo.views/v1@1.0.0', 'demo.backend/v1@1.0.0'],
          },
        },
      ],
      headers,
    ),
    [],
  );
});
