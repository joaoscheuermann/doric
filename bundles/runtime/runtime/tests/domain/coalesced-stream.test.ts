import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContractError } from 'bundle/contracts';

import {
  mergeDeltas,
  type StreamDelta,
  streamDelta,
} from '../../src/contracts/deltas.js';
import type { ThreadEvent } from '../../src/contracts/model.js';
import type { ThreadWatchItem } from '../../src/contracts/watches.js';
import { memoryBackend } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred, type HarnessRun } from './support/harness.js';

/*
 * A Thread whose executor writes its streamed deltas coalesced, as the
 * default executor does: the runtime stores each write as one event and
 * publishes it after its commit, so a live watch reads the same log a replay
 * does, and a host that stops before a held window is written has published
 * nothing the log lacks. The script folds tokens with the shared merge rule,
 * `batch` at a time, standing in for the default executor's window.
 */

const tokens = (count: number, type: 'text.delta' | 'reasoning.delta') =>
  Array.from(
    { length: count },
    (_value, index): StreamDelta => ({ type, delta: `${type[0]}${index} ` }),
  );

/** The tokens as the executor writes them: runs merged, `batch` at a time. */
const coalesce = (
  input: readonly StreamDelta[],
  batch: number,
): StreamDelta[] => {
  const out: { delta: StreamDelta; count: number }[] = [];
  for (const delta of input) {
    const last = out.at(-1);
    const merged =
      last !== undefined && last.count < batch
        ? mergeDeltas(last.delta, delta)
        : undefined;
    if (last !== undefined && merged !== undefined) {
      last.delta = merged;
      last.count += 1;
    } else out.push({ delta, count: 1 });
  }
  return out.map(({ delta }) => delta);
};

/** A watch listener that records every item. */
const recorder = () => {
  const items: ThreadWatchItem[] = [];
  const ended: (ContractError | undefined)[] = [];
  return {
    items,
    ended,
    listener: {
      next: (item: ThreadWatchItem) => {
        items.push(item);
      },
      end: (error?: ContractError) => {
        ended.push(error);
      },
    },
    /** Every event the watch delivered, its snapshot's first. */
    events: (): ThreadEvent[] =>
      items.flatMap((item) =>
        item.kind === 'snapshot'
          ? [...item.events]
          : item.kind === 'event'
            ? [item.event]
            : [],
      ),
  };
};

/** The text of every text delta among `events`, logged or not, in order. */
const textOf = (events: readonly (ThreadEvent | StreamDelta)[]): string =>
  events
    .flatMap((value) => {
      const delta = streamDelta('event' in value ? value.event : value);
      return delta !== undefined && delta.type !== 'tool_call.delta'
        ? [delta.delta]
        : [];
    })
    .join('');

void test('a live Thread watch reads a coalesced stream exactly as a fresh replay does', {
  timeout: 10_000,
}, async () => {
  const written = [
    ...coalesce(tokens(30, 'reasoning.delta'), 8),
    ...coalesce(tokens(50, 'text.delta'), 8),
  ];
  const harness = createHarness({
    execute: async ({ session }: HarnessRun) => {
      for (const event of written) await session.record({ event });
      await session.record({ event: { type: 'usage', usage: {} } });
      return 'done';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const live = recorder();
    const watch = harness.threads.watchThread(
      { threadId: thread.id, afterSequence: 0 },
      live.listener,
    );
    await harness.service.threads.prompt(thread.id, 'stream');
    await harness.waitFor(
      () => live.events().some(({ type }) => type === 'prompt.finished'),
      'the prompt to finish live',
    );
    watch.dispose();

    const replay = await harness.stores.threads.eventsAfter(thread.id, 0);
    assert.deepEqual(live.events(), replay);
    // The runtime neither splits nor joins what the executor wrote.
    const stored = replay.flatMap((event) => streamDelta(event.event) ?? []);
    assert.deepEqual(stored, written);
    assert.ok(stored.length <= Math.ceil(30 / 8) + Math.ceil(50 / 8));
  } finally {
    await harness.dispose();
  }
});

void test('a host stopped mid-stream published only what is durable, and the resumed prompt continues the same log', {
  timeout: 10_000,
}, async () => {
  const backend = memoryBackend();
  const before = coalesce(tokens(12, 'text.delta'), 4);
  const after = coalesce(tokens(6, 'text.delta'), 4);
  const streamed = deferred();
  const first = createHarness({
    backend,
    execute: async ({ session, signal }: HarnessRun) => {
      for (const event of before) await session.record({ event });
      streamed.resolve();
      // The window the run still holds is never written: the host stops
      // first, as a crash would.
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw signal?.reason;
    },
  });
  const project = await first.readyProject();
  const thread = await first.createThread(project.id);
  const live = recorder();
  first.threads.watchThread(
    { threadId: thread.id, afterSequence: 0 },
    live.listener,
  );
  const accepted = await first.service.threads.prompt(thread.id, 'stream');
  assert.ok(accepted.status === 'accepted');
  await streamed.promise;
  await first.service.dispose();

  const durable = await first.stores.threads.eventsAfter(thread.id, 0);
  const bySequence = new Map(durable.map((event) => [event.sequence, event]));
  for (const event of live.events())
    assert.deepEqual(bySequence.get(event.sequence), event);
  assert.equal(textOf(durable), textOf(before));
  await first.dispose();

  const done = deferred();
  const second = createHarness({
    backend,
    sandbox: { sandbox: fakeSandbox() as never },
    execute: async ({ session }: HarnessRun) => {
      for (const event of after) await session.record({ event });
      done.resolve();
      return 'done';
    },
  });
  try {
    assert.equal(await second.service.resumeInterrupted(), 1);
    await done.promise;
    await second.threadState(thread.id, 'ready');
    const resumed = recorder();
    const watch = second.threads.watchThread(
      { threadId: thread.id, afterSequence: 0 },
      resumed.listener,
    );
    await second.waitFor(
      () => resumed.events().some(({ type }) => type === 'prompt.finished'),
      'the resumed prompt to finish',
    );
    watch.dispose();
    const log = await second.stores.threads.eventsAfter(thread.id, 0);
    assert.deepEqual(resumed.events(), log);
    // What the first host published is where it was, before the resumed run.
    assert.deepEqual(log.slice(0, durable.length), durable);
    assert.equal(
      textOf(log),
      textOf([...before, ...after]),
      'the held window is lost, never half-written',
    );
    assert.equal(
      log.filter(({ type }) => type === 'prompt.finished').length,
      1,
    );
  } finally {
    await second.dispose();
    await backend.close();
  }
});
