/**
 * Commit failure over `storage/v2` (T4.3): the document parts of X1, X2
 * and X5, X2 without `invalid_index_value`, which `Commit` cannot reach
 * (PF7); and the stream parts of X1 and X3–X5, skipped with `untilS78`.
 */
import assert from 'node:assert/strict';

import type { CommitBatch, Storage } from '../../client/types.js';
import { eventPrefix, type StreamFiles, streamFiles, textOf } from './files.js';
import {
  documentBytes,
  entries,
  idsOf,
  note,
  noteKey,
  notePut,
  range,
  sizedNote,
  state,
  views,
} from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  untilS78,
  type V2Case,
  type V2Harness,
} from './harness.js';
import { isCode } from './support.js';

const failures = caseGroup('commit failure');
const stream = `${eventPrefix}n1`;
const other = `${eventPrefix}n2`;

type Failure = readonly [code: string, batch: CommitBatch];

/** Everything a failed batch of documents could leave behind. */
const documentTraces = async (harness: V2Harness, storage: Storage) => ({
  documents: await views(storage, ['n1', 'n2', 'n3'].map(noteKey)),
  titles: await idsOf(storage, { type: note, index: 'byTitle', equals: [] }),
  tags: await idsOf(storage, { type: note, index: 'byTag', equals: [] }),
  state: await state(harness),
});

/** Each batch fails with its code, and afterwards nothing has changed. */
const assertRefused = async (
  storage: Storage,
  failed: readonly Failure[],
  traces: () => Promise<unknown>,
): Promise<void> => {
  const before = await traces();

  for (const [code, batch] of failed) {
    await assert.rejects(storage.commit(batch), isCode(code));
    assert.deepEqual(await traces(), before, code);
  }
};

/** A store holding one indexed document, the one `n1`, `{ one, t }`. */
const documentsOnly = async (
  harness: V2Harness,
  failed: readonly Failure[],
): Promise<void> => {
  const storage = await harness.open();

  await storage.commit({ put: [notePut('n1', { title: 'one', tag: 't' })] });
  await assertRefused(storage, failed, () => documentTraces(harness, storage));
};

/**
 * A store holding `n1`, a stream whose tail was truncated (a mark) and a
 * second stream; each batch fails, nothing changes, and no sequence moved.
 */
const withStreams = async (
  harness: V2Harness,
  failed: (files: StreamFiles) => readonly Failure[],
): Promise<void> => {
  const files = streamFiles();
  const event = (text: string) => textOf(files.event, text);
  const storage = await harness.open(conformanceBundle, [
    ...conformanceFiles,
    files.file,
  ]);

  await storage.commit({
    put: [notePut('n1', { title: 'one', tag: 't' })],
    append: [{ stream, events: ['e1', 'e2', 'e3', 'e4'].map(event) }],
  });
  await storage.commit({
    truncate: { stream, afterSequence: 3 },
    append: [{ stream: other, events: [event('o1')] }],
  });

  const marks = async (name: string, afterSequence: number) => {
    const page = await storage.read({
      stream: name,
      afterSequence,
      limit: 100,
    });

    return { lastSequence: page.lastSequence, truncations: page.truncations };
  };

  await assertRefused(storage, failed(files), async () => ({
    ...(await documentTraces(harness, storage)),
    stream: await entries(storage, stream),
    // A reader holding the removed tail sees the stream's marks.
    tail: await marks(stream, 4),
    other: await entries(storage, other),
  }));

  // No sequence advanced: the next append continues the counter.
  await storage.commit({ append: [{ stream, events: [event('e5')] }] });
  assert.deepEqual(await entries(storage, stream, 4), [[5, 'e5']]);
};

/**
 * The cases, in run order, group `commit failure`: X1, X2, X5, then
 * `X1-streams`, X3, X4 and `X5-streams` with `skip: untilS78`.
 */
export const failureCases: readonly V2Case[] = Object.freeze([
  failures(
    'X1',
    'a stale expect given last rolls back every other part of the batch',
    (harness) =>
      documentsOnly(harness, [
        [
          'revision_conflict',
          {
            delete: [noteKey('n1')],
            put: [notePut('n2', { title: 'two', tag: 't' })],
            expect: [
              { ...noteKey('n1'), revision: 1 },
              { ...noteKey('n3'), revision: 2 },
            ],
          },
        ],
      ]),
  ),
  failures(
    'X2',
    'a unique_conflict raised after other puts rolls back the batch',
    (harness) =>
      documentsOnly(harness, [
        [
          'unique_conflict',
          {
            put: [
              notePut('n2', { title: 'two', tag: 't' }),
              notePut('n3', { title: 'one', tag: 't' }),
            ],
          },
        ],
        [
          'unique_conflict',
          {
            delete: [noteKey('n1')],
            put: [
              notePut('n2', { title: 'two' }),
              notePut('n3', { title: 'two' }),
            ],
          },
        ],
      ]),
  ),
  failures(
    'X5',
    'an empty batch is invalid_input and applies nothing',
    (harness) =>
      documentsOnly(harness, [
        ['invalid_input', {}],
        ['invalid_input', { expect: [], put: [], delete: [] }],
      ]),
  ),
  failures(
    'X1-streams',
    'a stale expect given last rolls back the drop, the truncate and the appends',
    (harness) =>
      withStreams(harness, (files) => [
        [
          'revision_conflict',
          {
            delete: [noteKey('n1')],
            put: [notePut('n2', { title: 'two', tag: 't' })],
            dropStreams: [other],
            truncate: { stream, afterSequence: 1 },
            append: [{ stream, events: [textOf(files.event, 'x')] }],
            expect: [
              { ...noteKey('n1'), revision: 1 },
              { ...noteKey('n3'), revision: 2 },
            ],
          },
        ],
      ]),
    { skip: untilS78 },
  ),
  failures(
    'X3',
    'a sequence_conflict after a truncate rolls back the truncate and the rest',
    (harness) =>
      withStreams(harness, (files) => [
        [
          'sequence_conflict',
          {
            put: [notePut('n2', { title: 'two' })],
            truncate: { stream, afterSequence: 1 },
            append: [
              { stream: other, events: [textOf(files.event, 'x')] },
              {
                stream,
                expectedSequence: 1,
                events: [textOf(files.event, 'y')],
              },
            ],
          },
        ],
        [
          'sequence_conflict',
          {
            dropStreams: [other],
            append: [
              {
                stream: other,
                expectedSequence: 1,
                events: [textOf(files.event, 'x')],
              },
            ],
          },
        ],
      ]),
    { skip: untilS78 },
  ),
  failures(
    'X4',
    'a limit_exceeded batch with streams is refused whole',
    (harness) =>
      withStreams(harness, (files) => [
        [
          'limit_exceeded',
          {
            put: [notePut('n2', { title: 'two' })],
            append: [
              {
                stream,
                events: range(10_000).map((index) =>
                  textOf(files.event, `${index}`),
                ),
              },
            ],
          },
        ],
        [
          'limit_exceeded',
          {
            put: [
              notePut('n2', { title: 'two' }),
              { ...noteKey('n3'), value: sizedNote('n3', documentBytes + 1) },
            ],
            append: [{ stream, events: [textOf(files.event, 'x')] }],
          },
        ],
        [
          'limit_exceeded',
          {
            put: [notePut('n2', { title: 'two' })],
            append: [
              {
                stream,
                events: [
                  textOf(files.event, 'small'),
                  textOf(files.event, 'y'.repeat(3_145_728)),
                ],
              },
            ],
          },
        ],
      ]),
    { skip: untilS78, timeout: 300_000 },
  ),
  failures(
    'X5-streams',
    'a truncate after the last sequence is invalid_input and applies nothing',
    (harness) =>
      withStreams(harness, (files) => [
        [
          'invalid_input',
          {
            put: [notePut('n2', { title: 'two' })],
            append: [{ stream: other, events: [textOf(files.event, 'x')] }],
            truncate: { stream, afterSequence: 5 },
          },
        ],
        // The dropped stream is empty again, so the truncate is past its end.
        [
          'invalid_input',
          {
            delete: [noteKey('n1')],
            dropStreams: [stream],
            truncate: { stream, afterSequence: 1 },
          },
        ],
      ]),
    { skip: untilS78 },
  ),
]);
