import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import { mergeDeltas, type StreamDelta, streamDelta } from 'runtime/contracts';

import { deltaWindow } from '../src/host/deltas.js';
import {
  bundleServices,
  fakeThreadState,
  runPrompt,
} from './support/harness.js';

/*
 * What a run's streamed tokens leave in the Thread's log: the deltas the
 * provider streamed, coalesced, with every other event where the run wrote
 * it. The provider is the boundary a case scripts; the session (one write is
 * one commit and one publication in the runtime) is the observation.
 */

type Yielded = Record<string, unknown> & { readonly type: string };

/** A provider that streams `deltas` in one turn, then finishes it. */
const streaming = (
  deltas: readonly Yielded[],
  after: (index: number) => void = () => undefined,
) => ({
  metadata: { id: 'provider', name: 'provider' },
  stream: async function* (request: ProviderRequest) {
    yield {
      type: 'response.started' as const,
      provider: { id: 'provider', name: 'provider' },
      model: request.model,
    };
    for (const [index, delta] of deltas.entries()) {
      yield delta;
      after(index);
    }
    yield {
      type: 'response.finished' as const,
      finish: { text: 'done', finishReason: 'stop' as const, toolCalls: [] },
    };
  },
});

const setup = (provider: object) => {
  const state = fakeThreadState();
  const services = bundleServices({ provider });
  return {
    state,
    run: async (signal?: AbortSignal) => {
      await services.activate();
      return runPrompt(
        services,
        state,
        'prompt',
        signal === undefined ? {} : { signal },
      );
    },
    /** The deltas the log stores, in order. */
    deltas: () => state.events.flatMap(({ event }) => streamDelta(event) ?? []),
    /** The type of every stored event that is not a delta, in order. */
    others: () =>
      state.events.flatMap(({ event }) =>
        streamDelta(event) === undefined ? [(event as Yielded).type] : [],
      ),
  };
};

const text = (delta: string) => ({ type: 'text.delta', delta });
const reasoning = (delta: string) => ({ type: 'reasoning.delta', delta });

const textOf = (deltas: readonly StreamDelta[], type: string): string =>
  deltas
    .flatMap((delta) =>
      delta.type === type && delta.type !== 'tool_call.delta'
        ? [delta.delta]
        : [],
    )
    .join('');

/** Neighbouring stored deltas that the shared rule would have merged. */
const mergeable = (deltas: readonly StreamDelta[]): number =>
  deltas.filter(
    (delta, index) =>
      index > 0 &&
      mergeDeltas(deltas[index - 1] as StreamDelta, delta) !== undefined,
  ).length;

void test('stores a streamed turn as one delta event per run of tokens, around the same other events', async () => {
  const tokens = [
    ...Array.from({ length: 40 }, (_value, index) => reasoning(`r${index} `)),
    text(''),
    ...Array.from({ length: 60 }, (_value, index) => text(`t${index} `)),
  ];
  const harness = setup(streaming(tokens));
  const started = performance.now();

  await harness.run();

  const elapsed = performance.now() - started;
  // Only a window that ended mid-run splits a run of tokens.
  const windows = Math.floor(elapsed / deltaWindow);
  const deltas = harness.deltas();
  assert.ok(
    deltas.length <= 2 + windows,
    `${deltas.length} delta events for 2 runs of tokens in ${elapsed.toFixed(0)} ms`,
  );
  assert.ok(mergeable(deltas) <= windows);
  assert.equal(
    textOf(deltas, 'reasoning.delta'),
    tokens
      .slice(0, 40)
      .map(({ delta }) => delta)
      .join(''),
  );
  assert.equal(
    textOf(deltas, 'text.delta'),
    tokens
      .slice(41)
      .map(({ delta }) => delta)
      .join(''),
  );
  assert.deepEqual(harness.others(), [
    'agent.started',
    'response.started',
    'response.finished',
    'agent.finished',
  ]);
  // Every delta sits between the response's start and its finish.
  const types = harness.state.events.map(
    ({ event }) => (event as Yielded).type,
  );
  const first = types.findIndex((type) => type.endsWith('.delta'));
  const last =
    types.length -
    1 -
    [...types].reverse().findIndex((type) => type.endsWith('.delta'));
  assert.ok(first > types.indexOf('response.started'));
  assert.ok(last < types.indexOf('response.finished'));
});

void test('writes the deltas an aborted run still held before the history it saves', async () => {
  const controller = new AbortController();
  const harness = setup(
    streaming([text('Hello'), text(', '), text('world')], (index) => {
      if (index === 1) controller.abort();
    }),
  );

  await assert.rejects(harness.run(controller.signal), { name: 'AbortError' });

  // The run took the first two tokens in before the abort ended it.
  assert.equal(textOf(harness.deltas(), 'text.delta'), 'Hello, ');
  const writes = harness.state.writes;
  const delta = writes
    .map(({ event }) => streamDelta(event) !== undefined)
    .lastIndexOf(true);
  assert.ok(delta >= 0);
  assert.ok(
    writes.slice(delta + 1).some(({ history }) => history !== undefined),
    'the history is saved after the held deltas',
  );
});

void test('writes the deltas a failing run still held before the history it saves', async () => {
  const harness = setup({
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* () {
      yield text('partial ');
      yield text('answer');
      throw new Error('provider failed');
    },
  });

  await assert.rejects(harness.run(), { message: 'provider failed' });

  assert.equal(textOf(harness.deltas(), 'text.delta'), 'partial answer');
  assert.ok(harness.state.writes.at(-1)?.history !== undefined);
});
