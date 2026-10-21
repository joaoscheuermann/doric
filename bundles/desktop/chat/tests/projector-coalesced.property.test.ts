import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isEmptyDelta,
  mergeDeltas,
  type StreamDelta,
  streamDelta,
} from 'runtime/contracts';

import {
  emptyProjection,
  type Projection,
  projectEvents,
  type Turn,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

/*
 * The default executor writes a run's streamed deltas coalesced
 * (`runtime/contracts` `mergeDeltas`, the rule this test shares with it), so
 * the transcript a coalesced log projects must be the one the same log
 * projects token by token: the same turns, each opened by the same event
 * position and last written at the same time. A coalesced event is modelled
 * at the position of its first token and the time of its last, which is where
 * the writer puts it; windows that end mid-run are modelled by random splits.
 */

/** A small seeded generator, so a failure reproduces. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

type Draw = () => number;

const pick = <T>(next: Draw, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)] as T;

const pieces = ['', ' ', '\n\n', '\n', 'Hello', ' world', 'é', '.'];

/** One prompt's events, as a run writes them token by token. */
const promptEvents = (
  next: Draw,
  index: number,
): { readonly promptId: string; readonly event: Record<string, unknown> }[] => {
  const promptId = `prompt-${index}`;
  const events: Record<string, unknown>[] = [
    {
      type: 'prompt.accepted',
      text: `Question ${index}`,
      source: { kind: 'user' },
    },
    { type: 'prompt.started' },
    { type: 'agent.started', model: 'model', input: `Question ${index}` },
  ];
  let calls = 0;
  const steps = Math.floor(next() * 60);
  for (let step = 0; step < steps; step += 1) {
    const kind = next();
    if (kind < 0.35)
      events.push({ type: 'text.delta', delta: pick(next, pieces) });
    else if (kind < 0.6)
      events.push({ type: 'reasoning.delta', delta: pick(next, pieces) });
    else if (kind < 0.7)
      events.push({ type: 'refusal.delta', delta: pick(next, pieces) });
    else if (kind < 0.82)
      events.push({
        type: 'tool_call.delta',
        index: calls,
        id: `call-${index}-${calls}`,
        name: 'edit',
        argumentsDelta: pick(next, ['', '{"a":', '1}']),
      });
    else if (kind < 0.92) {
      const call = { id: `call-${index}-${calls}`, name: 'edit', payload: {} };
      calls += 1;
      events.push({ type: 'tool.started', call });
      events.push({
        type: next() < 0.8 ? 'tool.finished' : 'tool.failed',
        call,
        record: { output: 'ok' },
        error: { message: 'failed' },
      });
    } else events.push({ type: 'usage', usage: { inputTokens: 1 } });
  }
  const ending = next();
  if (ending < 0.7) {
    const text = 'The answer.';
    events.push({ type: 'agent.finished', response: { text } });
    events.push({
      type: 'prompt.finished',
      status: 'completed',
      text,
      source: { kind: 'user' },
    });
  } else if (ending < 0.85)
    events.push({
      type: 'prompt.finished',
      status: 'failed',
      text: '',
      source: { kind: 'user' },
    });
  // Otherwise the prompt is still streaming when the log ends.
  return events.map((event) => ({ promptId, event }));
};

/** A Thread log written token by token: sequences 1..n, one ms apart. */
const tokenLog = (next: Draw): ThreadEvent[] =>
  Array.from({ length: 1 + Math.floor(next() * 4) }, (_value, index) =>
    promptEvents(next, index),
  )
    .flat()
    .map(({ promptId, event }, index) => ({
      projectId: 'project',
      threadId: 'thread',
      promptId,
      sequence: index + 1,
      type: String(event.type),
      event,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
    }));

/**
 * The same log as the writer coalesces it: empty deltas dropped, and a delta
 * merged into the one before it when the shared rule allows and no window
 * ended in between. A merged event keeps the first token's place and takes
 * the last token's time.
 */
const coalescedLog = (
  log: readonly ThreadEvent[],
  next: Draw,
): ThreadEvent[] => {
  const out: ThreadEvent[] = [];
  /** Whether the last event out is a delta still open to merging. */
  let open = false;
  for (const item of log) {
    const delta = streamDelta(item.event);
    if (delta === undefined) {
      out.push(item);
      open = false;
      continue;
    }
    if (isEmptyDelta(delta)) continue;
    const last = out.at(-1);
    const windowEnded = next() < 0.15;
    const merged =
      open &&
      !windowEnded &&
      last !== undefined &&
      last.promptId === item.promptId
        ? mergeDeltas(streamDelta(last.event) as StreamDelta, delta)
        : undefined;
    if (last !== undefined && merged !== undefined)
      out[out.length - 1] = {
        ...last,
        event: merged,
        createdAt: item.createdAt,
      };
    else out.push(item);
    open = true;
  }
  return out;
};

const project = (log: readonly ThreadEvent[]): Projection =>
  projectEvents(emptyProjection, log);

/** A turn without the events it was read from. */
const drawn = (turn: Turn): Omit<Turn, 'events'> => {
  const { events: _events, ...rest } = turn;
  return rest;
};

/** The log split into batches at random, as a live watch delivers it. */
const batches = (log: readonly ThreadEvent[], next: Draw): ThreadEvent[][] => {
  const out: ThreadEvent[][] = [];
  let at = 0;
  while (at < log.length) {
    const size = 1 + Math.floor(next() * 6);
    out.push(log.slice(at, at + size));
    at += size;
  }
  return out;
};

describe('projection of a coalesced log', () => {
  test('draws the same turns as the token log, each opened at the same place and last written at the same time', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed * 7919);
      const tokens = tokenLog(next);
      const coalesced = coalescedLog(tokens, next);
      const expected = project(tokens).turns;
      const actual = project(coalesced).turns;

      assert.deepEqual(
        actual.map(drawn),
        expected.map(drawn),
        `seed ${seed}: turns`,
      );
      assert.deepEqual(
        actual.map((turn) => turn.events[0]?.sequence),
        expected.map((turn) => turn.events[0]?.sequence),
        `seed ${seed}: the event each turn opens with`,
      );
      assert.deepEqual(
        actual.map((turn) => turn.events.at(-1)?.createdAt),
        expected.map((turn) => turn.events.at(-1)?.createdAt),
        `seed ${seed}: the time each turn was last written`,
      );
    }
  });

  test('reads the same turns live, in batches split anywhere, as from the whole log', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed * 104_729);
      const coalesced = coalescedLog(tokenLog(next), next);
      const live = batches(coalesced, next).reduce(
        (projection, batch) => projectEvents(projection, batch),
        emptyProjection,
      );

      assert.deepEqual(
        live.turns,
        project(coalesced).turns,
        `seed ${seed}: live batches`,
      );
    }
  });
});
