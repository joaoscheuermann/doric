/**
 * Revision conflicts over `storage/v2` (T4.3): R1–R3, as in the v1 kit, on
 * `Note` documents; `documents.ts` runs them after D1–D7.
 */
import assert from 'node:assert/strict';

import {
  noteKey,
  notePut,
  revisions,
  stored,
  view,
  views,
} from './fixtures.js';
import { caseGroup, type V2Case } from './harness.js';
import { isCode } from './support.js';

const conflicts = caseGroup('revision conflicts');

/** R1–R3, group `revision conflicts`. None is skipped. */
export const revisionCases: readonly V2Case[] = [
  conflicts(
    'R1',
    'a revision_conflict names the document, the expected and the actual revision',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: '1' })] });
      await storage.commit({ put: [notePut('n1', { title: '2' })] });
      await assert.rejects(
        storage.commit({
          expect: [{ ...noteKey('n1'), revision: 1 }],
          put: [notePut('n1', { title: '3' })],
        }),
        isCode('revision_conflict', {
          ...noteKey('n1'),
          expected: 1,
          actual: 2,
        }),
      );
    },
  ),
  conflicts(
    'R2',
    'after a conflict, re-reading and retrying with the current revision succeeds',
    async (harness) => {
      const writer = await harness.open();
      const other = await harness.open();

      await writer.commit({ put: [notePut('n1', { title: 'first' })] });

      const read = await writer.get(noteKey('n1'));

      // Another instance writes in between.
      await other.commit({ put: [notePut('n1', { title: 'other' })] });
      await assert.rejects(
        writer.commit({
          expect: [{ ...noteKey('n1'), revision: read?.revision ?? 0 }],
          put: [notePut('n1', { title: 'mine' })],
        }),
        isCode('revision_conflict'),
      );

      const current = view(await writer.get(noteKey('n1')));

      assert.deepEqual(current, stored(noteKey('n1'), 2, { title: 'other' }));
      await writer.commit({
        expect: [{ ...noteKey('n1'), revision: 2 }],
        put: [notePut('n1', { title: 'mine' })],
      });
      // The new revision is the expected one plus 1.
      assert.deepEqual(
        view(await other.get(noteKey('n1'))),
        stored(noteKey('n1'), 3, { title: 'mine' }),
      );
    },
  ),
  conflicts(
    'R3',
    'one stale document among several expected leaves every document unchanged',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: [notePut('n1', { title: 'a' }), notePut('n2', { title: 'b' })],
      });
      await storage.commit({ put: [notePut('n2', { title: 'b2' })] });
      await assert.rejects(
        storage.commit({
          expect: [
            { ...noteKey('n1'), revision: 1 },
            { ...noteKey('n2'), revision: 1 },
          ],
          put: [
            notePut('n1', { title: 'x' }),
            notePut('n2', { title: 'y' }),
            notePut('n3', { title: 'z' }),
          ],
        }),
        isCode('revision_conflict', {
          ...noteKey('n2'),
          expected: 1,
          actual: 2,
        }),
      );
      assert.deepEqual(
        await views(storage, [noteKey('n1'), noteKey('n2'), noteKey('n3')]),
        [
          stored(noteKey('n1'), 1, { title: 'a' }),
          stored(noteKey('n2'), 2, { title: 'b2' }),
          undefined,
        ],
      );
      assert.deepEqual(
        await revisions(storage, [noteKey('n1'), noteKey('n2')]),
        [1, 2],
      );
    },
  ),
];
