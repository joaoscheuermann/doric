// The turns a conversation draws (bundle isolation 5(a), `chat.views/v1`
// 1.2.0): with nothing registered, the projection's own turns; otherwise the
// drafts grouped with each tool's drawing, so a `standalone` tool stays out of
// the activity summary, and every input whose source has an input renderer
// carries that element.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { turnKey } from '../src/client/domain/conversation-sync.js';
import { drawnTurns } from '../src/client/domain/drawn-turns.js';
import {
  emptyProjection,
  projectEvents,
  type Turn,
  type UserTurn,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';
import type { ToolRendererSpec } from '../src/contracts/index.js';

const event = (
  sequence: number,
  promptId: string,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
});

const call = (
  id: string,
  name: string,
  payload: unknown = {},
): Readonly<Record<string, unknown>> => ({ id, name, index: 0, payload });

const ran = (
  sequence: number,
  id: string,
  name: string,
): readonly ThreadEvent[] => [
  event(sequence, 'one', { type: 'tool.started', call: call(id, name) }),
  event(sequence + 1, 'one', {
    type: 'tool.finished',
    call: call(id, name),
    record: { output: 'ok' },
  }),
];

const types = (turns: readonly Turn[]): readonly string[] =>
  turns.map((turn) => turn.type);

const tools = (
  ...specs: readonly ToolRendererSpec[]
): ReadonlyMap<string, ToolRendererSpec> =>
  new Map(specs.map((spec) => [spec.toolName, spec]));

const noTools: ReadonlyMap<string, ToolRendererSpec> = new Map();
const noInputs: ReadonlyMap<string, string> = new Map();

/** reasoning, terminal, probe_tool, reasoning, terminal: one prompt's burst. */
const burst: readonly ThreadEvent[] = [
  event(1, 'one', { type: 'reasoning.delta', delta: 'inspect' }),
  ...ran(2, 'c1', 'terminal'),
  ...ran(4, 'c2', 'probe_tool'),
  event(6, 'one', { type: 'reasoning.delta', delta: 'verify' }),
  ...ran(7, 'c3', 'terminal'),
];

const settled = projectEvents(emptyProjection, [
  ...burst,
  event(9, 'one', {
    type: 'prompt.finished',
    status: 'completed',
    text: '',
    source: { kind: 'user' },
  }),
]);

const prompt = (
  promptId: string,
  sequence: number,
  text: string,
  source: Readonly<Record<string, unknown>>,
): ThreadEvent =>
  event(sequence, promptId, { type: 'prompt.accepted', text, source });

const userTurn = (turns: readonly Turn[]): UserTurn => {
  const turn = turns.find((each): each is UserTurn => each.type === 'user');
  assert.ok(turn, `no user turn in ${types(turns).join(', ')}`);
  return turn;
};

describe('drawnTurns', () => {
  test('with nothing registered, answers the projection’s own turns', () => {
    assert.equal(drawnTurns(settled, noTools, noInputs), settled.turns);
  });

  test('a standalone tool in a settled burst is its own turn, between activity turns, in log order', () => {
    // Without the registration the whole burst is one summary.
    assert.deepEqual(types(settled.turns), ['activity']);

    const turns = drawnTurns(
      settled,
      tools({ toolName: 'probe_tool', standalone: true }),
      noInputs,
    );
    assert.deepEqual(types(turns), ['activity', 'tool_call', 'activity']);
    const middle = turns[1];
    assert.equal(middle?.type === 'tool_call' ? middle.name : '', 'probe_tool');
    const first = turns[0];
    const last = turns[2];
    assert.deepEqual(
      first?.type === 'activity'
        ? first.items.map((item) => item.kind)
        : undefined,
      ['thinking', 'tool'],
    );
    assert.deepEqual(
      last?.type === 'activity'
        ? last.items.map((item) => item.kind)
        : undefined,
      ['thinking', 'tool'],
    );
  });

  test('a grouped registration leaves the summary whole', () => {
    const turns = drawnTurns(
      settled,
      tools({ toolName: 'probe_tool', elementTag: 'probe-tool-call' }),
      noInputs,
    );
    assert.deepEqual(types(turns), ['activity']);
    const only = turns[0];
    assert.equal(only?.type === 'activity' ? only.tools : 0, 3);
  });

  // 5(b) change 3: `thread-spawn` was the chat's last built-in standalone
  // name; unregistered, it folds like any other, so the projection's own turns
  // and the registered drawing agree on it (T5.4).
  test('an unregistered thread-spawn folds into the summary, with or without other registrations', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'inspect' }),
      ...ran(2, 'c1', 'thread-spawn'),
      ...ran(4, 'c2', 'terminal'),
      event(6, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: { kind: 'user' },
      }),
    ]);
    assert.deepEqual(types(projection.turns), ['activity']);
    const turns = drawnTurns(
      projection,
      tools({ toolName: 'probe_tool', standalone: true }),
      noInputs,
    );
    assert.deepEqual(types(turns), ['activity']);
  });

  test('a registration that takes a standalone name back into the group folds it (O4)', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'inspect' }),
      ...ran(2, 'c1', 'thread-spawn'),
      ...ran(4, 'c2', 'terminal'),
      event(6, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: { kind: 'user' },
      }),
    ]);
    const standalone = drawnTurns(
      projection,
      tools({ toolName: 'thread-spawn', standalone: true }),
      noInputs,
    );
    assert.deepEqual(types(standalone), ['thinking', 'tool_call', 'tool_call']);
    const grouped = drawnTurns(
      projection,
      tools({ toolName: 'thread-spawn' }),
      noInputs,
    );
    assert.deepEqual(types(grouped), ['activity']);
  });

  test('the live burst keeps every step on its own', () => {
    const live = projectEvents(emptyProjection, burst);
    const turns = drawnTurns(
      live,
      tools({ toolName: 'probe_tool', standalone: true }),
      noInputs,
    );
    assert.deepEqual(types(turns), [
      'thinking',
      'tool_call',
      'tool_call',
      'thinking',
      'tool_call',
    ]);
  });

  test('a terminal input carries element exactly while terminal is registered, and its turn key starts with input: then', () => {
    const text = 'output without the host header';
    const projection = projectEvents(emptyProjection, [
      prompt('one', 1, text, { kind: 'terminal', terminalId: 'terminal-3f8a' }),
    ]);

    const drawn = userTurn(
      drawnTurns(projection, noTools, new Map([['terminal', 'probe-input']])),
    );
    assert.equal(drawn.element, 'probe-input');
    assert.equal(drawn.input?.source.kind, 'terminal');
    assert.equal(drawn.input?.text, text);
    assert.ok(turnKey(drawn).startsWith('input:'), turnKey(drawn));

    const plain = userTurn(
      drawnTurns(projection, noTools, new Map([['parent', 'probe-input']])),
    );
    assert.equal(plain.element, undefined);
    assert.ok(!turnKey(plain).startsWith('input:'), turnKey(plain));
    assert.ok(turnKey(plain).startsWith('user:'), turnKey(plain));
  });

  test('a bundle instruction carries element only for its own bundle:<id>', () => {
    const projection = projectEvents(emptyProjection, [
      prompt('one', 1, '# Probe instruction', {
        kind: 'bundle',
        bundleId: 'probe',
        reason: 'probe-reason',
      }),
    ]);
    assert.equal(
      userTurn(
        drawnTurns(
          projection,
          noTools,
          new Map([['bundle:probe', 'probe-input']]),
        ),
      ).element,
      'probe-input',
    );
    assert.equal(
      userTurn(
        drawnTurns(
          projection,
          noTools,
          new Map([['bundle:other', 'probe-input']]),
        ),
      ).element,
      undefined,
    );
  });

  test('a user prompt never carries element', () => {
    const projection = projectEvents(emptyProjection, [
      prompt('one', 1, 'Hi', { kind: 'user' }),
    ]);
    const turn = userTurn(
      drawnTurns(
        projection,
        noTools,
        new Map([
          ['user', 'probe-input'],
          ['terminal', 'probe-input'],
          ['bundle:probe', 'probe-input'],
        ]),
      ),
    );
    assert.equal(turn.element, undefined);
    assert.equal(turn.input, undefined);
    assert.ok(turnKey(turn).startsWith('user:'), turnKey(turn));
  });
});
