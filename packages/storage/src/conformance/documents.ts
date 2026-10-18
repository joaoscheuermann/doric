import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import { isCode, open } from './support.js';

const note = 'conformance.note/v1';
const key = (id: string) => ({ type: note, id });
const put = (id: string, value: unknown) => ({ type: note, id, value });

const revisions = (backend: StorageBackend, ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => (await backend.get(key(id)))?.revision));

const values = (backend: StorageBackend, ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => (await backend.get(key(id)))?.value));

const documents = caseGroup('documents');

export const documentCases = [
  documents(
    'D1',
    'a put document reads back as stored, whatever JSON it holds',
    async (harness) => {
      const backend = await open(harness);
      const stored: [string, unknown][] = [
        ['object', { title: 'one', nested: { list: [1, null, 'two', true] } }],
        ['string', 'a string with é and 日本'],
        ['number', -12.5],
        ['boolean', false],
        ['null', null],
        ['array', [{ a: 1 }, [2], 'three']],
      ];

      await backend.commit({
        put: stored.map(([id, value]) => put(id, value)),
      });

      for (const [id, value] of stored) {
        assert.deepEqual(await backend.get(key(id)), {
          type: note,
          id,
          revision: 1,
          value,
        });
      }

      // Another instance over the same store reads the same documents.
      const other = await open(harness);

      assert.deepEqual(
        await values(
          other,
          stored.map(([id]) => id),
        ),
        stored.map(([, value]) => value),
      );
    },
  ),
  documents(
    'D2',
    'the first revision is 1 and each put adds one, two puts in one batch included',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({ put: [put('n1', { v: 1 })] });
      assert.equal((await backend.get(key('n1')))?.revision, 1);

      await backend.commit({ put: [put('n1', { v: 2 })] });
      await backend.commit({ put: [put('n1', { v: 3 })] });
      assert.deepEqual(await backend.get(key('n1')), {
        ...key('n1'),
        revision: 3,
        value: { v: 3 },
      });

      // Two puts of one document in one batch are two revisions; the last value wins.
      await backend.commit({ put: [put('n1', 'first'), put('n1', 'last')] });
      assert.deepEqual(await backend.get(key('n1')), {
        ...key('n1'),
        revision: 5,
        value: 'last',
      });
    },
  ),
  documents(
    'D3',
    'a deleted document is gone, and created again it starts over at revision 1',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({ put: [put('n1', 'a'), put('n2', 'b')] });
      await backend.commit({ put: [put('n1', 'a2')] });
      await backend.commit({ delete: [key('n1')] });
      assert.equal(await backend.get(key('n1')), undefined);
      assert.deepEqual(await values(backend, ['n2']), ['b']);

      // Deleting an absent document is not an error.
      await backend.commit({ delete: [key('n1'), key('never')] });

      await backend.commit({ put: [put('n1', 'again')] });
      assert.deepEqual(await backend.get(key('n1')), {
        ...key('n1'),
        revision: 1,
        value: 'again',
      });

      // A delete and a put of one document in one batch recreate it.
      await backend.commit({ delete: [key('n2')], put: [put('n2', 'fresh')] });
      assert.deepEqual(await backend.get(key('n2')), {
        ...key('n2'),
        revision: 1,
        value: 'fresh',
      });
    },
  ),
  documents(
    'D4',
    'a document never written is undefined, in any type',
    async (harness) => {
      const backend = await open(harness);

      assert.equal(await backend.get(key('missing')), undefined);
      await backend.commit({ put: [put('n1', 'x')] });
      assert.equal(await backend.get(key('missing')), undefined);
      assert.equal(
        await backend.get({ type: 'conformance.other/v1', id: 'n1' }),
        undefined,
      );
    },
  ),
  documents(
    'D5',
    'an expect mismatch is revision_conflict and nothing of the batch applies',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({ put: [put('n1', { v: 1 })] });
      await assert.rejects(
        backend.commit({
          expect: [{ ...key('n1'), revision: 2 }],
          put: [put('n1', { v: 2 }), put('n2', { v: 1 })],
          delete: [key('n1')],
        }),
        isCode('revision_conflict'),
      );
      assert.deepEqual(await backend.get(key('n1')), {
        ...key('n1'),
        revision: 1,
        value: { v: 1 },
      });
      assert.equal(await backend.get(key('n2')), undefined);
    },
  ),
  documents(
    'D6',
    'expect revision 0 passes only while the document is absent',
    async (harness) => {
      const backend = await open(harness);
      const create = (value: string) => ({
        expect: [{ ...key('n1'), revision: 0 }],
        put: [put('n1', value)],
      });

      await backend.commit(create('created'));
      assert.equal((await backend.get(key('n1')))?.revision, 1);
      await assert.rejects(
        backend.commit(create('twice')),
        isCode('revision_conflict', { ...key('n1'), expected: 0, actual: 1 }),
      );
      assert.deepEqual(await values(backend, ['n1']), ['created']);

      // After a delete the document is absent again.
      await backend.commit({ delete: [key('n1')] });
      await backend.commit(create('recreated'));
      assert.deepEqual(await backend.get(key('n1')), {
        ...key('n1'),
        revision: 1,
        value: 'recreated',
      });

      // Expecting an absent document at another revision fails with actual 0.
      await assert.rejects(
        backend.commit({ expect: [{ ...key('n2'), revision: 1 }] }),
        isCode('revision_conflict', { ...key('n2'), expected: 1, actual: 0 }),
      );
    },
  ),
  documents(
    'D7',
    'a document of an undeclared type stays readable, and declareType never deletes data',
    async (harness) => {
      const backend = await open(harness);
      const ids = ['n1', 'n2', 'n3'];

      await backend.commit({
        put: [
          put('n1', { title: 'same', tag: 'x' }),
          put('n2', { title: 'same', tag: 'y' }),
          put('n3', { other: true }),
        ],
      });
      assert.deepEqual(await revisions(backend, ids), [1, 1, 1]);

      await backend.declareType({
        type: note,
        indexes: [{ name: 'byTag', fields: ['tag'] }],
      });
      // A declaration the stored data violates is refused and deletes nothing.
      await assert.rejects(
        backend.declareType({
          type: note,
          indexes: [{ name: 'byTitle', fields: ['title'], unique: true }],
        }),
        isCode('unique_conflict'),
      );
      await backend.declareType({ type: note, indexes: [] });
      assert.deepEqual(await revisions(backend, ids), [1, 1, 1]);
      assert.deepEqual(await values(backend, ids), [
        { title: 'same', tag: 'x' },
        { title: 'same', tag: 'y' },
        { other: true },
      ]);
    },
  ),
];

const revisionConflicts = caseGroup('revision conflicts');

export const revisionCases = [
  revisionConflicts(
    'R1',
    'a revision_conflict names the document, the expected and the actual revision',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({ put: [put('n1', 1)] });
      await backend.commit({ put: [put('n1', 2)] });
      await assert.rejects(
        backend.commit({
          expect: [{ ...key('n1'), revision: 1 }],
          put: [put('n1', 3)],
        }),
        isCode('revision_conflict', {
          type: note,
          id: 'n1',
          expected: 1,
          actual: 2,
        }),
      );
    },
  ),
  revisionConflicts(
    'R2',
    'after a conflict, re-reading and retrying with the current revision succeeds',
    async (harness) => {
      const writer = await open(harness);
      const other = await open(harness);

      await writer.commit({ put: [put('n1', { v: 1 })] });

      const read = await writer.get(key('n1'));

      // Another instance writes in between.
      await other.commit({ put: [put('n1', { v: 'other' })] });
      await assert.rejects(
        writer.commit({
          expect: [{ ...key('n1'), revision: read?.revision ?? 0 }],
          put: [put('n1', { v: 'mine' })],
        }),
        isCode('revision_conflict'),
      );

      const current = await writer.get(key('n1'));

      assert.deepEqual(current?.value, { v: 'other' });
      await writer.commit({
        expect: [{ ...key('n1'), revision: current?.revision ?? 0 }],
        put: [put('n1', { v: 'mine' })],
      });
      // The new revision is the expected one plus 1.
      assert.deepEqual(await other.get(key('n1')), {
        ...key('n1'),
        revision: (current?.revision ?? 0) + 1,
        value: { v: 'mine' },
      });
    },
  ),
  revisionConflicts(
    'R3',
    'one stale document among several expected leaves every document unchanged',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({ put: [put('n1', 'a'), put('n2', 'b')] });
      await backend.commit({ put: [put('n2', 'b2')] });
      await assert.rejects(
        backend.commit({
          expect: [
            { ...key('n1'), revision: 1 },
            { ...key('n2'), revision: 1 },
          ],
          put: [put('n1', 'x'), put('n2', 'y'), put('n3', 'z')],
        }),
        isCode('revision_conflict', {
          ...key('n2'),
          expected: 1,
          actual: 2,
        }),
      );
      assert.deepEqual(await values(backend, ['n1', 'n2', 'n3']), [
        'a',
        'b2',
        undefined,
      ]);
      assert.deepEqual(await revisions(backend, ['n1', 'n2']), [1, 2]);
    },
  ),
];
