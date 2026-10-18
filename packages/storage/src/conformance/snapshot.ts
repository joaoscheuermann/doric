import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import { codeOf, isCode, open, readAfter } from './support.js';

const snapshot = { type: 'conformance.thread/v1', id: 't1' };
const stream = 'conformance.thread.events/t1';

interface Folded {
  /** The last sequence folded into `seen`. */
  readonly cursor: number;
  readonly seen: readonly string[];
}

/** What a replaying reader sees: the snapshot, then every entry after its cursor. */
const replay = async (backend: StorageBackend): Promise<string[]> => {
  const state = (await backend.get(snapshot))?.value as Folded;
  const rest = await readAfter(backend, stream, state.cursor, 5);

  return [...state.seen, ...rest.map(({ value }) => value as string)];
};

const snapshots = caseGroup('snapshot + cursor');

export const snapshotCases = [
  snapshots(
    'P1',
    'a snapshot committed with its appends holds their cursor, and a read after it sees the rest',
    async (harness) => {
      const writer = await open(harness);
      const stale = await open(harness);

      // One commit appends three events and folds them into the snapshot.
      await writer.commit({
        expect: [{ ...snapshot, revision: 0 }],
        put: [{ ...snapshot, value: { cursor: 3, seen: ['e1', 'e2', 'e3'] } }],
        append: [{ stream, expectedSequence: 0, events: ['e1', 'e2', 'e3'] }],
      });
      // A writer that missed them fails whole: neither its fold nor its append lands.
      await assert.rejects(
        stale.commit({
          put: [{ ...snapshot, value: { cursor: 1, seen: ['lost'] } }],
          append: [{ stream, expectedSequence: 0, events: ['lost'] }],
        }),
        isCode('sequence_conflict'),
      );
      // Later appends are not folded.
      await writer.commit({ append: [{ stream, events: ['e4'] }] });
      await stale.commit({ append: [{ stream, events: ['e5'] }] });

      assert.deepEqual(await replay(await open(harness)), [
        'e1',
        'e2',
        'e3',
        'e4',
        'e5',
      ]);
      assert.equal((await writer.get(snapshot))?.revision, 1);
    },
  ),
  snapshots(
    'P2',
    'with concurrent folders and appenders, snapshot plus cursor sees each entry exactly once',
    async (harness) => {
      const folders = [await open(harness), await open(harness)];
      const appender = await open(harness);

      await appender.commit({
        put: [{ ...snapshot, value: { cursor: 0, seen: [] } }],
      });

      // A folder appends one event and folds everything new, its event
      // included, into the snapshot in the same commit, retrying on conflicts.
      const fold = async (backend: StorageBackend, event: string) => {
        for (;;) {
          const current = await backend.get(snapshot);
          const state = current?.value as Folded;
          const page = await backend.read({
            stream,
            afterSequence: state.cursor,
            limit: 1000,
          });
          const unseen = page.entries.map(({ value }) => value as string);

          try {
            await backend.commit({
              expect: [{ ...snapshot, revision: current?.revision ?? 0 }],
              put: [
                {
                  ...snapshot,
                  value: {
                    cursor: page.lastSequence + 1,
                    seen: [...state.seen, ...unseen, event],
                  },
                },
              ],
              append: [
                {
                  stream,
                  expectedSequence: page.lastSequence,
                  events: [event],
                },
              ],
            });

            return;
          } catch (error) {
            const code = codeOf({ status: 'rejected', reason: error });

            if (code !== 'revision_conflict' && code !== 'sequence_conflict') {
              throw error;
            }
          }
        }
      };
      const folded = Array.from({ length: 12 }, (_, index) => `f${index}`);
      const plain = Array.from({ length: 12 }, (_, index) => `p${index}`);

      await Promise.all([
        ...folded.map((event, index) =>
          fold(folders[index % 2] as StorageBackend, event),
        ),
        ...plain.map((event) =>
          appender.commit({ append: [{ stream, events: [event] }] }),
        ),
      ]);

      const all = await replay(await open(harness));

      assert.equal(new Set(all).size, all.length, 'no entry is seen twice');
      assert.deepEqual([...all].sort(), [...folded, ...plain].sort());
      // The replay follows the stream's own order.
      assert.deepEqual(
        all,
        (await readAfter(appender, stream)).map(({ value }) => value),
      );
    },
  ),
];
