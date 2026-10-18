import assert from 'node:assert/strict';

import { caseGroup } from './harness.js';
import { isCode, open } from './support.js';

const note = 'conformance.note/v1';
const put = (id: string, value: unknown) => ({ type: note, id, value });
const stream = 'conformance.note.events/n1';

const limits = caseGroup('limits');

export const limitCases = [
  limits(
    'L1',
    'capabilities are positive integers, and configured limits are reported',
    async (harness) => {
      const defaults = await (await open(harness)).capabilities();

      for (const [name, value] of Object.entries(defaults)) {
        assert.ok(Number.isInteger(value) && value > 0, `${name} is ${value}`);
      }

      assert.deepEqual(
        await (
          await open(harness, {
            limits: { maxBatch: 2, maxDocumentBytes: 7, maxAppendBytes: 5 },
          })
        ).capabilities(),
        { maxBatch: 2, maxDocumentBytes: 7, maxAppendBytes: 5 },
      );
      assert.deepEqual(
        await (await open(harness, { limits: { maxBatch: 3 } })).capabilities(),
        { ...defaults, maxBatch: 3 },
      );
    },
  ),
  limits(
    'L2',
    'a batch of more than maxBatch items is limit_exceeded; maxBatch items pass',
    async (harness) => {
      const backend = await open(harness, { limits: { maxBatch: 4 } });

      // Every kind of item counts: expect, put, delete, dropStreams, truncate and each event.
      await backend.commit({ put: [put('n1', 'x')] });
      await backend.commit({
        expect: [{ type: note, id: 'n1', revision: 1 }],
        put: [put('n2', 'y')],
        append: [{ stream, events: ['a', 'b'] }],
      });

      const over = [
        { put: [1, 2, 3, 4, 5].map((index) => put(`p${index}`, index)) },
        {
          expect: [{ type: note, id: 'n1', revision: 1 }],
          delete: [{ type: note, id: 'n2' }],
          dropStreams: ['conformance.note.events/n9'],
          truncate: { stream, afterSequence: 1 },
          append: [{ stream, events: ['c'] }],
        },
        { append: [{ stream, events: ['1', '2', '3', '4', '5'] }] },
      ];

      for (const batch of over) {
        await assert.rejects(
          backend.commit(batch),
          isCode('limit_exceeded', { what: 'batch', limit: 4 }),
        );
      }

      assert.equal(await backend.get({ type: note, id: 'p1' }), undefined);
      assert.equal((await backend.get({ type: note, id: 'n2' }))?.revision, 1);
    },
  ),
  limits(
    'L3',
    'a document over maxDocumentBytes or an event over maxAppendBytes is limit_exceeded',
    async (harness) => {
      const backend = await open(harness, {
        limits: { maxDocumentBytes: 7, maxAppendBytes: 5 },
      });

      // Sizes are the UTF-8 bytes of the JSON text: '"12345"' is 7 bytes.
      await backend.commit({ put: [put('n1', '12345')] });
      await assert.rejects(
        backend.commit({ put: [put('n1', '123456')] }),
        isCode('limit_exceeded', { what: 'document', limit: 7 }),
      );
      // 'é' is two bytes: '"éé"' is 6, '"ééé"' is 8.
      await backend.commit({ put: [put('n2', 'éé')] });
      await assert.rejects(
        backend.commit({ put: [put('n2', 'ééé')] }),
        isCode('limit_exceeded', { what: 'document', limit: 7 }),
      );
      // The limit holds per event: '"abc"' is 5 bytes.
      await backend.commit({ append: [{ stream, events: ['abc', 'def'] }] });
      await assert.rejects(
        backend.commit({ append: [{ stream, events: ['ab', 'abcd'] }] }),
        isCode('limit_exceeded', { what: 'append', limit: 5 }),
      );
      assert.deepEqual(
        [
          (await backend.get({ type: note, id: 'n1' }))?.value,
          (await backend.get({ type: note, id: 'n2' }))?.value,
          (await backend.read({ stream, afterSequence: 0, limit: 10 }))
            .lastSequence,
        ],
        ['12345', 'éé', 2],
      );
    },
  ),
];
