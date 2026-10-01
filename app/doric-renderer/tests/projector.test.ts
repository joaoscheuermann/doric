import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ActivityTurn,
  emptyProjection,
  projectEvents,
  sandboxWrites,
  type ToolTurn,
  type Turn,
} from '../src/domain/projector';
import type { ThreadEvent } from '../src/domain/workspace';

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
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

const call = (
  id: string,
  name: string,
  payload: unknown = {},
): Readonly<Record<string, unknown>> => ({ id, name, index: 0, payload });

const types = (turns: readonly Turn[]): readonly string[] =>
  turns.map((turn) => turn.type);

const textOf = (turn: Turn | undefined): string | undefined =>
  turn === undefined || turn.type === 'tool_call' || turn.type === 'activity'
    ? undefined
    : turn.text;

const agentStatus = (turn: Turn | undefined): string | undefined =>
  turn?.type === 'agent' ? turn.status : undefined;

const toolOf = (turn: Turn | undefined): ToolTurn | undefined =>
  turn?.type === 'tool_call' ? turn : undefined;

const streamingOf = (turn: Turn | undefined): boolean | undefined =>
  turn?.type === 'thinking' ? turn.streaming : undefined;

const awaitingOf = (turn: Turn | undefined): boolean | undefined =>
  turn?.type === 'user' ? turn.awaiting : undefined;

const activityOf = (turn: Turn | undefined): ActivityTurn | undefined =>
  turn?.type === 'activity' ? turn : undefined;

describe('thread event projection', () => {
  test('opens a user turn for the human prompt', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['user']);
    assert.equal(projection.turns[0]?.promptId, 'one');
    assert.equal(textOf(projection.turns[0]), 'Hi');
    assert.equal(
      projection.turns[0]?.type === 'user' && projection.turns[0].accepted,
      true,
    );
    assert.equal(
      projection.turns[0]?.type === 'user'
        ? projection.turns[0].delegated
        : 'x',
      undefined,
    );
  });

  test('attributes a delegated input to another Thread, not the human', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Delegated task',
        source: { kind: 'parent', threadId: 'parent-thread' },
      }),
    ]);

    const turn = projection.turns[0];
    assert.equal(turn?.type, 'user');
    assert.equal(
      turn?.type === 'user' ? turn.delegated?.kind : undefined,
      'parent',
    );
    assert.equal(textOf(turn), '');
  });

  test('carries a child result without the host envelope', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: [
          '# Delegated task result',
          '',
          'Child thread: 2a9ba487',
          'Child prompt: 92f6930f',
          'Originating prompt: 4ac62e86',
          'Status: completed',
          '',
          '## Result',
          '',
          'El workspace está vacío.',
        ].join('\n'),
        source: { kind: 'result', threadId: '2a9ba487' },
      }),
    ]);

    const turn = projection.turns[0];
    const delegated = turn?.type === 'user' ? turn.delegated : undefined;
    assert.equal(delegated?.kind, 'result');
    assert.equal(delegated?.status, 'completed');
    assert.equal(delegated?.text, 'El workspace está vacío.');
    assert.equal(textOf(turn), '');
  });

  test('accumulates consecutive reasoning deltas into one thinking turn', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'Let me ' }),
      event(2, 'one', { type: 'reasoning.delta', delta: 'think.' }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking']);
    assert.equal(textOf(projection.turns[0]), 'Let me think.');
    assert.equal(projection.turns[0]?.events.length, 2);
  });

  test('ignores a text delta that carries no text', () => {
    // OpenRouter sends one empty text delta beside each reasoning chunk, so an
    // unfiltered delta would open an agent turn inside the run and split it.
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'The user is' }),
      event(2, 'one', { type: 'text.delta', delta: '' }),
      event(3, 'one', { type: 'reasoning.delta', delta: ' greeting me.' }),
      event(4, 'one', { type: 'text.delta', delta: '' }),
      event(5, 'one', { type: 'text.delta', delta: 'Hi' }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'The user is greeting me.');
    assert.equal(textOf(projection.turns[1]), 'Hi');
  });

  test('ignores a delta that carries no text however its run would read', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: '' }),
      event(2, 'one', { type: 'text.delta', delta: '' }),
    ]);

    assert.deepEqual(types(projection.turns), []);
  });

  test('reads a trailing reasoning run as still streaming', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'hmm' }),
    ]);

    assert.equal(streamingOf(projection.turns[0]), true);
  });

  test('keeps a lone thought as its own step, not a summary', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'hmm' }),
      event(2, 'one', { type: 'text.delta', delta: 'so' }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'hmm');
  });

  test('keeps a lone thought when its job ends without an answer', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'hmm' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'cancelled',
        text: '',
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking']);
    assert.equal(streamingOf(projection.turns[0]), false);
  });

  test('groups a completed burst and counts what it did', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'a' }),
      event(2, 'one', { type: 'tool.started', call: call('c1', 'read_file') }),
      event(3, 'one', {
        type: 'tool.finished',
        call: call('c1', 'read_file'),
        record: { output: 'x' },
      }),
      event(4, 'one', { type: 'reasoning.delta', delta: 'b' }),
      event(5, 'one', { type: 'text.delta', delta: 'answer' }),
    ]);

    assert.deepEqual(types(projection.turns), ['activity', 'agent']);
    const activity = activityOf(projection.turns[0]);
    assert.equal(activity?.thoughts, 2);
    assert.equal(activity?.tools, 1);
    assert.deepEqual(
      activity?.items.map((item) => item.kind),
      ['thinking', 'tool', 'thinking'],
    );
  });

  test('keeps a lone thought when a new prompt closes it', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'a' }),
      event(2, 'two', {
        type: 'prompt.accepted',
        text: 'next',
        source: { kind: 'user' },
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking', 'user']);
  });

  test('reads a prompt the agent has not answered as awaiting', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(awaitingOf(projection.turns[0]), true);
  });

  test('stops awaiting once the agent produces a step', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      event(2, 'one', { type: 'reasoning.delta', delta: 'hmm' }),
    ]);

    assert.equal(awaitingOf(projection.turns[0]), false);
  });

  test('stops awaiting once the job ends without an answer', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'cancelled',
        text: '',
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['user']);
    assert.equal(awaitingOf(projection.turns[0]), false);
  });

  test('accumulates consecutive text deltas into one agent turn', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'Hel' }),
      event(2, 'one', { type: 'text.delta', delta: 'lo' }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent']);
    assert.equal(textOf(projection.turns[0]), 'Hello');
    assert.equal(agentStatus(projection.turns[0]), 'streaming');
  });

  test('keeps thinking, text and a tool call in event order', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'hmm' }),
      event(2, 'one', { type: 'text.delta', delta: 'before' }),
      event(3, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
    ]);

    assert.deepEqual(types(projection.turns), [
      'thinking',
      'agent',
      'tool_call',
    ]);
  });

  test('splits the agent text around a tool call into two turns', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'before' }),
      event(2, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(3, 'one', { type: 'text.delta', delta: 'after' }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent', 'tool_call', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'before');
    assert.equal(textOf(projection.turns[2]), 'after');
  });

  test('pairs a finished call with its started turn by call id', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(2, 'one', {
        type: 'tool.finished',
        call: call('c1', 'terminal', { command: 'ls' }),
        record: {
          id: 'r1',
          callId: 'c1',
          toolName: 'terminal',
          input: { command: 'ls' },
          output: '/workspace',
        },
      }),
    ]);

    const tool = toolOf(projection.turns[0]);
    assert.deepEqual(types(projection.turns), ['tool_call']);
    assert.equal(tool?.status, 'finished');
    assert.equal(tool?.result, '/workspace');
    assert.equal(tool?.name, 'terminal');
    assert.equal(tool?.args, '{"command":"ls"}');
    assert.equal(projection.turns[0]?.events.length, 2);
  });

  test('marks a failed call and keeps its error message', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'boom' }),
      }),
      event(2, 'one', {
        type: 'tool.failed',
        call: call('c1', 'terminal', { command: 'boom' }),
        error: { message: 'command failed' },
      }),
    ]);

    const tool = toolOf(projection.turns[0]);
    assert.equal(tool?.status, 'failed');
    assert.equal(tool?.error, 'command failed');
  });

  test('leaves a call running when the prompt finishes first', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'sleep' }),
      }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'done',
        source: {},
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['tool_call', 'agent']);
    assert.equal(toolOf(projection.turns[0])?.status, 'running');
    assert.equal(agentStatus(projection.turns[1]), 'completed');
    assert.equal(textOf(projection.turns[1]), 'done');
  });

  test('uses the finished text as the authoritative last answer', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'first' }),
      event(2, 'one', { type: 'tool.started', call: call('c1', 'tree') }),
      event(3, 'one', { type: 'text.delta', delta: 'draft' }),
      event(4, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'final',
        source: {},
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent', 'tool_call', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'first');
    assert.equal(textOf(projection.turns[2]), 'final');
  });

  test('preserves partial output when an agent fails', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'still useful' }),
      event(2, 'one', { type: 'agent.failed', error: 'redacted' }),
      event(3, 'one', {
        type: 'prompt.finished',
        status: 'failed',
        text: 'The prompt failed.',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(textOf(projection.turns[0]), 'still useful');
    assert.equal(agentStatus(projection.turns[0]), 'failed');
  });

  test('preserves partial output when an agent is cancelled', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'partial answer' }),
      event(2, 'one', { type: 'agent.cancelled' }),
      event(3, 'one', {
        type: 'prompt.finished',
        status: 'cancelled',
        text: 'The prompt was cancelled.',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(textOf(projection.turns[0]), 'partial answer');
    assert.equal(agentStatus(projection.turns[0]), 'cancelled');
  });

  test('opens an agent turn for a finished text with no streamed text', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'thought' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'answer',
        source: {},
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking', 'agent']);
    assert.equal(textOf(projection.turns[1]), 'answer');
    assert.equal(agentStatus(projection.turns[1]), 'completed');
  });

  test('writes no turn for a completion that carries no text at all', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: {},
      }),
    ]);

    assert.deepEqual(types(projection.turns), []);
  });

  test('orders turns by sequence, not by prompt identifier', () => {
    const projection = projectEvents(emptyProjection, [
      event(2, 'alpha', { type: 'text.delta', delta: 'second' }),
      event(1, 'zulu', { type: 'text.delta', delta: 'first' }),
    ]);

    assert.deepEqual(
      projection.turns.map(({ promptId }) => promptId),
      ['zulu', 'alpha'],
    );
  });

  test('deduplicates a replayed sequence within its turn', () => {
    const delta = event(2, 'one', { type: 'text.delta', delta: 'Hello' });
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      delta,
      delta,
    ]);

    assert.deepEqual(types(projection.turns), ['user', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'Hi');
    assert.equal(textOf(projection.turns[1]), 'Hello');
    assert.equal(projection.turns[1]?.events.length, 1);
  });

  test('drops the turns a rewind discarded and keeps the survivors', () => {
    const held = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'first',
        source: { kind: 'user' },
      }),
      event(2, 'one', { type: 'text.delta', delta: 'answer one' }),
      event(3, 'two', {
        type: 'prompt.accepted',
        text: 'second',
        source: { kind: 'user' },
      }),
      event(4, 'two', { type: 'text.delta', delta: 'answer two' }),
    ]);
    const after = projectEvents(held, [
      event(5, 'two', { type: 'history.truncated', afterSequence: 2 }),
      event(6, 'three', {
        type: 'prompt.accepted',
        text: 'edited',
        source: { kind: 'user' },
      }),
    ]);

    assert.deepEqual(
      after.turns.map(({ promptId }) => promptId),
      ['one', 'one', 'three'],
    );
    assert.equal(textOf(after.turns[0]), 'first');
    assert.equal(textOf(after.turns[2]), 'edited');
    assert.ok(after.events.some(({ type }) => type === 'history.truncated'));
  });

  test('ignores duplicate and unknown stream events', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'answer' }),
      event(2, 'one', { type: 'tool_call.delta', call: call('x', 'terminal') }),
      event(3, 'one', { type: 'tool_call.done', call: call('x', 'terminal') }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent']);
    assert.equal(textOf(projection.turns[0]), 'answer');
  });

  test('ignores a result for a call that never started', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.finished',
        call: call('ghost', 'terminal'),
        record: { output: 'orphan' },
      }),
    ]);

    assert.deepEqual(types(projection.turns), []);
  });
});

describe('sandbox writes in the log', () => {
  const finished = (sequence: number, name: string): ThreadEvent =>
    event(sequence, 'one', {
      type: 'tool.finished',
      call: call(`c${sequence}`, name),
      record: { output: 'ok' },
    });

  test('counts the finished calls that can change the sandbox', () => {
    assert.equal(
      sandboxWrites([
        finished(1, 'write'),
        finished(2, 'edit'),
        finished(3, 'terminal'),
        finished(4, 'grep'),
        finished(5, 'tree'),
      ]),
      3,
    );
  });

  test('counts a call only once it has finished', () => {
    assert.equal(
      sandboxWrites([
        event(1, 'one', {
          type: 'tool.started',
          call: call('c1', 'write'),
        }),
        event(2, 'one', {
          type: 'tool.failed',
          call: call('c1', 'write'),
          error: { message: 'no' },
        }),
      ]),
      0,
    );
  });

  test('counts no write in a log that has none', () => {
    assert.equal(
      sandboxWrites([
        event(1, 'one', {
          type: 'prompt.accepted',
          text: 'hi',
          source: { kind: 'user' },
        }),
        event(2, 'one', { type: 'text.delta', delta: 'hello' }),
      ]),
      0,
    );
    assert.equal(sandboxWrites([]), 0);
  });
});
