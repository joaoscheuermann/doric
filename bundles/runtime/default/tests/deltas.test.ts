import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type HistoryPatch,
  isEmptyDelta,
  mergeDeltas,
  type PromptSession,
  type StreamDelta,
  streamDelta,
} from 'runtime/contracts';

import { type Clock, coalesced } from '../src/host/deltas.js';

/*
 * The run's writes as the Thread receives them: streamed deltas arrive
 * coalesced, everything else arrives as it was written, in the order it was
 * written. The session is the boundary (one write is one commit and one
 * publication in the runtime), and the window runs on a clock the case moves.
 */

type Entry = Parameters<PromptSession['record']>[0];

const history: HistoryPatch = { format: 'test/v1', parts: { messages: [] } };

/** A clock whose time moves only when a case advances it. */
const manualClock = () => {
  let now = 0;
  let id = 0;
  const tasks = new Map<number, { readonly at: number; run(): void }>();
  const clock: Clock = {
    setTimeout: (task, delay) => {
      id += 1;
      tasks.set(id, { at: now + delay, run: task });
      return id;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as number);
    },
  };
  return {
    clock,
    /** Moves the time on, running every task that falls due, then settles. */
    advance: async (ms: number) => {
      now += ms;
      for (const [key, task] of [...tasks].sort(([, a], [, b]) => a.at - b.at))
        if (task.at <= now) {
          tasks.delete(key);
          task.run();
        }
      await settled();
    },
  };
};

/** Lets every queued write run. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A session that keeps what it was asked to write and can refuse a write. */
const fakeSession = () => {
  const writes: Entry[] = [];
  let refuse: ((entry: Entry) => unknown) | undefined;
  const session: PromptSession = {
    history: { format: undefined, read: async () => undefined },
    record: async (entry) => {
      const error = refuse?.(entry);
      if (error !== undefined) throw error;
      writes.push(entry);
    },
  };
  return {
    session,
    writes,
    refuseWhen: (test: (entry: Entry) => unknown) => {
      refuse = test;
    },
    /** The events written, in order. */
    events: () => writes.flatMap(({ event }) => event ?? []),
  };
};

const text = (delta: string) => ({ type: 'text.delta', delta });
const reasoning = (delta: string) => ({ type: 'reasoning.delta', delta });
const refusal = (delta: string) => ({ type: 'refusal.delta', delta });
const call = (
  index: number,
  argumentsDelta?: string,
  id = `call-${index}`,
) => ({
  type: 'tool_call.delta',
  index,
  id,
  name: 'edit',
  ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
});

/** Records every event through a coalescing session whose window never ends. */
const writeAll = async (
  events: readonly unknown[],
  options: { readonly limit?: number } = {},
) => {
  const target = fakeSession();
  const { clock } = manualClock();
  const log = coalesced(target.session, { clock, ...options });
  for (const event of events) await log.record({ event });
  await log.record({ history });
  return target;
};

describe('coalesced deltas', () => {
  test('writes one event per run of same-kind deltas, holding their concatenation', async () => {
    const target = await writeAll([
      reasoning('Let '),
      reasoning('me think'),
      text('Hello'),
      text(', '),
      text('world'),
      refusal('I cannot '),
      refusal('do that'),
    ]);

    assert.deepEqual(target.events(), [
      reasoning('Let me think'),
      text('Hello, world'),
      refusal('I cannot do that'),
    ]);
  });

  test('keeps runs apart where the kind changes, in the order they were written', async () => {
    const target = await writeAll([
      reasoning('a'),
      text('b'),
      reasoning('c'),
      reasoning('d'),
      text('e'),
    ]);

    assert.deepEqual(target.events(), [
      reasoning('a'),
      text('b'),
      reasoning('cd'),
      text('e'),
    ]);
  });

  test('merges a tool call’s argument pieces per call and keeps other calls apart', async () => {
    const target = await writeAll([
      call(0, ''),
      call(0, '{"path":'),
      call(0, '"a.ts"}'),
      call(1, '{}'),
      call(1, '[]', 'call-other'),
      call(0, '{"x":1}'),
    ]);

    assert.deepEqual(target.events(), [
      call(0, '{"path":"a.ts"}'),
      call(1, '{}'),
      call(1, '[]', 'call-other'),
      call(0, '{"x":1}'),
    ]);
  });

  test('keeps a tool call’s identity from its first piece, which carries no arguments', async () => {
    const target = await writeAll([
      { type: 'tool_call.delta', index: 0, id: 'call-0', name: 'edit' },
      { type: 'tool_call.delta', index: 0, argumentsDelta: '{"path":' },
      { type: 'tool_call.delta', index: 0, argumentsDelta: '"a.ts"}' },
    ]);

    assert.deepEqual(target.events(), [
      {
        type: 'tool_call.delta',
        index: 0,
        id: 'call-0',
        name: 'edit',
        argumentsDelta: '{"path":"a.ts"}',
      },
    ]);
  });

  test('keeps blank text before an answer apart from the answer’s first words', async () => {
    const target = await writeAll([
      text('\n\n'),
      text(' '),
      text('Hello'),
      text('\n\n'),
      text('there'),
    ]);

    assert.deepEqual(target.events(), [text('\n\n '), text('Hello\n\nthere')]);
  });

  test('merges blank reasoning with the reasoning that follows it', async () => {
    const target = await writeAll([reasoning('\n'), reasoning('think')]);

    assert.deepEqual(target.events(), [reasoning('\nthink')]);
  });

  test('drops empty deltas without ending the run they sit in', async () => {
    const target = await writeAll([
      text(''),
      text('a'),
      reasoning(''),
      { type: 'tool_call.delta', index: 0 },
      { type: 'tool_call.delta', index: 0, argumentsDelta: '' },
      text('b'),
    ]);

    assert.deepEqual(target.events(), [text('ab')]);
  });

  test('writes a run once it reaches the size cap, counting UTF-8 bytes', async () => {
    const target = fakeSession();
    const { clock } = manualClock();
    const log = coalesced(target.session, { clock, limit: 8 });

    await log.record({ event: text('aaaa') });
    await log.record({ event: text('bbbb') });
    // At the cap the run is written at once, without waiting for its window.
    assert.deepEqual(target.events(), [text('aaaabbbb')]);
    await log.record({ event: text('ccc') });
    // 'é' is two bytes: 3 + 6 would pass the cap, so a new run starts.
    await log.record({ event: text('ééé') });
    await log.record({ history });

    assert.deepEqual(target.events().slice(0, 3), [
      text('aaaabbbb'),
      text('ccc'),
      text('ééé'),
    ]);
  });

  test('writes a held run when the window since its first delta ends', async () => {
    const target = fakeSession();
    const time = manualClock();
    const log = coalesced(target.session, { clock: time.clock });

    await log.record({ event: text('a') });
    await time.advance(200);
    await log.record({ event: text('b') });
    await time.advance(49);
    assert.deepEqual(target.events(), []);
    await time.advance(1);
    assert.deepEqual(target.events(), [text('ab')]);

    // The next delta opens a window of its own.
    await log.record({ event: text('c') });
    await time.advance(249);
    assert.deepEqual(target.events(), [text('ab')]);
    await time.advance(1);
    assert.deepEqual(target.events(), [text('ab'), text('c')]);
  });

  test('writes the held run before any other event and before a history save', async () => {
    const target = fakeSession();
    const { clock } = manualClock();
    const log = coalesced(target.session, { clock });
    const usage = { type: 'usage', usage: { inputTokens: 1 } };
    const finished = { type: 'response.finished' };

    await log.record({ event: text('a') });
    await log.record({ event: text('b') });
    await log.record({ event: usage });
    await log.record({ event: text('c') });
    await log.record({ history });
    await log.record({ event: text('d') });
    await log.record({ history, event: finished });

    assert.deepEqual(target.writes, [
      { event: text('ab') },
      { event: usage },
      { event: text('c') },
      { history },
      { event: text('d') },
      { history, event: finished },
    ]);
  });

  test('fails the write that flushes a held run when the session refuses it', async () => {
    const target = fakeSession();
    const { clock } = manualClock();
    const log = coalesced(target.session, { clock });
    const refused = new Error('disk full');
    target.refuseWhen((entry) =>
      streamDelta(entry.event) === undefined ? undefined : refused,
    );

    await log.record({ event: text('a') });
    await assert.rejects(log.record({ history }), refused);
  });

  test('hands a window’s failed write to the next write', async () => {
    const target = fakeSession();
    const time = manualClock();
    const log = coalesced(target.session, { clock: time.clock });
    const refused = new Error('disk full');
    target.refuseWhen(() => refused);

    await log.record({ event: text('a') });
    await time.advance(250);
    target.refuseWhen(() => undefined);

    await assert.rejects(log.record({ event: text('b') }), refused);
    // Owed once: the write after it goes through.
    await log.record({ history });
    assert.deepEqual(target.writes, [{ history }]);
  });

  test('saves the history after a window’s failed write, then answers that failure', async () => {
    const target = fakeSession();
    const time = manualClock();
    const log = coalesced(target.session, { clock: time.clock });
    const refused = new Error('disk full');
    target.refuseWhen((entry) =>
      entry.history === undefined ? refused : undefined,
    );

    await log.record({ event: text('a') });
    await time.advance(250);

    // The run stops: its last write saves the history it ends with.
    await assert.rejects(log.record({ history }), refused);
    assert.deepEqual(target.writes, [{ history }]);
  });
});

/** A small seeded generator, so a failure reproduces. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const pieces = ['', ' ', '\n\n', 'a', 'word ', 'é', '{"k":', '1}'];

/** One random delta among every kind, blank and empty ones included. */
const anyDelta = (next: () => number): StreamDelta => {
  const piece = pieces[Math.floor(next() * pieces.length)] ?? '';
  const kind = Math.floor(next() * 4);
  if (kind === 0) return { type: 'text.delta', delta: piece };
  if (kind === 1) return { type: 'reasoning.delta', delta: piece };
  if (kind === 2) return { type: 'refusal.delta', delta: piece };
  const index = Math.floor(next() * 2);
  return {
    type: 'tool_call.delta',
    index,
    id: `call-${index}`,
    argumentsDelta: piece,
  };
};

const textOf = (delta: StreamDelta): string =>
  delta.type === 'tool_call.delta' ? (delta.argumentsDelta ?? '') : delta.delta;

/** The text of every delta of one kind (and tool call), in order. */
const byKind = (deltas: readonly StreamDelta[]): Map<string, string> => {
  const kinds = new Map<string, string>();
  for (const delta of deltas) {
    if (textOf(delta) === '') continue;
    const key =
      delta.type === 'tool_call.delta'
        ? `${delta.type}:${delta.index}`
        : delta.type;
    kinds.set(key, `${kinds.get(key) ?? ''}${textOf(delta)}`);
  }
  return kinds;
};

describe('coalesced deltas over seeded streams', () => {
  test('keep every piece of text, in order, with no two neighbours left that could merge', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const next = random(seed * 7919);
      const input = Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
        anyDelta(next),
      );
      const stored = (await writeAll(input))
        .events()
        .map((event) => streamDelta(event))
        .filter((delta) => delta !== undefined);

      assert.deepEqual(byKind(stored), byKind(input), `seed ${seed}: text`);
      assert.ok(
        stored.every((delta) => !isEmptyDelta(delta)),
        `seed ${seed}: no empty delta is written`,
      );
      for (let index = 1; index < stored.length; index += 1)
        assert.equal(
          mergeDeltas(
            stored[index - 1] as StreamDelta,
            stored[index] as StreamDelta,
          ),
          undefined,
          `seed ${seed}: deltas ${index - 1} and ${index} could merge`,
        );
    }
  });
});
