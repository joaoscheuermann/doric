// T4.20 (AC4.2): the test engine of `storage/testing` starts empty, resets,
// cleans up its own directory, leaves a directory the test gave it, and
// serves only `doric`; and, from S77b1, `openTestStorage` keeps a bundle's
// records under its prefix, resets to an empty store with the bundle's
// declarations, and `TestEngine.storage` registers as a given generation.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { create } from '@bufbuild/protobuf';
import { isContractError } from 'bundle/contracts';
import {
  CommitRequestSchema,
  GetRequestSchema,
  RangeRequestSchema,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import {
  dump,
  everything,
  rangeAll,
  refusal,
} from '../src/conformance/kv/support.js';
import type { Kv } from '../src/kv.js';
import { openTestEngineAt } from '../src/test-engine.js';
import {
  openTestEngine,
  openTestStorage,
  type TestEngine,
} from '../src/testing.js';
import { itemFile, itemOf } from './support/descriptors.js';

const caseTimeoutMs = 120_000;
const encoder = new TextEncoder();
const key = (text: string): Uint8Array => encoder.encode(text);

const putItem = (name: string, value: string) =>
  create(CommitRequestSchema, {
    item: { case: 'put', value: { key: key(name), value: key(value) } },
  });

const collect = async <T>(answer: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];

  for await (const item of answer) {
    out.push(item);
  }

  return out;
};

/** Every key of every caller, read as `doric`. */
const allKeys = async (engine: TestEngine): Promise<string[]> => {
  const entries = await collect(
    engine.kv('doric').range(
      create(RangeRequestSchema, {
        start: new Uint8Array(),
        end: Uint8Array.of(0xff),
        limit: 1000,
      }),
    ),
  );

  return entries.map((entry) => new TextDecoder().decode(entry.key));
};

const readValue = async (kv: Kv, name: string): Promise<string | undefined> => {
  const [item] = await collect(
    kv.get(create(GetRequestSchema, { keys: [key(name)] })),
  );
  const value = item?.value;

  return value === undefined ? undefined : new TextDecoder().decode(value);
};

describe('openTestEngine', { timeout: caseTimeoutMs }, () => {
  // `openTestEngine` makes its directory under `os.tmpdir()`, which reads
  // `TMPDIR`: each case points it at a directory of its own, so the engine's
  // directory is the one entry there, whatever other test files run.
  const savedTmpdir = process.env.TMPDIR;
  let root = '';
  let scratch = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'doric-test-engine-test-'));
  });

  after(async () => {
    if (savedTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = savedTmpdir;
    }

    await rm(root, { recursive: true, force: true });
  });

  const isolateTmpdir = async (): Promise<string> => {
    scratch = await mkdtemp(join(root, 'tmp-'));
    process.env.TMPDIR = scratch;

    return scratch;
  };

  test("reset() empties every caller's keys", async (t) => {
    await isolateTmpdir();

    const engine = await openTestEngine();

    t.after(() => engine.close());

    await engine
      .kv('doric')
      .commit([putItem('x/one', '1'), putItem('x/two', '2')]);
    await engine.kv('doric').commit([putItem('y/one', '1')]);
    await engine.kv('doric').commit([putItem('doric/one', '1')]);
    assert.deepEqual(await allKeys(engine), [
      'doric/one',
      'x/one',
      'x/two',
      'y/one',
    ]);

    await engine.reset();

    assert.deepEqual(await allKeys(engine), []);
  });

  test('a caller but doric is refused with not_owner', async (t) => {
    await isolateTmpdir();

    const engine = await openTestEngine();

    t.after(() => engine.close());

    await assert.rejects(readValue(engine.kv('x'), 'x/a'), (error: unknown) => {
      assert.ok(
        isContractError(error),
        `expected not_owner, got ${String(error)}`,
      );
      assert.equal(error.code, 'not_owner', error.message);
      assert.equal(error.message, 'storage.kv/v1 serves only the platform.');

      return true;
    });
  });

  test("a new engine after close() starts empty, and the first one's directory is gone", async (t) => {
    const parent = await isolateTmpdir();
    const first = await openTestEngine();

    await first.kv('doric').commit([putItem('x/kept', 'v')]);

    const made = await readdir(parent);

    assert.equal(
      made.length,
      1,
      `the engine made one directory: ${made.join(', ')}`,
    );

    const firstDir = join(parent, made[0] as string);

    await first.close();
    assert.equal(
      existsSync(firstDir),
      false,
      'close() removes the directory it made',
    );
    await first.close();

    const second = await openTestEngine();

    t.after(() => second.close());
    assert.deepEqual(await allKeys(second), []);
  });

  test('a second engine on the path of a closed first one reads what it wrote, and the path stays', async (t) => {
    await isolateTmpdir();

    const path = await mkdtemp(join(root, 'path-'));
    const first = await openTestEngine({ path });

    await first.kv('doric').commit([putItem('x/durable', 'written')]);
    await first.close();
    assert.equal(existsSync(path), true, 'close() leaves the given path');
    assert.equal(existsSync(join(path, 'doric.sqlite3')), true);

    const second = await openTestEngine({ path });

    t.after(async () => {
      await second.close();
      assert.equal(existsSync(path), true, 'close() leaves the given path');
    });
    assert.equal(await readValue(second.kv('doric'), 'x/durable'), 'written');
  });

  test('openTestEngineAt on a missing executable rejects naming sqlite:compile and starts nothing', async () => {
    const parent = await isolateTmpdir();
    const missing = join(root, 'no-such-dir', 'doric-sqlite');

    await assert.rejects(openTestEngineAt(missing), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /npx nx run sqlite:compile/);

      return true;
    });
    assert.deepEqual(await readdir(parent), [], 'no engine directory was made');
  });

  test("TE1: openTestStorage stores under the bundle's prefix, its kv reads every key, and close() stops it", async (t) => {
    await isolateTmpdir();

    const x = itemFile('x');
    const key = { type: 'x.item/v1', id: 'one' };
    const opened = await openTestStorage('x', [x.file]);
    let closed = false;

    t.after(() => (closed ? undefined : opened.close()));
    await opened.storage.commit({
      put: [{ ...key, value: itemOf(x.item, '1') }],
    });

    const keys = (
      await rangeAll(opened.kv, { ...everything, limit: 1000 })
    ).map((entry) => Buffer.from(entry.key).toString('latin1'));

    assert.ok(keys.length > 0, 'the commit wrote keys');
    assert.deepEqual(
      keys.filter((stored) => !stored.startsWith('x/')),
      [],
    );

    await opened.close();
    closed = true;
    await assert.rejects(opened.storage.get(key), refusal('unavailable'));
  });

  test('TE2: after reset() the store is empty and the bundle registered again', async (t) => {
    await isolateTmpdir();

    const x = itemFile('x');
    const key = { type: 'x.item/v1', id: 'one' };
    const opened = await openTestStorage('x', [x.file]);

    t.after(() => opened.close());
    await opened.storage.commit({
      put: [{ ...key, value: itemOf(x.item, '1') }],
    });
    await opened.storage.commit({
      put: [{ ...key, value: itemOf(x.item, '2') }],
    });
    assert.equal((await opened.storage.get(key))?.revision, 2);

    await opened.reset();

    await opened.storage.commit({
      expect: [{ ...key, revision: 0 }],
      put: [{ ...key, value: itemOf(x.item, '3') }],
    });
    assert.equal((await opened.storage.get(key))?.revision, 1);
  });

  test('TE3: a registration of a generation below the one registered changes nothing', async (t) => {
    await isolateTmpdir();

    const engine = await openTestEngine();

    t.after(() => engine.close());
    await engine.storage('x', [itemFile('x').file], 2);
    const registered = await dump(engine);

    await engine.storage('x', [itemFile('x', 'extra').file], 1);

    assert.deepEqual(await dump(engine), registered);
  });
});
