/**
 * Snapshot plus cursor (T4.3): P1 and P2 append to streams, so both are
 * skipped with `untilS78` until S78 enables them.
 */
import assert from 'node:assert/strict';

import { create, toJson } from '@bufbuild/protobuf';

import type { Storage } from '../../client/types.js';
import {
  eventPrefix,
  fold,
  type StreamFiles,
  streamFiles,
  textOf,
} from './files.js';
import { entries } from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  untilS78,
  type V2Case,
  type V2Harness,
} from './harness.js';
import { codeOf, isCode } from './support.js';

const snapshots = caseGroup('snapshot + cursor');
const snapshot = { type: fold, id: 't1' };
const stream = `${eventPrefix}t1`;

interface Folded {
  /** The last sequence folded into `seen`. */
  readonly cursor: number;
  readonly seen: readonly string[];
}

/** One instance over the conformance files and the stream files. */
const opened = (harness: V2Harness, files: StreamFiles): Promise<Storage> =>
  harness.open(conformanceBundle, [...conformanceFiles, files.file]);

const foldOf = (files: StreamFiles, state: Folded) => ({
  ...snapshot,
  value: create(files.fold, {
    cursor: state.cursor,
    seen: [...state.seen],
  } as never),
});

/** The snapshot's state and revision, `{ cursor: 0, seen: [] }` when absent. */
const current = async (storage: Storage, files: StreamFiles) => {
  const document = await storage.get(snapshot);
  const json =
    document === undefined
      ? {}
      : (toJson(files.fold, document.value, {
          alwaysEmitImplicit: true,
        }) as { cursor?: number; seen?: string[] });

  return {
    revision: document?.revision ?? 0,
    state: { cursor: json.cursor ?? 0, seen: json.seen ?? [] } as Folded,
  };
};

/** What a replaying reader sees: the snapshot, then every entry after its cursor. */
const replay = async (storage: Storage, files: StreamFiles) => {
  const { state } = await current(storage, files);
  const rest = await entries(storage, stream, state.cursor, 5);

  return [...state.seen, ...rest.map(([, text]) => text)];
};

/** The cases, group `snapshot + cursor`: P1 and P2, both `skip: untilS78`. */
export const snapshotCases: readonly V2Case[] = Object.freeze([
  snapshots(
    'P1',
    'a snapshot committed with its appends holds their cursor, and a read after it sees the rest',
    async (harness) => {
      const files = streamFiles();
      const event = (text: string) => textOf(files.event, text);
      const writer = await opened(harness, files);
      const stale = await opened(harness, files);

      // One commit appends three events and folds them into the snapshot.
      await writer.commit({
        expect: [{ ...snapshot, revision: 0 }],
        put: [foldOf(files, { cursor: 3, seen: ['e1', 'e2', 'e3'] })],
        append: [
          {
            stream,
            expectedSequence: 0,
            events: ['e1', 'e2', 'e3'].map(event),
          },
        ],
      });
      // A writer that missed them fails whole: neither its fold nor its append lands.
      await assert.rejects(
        stale.commit({
          put: [foldOf(files, { cursor: 1, seen: ['lost'] })],
          append: [{ stream, expectedSequence: 0, events: [event('lost')] }],
        }),
        isCode('sequence_conflict'),
      );
      // Later appends are not folded.
      await writer.commit({ append: [{ stream, events: [event('e4')] }] });
      await stale.commit({ append: [{ stream, events: [event('e5')] }] });

      assert.deepEqual(await replay(await opened(harness, files), files), [
        'e1',
        'e2',
        'e3',
        'e4',
        'e5',
      ]);
      assert.equal((await current(writer, files)).revision, 1);
    },
    { skip: untilS78 },
  ),
  snapshots(
    'P2',
    'with concurrent folders and appenders, snapshot plus cursor sees each entry exactly once',
    async (harness) => {
      const files = streamFiles();
      const event = (text: string) => textOf(files.event, text);
      const folders = [
        await opened(harness, files),
        await opened(harness, files),
      ];
      const appender = await opened(harness, files);

      await appender.commit({ put: [foldOf(files, { cursor: 0, seen: [] })] });

      // A folder appends one event and folds everything new, its event
      // included, into the snapshot in the same commit, retrying on conflicts.
      const foldIn = async (storage: Storage, text: string): Promise<void> => {
        for (;;) {
          const { revision, state } = await current(storage, files);
          const page = await storage.read({
            stream,
            afterSequence: state.cursor,
            limit: 1000,
          });
          const unseen = page.entries.map(
            ({ value }) => (value as unknown as { text: string }).text,
          );

          try {
            await storage.commit({
              expect: [{ ...snapshot, revision }],
              put: [
                foldOf(files, {
                  cursor: page.lastSequence + 1,
                  seen: [...state.seen, ...unseen, text],
                }),
              ],
              append: [
                {
                  stream,
                  expectedSequence: page.lastSequence,
                  events: [event(text)],
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
        ...folded.map((text, index) =>
          foldIn(folders[index % 2] as Storage, text),
        ),
        ...plain.map((text) =>
          appender.commit({ append: [{ stream, events: [event(text)] }] }),
        ),
      ]);

      const all = await replay(await opened(harness, files), files);

      assert.equal(new Set(all).size, all.length, 'no entry is seen twice');
      assert.deepEqual([...all].sort(), [...folded, ...plain].sort());
      // The replay follows the stream's own order.
      assert.deepEqual(
        all,
        (await entries(appender, stream)).map(([, text]) => text),
      );
    },
    { skip: untilS78 },
  ),
]);
