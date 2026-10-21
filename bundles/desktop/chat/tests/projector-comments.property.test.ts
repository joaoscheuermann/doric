import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  emptyProjection,
  type Projection,
  projectEvents,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

/*
 * A send flushes the comments of the composer's stack before the prompt they
 * annotate, and a reader can add more while the agent works or after it
 * finished. Wherever a comment of a prompt lands in the log — before its
 * prompt, between that prompt's turns or another prompt's, after the prompt
 * finished, in the same batch or a later one — it is the margin of that
 * prompt's user turn, in the order the log wrote it, and pinned by its place
 * there. A prompt whose words are not drawn yet holds its comments until they
 * are. These are the observations the cases below state, read from the whole
 * log, from the log read in batches split anywhere, and across a rewind.
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

type Step = {
  readonly promptId: string;
  readonly event: Readonly<Record<string, unknown> & { type: string }>;
};

/**
 * How a prompt's words come to be drawn: at acceptance (a log written before
 * the queue flag), at dispatch, where a running prompt takes in a steer, after
 * a queue receipt, or not yet at all.
 */
const modes = ['legacy', 'modern', 'steer', 'queued', 'unstarted'] as const;

/** One prompt's own events, in the order a run writes them. */
const promptSteps = (next: Draw, promptId: string): Step[] => {
  const mode = pick(next, modes);
  const text = `Question ${promptId}`;
  const source = { kind: 'user' };
  const steps: Step['event'][] = [];
  if (mode === 'legacy') steps.push({ type: 'prompt.accepted', text, source });
  else if (mode === 'steer')
    steps.push(
      {
        type: 'prompt.accepted',
        text,
        source,
        queued: false,
        steer: 'running',
      },
      { type: 'prompt.steered' },
    );
  else if (mode === 'queued')
    steps.push(
      { type: 'prompt.accepted', text, source, queued: true },
      { type: 'prompt.queued' },
      { type: 'prompt.started' },
    );
  else {
    steps.push({ type: 'prompt.accepted', text, source, queued: false });
    if (mode === 'modern') steps.push({ type: 'prompt.started' });
  }
  if (mode === 'unstarted') return steps.map((event) => ({ promptId, event }));

  const work = Math.floor(next() * 6);
  for (let index = 0; index < work; index += 1) {
    const kind = next();
    if (kind < 0.3) steps.push({ type: 'text.delta', delta: 'answer ' });
    else if (kind < 0.55)
      steps.push({ type: 'reasoning.delta', delta: 'thinking ' });
    else if (kind < 0.8) {
      const call = {
        id: `${promptId}-call-${index}`,
        name: 'read',
        payload: {},
      };
      steps.push(
        { type: 'tool.started', call },
        { type: 'tool.finished', call, record: { output: 'ok' } },
      );
    } else
      steps.push(
        { type: 'compaction.started', trigger: 'automatic' },
        { type: 'compaction.finished', summary: 'earlier work' },
      );
  }
  if (next() < 0.7)
    steps.push({ type: 'prompt.finished', status: 'completed', text: 'done' });
  return steps.map((event) => ({ promptId, event }));
};

/** Several prompts' events, interleaved the way concurrent work writes them. */
const interleaved = (next: Draw, promptIds: readonly string[]): Step[] => {
  const scripts = promptIds.map((promptId) => promptSteps(next, promptId));
  const steps: Step[] = [];
  for (;;) {
    const open = scripts.filter((script) => script.length > 0);
    if (open.length === 0) return steps;
    const step = pick(next, open).shift();
    if (step !== undefined) steps.push(step);
  }
};

/**
 * Comments of the given prompts, each written at a random place in the log:
 * before its prompt, among any prompt's turns, or after them all. One prompt
 * id may name no prompt at all, as a flush whose send never landed would.
 */
const withComments = (
  next: Draw,
  steps: Step[],
  promptIds: readonly string[],
  tag: string,
): Step[] => {
  const result = [...steps];
  let count = 0;
  for (const promptId of promptIds) {
    const comments = Math.floor(next() * 4);
    for (let index = 0; index < comments; index += 1) {
      const at = Math.floor(next() * (result.length + 1));
      result.splice(at, 0, {
        promptId,
        event: {
          type: 'comments.added/v1',
          commentId: `${tag}-comment-${count}`,
          author: 'user',
          text: `note ${count}`,
          target: { kind: 'message', id: 'm1' },
        },
      });
      count += 1;
    }
  }
  return result;
};

const sequenced = (steps: readonly Step[], from: number): ThreadEvent[] =>
  steps.map(({ promptId, event }, index) => ({
    projectId: 'project',
    threadId: 'thread',
    promptId,
    sequence: from + index,
    type: event.type,
    event,
    createdAt: new Date(
      Date.UTC(2026, 0, 1) + (from + index) * 1000,
    ).toISOString(),
  }));

/** A log, and the events of it a reader still has once a rewind discarded some. */
type Log = {
  readonly events: readonly ThreadEvent[];
  readonly surviving: readonly ThreadEvent[];
};

/**
 * A log of a few prompts and their comments. Some seeds rewind it partway —
 * the marker discards everything after the sequence it names — and go on with
 * new prompts, while comments keep arriving for prompts on both sides.
 */
const generatedLog = (next: Draw): Log => {
  const before = ['a', 'b', 'c', 'd'].slice(0, 1 + Math.floor(next() * 4));
  const ghost = next() < 0.3 ? ['ghost'] : [];
  const first = sequenced(
    withComments(next, interleaved(next, before), [...before, ...ghost], 'x'),
    1,
  );
  if (next() < 0.6) return { events: first, surviving: first };

  const afterSequence = Math.floor(next() * (first.length + 1));
  const marker = first.length + 1;
  const [truncated] = sequenced(
    [
      {
        promptId: 'rewind',
        event: { type: 'history.truncated', afterSequence },
      },
    ],
    marker,
  );
  const later = ['e', 'f'].slice(0, 1 + Math.floor(next() * 2));
  const rest = sequenced(
    withComments(next, interleaved(next, later), [...before, ...later], 'y'),
    marker + 1,
  );
  const kept = first.filter((item) => item.sequence <= afterSequence);
  return {
    events: [
      ...first,
      ...(truncated === undefined ? [] : [truncated]),
      ...rest,
    ],
    surviving: [...kept, ...rest],
  };
};

/**
 * What the surviving log says of each prompt: the comments it wrote for the
 * prompt in log order, and whether the prompt's words are drawn — at
 * acceptance in a log without the queue flag, otherwise once the prompt is
 * dispatched or a running prompt takes it in as a steer.
 */
const expected = (surviving: readonly ThreadEvent[]) => {
  const comments = new Map<string, string[]>();
  const accepted = new Map<string, boolean>();
  const shown = new Set<string>();
  for (const item of surviving) {
    const event = item.event as Record<string, unknown>;
    if (event.type === 'comments.added/v1') {
      const held = comments.get(item.promptId) ?? [];
      held.push(String(event.commentId));
      comments.set(item.promptId, held);
      continue;
    }
    if (event.type === 'prompt.accepted' && !accepted.has(item.promptId))
      accepted.set(item.promptId, typeof event.queued !== 'boolean');
    const legacy = accepted.get(item.promptId);
    if (legacy === undefined) continue;
    if (
      event.type === 'prompt.started' ||
      event.type === 'prompt.steered' ||
      (event.type === 'prompt.accepted' && legacy)
    )
      shown.add(item.promptId);
  }
  return { comments, shown };
};

/** The ids of the comments each user turn wears, by prompt. */
const drawnComments = (projection: Projection): Map<string, string[][]> => {
  const drawn = new Map<string, string[][]>();
  for (const turn of projection.turns) {
    if (turn.type !== 'user') continue;
    const held = drawn.get(turn.promptId) ?? [];
    held.push(turn.comments.map((comment) => comment.commentId));
    drawn.set(turn.promptId, held);
  }
  return drawn;
};

const assertMargins = (
  projection: Projection,
  log: Log,
  label: string,
): void => {
  const { comments, shown } = expected(log.surviving);
  const drawn = drawnComments(projection);
  const promptIds = new Set([...comments.keys(), ...shown, ...drawn.keys()]);
  for (const promptId of promptIds) {
    const written = comments.get(promptId) ?? [];
    if (shown.has(promptId)) {
      assert.deepEqual(
        drawn.get(promptId),
        [written],
        `${label}: the user turn of ${promptId} wears its comments in log order`,
      );
    } else {
      assert.equal(
        drawn.get(promptId),
        undefined,
        `${label}: ${promptId} draws no user turn yet`,
      );
      assert.deepEqual(
        (projection.comments.get(promptId) ?? []).map(
          (comment) => comment.commentId,
        ),
        written,
        `${label}: ${promptId} holds its comments until its words are drawn`,
      );
    }
    written.forEach((commentId, index) => {
      assert.equal(
        projection.threads.get(commentId)?.messages[0]?.pin,
        index + 1,
        `${label}: ${commentId} is pinned by its place in ${promptId}'s margin`,
      );
    });
  }
};

/** The log read in batches of random size, as a live subscription reads it. */
const inBatches = (next: Draw, events: readonly ThreadEvent[]): Projection => {
  let projection = emptyProjection;
  let index = 0;
  while (index < events.length) {
    const size = 1 + Math.floor(next() * 6);
    projection = projectEvents(projection, events.slice(index, index + size));
    index += size;
  }
  return projection;
};

describe('the comments of a prompt, wherever the log writes them', () => {
  test('join its user turn in log order from the whole log, held until the turn is drawn', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const log = generatedLog(random(seed * 6151));
      assertMargins(
        projectEvents(emptyProjection, log.events),
        log,
        `seed ${seed}`,
      );
    }
  });

  test('join it the same way when the log is read in batches split anywhere', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed * 12_289);
      const log = generatedLog(next);
      const whole = projectEvents(emptyProjection, log.events);
      const batched = inBatches(next, log.events);
      assertMargins(batched, log, `seed ${seed} in batches`);
      assert.deepEqual(batched.turns, whole.turns, `seed ${seed}: turns`);
    }
  });

  test('join a turn drawn before them, after another prompt began and after the prompt finished', () => {
    const log = sequenced(
      [
        {
          promptId: 'one',
          event: {
            type: 'comments.added/v1',
            commentId: 'flushed',
            author: 'user',
            text: 'before the prompt',
            target: { kind: 'message', id: 'm1' },
          },
        },
        {
          promptId: 'one',
          event: {
            type: 'prompt.accepted',
            text: 'Question',
            source: { kind: 'user' },
            queued: false,
          },
        },
        { promptId: 'one', event: { type: 'prompt.started' } },
        { promptId: 'one', event: { type: 'text.delta', delta: 'On it' } },
        {
          promptId: 'two',
          event: {
            type: 'prompt.accepted',
            text: 'Next',
            source: { kind: 'user' },
          },
        },
        {
          promptId: 'one',
          event: {
            type: 'comments.added/v1',
            commentId: 'between',
            author: 'user',
            text: 'while two began',
            target: { kind: 'message', id: 'm1' },
          },
        },
        {
          promptId: 'one',
          event: { type: 'prompt.finished', status: 'completed', text: 'ok' },
        },
        {
          promptId: 'one',
          event: {
            type: 'comments.added/v1',
            commentId: 'after',
            author: 'user',
            text: 'once it finished',
            target: { kind: 'message', id: 'm1' },
          },
        },
      ],
      1,
    );

    let live = emptyProjection;
    for (const item of log) live = projectEvents(live, [item]);

    for (const projection of [projectEvents(emptyProjection, log), live]) {
      const one = projection.turns.find(
        (turn) => turn.type === 'user' && turn.promptId === 'one',
      );
      const two = projection.turns.find(
        (turn) => turn.type === 'user' && turn.promptId === 'two',
      );
      assert.deepEqual(
        one?.type === 'user'
          ? one.comments.map((comment) => comment.commentId)
          : undefined,
        ['flushed', 'between', 'after'],
      );
      assert.deepEqual(two?.type === 'user' ? two.comments : undefined, []);
      assert.equal(projection.threads.get('after')?.messages[0]?.pin, 3);
    }
  });
});
