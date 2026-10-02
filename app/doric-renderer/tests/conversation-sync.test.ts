import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AGENT_NAME,
  type AuthorDraft,
  READER_NAME,
} from '../src/domain/conversation-authors';
import {
  type SyncCreate,
  type SyncPlan,
  syncPlan,
} from '../src/domain/conversation-sync';
import type {
  ActivityTurn,
  AgentTurn,
  ThinkingTurn,
  ToolTurn,
  Turn,
  UserTurn,
} from '../src/domain/projector';
import type { ThreadEvent } from '../src/domain/workspace';

const event = (sequence: number): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId: 'prompt',
  sequence,
  type: 'text.delta',
  event: { type: 'text.delta', delta: '' },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const user = (promptId: string, sequence: number): UserTurn => ({
  type: 'user',
  promptId,
  events: [event(sequence)],
  text: 'question',
  accepted: true,
  awaiting: false,
});

const agent = (
  promptId: string,
  sequence: number,
  text = 'answer',
): AgentTurn => ({
  type: 'agent',
  promptId,
  events: [event(sequence)],
  text,
  status: 'completed',
});

const thinking = (promptId: string, sequence: number): ThinkingTurn => ({
  type: 'thinking',
  promptId,
  events: [event(sequence)],
  text: 'thought',
  streaming: false,
});

const tool = (promptId: string, sequence: number): ToolTurn => ({
  type: 'tool_call',
  promptId,
  events: [event(sequence)],
  callId: `call-${sequence}`,
  name: 'read_file',
  args: '{}',
  status: 'finished',
  result: 'ok',
});

const activity = (promptId: string, sequence: number): ActivityTurn => ({
  type: 'activity',
  promptId,
  events: [event(sequence)],
  thoughts: 1,
  tools: 1,
  items: [{ kind: 'thinking', text: 'thought' }],
});

/** The key every turn's block is held under, read off a plan. */
const keysFor = (turns: readonly Turn[]): Map<Turn, string> => {
  const plan = syncPlan([], turns, Number.MAX_SAFE_INTEGER);
  return new Map(
    plan.steps.map((step): [Turn, string] => [step.turn, step.key]),
  );
};

/** One turn's key, in the map a `keysFor` read. */
const keyOf = (keys: Map<Turn, string>, turn: Turn): string => {
  const key = keys.get(turn);
  assert.ok(key !== undefined, 'the turn must have a key');
  return key;
};

/** Where a created block lands in the transcript, as the plan states it. */
const placeOf = (line: readonly string[], step: SyncCreate): number => {
  if (step.after !== null) {
    const index = line.indexOf(step.after);
    assert.notEqual(index, -1, 'the unit a new block follows must stand');
    return index + 1;
  }
  if (step.before !== null) {
    const index = line.indexOf(step.before);
    assert.notEqual(index, -1, 'the unit a new block precedes must stand');
    return index;
  }
  return 0;
};

/** Applies one plan's steps to the keys the editor holds, in transcript order. */
const apply = (line: readonly string[], plan: SyncPlan): string[] => {
  const out = [...line];
  for (const key of plan.removals) {
    const index = out.indexOf(key);
    if (index >= 0) out.splice(index, 1);
  }
  for (const step of plan.steps) {
    if (step.kind !== 'create') continue;
    out.splice(placeOf(out, step), 0, step.key);
  }
  return out;
};

/** Fills the editor with plan after plan, as the sync does across frames. */
const fill = (turns: readonly Turn[], creates: number): string[] => {
  let line: string[] = [];
  for (let pass = 0; pass <= turns.length; pass += 1) {
    const plan = syncPlan(line, turns, creates);
    assert.ok(
      plan.steps.filter((step) => step.kind === 'create').length <= creates,
      'a pass creates no more blocks than its budget',
    );
    line = apply(line, plan);
    if (!plan.pending) return line;
  }
  assert.fail('the fills never ran out of pending turns');
};

describe('bringing the blocks in step with the turns', () => {
  test('creates the newest turns first when the transcript arrives whole', () => {
    const first = user('one', 1);
    const run = agent('one', 2);
    const next = user('two', 3);
    const answer = agent('two', 4);
    const turns = [first, run, next, answer];

    const plan = syncPlan([], turns, 2);

    assert.deepEqual(
      plan.steps.map((step) => step.turn),
      [next, answer],
    );
    assert.deepEqual(
      plan.steps.map((step) => step.kind),
      ['create', 'create'],
    );
    assert.equal(plan.pending, true);
  });

  test('leaves the blocks standing where a one-shot sync would put them', () => {
    const turns = [
      user('one', 1),
      thinking('one', 2),
      tool('one', 3),
      agent('one', 4),
      user('two', 5),
      agent('two', 6),
    ];
    const keys = keysFor(turns);
    const whole = turns.map((turn) => keyOf(keys, turn));

    for (const creates of [1, 2, 3, 100]) {
      assert.deepEqual(fill(turns, creates), whole);
    }
  });

  test('refreshes a turn that keeps streaming while older turns are still being inserted', () => {
    const open = user('one', 1);
    const old = user('one', 2);
    const run = agent('one', 3, 'Hel');
    const keys = keysFor([open, old, run]);

    const grown = { ...run, text: 'Hello' };
    const prompt = user('two', 4);
    const turns = [open, old, grown, prompt];

    // The editor holds the newest two blocks of the earlier reading; the run it
    // grew and the prompt it just gained are what the chat now holds.
    const held = [keyOf(keys, old), keyOf(keys, run)];
    const plan = syncPlan(held, turns, 2);

    const updated = plan.steps.filter((step) => step.kind === 'update');
    assert.deepEqual(
      updated.map((step) => step.turn),
      [old, grown],
    );
    const created = plan.steps.filter((step) => step.kind === 'create');
    assert.deepEqual(
      created.map((step) => step.turn),
      [open, prompt],
    );
    assert.equal(plan.pending, false);

    // Nothing is dropped or duplicated on the way to the whole transcript.
    const keysNow = keysFor(turns);
    assert.deepEqual(
      fill(turns, 2),
      turns.map((turn) => keyOf(keysNow, turn)),
    );
  });

  test('replaces the blocks of a burst that closes while older turns are still being inserted', () => {
    const earlier = user('one', 0);
    const open = user('one', 1);
    const thought = thinking('one', 2);
    const call = tool('one', 3);
    const keys = keysFor([earlier, open, thought, call]);

    const burst = activity('one', 2);
    const answer = agent('one', 4);
    const turns = [earlier, open, burst, answer];

    const held = [keyOf(keys, open), keyOf(keys, thought), keyOf(keys, call)];
    const plan = syncPlan(held, turns, 2);

    // The steps the burst grouped are gone, its one block stands where they
    // stood — right after the prompt that opened the job — and the answer that
    // closed the burst lands with it, while the older turn waits its turn.
    assert.deepEqual(plan.removals, [keyOf(keys, thought), keyOf(keys, call)]);
    const created = plan.steps.filter((step) => step.kind === 'create');
    assert.deepEqual(
      created.map((step) => step.turn),
      [burst, answer],
    );
    assert.equal(
      created[0]?.kind === 'create' ? created[0].after : 'x',
      keyOf(keys, open),
    );
    assert.deepEqual(
      plan.steps.map((step) => step.turn),
      [open, burst, answer],
    );
    assert.equal(plan.pending, true);
  });

  test('removes the blocks of turns a rewind dropped while older turns are still being inserted', () => {
    const open = user('one', 1);
    const run = agent('one', 2);
    const keys = keysFor([open, run]);

    const earlier = user('one', 0);
    const prompt = user('two', 3);
    const turns = [earlier, open, prompt];

    const held = [keyOf(keys, open), keyOf(keys, run)];
    const plan = syncPlan(held, turns, 1);

    assert.deepEqual(plan.removals, [keyOf(keys, run)]);
    assert.deepEqual(
      plan.steps.map((step) => step.turn),
      [open, prompt],
    );
    assert.equal(plan.pending, true);
  });

  test("wears the reader's line on their prompt and the agent's on the last turn of its run", () => {
    const turns = [
      user('one', 1),
      thinking('one', 2),
      tool('one', 3),
      agent('one', 4),
      user('two', 5),
      agent('two', 6),
    ];

    const plan = syncPlan([], turns, Number.MAX_SAFE_INTEGER);

    const authors = plan.steps.map(
      (step): AuthorDraft | null | undefined => step.author,
    );
    assert.deepEqual(
      authors.map((author) => author?.role),
      ['user', undefined, undefined, 'agent', 'user', 'agent'],
    );
    assert.deepEqual(
      authors.map((author) => author?.name),
      [READER_NAME, undefined, undefined, AGENT_NAME, READER_NAME, AGENT_NAME],
    );
  });

  test("keeps a streaming turn's key stable while its text grows", () => {
    const run = agent('one', 1);
    const grown: AgentTurn = {
      ...run,
      events: [...run.events, event(2)],
      text: 'a longer answer',
    };

    const before = syncPlan([], [run], 1);
    const after = syncPlan([], [grown], 1);

    assert.equal(before.steps[0]?.key, after.steps[0]?.key);
  });
});
