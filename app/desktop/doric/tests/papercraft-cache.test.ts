// PC11: the `papercraft` bundle's desktopMain part as `papercraft.cache/v1`
// (D14): the built part activated over a fake broker whose `doric.cache/v1`
// answers one cache root. `ensure` writes `<dir>/<file>` only once its SHA-256 is confirmed;
// the first `ensure` of an app session cuts a root above 256 MiB back to at
// most 128 MiB, oldest `<dir>/` first, before it writes; later ones cut
// nothing; a directory `ensure` keeps gets a fresh modification time.
//
// An app session is one load of the part: each test imports the built module
// afresh (a distinct query) and activates it once.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
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

import { desktopPaths } from '../src/platform/paths';

/** The bundle's built desktopMain part, as the generation runner loads it. */
const PAPERCRAFT_DIST = resolve('bundles/features/papercraft/dist');

const MiB = 1024 * 1024;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A module directory name as `ModuleRef.dir` is: 64 lowercase hex. */
const dirOf = (name: string): string => sha256(name);

/** One entry in the wire shape `papercraft.programs/v1.read` returns. */
const entryOf = (path: string, content: string) => ({
  path,
  sha256: sha256(content),
  base64: Buffer.from(content, 'utf8').toString('base64'),
});

/** A `Call` as the desktopMain kernel hands the part's provider. */
const call: Call = {
  caller: { bundleId: 'papercraft', version: '1.3.0', generation: 1 },
  scope: { projectId: 'p1', threadId: 't1' },
} as unknown as Call;

interface EnsureResult {
  readonly written: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly {
    readonly path: string;
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
let directoryAsked = 0;
let provided: Map<string, AnyServiceDefinition>;
let cleanup: (() => void) | undefined;
let sessions = 0;

/** Loads the built part afresh and activates it: a new app session. */
const startSession = async (): Promise<void> => {
  cleanup?.();
  provided = new Map();
  sessions += 1;

  const { activate } = (await import(
    `${pathToFileURL(join(PAPERCRAFT_DIST, 'desktop', 'index.js')).href}?session=${sessions}`
  )) as {
    readonly activate: (ctx: { readonly services: Services }) => () => void;
  };

  cleanup = activate({ services });
};

const ensure = (input: unknown): Promise<EnsureResult> => {
  const definition = provided.get('papercraft.cache/v1');

  assert.ok(definition !== undefined, 'papercraft.cache/v1 is provided');

  const execute = (
    definition as unknown as {
      readonly methods: {
        readonly ensure: { readonly execute: EnsureExecute };
      };
    }
  ).methods.ensure.execute;

  return execute(input, call, services);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'doric-papercraft-cache-'));
  directoryAsked = 0;
  const disposable = { dispose: () => undefined };
  services = {
    provide: (definition: AnyServiceDefinition) => {
      provided.set(definition.id, definition);

      return disposable;
    },
    use: (ref: unknown) => {
      if ((ref as { readonly id?: string }).id === DoricCacheV1.id) {
        return {
          directory: async () => {
            directoryAsked += 1;

            return root;
          },
        };
      }

      // Any other platform service the part registers with (commands).
      return new Proxy({}, { get: () => () => disposable });
    },
    whenAvailable: () => disposable,
  } as unknown as Services;
});

afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  await rm(root, { recursive: true, force: true });
});

/** The `<dir>/` directories in the root (the staging folder excluded). */
const moduleDirs = async (): Promise<string[]> =>
  (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && /^[0-9a-f]{64}$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();

/** The bytes the `<dir>/` directories hold. */
const rootSize = async (): Promise<number> => {
  let total = 0;

  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);

      if (entry.isDirectory()) {
        await walk(child);
      } else {
        total += (await stat(child)).size;
      }
    }
  };

  for (const dir of await moduleDirs()) {
    await walk(join(root, dir));
  }

  return total;
};

const BLOB = Buffer.alloc(30 * MiB, 7);

/**
 * Writes `count` module directories of 30 MiB each, the first the oldest:
 * modification times one day apart, starting at `fromDay` days after 2001-01-01.
 */
const fillRoot = async (
  prefix: string,
  count: number,
  fromDay: number,
): Promise<string[]> => {
  const dirs: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const dir = dirOf(`${prefix}-${i}`);
    const at = new Date(Date.UTC(2001, 0, 1 + fromDay + i));

    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'blob.bin'), BLOB);
    await utimes(join(root, dir, 'blob.bin'), at, at);
    await utimes(join(root, dir), at, at);
    dirs.push(dir);
  }

  return dirs;
};

describe('papercraft.cache/v1 (desktopMain, PC11)', () => {
  test('provides the contract the manifest declares, asking its directory only at the first ensure', async () => {
    await startSession();

    assert.ok(provided.has('papercraft.cache/v1'));
    assert.equal(directoryAsked, 0);

    const dir = dirOf('first');
    await ensure({ entries: [entryOf(`${dir}/index.js`, 'export {};')] });

    assert.ok(directoryAsked >= 1);
  });

  test('writes each <dir>/<file> only once its SHA-256 is confirmed, and keeps what matches', async () => {
    await startSession();

    const dir = dirOf('module');
    const entries = [
      entryOf(`${dir}/index.js`, 'export const Button = 1;'),
      entryOf(`${dir}/index.css`, '.btn {}'),
      entryOf(`${dir}/assets/${'b'.repeat(64)}.woff2`, 'font'),
    ];

    const first = await ensure({ entries });

    assert.deepEqual(first.failed, []);
    assert.deepEqual(
      [...first.written].sort(),
      entries.map((entry) => entry.path).sort(),
    );
    assert.deepEqual(first.kept, []);
    assert.equal(
      await readFile(join(root, dir, 'index.js'), 'utf8'),
      'export const Button = 1;',
    );
    assert.equal(
      await readFile(
        join(root, dir, 'assets', `${'b'.repeat(64)}.woff2`),
        'utf8',
      ),
      'font',
    );

    const second = await ensure({ entries });

    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.written, []);
    assert.deepEqual(
      [...second.kept].sort(),
      entries.map((entry) => entry.path).sort(),
    );
  });

  test('refuses a file whose SHA-256 differs from the bytes', async () => {
    await startSession();

    const dir = dirOf('mismatch');
    const declared = entryOf(`${dir}/index.js`, 'expected');
    const mismatch = {
      path: declared.path,
      sha256: declared.sha256,
      base64: Buffer.from('something else', 'utf8').toString('base64'),
    };

    const result = await ensure({ entries: [mismatch] });

    assert.deepEqual(
      result.failed.map((failure) => failure.path),
      [declared.path],
    );
    assert.ok((result.failed[0]?.message ?? '').length > 0);
    assert.deepEqual(result.written, []);
    assert.deepEqual(result.kept, []);
    await assert.rejects(readFile(join(root, dir, 'index.js')));
  });

  test('the first ensure of a session cuts a 300 MiB root to at most 128 MiB, oldest first, before it writes; a second cuts nothing', async () => {
    // Ten directories of 30 MiB, `dirs[0]` the oldest. The entry targets the
    // oldest one: cut before the write, its blob is gone and its file is
    // written anew; cut after, the file would be kept with its blob.
    const dirs = await fillRoot('old', 10, 0);
    const oldest = dirs[0] as string;
    const source = 'export const Card = 1;';
    await writeFile(join(root, oldest, 'index.js'), source);
    const at = new Date(Date.UTC(2001, 0, 1));
    await utimes(join(root, oldest), at, at);

    assert.equal(await rootSize(), 300 * MiB + source.length);

    await startSession();

    const first = await ensure({
      entries: [entryOf(`${oldest}/index.js`, source)],
    });

    assert.deepEqual(first.failed, []);
    assert.deepEqual(first.written, [`${oldest}/index.js`]);
    assert.deepEqual(first.kept, []);

    // 300 MiB down to at most 128 MiB, deleting whole directories oldest
    // first, leaves the four newest (120 MiB); the oldest one holds only the
    // file written after the cut.
    assert.ok((await rootSize()) <= 128 * MiB);
    assert.deepEqual(await moduleDirs(), [...dirs.slice(6), oldest].sort());
    assert.deepEqual(await readdir(join(root, oldest)), ['index.js']);
    for (const dir of dirs.slice(6)) {
      assert.deepEqual(await readdir(join(root, dir)), ['blob.bin']);
    }

    // The same session above 256 MiB again: the next ensure deletes nothing.
    const more = await fillRoot('more', 6, 100);
    const before = await moduleDirs();

    assert.ok((await rootSize()) > 256 * MiB);

    const next = dirOf('next');
    const second = await ensure({
      entries: [entryOf(`${next}/index.js`, 'export {};')],
    });

    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.written, [`${next}/index.js`]);
    assert.deepEqual(await moduleDirs(), [...before, next].sort());
    for (const dir of more) {
      assert.deepEqual(await readdir(join(root, dir)), ['blob.bin']);
    }
  });

  test('a root at or below 256 MiB is not cut', async () => {
    const dirs = await fillRoot('small', 8, 0);

    await startSession();

    const dir = dirOf('new');
    const result = await ensure({
      entries: [entryOf(`${dir}/index.js`, 'export {};')],
    });

    assert.deepEqual(result.failed, []);
    assert.deepEqual(await moduleDirs(), [...dirs, dir].sort());
  });

  test('a directory ensure keeps is no longer among the oldest', async () => {
    const day = (n: number) => new Date(Date.UTC(2001, 0, n));
    const names = ['a', 'b', 'c'].map(dirOf);
    const [kept, ...others] = names as [string, ...string[]];
    const source = 'export const Kept = 1;';

    for (const [index, dir] of names.entries()) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'index.js'), `${source}${index}`);
      await utimes(join(root, dir), day(index + 1), day(index + 1));
    }
    await writeFile(join(root, kept, 'index.js'), source);
    await utimes(join(root, kept), day(1), day(1));

    await startSession();

    const startedAt = Date.now();
    const result = await ensure({
      entries: [entryOf(`${kept}/index.js`, source)],
    });

    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.kept, [`${kept}/index.js`]);
    assert.deepEqual(result.written, []);

    const keptAt = (await stat(join(root, kept))).mtimeMs;

    assert.ok(keptAt >= startedAt - 2_000, 'the kept directory is touched');
    for (const dir of others) {
      assert.ok(keptAt > (await stat(join(root, dir))).mtimeMs, dir);
    }
  });

  test('the directory is userData/papercraft/', () => {
    const userData = join(tmpdir(), 'doric-user-data');

    assert.equal(
      desktopPaths(userData).papercraftModules,
      join(userData, 'papercraft'),
    );
  });
});
