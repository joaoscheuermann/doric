/**
 * Index keys over `storage/v2` (T4.3, T4.23, OQ10): Q7's moves between
 * keys, Q8's removal of a deleted document from every index, Q9's
 * `unique_conflict` with `{ type, index }`, Q10's rebuild by registration
 * of `withIndexes` variants, whose `unique_conflict` has
 * `{ type, index, ids }`, and T4.23's parity of the engine's index keys
 * with `encodeIndexKey(indexValues(toJson(…)))`. `indexes.ts` runs them
 * after Q6.
 */
import assert from 'node:assert/strict';

import { create, type MessageInitShape, toJson } from '@bufbuild/protobuf';

import { ThreadSchema } from '../../contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { encodeIndexKey, indexValues } from '../../keys.js';
import {
  idsOf,
  note,
  noteKey,
  notePut,
  revisions,
  stored,
  thread,
  threadIndexes,
  threadKey,
  threadPut,
  threadsWith,
  view,
} from './fixtures.js';
import { caseGroup, conformanceBundle, type V2Case } from './harness.js';
import { indexKeys, isCode } from './support.js';

const queries = caseGroup('paginated queries');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The cases, in run order: Q7, Q8, Q9, Q10, T4.23. None is skipped. */
export const keyedCases: readonly V2Case[] = [
  queries(
    'Q7',
    'a put that changes indexed fields moves the document between keys',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: [
          threadPut('t1', { projectId: 'p1', createdAt: '1', name: 'old' }),
          threadPut('t2', { projectId: 'p1', createdAt: '2', name: 'old' }),
        ],
      });
      await storage.commit({
        put: [
          threadPut('t1', { projectId: 'p2', createdAt: '1', name: 'new' }),
        ],
      });

      const ids = (index: string, equals: (string | null)[]) =>
        idsOf(storage, { type: thread, index, equals });

      assert.deepEqual(await ids('byProject', ['p1']), ['t2']);
      assert.deepEqual(await ids('byProject', ['p2']), ['t1']);
      assert.deepEqual(await ids('byName', ['old']), ['t2']);

      // Unsetting an indexed optional field moves the document to null.
      await storage.commit({
        put: [threadPut('t2', { projectId: 'p1', createdAt: '2' })],
      });
      assert.deepEqual(await ids('byName', [null]), ['t2']);
      assert.deepEqual(await ids('byName', ['old']), []);

      // A query answers the whole stored document at its current revision.
      const page = await storage.query({
        type: thread,
        index: 'byName',
        equals: ['new'],
        limit: 1,
      });

      assert.deepEqual(
        page.items.map((item) => view(item)),
        [
          stored(threadKey('t1'), 2, {
            projectId: 'p2',
            createdAt: '1',
            name: 'new',
          }),
        ],
      );
    },
  ),
  queries('Q8', 'a deleted document leaves every index', async (harness) => {
    const storage = await harness.open();
    const ids = (index: string, equals: string[]) =>
      idsOf(storage, { type: note, index, equals });

    await storage.commit({
      put: [
        notePut('n1', { title: 'one', tag: 'shared' }),
        notePut('n2', { title: 'two', tag: 'shared' }),
      ],
    });
    await storage.commit({ delete: [noteKey('n1')] });

    assert.deepEqual(await ids('byTitle', ['one']), []);
    assert.deepEqual(await ids('byTitle', []), ['n2']);
    assert.deepEqual(await ids('byTag', ['shared']), ['n2']);
    assert.deepEqual(await ids('byTag', []), ['n2']);

    // Only n2's entries remain: one per index, none naming n1.
    const entries = await indexKeys(
      harness.engine.kv('doric'),
      conformanceBundle,
      note,
    );
    const n2Tag = hex(encodeIndexKey(['shared', 'n2']));

    assert.deepEqual(
      entries
        .map((entry) => ({
          index: entry.index,
          values: hex(entry.values),
          value: Buffer.from(entry.value).toString('utf8'),
        }))
        .sort((left, right) => (left.index < right.index ? -1 : 1)),
      [
        { index: 'byTag', values: n2Tag, value: '' },
        { index: 'byTitle', values: hex(encodeIndexKey(['two'])), value: 'n2' },
      ],
    );

    // Its unique key is free again.
    await storage.commit({ put: [notePut('n3', { title: 'one' })] });
    assert.deepEqual(await ids('byTitle', ['one']), ['n3']);
  }),
  queries(
    'Q9',
    'a unique index violation is unique_conflict with its type and index, and the batch applies nothing',
    async (harness) => {
      const storage = await harness.open();
      const titles = (equals: string[]) =>
        idsOf(storage, { type: note, index: 'byTitle', equals });

      await storage.commit({ put: [notePut('n1', { title: 'taken' })] });
      await assert.rejects(
        storage.commit({
          put: [
            notePut('n2', { title: 'fresh' }),
            notePut('n3', { title: 'taken' }),
          ],
        }),
        isCode('unique_conflict', { type: note, index: 'byTitle' }),
      );
      assert.equal(await storage.get(noteKey('n2')), undefined);
      assert.deepEqual(await titles([]), ['n1']);

      // Puts apply in batch order: n2 takes "taken" while n1 still holds it.
      await assert.rejects(
        storage.commit({
          put: [
            notePut('n2', { title: 'taken' }),
            notePut('n1', { title: 'moved' }),
          ],
        }),
        isCode('unique_conflict', { type: note, index: 'byTitle' }),
      );
      // In the other order n1 has already moved away.
      await storage.commit({
        put: [
          notePut('n1', { title: 'moved' }),
          notePut('n2', { title: 'taken' }),
        ],
      });
      assert.deepEqual(await titles(['taken']), ['n2']);

      // A document may put the key it already holds.
      await storage.commit({
        put: [notePut('n2', { title: 'taken', tag: 'v2' })],
      });
      assert.deepEqual(await revisions(storage, [noteKey('n2')]), [2]);
    },
  ),
  queries(
    'Q10',
    'a registration that adds an index builds it for stored documents, and one that fails changes nothing',
    async (harness) => {
      await (await harness.open()).commit({
        put: [
          threadPut('t1', { name: 'b', projectId: 'x' }),
          threadPut('t2', { name: 'a', projectId: 'x' }),
          threadPut('t3', { projectId: 'y' }),
        ],
      });

      const labelled = await harness.open(
        conformanceBundle,
        threadsWith([...threadIndexes, { name: 'byLabel', fields: ['name'] }]),
      );
      const labels = (equals: (string | null)[]) =>
        idsOf(labelled, { type: thread, index: 'byLabel', equals });

      assert.deepEqual(await labels([]), ['t3', 't2', 't1']);

      // A unique index the stored documents violate: the rebuild is refused.
      await assert.rejects(
        harness.open(
          conformanceBundle,
          threadsWith([
            ...threadIndexes,
            { name: 'byLabel', fields: ['name'] },
            { name: 'byProjectOnce', fields: ['projectId'], unique: true },
          ]),
        ),
        isCode('unique_conflict', {
          type: thread,
          index: 'byProjectOnce',
          ids: ['t1', 't2'],
        }),
      );
      assert.deepEqual(await labels(['a']), ['t2']);
      await assert.rejects(
        idsOf(labelled, { type: thread, index: 'byProjectOnce', equals: [] }),
        isCode('invalid_input'),
      );
      // The previous declaration still holds for new puts.
      await labelled.commit({
        put: [threadPut('t4', { name: 'c', projectId: 'x' })],
      });
      assert.deepEqual(await labels([]), ['t3', 't2', 't1', 't4']);

      // Redeclaring an index over other fields rebuilds its entries.
      const relabelled = await harness.open(
        conformanceBundle,
        threadsWith([
          ...threadIndexes,
          { name: 'byLabel', fields: ['projectId'] },
        ]),
      );
      const relabels = (equals: string[]) =>
        idsOf(relabelled, { type: thread, index: 'byLabel', equals });

      assert.deepEqual(await relabels(['x']), ['t1', 't2', 't4']);

      // One name twice in a declaration is invalid_input and changes nothing.
      await assert.rejects(
        harness.open(
          conformanceBundle,
          threadsWith([
            ...threadIndexes,
            { name: 'same', fields: ['name'] },
            { name: 'same', fields: ['projectId'] },
          ]),
        ),
        isCode('invalid_input'),
      );
      assert.deepEqual(await relabels(['y']), ['t3']);
    },
  ),
  queries(
    'T4.23',
    "every index key of a Thread is encodeIndexKey of its values in toJson's form with defaults, then its id",
    async (harness) => {
      const storage = await harness.open();
      const threads: [string, MessageInitShape<typeof ThreadSchema>][] = [
        [
          'full',
          {
            projectId: 'p1',
            parentId: 'root',
            createdAt: '2026-11-28T12:00:00.000Z',
            owner: { id: 'u1' },
            count: 2.5,
            flag: true,
            name: 'é 日本',
          },
        ],
        ['unset', { projectId: 'p1' }],
        ['defaults', { owner: {}, count: 0, flag: false, name: '' }],
        ['negative', { projectId: 'p2', count: -1e21, flag: true }],
      ];

      await storage.commit({
        put: threads.map(([id, init]) => threadPut(id, init)),
      });

      const expected = threads
        .flatMap(([id, init]) => {
          const json = toJson(ThreadSchema, create(ThreadSchema, init), {
            alwaysEmitImplicit: true,
          });

          return threadIndexes.map(({ name, fields }) => ({
            type: thread,
            index: name,
            values: hex(encodeIndexKey([...indexValues(json, fields), id])),
            value: '',
          }));
        })
        .sort((left, right) =>
          `${left.index}/${left.values}` < `${right.index}/${right.values}`
            ? -1
            : 1,
        );
      const entries = (
        await indexKeys(harness.engine.kv('doric'), conformanceBundle, thread)
      )
        .map((entry) => ({
          type: entry.type,
          index: entry.index,
          values: hex(entry.values),
          value: hex(entry.value),
        }))
        .sort((left, right) =>
          `${left.index}/${left.values}` < `${right.index}/${right.values}`
            ? -1
            : 1,
        );

      assert.equal(entries.length, threads.length * threadIndexes.length);
      assert.deepEqual(entries, expected);
    },
  ),
];
