// `readThreadEventLog` reads a Thread's whole log through `ThreadEvents` pages
// (phase 3, slice S62b, C3, test 14): `ThreadEvents` answers at most 3 MiB per
// call, and the helper continues from each page's last sequence until a page
// reaches `lastSequence`. Run against a fake `threadEvents`.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create } from '@bufbuild/protobuf';
import { type Client, Code, ConnectError } from '@connectrpc/connect';
import { isContractError } from 'bundle/contracts';

import {
  type ThreadEventsResponse,
  ThreadEventsResponseSchema,
  type ThreadsService,
} from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { readThreadEventLog } from '../../src/contracts/index.js';

type ThreadEventsPort = Pick<Client<typeof ThreadsService>, 'threadEvents'>;

interface Call {
  readonly id: string | undefined;
  readonly afterSequence: number | undefined;
  readonly signal: AbortSignal | undefined;
}

const threadId = 'thread-1';

/** An event of `threadId` at `sequence`. */
const event = (sequence: number) => ({
  projectId: 'project-1',
  threadId,
  promptId: 'prompt-1',
  sequence,
  type: 'note',
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** A page holding the events at `sequences`, with the log's `lastSequence`. */
const page = (sequences: readonly number[], lastSequence: number) =>
  create(ThreadEventsResponseSchema, {
    threadEventLog: { events: sequences.map(event), lastSequence },
  });

const noLog = () => create(ThreadEventsResponseSchema, {});

/** A fake `threadEvents` that answers `pages` in order and records each call. */
const fake = (
  pages: readonly (ThreadEventsResponse | Error)[],
): { port: ThreadEventsPort; calls: Call[] } => {
  const calls: Call[] = [];
  const port: ThreadEventsPort = {
    threadEvents: async (request, options) => {
      calls.push({
        id: request.id,
        afterSequence: request.afterSequence,
        signal: options?.signal,
      });
      const answer = pages[calls.length - 1];
      if (answer === undefined) throw new Error('an unexpected call');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { port, calls };
};

const sequencesOf = (
  log: Awaited<ReturnType<typeof readThreadEventLog>>,
): number[] | undefined => log?.events.map(({ sequence }) => sequence);

describe('S62b: readThreadEventLog pages ThreadEvents', () => {
  test('cut pages are joined in order, each cursor is the previous page’s last sequence, and lastSequence is the largest read', async () => {
    const { port, calls } = fake([
      page([4, 5], 9),
      page([6, 7], 9),
      page([8, 9, 10], 10),
    ]);

    const log = await readThreadEventLog(port, {
      id: threadId,
      afterSequence: 3,
    });

    assert.deepEqual(sequencesOf(log), [4, 5, 6, 7, 8, 9, 10]);
    assert.equal(log?.lastSequence, 10);
    assert.deepEqual(
      calls.map(({ id, afterSequence }) => ({ id, afterSequence })),
      [
        { id: threadId, afterSequence: 3 },
        { id: threadId, afterSequence: 5 },
        { id: threadId, afterSequence: 7 },
      ],
    );
  });

  test('an uncut provider gets one call', async () => {
    const { port, calls } = fake([page([1, 2, 3], 3)]);

    const log = await readThreadEventLog(port, {
      id: threadId,
      afterSequence: 0,
    });

    assert.deepEqual(sequencesOf(log), [1, 2, 3]);
    assert.equal(log?.lastSequence, 3);
    assert.equal(calls.length, 1);
  });

  test('an empty page ends the read with one call', async () => {
    const { port, calls } = fake([page([], 5)]);

    const log = await readThreadEventLog(port, {
      id: threadId,
      afterSequence: 5,
    });

    assert.deepEqual(sequencesOf(log), []);
    assert.equal(log?.lastSequence, 5);
    assert.equal(calls.length, 1);
  });

  test('a first page with no log answers undefined', async () => {
    const { port, calls } = fake([noLog()]);

    const log = await readThreadEventLog(port, {
      id: threadId,
      afterSequence: 0,
    });

    assert.equal(log, undefined);
    assert.equal(calls.length, 1);
  });

  test('a later page with no log (the Thread deleted between pages) answers undefined', async () => {
    const { port, calls } = fake([page([1, 2], 6), noLog()]);

    const log = await readThreadEventLog(port, {
      id: threadId,
      afterSequence: 0,
    });

    assert.equal(log, undefined);
    assert.equal(calls.length, 2);
  });

  test('a page that does not advance rejects invalid_output', async () => {
    const { port, calls } = fake([page([1, 2], 6), page([2], 6)]);

    await assert.rejects(
      async () =>
        await readThreadEventLog(port, { id: threadId, afterSequence: 0 }),
      (error) => isContractError(error) && error.code === 'invalid_output',
    );
    assert.equal(calls.length, 2);
  });

  test('a call’s rejection passes through unchanged', async () => {
    const failure = new ConnectError('the runtime is gone', Code.Unavailable);
    const { port } = fake([page([1, 2], 6), failure]);

    await assert.rejects(
      async () =>
        await readThreadEventLog(port, { id: threadId, afterSequence: 0 }),
      (error) => error === failure,
    );
  });

  test('options.signal reaches each call', async () => {
    const controller = new AbortController();
    const { port, calls } = fake([page([1, 2], 4), page([3, 4], 4)]);

    await readThreadEventLog(
      port,
      { id: threadId, afterSequence: 0 },
      { signal: controller.signal },
    );

    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(call.signal, controller.signal);
  });
});
