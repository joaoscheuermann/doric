// The `artifacts` bundle's desktopMain part (`artifacts.cache/v1`, stage 2 of
// `docs/architecture/bundles/artifacts.md`): the built part activated over a
// fake broker whose `doric.cache/v1` answers one cache root, the `ensure` the
// window calls with what `artifacts/v1.read` returned, and the protocol route
// that serves what passed the hash check. Everything the part refuses must
// stay outside the tree the route serves.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  type AnyServiceDefinition,
  type Call,
  DoricCacheV1,
  type Services,
} from 'bundle/contracts';

import { renderFrameDocument } from '../src/platform/protocol/frame';
import type { ProtocolDeps } from '../src/platform/protocol/handler';
import { respond } from '../src/platform/protocol/handler';
import { createShellRenderer } from '../src/platform/protocol/shell';

/** The bundle's built desktopMain part, as the generation runner loads it. */
const ARTIFACTS_DIST = resolve('bundles/features/artifacts/dist');

const TEMPLATE = `<!doctype html>
<html lang="en" class="dark">
  <head><meta charset="utf-8" /><title>Doric</title></head>
  <body><div id="root"></div></body>
</html>
`;

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** One entry in the wire shape `artifacts/v1.read` returns. */
const entryOf = (path: string, content: string) => ({
  path,
  sha256: sha256(content),
  base64: Buffer.from(content, 'utf8').toString('base64'),
});

/** A `Call` as the desktopMain kernel hands the part's provider. */
const call: Call = {
  caller: { bundleId: 'artifacts', version: '1.0.0', generation: 1 },
} as unknown as Call;

interface EnsureResult {
  readonly kept: number;
  readonly written: number;
  readonly failed: readonly {
    readonly path: string;
    readonly reason: string;
    readonly message: string;
  }[];
}

/** The `ensure` method the activation provided, as the bridge would call it. */
type EnsureExecute = (
  input: unknown,
  call: Call,
  services: Services,
) => Promise<EnsureResult>;

let root: string;
let services: Services;
let ensure: EnsureExecute | undefined;
let cleanup: (() => void) | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'doric-artifacts-cache-'));
  services = {
    provide: (definition: AnyServiceDefinition) => {
      assert.equal(definition.id, 'artifacts.cache/v1');
      assert.equal(definition.cardinality, 'one');

      ensure = (
        definition as unknown as {
          readonly methods: {
            readonly ensure: { readonly execute: EnsureExecute };
          };
        }
      ).methods.ensure.execute;

      return { dispose: () => undefined };
    },
    use: (ref: unknown) => {
      assert.equal((ref as { readonly id?: string }).id, DoricCacheV1.id);

      return { directory: async () => root };
    },
    whenAvailable: () => ({ dispose: () => undefined }),
  } as unknown as Services;
  const { activate } = (await import(
    pathToFileURL(join(ARTIFACTS_DIST, 'desktop', 'index.js')).href
  )) as {
    readonly activate: (ctx: { readonly services: Services }) => () => void;
  };

  cleanup = activate({ services });
});

afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  ensure = undefined;
  await rm(root, { recursive: true, force: true });
});

const revision = 'checkout-7f3a@1';

const revisionDir = () => join(root, revision);

const deps = (): ProtocolDeps => ({
  resources: {
    platformRoot: join(root, 'platform'),
    schemasRoot: join(root, 'schemas'),
    shellRoot: join(root, 'renderer'),
    shellVersion: '1.0.0',
  },
  bundles: { file: () => undefined },
  artifacts: { root },
  frame: renderFrameDocument({ imports: {} }),
  shell: createShellRenderer({
    mode: 'packaged',
    template: async () => TEMPLATE,
    generation: () => 1,
    importMap: () => ({ imports: {} }),
    themeHref: '/theme.css',
    devServerOrigin: 'http://localhost:4200',
  }),
});

const get = (url: string) => respond({ url }, deps());

describe('artifacts.cache/v1 (desktopMain)', () => {
  test('provides the contract the manifest declares', () => {
    assert.ok(ensure !== undefined);
  });

  test('writes each entry only once its SHA-256 is confirmed, and keeps what matches', async () => {
    const entries = [
      entryOf('index.js', 'export const a = 1;'),
      entryOf('assets/theme.css', 'body {}'),
    ];

    const first = await ensure?.(
      { artifactId: 'checkout-7f3a', revision: 1, entries },
      call,
      services,
    );

    assert.deepEqual(first?.failed, []);
    assert.equal(first?.written, 2);
    assert.equal(first?.kept, 0);

    assert.equal(
      await readFile(join(revisionDir(), 'index.js'), 'utf8'),
      'export const a = 1;',
    );
    assert.equal(
      await readFile(join(revisionDir(), 'assets', 'theme.css'), 'utf8'),
      'body {}',
    );

    const second = await ensure?.(
      { artifactId: 'checkout-7f3a', revision: 1, entries },
      call,
      services,
    );

    assert.deepEqual(second?.failed, []);
    assert.equal(second?.written, 0);
    assert.equal(second?.kept, 2);
  });

  test('refuses an entry whose bytes do not match the declared hash', async () => {
    const declared = entryOf('index.js', 'expected');

    // The bytes say "something else" while the entry declares the hash of
    // "expected": nothing reaches the cache.
    const mismatch = {
      path: declared.path,
      sha256: declared.sha256,
      base64: Buffer.from('something else', 'utf8').toString('base64'),
    };

    const result = await ensure?.(
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        entries: [mismatch],
      },
      call,
      services,
    );

    assert.deepEqual(result?.failed, [
      {
        path: 'index.js',
        reason: 'hash_mismatch',
        message: 'artifact entry hash mismatch: index.js',
      },
    ]);
    assert.equal(result?.written, 0);

    await assert.rejects(readFile(join(revisionDir(), 'index.js')));
  });

  test('refuses an entry whose path leaves the revision directory', async () => {
    const result = await ensure?.(
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        entries: [entryOf('../escape.js', 'export const a = 1;')],
      },
      call,
      services,
    );

    assert.deepEqual(result?.failed, [
      {
        path: '../escape.js',
        reason: 'invalid_path',
        message: 'artifact entry leaves the revision directory: ../escape.js',
      },
    ]);

    await assert.rejects(readFile(join(root, 'escape.js')));
  });

  test('refuses an artifact id that would leave the cache root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'doric-artifacts-outside-'));

    try {
      for (const artifactId of [
        '../../../tmp/x',
        // Resolved from the cache root, this would land inside `outside`.
        `..${'/..'.repeat(16)}${outside}/x`,
        'a/b',
      ]) {
        const result = await ensure?.(
          {
            artifactId,
            revision: 1,
            entries: [entryOf('index.js', 'escaped')],
          },
          call,
          services,
        );

        assert.equal(result?.written, 0, artifactId);
        assert.deepEqual(
          result?.failed.map((failure) => failure.reason),
          ['invalid_path'],
          artifactId,
        );
      }

      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('replaces a tampered cached file with the verified bytes', async () => {
    await mkdir(revisionDir(), { recursive: true });
    await writeFile(join(revisionDir(), 'index.js'), 'evil');

    const result = await ensure?.(
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        entries: [entryOf('index.js', 'good')],
      },
      call,
      services,
    );

    assert.deepEqual(result?.failed, []);
    assert.equal(result?.written, 1);
    assert.equal(
      await readFile(join(revisionDir(), 'index.js'), 'utf8'),
      'good',
    );
  });

  test('serves the verified revision over /artifacts/ and refuses everything else', async () => {
    await ensure?.(
      {
        artifactId: 'checkout-7f3a',
        revision: 1,
        entries: [
          entryOf('index.js', 'export const a = 1;'),
          entryOf('assets/theme.css', 'body {}'),
        ],
      },
      call,
      services,
    );

    const served = await get('doric://app/artifacts/checkout-7f3a@1/index.js');

    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'text/javascript');
    assert.equal(await served.text(), 'export const a = 1;');

    const styled = await get(
      'doric://app/artifacts/checkout-7f3a@1/assets/theme.css',
    );

    assert.equal(styled.status, 200);
    assert.equal(styled.headers.get('content-type'), 'text/css');

    for (const url of [
      'doric://app/artifacts/checkout-7f3a@1/missing.js',
      'doric://app/artifacts/checkout-7f3a@2/index.js',
      'doric://app/artifacts/.tmp/staged.js',
      'doric://app/artifacts/checkout-7f3a@index.js',
    ]) {
      const response = await get(url);

      assert.equal(response.status, 404, url);
    }

    // Forms the URL parser keeps in the path must be refused.
    for (const url of [
      'doric://app/artifacts/checkout-7f3a@1/..%5c..%5coutside.js',
      'doric://app/artifacts/checkout-7f3a@1/%2e%2e%2f..%2fsecret.js',
    ]) {
      const response = await get(url);

      assert.equal(response.status, 404, url);
    }

    // No path ever resolves outside the cache root: the URL parser folds
    // `%2e%2e` dot segments into `/outside.js`, which is not an asset path at
    // all (the shell answers), and never the file outside the root.
    await writeFile(join(root, 'secret.txt'), 'outside');

    for (const url of [
      'doric://app/artifacts/checkout-7f3a@1/../../secret.txt',
      'doric://app/artifacts/checkout-7f3a@1/%2e%2e/%2e%2e/secret.txt',
    ]) {
      const response = await get(url);

      assert.ok(!(await response.text()).includes('outside'), url);
    }
  });
});
