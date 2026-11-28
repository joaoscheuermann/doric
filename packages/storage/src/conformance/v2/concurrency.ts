/**
 * Concurrency over two instances of one bundle on one engine (T4.8):
 * C1 and C4, and an instance of another bundle refused `not_owner`
 * through `V2Harness.raw` (PF5); C2 and C3, which append to streams, and
 * `not_owner-streams`, the same refusal for every stream call on
 * conformance's stream prefix.
 */
import assert from 'node:assert/strict';

import { create, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { CommitRequestSchema } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import type { Storage } from '../../client/types.js';
import { NoteSchema } from '../../contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { eventPrefix, streamFiles, textOf } from './files.js';
import {
  contract,
  drain,
  entries,
  idsOf,
  note,
  noteKey,
  notePut,
  range,
  revisions,
  stored,
  streamOf,
  view,
  views,
} from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  type V2Case,
  type V2Harness,
} from './harness.js';
import { isCode, tally } from './support.js';

const concurrency = caseGroup('concurrency');
const stream = `${eventPrefix}n1`;

/** Two instances of one bundle over one engine, so calls race across them. */
const pair = async (
  harness: V2Harness,
  files = conformanceFiles,
): Promise<(index: number) => Storage> => {
  const instances = [
    await harness.open(conformanceBundle, files),
    await harness.open(conformanceBundle, files),
  ];

  return (index) => instances[index % 2] as Storage;
};

/**
 * The cases, in run order, group `concurrency`: C1–C4, then `not_owner`,
 * then `not_owner-streams`.
 */
export const concurrencyCases: readonly V2Case[] = Object.freeze([
  concurrency(
    'C1',
    'of 20 concurrent commits expecting the same revision, exactly one succeeds',
    async (harness) => {
      const storage = await pair(harness);

      await storage(0).commit({ put: [notePut('n1', { title: 'seed' })] });

      const results = await Promise.allSettled(
        range(20).map((index) =>
          storage(index).commit({
            expect: [{ ...noteKey('n1'), revision: 1 }],
            put: [notePut('n1', { title: `by ${index}` })],
          }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 1, revision_conflict: 19 });

      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(
        view(await storage(1).get(noteKey('n1'))),
        stored(noteKey('n1'), 2, { title: `by ${winner}` }),
      );

      // Concurrent creates expecting the document absent: one wins as well.
      const creates = await Promise.allSettled(
        range(12).map((index) =>
          storage(index).commit({
            expect: [{ ...noteKey('n2'), revision: 0 }],
            put: [notePut('n2', { title: `create ${index}` })],
          }),
        ),
      );

      assert.deepEqual(tally(creates), { ok: 1, revision_conflict: 11 });
      assert.deepEqual(await revisions(storage(0), [noteKey('n2')]), [1]);
    },
  ),
  concurrency(
    'C2',
    'of concurrent appends with the same expected sequence, exactly one succeeds',
    async (harness) => {
      const files = streamFiles();
      const storage = await pair(harness, [...conformanceFiles, files.file]);

      await storage(0).commit({
        append: [{ stream, events: [textOf(files.event, 'seed')] }],
      });

      const results = await Promise.allSettled(
        range(10).map((index) =>
          storage(index).commit({
            append: [
              {
                stream,
                expectedSequence: 1,
                events: [textOf(files.event, `e${index}`)],
              },
            ],
          }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 1, sequence_conflict: 9 });

      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(await entries(storage(1), stream), [
        [1, 'seed'],
        [2, `e${winner}`],
      ]);
    },
  ),
  concurrency(
    'C3',
    '50 concurrent appends without an expected sequence get contiguous, unique sequences',
    async (harness) => {
      const files = streamFiles();
      const storage = await pair(harness, [...conformanceFiles, files.file]);

      await Promise.all(
        range(50).map((index) =>
          storage(index).commit({
            append: [{ stream, events: [textOf(files.event, `e${index}`)] }],
          }),
        ),
      );

      const read = await entries(storage(0), stream);

      assert.deepEqual(
        read.map(([sequence]) => sequence),
        range(50).map((index) => index + 1),
      );
      assert.deepEqual(
        read.map(([, text]) => text).sort(),
        range(50)
          .map((index) => `e${index}`)
          .sort(),
      );
      assert.equal(
        (await storage(1).read({ stream, afterSequence: 0, limit: 1 }))
          .lastSequence,
        50,
      );
    },
  ),
  concurrency(
    'C4',
    'concurrent puts all succeed and each raises the revision by one; of 12 claims on one unique key, one does',
    async (harness) => {
      const storage = await pair(harness);
      const ids = range(30).map((index) => `d${index}`);
      const results = await Promise.allSettled(
        ids.map((id, index) =>
          storage(index).commit({
            put: [notePut(id, { title: id, tag: 'all' })],
          }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 30 });
      assert.deepEqual(
        (
          await idsOf(storage(1), {
            type: note,
            index: 'byTag',
            equals: ['all'],
          })
        ).sort(),
        [...ids].sort(),
      );

      // N concurrent puts of one document, with no expect, end at revision N.
      const puts = await Promise.allSettled(
        range(25).map((index) =>
          storage(index).commit({
            put: [notePut('counter', { title: 'counter', tag: `${index}` })],
          }),
        ),
      );

      assert.deepEqual(tally(puts), { ok: 25 });
      assert.deepEqual(await revisions(storage(0), [noteKey('counter')]), [25]);

      const claims = await Promise.allSettled(
        range(12).map((index) =>
          storage(index).commit({
            put: [
              notePut(`claim${index}`, { title: 'only one', tag: 'claim' }),
            ],
          }),
        ),
      );

      assert.deepEqual(tally(claims), { ok: 1, unique_conflict: 11 });

      const winner = claims.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(
        await idsOf(storage(0), {
          type: note,
          index: 'byTitle',
          equals: ['only one'],
        }),
        [`claim${winner}`],
      );
      assert.deepEqual(
        await idsOf(storage(0), {
          type: note,
          index: 'byTag',
          equals: ['claim'],
        }),
        [`claim${winner}`],
      );
    },
  ),
  concurrency(
    'not_owner',
    "an instance of the bundle y is not_owner for every call on conformance's types, and changes nothing",
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: 'mine' })] });
      await assert.rejects(
        harness.open('y', conformanceFiles),
        isCode('not_owner'),
      );

      const raw = harness.raw('y');

      await assert.rejects(
        contract(() => drain(raw.get(noteKey('n1')))),
        isCode('not_owner'),
      );
      await assert.rejects(
        contract(() =>
          drain(
            raw.query({
              storageQuery: {
                type: note,
                index: 'byTag',
                equals: [],
                limit: 10,
              },
            }),
          ),
        ),
        isCode('not_owner'),
      );
      await assert.rejects(
        contract(() =>
          raw.commit(
            streamOf([
              create(CommitRequestSchema, {
                item: { case: 'put', value: noteKey('n9') },
              }),
              create(CommitRequestSchema, {
                item: {
                  case: 'chunk',
                  value: toBinary(
                    NoteSchema,
                    create(NoteSchema, { title: 'theirs' }),
                  ),
                },
              }),
            ]),
          ),
        ),
        isCode('not_owner'),
      );
      assert.deepEqual(await views(storage, [noteKey('n1'), noteKey('n9')]), [
        stored(noteKey('n1'), 1, { title: 'mine' }),
        undefined,
      ]);
    },
  ),
  concurrency(
    'not_owner-streams',
    "an instance of the bundle y is not_owner for every call on conformance's streams, and changes nothing",
    async (harness) => {
      const files = streamFiles();
      const storage = await harness.open(conformanceBundle, [
        ...conformanceFiles,
        files.file,
      ]);

      await storage.commit({
        append: [{ stream, events: [textOf(files.event, 'mine')] }],
      });
      await assert.rejects(
        harness.open('y', [files.file]),
        isCode('not_owner'),
      );

      const raw = harness.raw('y');
      const commitOf = (
        items: readonly MessageInitShape<typeof CommitRequestSchema>[],
      ) =>
        contract(() =>
          raw.commit(
            streamOf(items.map((item) => create(CommitRequestSchema, item))),
          ),
        );

      await assert.rejects(
        contract(() =>
          drain(
            raw.read({ streamRead: { stream, afterSequence: 0, limit: 10 } }),
          ),
        ),
        isCode('not_owner'),
      );
      await assert.rejects(
        commitOf([
          { item: { case: 'append', value: { stream } } },
          {
            item: {
              case: 'event',
              value: toBinary(files.event, textOf(files.event, 'theirs')),
            },
          },
        ]),
        isCode('not_owner'),
      );
      await assert.rejects(
        commitOf([
          { item: { case: 'truncate', value: { stream, afterSequence: 0 } } },
        ]),
        isCode('not_owner'),
      );
      await assert.rejects(
        commitOf([{ item: { case: 'dropStream', value: stream } }]),
        isCode('not_owner'),
      );
      assert.deepEqual(await entries(storage, stream), [[1, 'mine']]);
    },
  ),
]);
