import assert from 'node:assert/strict';

import type { CommitBatch, StorageBackend } from 'bundle/contracts';

import { type ConformanceHarness, caseGroup } from './harness.js';
import { feedAfter, isCode, open, queryIds } from './support.js';

const note = 'conformance.note/v1';
const key = (id: string) => ({ type: note, id });
const put = (id: string, value: unknown) => ({ type: note, id, value });
const stream = 'conformance.note.events/n1';
const other = 'conformance.note.events/n2';

/**
 * A store holding one indexed document, a stream whose tail was truncated
 * (a mark) and a second stream, with limits small enough to exceed.
 */
const seeded = async (harness: ConformanceHarness) => {
  const backend = await open(harness, {
    limits: { maxBatch: 8, maxDocumentBytes: 64, maxAppendBytes: 64 },
  });

  await backend.declareType({
    type: note,
    indexes: [
      { name: 'byTitle', fields: ['title'], unique: true },
      { name: 'byTag', fields: ['tag'] },
    ],
  });
  await backend.commit({
    put: [put('n1', { title: 'one', tag: 't' })],
    append: [{ stream, events: ['e1', 'e2', 'e3', 'e4'] }],
  });
  await backend.commit({
    truncate: { stream, afterSequence: 3 },
    append: [{ stream: other, events: ['o1'] }],
  });

  return backend;
};

/** Everything a failed batch could leave behind, read through the contract. */
const traces = async (backend: StorageBackend) => ({
  documents: await Promise.all(
    ['n1', 'n2', 'n3'].map((id) => backend.get(key(id))),
  ),
  titles: await queryIds(backend, {
    type: note,
    index: 'byTitle',
    equals: [],
    limit: 100,
  }),
  tags: await queryIds(backend, {
    type: note,
    index: 'byTag',
    equals: [],
    limit: 100,
  }),
  stream: await backend.read({ stream, afterSequence: 0, limit: 100 }),
  // A reader holding the removed tail sees the marks of the stream.
  tail: await backend.read({ stream, afterSequence: 4, limit: 100 }),
  other: await backend.read({ stream: other, afterSequence: 0, limit: 100 }),
  feed: await feedAfter(backend),
});

/** Each batch fails with its code, and afterwards nothing has changed. */
const assertRollback = async (
  harness: ConformanceHarness,
  failures: readonly (readonly [string, CommitBatch])[],
) => {
  const backend = await seeded(harness);
  const before = await traces(backend);

  for (const [code, batch] of failures) {
    await assert.rejects(backend.commit(batch), isCode(code));
    assert.deepEqual(await traces(backend), before, code);
  }

  // No sequence advanced: the next append continues the counter.
  await backend.commit({ append: [{ stream, events: ['e5'] }] });
  assert.deepEqual(
    (await backend.read({ stream, afterSequence: 4, limit: 10 })).entries.map(
      ({ sequence, value }) => [sequence, value],
    ),
    [[5, 'e5']],
  );
};

const failures = caseGroup('commit failure');

export const failureCases = [
  failures(
    'X1',
    'a stale expect given last rolls back every other part of the batch',
    (harness) =>
      assertRollback(harness, [
        [
          'revision_conflict',
          {
            delete: [key('n1')],
            put: [put('n2', { title: 'two', tag: 't' })],
            dropStreams: [other],
            truncate: { stream, afterSequence: 1 },
            append: [{ stream, events: ['x'] }],
            expect: [
              { ...key('n1'), revision: 1 },
              { ...key('n3'), revision: 2 },
            ],
          },
        ],
      ]),
  ),
  failures(
    'X2',
    'a unique_conflict or invalid_index_value raised after other puts rolls back the batch',
    (harness) =>
      assertRollback(harness, [
        [
          'unique_conflict',
          {
            put: [
              put('n2', { title: 'two', tag: 't' }),
              put('n3', { title: 'one', tag: 't' }),
            ],
            append: [{ stream: other, events: ['x'] }],
          },
        ],
        [
          'unique_conflict',
          {
            delete: [key('n1')],
            put: [put('n2', { title: 'two' }), put('n3', { title: 'two' })],
          },
        ],
        [
          'invalid_index_value',
          {
            put: [
              put('n2', { title: 'two' }),
              put('n3', { title: 'three', tag: { nested: true } }),
            ],
            truncate: { stream, afterSequence: 0 },
          },
        ],
      ]),
  ),
  failures(
    'X3',
    'a sequence_conflict after a truncate rolls back the truncate and the rest',
    (harness) =>
      assertRollback(harness, [
        [
          'sequence_conflict',
          {
            put: [put('n2', { title: 'two' })],
            truncate: { stream, afterSequence: 1 },
            append: [
              { stream: other, events: ['x'] },
              { stream, expectedSequence: 1, events: ['y'] },
            ],
          },
        ],
        [
          'sequence_conflict',
          {
            dropStreams: [other],
            append: [{ stream: other, expectedSequence: 1, events: ['x'] }],
          },
        ],
      ]),
  ),
  failures('X4', 'a limit_exceeded batch is refused whole', (harness) =>
    assertRollback(harness, [
      [
        'limit_exceeded',
        {
          put: [put('n2', { title: 'two' }), put('n3', { title: 'three' })],
          append: [{ stream, events: ['1', '2', '3', '4', '5', '6', '7'] }],
        },
      ],
      [
        'limit_exceeded',
        {
          put: [put('n2', { title: 'two' }), put('n3', 'x'.repeat(100))],
        },
      ],
      [
        'limit_exceeded',
        {
          put: [put('n2', { title: 'two' })],
          append: [{ stream, events: ['small', 'y'.repeat(100)] }],
        },
      ],
    ]),
  ),
  failures(
    'X5',
    'an empty batch, or a truncate after the last sequence, is invalid_input and applies nothing',
    (harness) =>
      assertRollback(harness, [
        ['invalid_input', {}],
        ['invalid_input', { put: [], delete: [], append: [], dropStreams: [] }],
        [
          'invalid_input',
          {
            put: [put('n2', { title: 'two' })],
            append: [{ stream: other, events: ['x'] }],
            truncate: { stream, afterSequence: 5 },
          },
        ],
        // The dropped stream is empty again, so the truncate is past its end.
        [
          'invalid_input',
          {
            delete: [key('n1')],
            dropStreams: [stream],
            truncate: { stream, afterSequence: 1 },
          },
        ],
      ]),
  ),
];
