// S78c (T4.26, AC-e): `Storage.watch` over the `sqlite` engine bundle. A
// watcher of a type and a stream receives one change per commit of its
// bundle that touches them, with the commit's position, the revisions and
// the `lastSequence`, and none for other types or streams (T9); a watcher
// that does not read is ended `unavailable`, `Watch fell behind.`, once its
// 1,024-change buffer is full (T10); a type or stream of another namespace
// is `not_owner`, and one the client declares no message for is
// `invalid_input` before any call (T11).
//
// Each watch is synced on a marker commit first: the engine takes the call
// asynchronously, and only a change it has delivered proves it subscribed.
// The router lends a stream 16 messages of credit (`initialCallCredit`,
// `packages/bundle/src/platform/router/control.ts`), so a watcher that does
// not read holds up to that many changes beyond the engine's buffer.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Storage, StorageChange } from '../src/client/types.js';
import {
  eventPrefix,
  otherItem,
  streamFiles,
  textOf,
} from '../src/conformance/v2/files.js';
import {
  contract,
  notePut,
  plain,
  plainPut,
} from '../src/conformance/v2/fixtures.js';
import {
  conformanceBundle,
  conformanceFiles,
  openV2Harness,
  type V2HarnessHandle,
} from '../src/conformance/v2/index.js';
import { isCode } from '../src/conformance/v2/support.js';

/** The engine's buffer of one watcher, in changes. */
const buffer = 1_024;
/** The router's initial credit of one stream, in messages. */
const callCredit = 16;
/** What the transport between the router and the client may hold besides. */
const slack = 64;

const stream = `${eventPrefix}w1`;
const other = `${eventPrefix}w2`;

let harness: V2HarnessHandle;

/** An instance over the conformance files and the stream files. */
const opened = async (): Promise<{
  readonly storage: Storage;
  readonly append: (name: string, ...texts: string[]) => Promise<number>;
}> => {
  const files = streamFiles();
  const storage = await harness.open(conformanceBundle, [
    ...conformanceFiles,
    files.file,
  ]);

  return {
    storage,
    append: async (name, ...texts) =>
      (
        await storage.commit({
          append: [
            {
              stream: name,
              events: texts.map((text) => textOf(files.event, text)),
            },
          ],
        })
      ).position,
  };
};

/** The next change of `changes`, failing after 10 s instead of hanging. */
const next = async (
  changes: AsyncIterator<StorageChange>,
): Promise<StorageChange> => {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    changes.next(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('no change within 10 s')),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));

  assert.equal(result.done, false, 'the watch has not ended');

  return result.value;
};

/**
 * Watches `plain` and `stream` on `storage`, then commits the marker
 * `plain/marker` and waits for its change, so the engine has subscribed.
 */
const watching = async (
  storage: Storage,
): Promise<AsyncIterator<StorageChange>> => {
  const changes = storage
    .watch({ types: [plain], streams: [stream] })
    [Symbol.asyncIterator]();
  const { position } = await storage.commit({
    put: [plainPut('marker', 'm')],
  });

  assert.deepEqual(await next(changes), {
    position,
    documents: [{ type: plain, id: 'marker', revision: 1, deleted: false }],
    streams: [],
  });

  return changes;
};

/** Iterates `changes` to its end. */
const drain = async (changes: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of changes) {
    // Only the end, or the refusal, matters.
  }
};

describe('storage/v2 Watch over sqlite', () => {
  before(async () => {
    harness = await openV2Harness();
  });
  after(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    await harness.reset();
  });

  test('T9 a watcher receives one change per touching commit with its position, revisions and lastSequence', async () => {
    const { storage, append } = await opened();
    const changes = await watching(storage);

    try {
      const put = await storage.commit({ put: [plainPut('p1', 'a')] });

      assert.deepEqual(await next(changes), {
        position: put.position,
        documents: [{ type: plain, id: 'p1', revision: 1, deleted: false }],
        streams: [],
      });

      const appended = await append(stream, 'a', 'b');

      assert.deepEqual(await next(changes), {
        position: appended,
        documents: [],
        streams: [{ stream, lastSequence: 2 }],
      });

      const both = await storage.commit({
        put: [plainPut('p1', 'b')],
        delete: [{ type: plain, id: 'marker' }],
        append: [{ stream, events: [textOf(streamFiles().event, 'c')] }],
      });
      const change = await next(changes);

      assert.equal(change.position, both.position);
      assert.deepEqual(
        [...change.documents].sort((a, b) => a.id.localeCompare(b.id)),
        [
          { type: plain, id: 'marker', revision: 0, deleted: true },
          { type: plain, id: 'p1', revision: 2, deleted: false },
        ],
      );
      assert.deepEqual(change.streams, [{ stream, lastSequence: 3 }]);
    } finally {
      await changes.return?.();
    }
  });

  test('T9 a commit of only other types and streams gives the watcher nothing', async () => {
    const { storage, append } = await opened();
    const changes = await watching(storage);

    try {
      await storage.commit({ put: [notePut('n1', { title: 'T1', tag: 'x' })] });
      await append(other, 'x');
      await storage.commit({
        expect: [{ type: plain, id: 'marker', revision: 1 }],
        put: [notePut('n2', { title: 'T2', tag: 'x' })],
      });
      const touching = await storage.commit({ put: [plainPut('p2', 'a')] });

      assert.deepEqual(await next(changes), {
        position: touching.position,
        documents: [{ type: plain, id: 'p2', revision: 1, deleted: false }],
        streams: [],
      });
    } finally {
      await changes.return?.();
    }
  });

  test('T10 a watcher that does not read is ended unavailable "Watch fell behind." once its buffer is full', {
    timeout: 300_000,
  }, async () => {
    const { storage } = await opened();
    const changes = await watching(storage);
    const commits = buffer + callCredit + slack + 96;

    for (let n = 0; n < commits; n += 1) {
      await storage.commit({ put: [plainPut(`p${n}`, 'a')] });
    }

    let received = 0;
    const ended = await (async () => {
      try {
        for (;;) {
          const result = await changes.next();

          if (result.done === true) {
            return new Error('the watch ended without an error');
          }
          received += 1;
        }
      } catch (error) {
        return error;
      }
    })();

    assert.ok(isCode('unavailable')(ended));
    assert.equal((ended as Error).message, 'Watch fell behind.');
    assert.ok(
      received >= buffer && received <= buffer + callCredit + slack,
      `${received} changes before the end`,
    );
  });

  test('T11 a type or a stream of another namespace is not_owner', async () => {
    const raw = harness.raw(conformanceBundle);

    await assert.rejects(
      contract(() => drain(raw.watch({ types: [otherItem], streams: [] }))),
      isCode('not_owner'),
    );
    await assert.rejects(
      contract(() =>
        drain(raw.watch({ types: [], streams: ['other.item.events/k'] })),
      ),
      isCode('not_owner'),
    );
  });

  test('T11 a type or a stream the client declares no message for is invalid_input before any call', async () => {
    const { storage } = await opened();

    await assert.rejects(
      (async () =>
        drain(storage.watch({ types: ['conformance.undeclared/v1'] })))(),
      isCode('invalid_input'),
    );
    await assert.rejects(
      (async () =>
        drain(
          storage.watch({ streams: ['conformance.undeclared.events/k'] }),
        ))(),
      isCode('invalid_input'),
    );
  });
});
