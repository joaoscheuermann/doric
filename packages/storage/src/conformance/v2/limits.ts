/**
 * Limits over `storage/v2` (T4.3): the engine's fixed limits, with no
 * configurable limit and so no L1 (PF7); a batch over 10,000 items or
 * 64 MiB is `limit_exceeded` with `details.limit` its name.
 */
import assert from 'node:assert/strict';

import {
  documentBytes,
  noteKey,
  padded,
  plainKey,
  plainPut,
  range,
  revisions,
  sizedNote,
} from './fixtures.js';
import { caseGroup, type V2Case } from './harness.js';
import { isCode } from './support.js';

const limits = caseGroup('limits');
/** The heavy cases' time limit: each sends up to 70 MiB or 10,001 items. */
const timeout = 300_000;
/** The most items of one batch, `chunk` items not counted. */
const batchItems = 10_000;
/** The most bytes of the values of one batch. */
const batchBytes = 67_108_864;

/**
 * The cases, in run order, group `limits`: L2, `L2-bytes` and L3. None is
 * skipped.
 */
export const limitCases: readonly V2Case[] = Object.freeze([
  limits(
    'L2',
    'a batch of 10,000 items passes, and one of 10,001 is limit_exceeded "batch"',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: range(batchItems).map((index) =>
          plainPut(`p${padded(index)}`, 'x'),
        ),
      });
      assert.deepEqual(
        await revisions(storage, [plainKey('p00000'), plainKey('p09999')]),
        [1, 1],
      );

      await assert.rejects(
        storage.commit({
          put: range(batchItems + 1).map((index) =>
            plainPut(`q${padded(index)}`, 'x'),
          ),
        }),
        isCode('limit_exceeded', { limit: 'batch' }),
      );
      assert.deepEqual(
        await revisions(storage, [plainKey('q00000'), plainKey('q10000')]),
        [undefined, undefined],
      );
    },
    { timeout },
  ),
  limits(
    'L2-bytes',
    'a batch of more than 64 MiB of values is limit_exceeded "batch"',
    async (harness) => {
      const storage = await harness.open();
      // Five values of 14 MiB, each under the document limit: 70 MiB.
      const each = 14 * 1_048_576;
      const ids = range(5).map((index) => `b${index}`);

      assert.ok(each * ids.length > batchBytes && each < documentBytes);
      await assert.rejects(
        storage.commit({
          put: ids.map((id) => ({
            ...noteKey(id),
            value: sizedNote(id, each),
          })),
        }),
        isCode('limit_exceeded', { limit: 'batch' }),
      );
      assert.deepEqual(
        await revisions(storage, ids.map(noteKey)),
        ids.map(() => undefined),
      );
    },
    { timeout },
  ),
  limits(
    'L3',
    'a value of 16 MiB passes, and one byte more is limit_exceeded "document"',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: [{ ...noteKey('big'), value: sizedNote('big', documentBytes) }],
      });
      await assert.rejects(
        storage.commit({
          put: [
            { ...noteKey('big'), value: sizedNote('big', documentBytes + 1) },
          ],
        }),
        isCode('limit_exceeded', { limit: 'document' }),
      );
      assert.deepEqual(await revisions(storage, [noteKey('big')]), [1]);
    },
    { timeout },
  ),
]);
