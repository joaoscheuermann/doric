import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ActivityTurn,
  emptyProjection,
  type LifecycleTurn,
  projectEvents,
  sandboxWrites,
  type ToolTurn,
  type Turn,
} from '../src/domain/projector';
import type { PromptFailure } from '../src/domain/prompt-lifecycle';
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
  turn !== undefined &&
  (turn.type === 'user' || turn.type === 'agent' || turn.type === 'thinking')
    ? turn.text
    : undefined;

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

const lifecycleOf = (
  turn: Turn | undefined,
): LifecycleTurn['lifecycle'] | undefined =>
  turn?.type === 'lifecycle' ? turn.lifecycle : undefined;

const standingOf = (turn: Turn | undefined): boolean | undefined => {
  const lifecycle = lifecycleOf(turn);
  return lifecycle?.kind === 'pause' ? lifecycle.standing : undefined;
};

const failureOf = (turn: Turn | undefined): PromptFailure | undefined =>
  turn?.type === 'failure' ? turn.failure : undefined;

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

describe('the prompt lifecycle in a log', () => {
  test('places a resumed final answer after its marker without replacing earlier output', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'Earlier output' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'Final answer',
      }),
    ]);
    assert.deepEqual(types(projection.turns), [
      'agent',
      'lifecycle',
      'lifecycle',
      'agent',
    ]);
    assert.equal(textOf(projection.turns[0]), 'Earlier output');
    assert.equal(textOf(projection.turns[3]), 'Final answer');
  });
  test('opens a pause block at the point the run was interrupted', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'half an ans' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent', 'lifecycle']);
    assert.deepEqual(lifecycleOf(projection.turns[1]), {
      at: '2026-01-01T00:00:02.000Z',
      kind: 'pause',
      reason: 'host_stopped',
      standing: true,
    });
  });

  test('opens a resume block before the run it took up again', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'before' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', { type: 'text.delta', delta: 'after' }),
    ]);

    assert.deepEqual(types(projection.turns), [
      'agent',
      'lifecycle',
      'lifecycle',
      'agent',
    ]);
    assert.deepEqual(lifecycleOf(projection.turns[1]), {
      at: '2026-01-01T00:00:02.000Z',
      kind: 'pause',
      reason: 'host_stopped',
      // The resume took it up, so the pause no longer offers the reader action.
      standing: false,
    });
    assert.deepEqual(lifecycleOf(projection.turns[2]), {
      attempt: 1,
      kind: 'resume',
    });
    assert.equal(textOf(projection.turns[0]), 'before');
    assert.equal(textOf(projection.turns[3]), 'after');
  });

  test('keeps a pause standing until the prompt is taken up or finished', () => {
    const stillPaused = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
    ]);
    assert.equal(standingOf(stillPaused.turns[0]), true);

    const finished = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'cancelled',
        text: '',
      }),
    ]);
    assert.equal(standingOf(finished.turns[0]), false);
  });

  test('ignores a pause or resume that names nothing to read', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.paused', reason: 'somewhere' }),
      event(2, 'one', { type: 'prompt.resumed' }),
    ]);

    assert.deepEqual(types(projection.turns), []);
  });

  test('keeps the reading of a pause in the projection it was returned with', () => {
    const first = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
    ]);
    const after = projectEvents(first, [
      event(2, 'one', { type: 'prompt.resumed', attempt: 1 }),
    ]);

    assert.equal(standingOf(first.turns[0]), true);
    assert.equal(standingOf(after.turns[0]), false);
  });

  test('opens a failure block carrying the code and message of the run', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'agent.failed',
        error: {
          name: 'ResumeExhaustedError',
          code: 'resume_exhausted',
          message: 'A execução foi interrompida três vezes.',
        },
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['failure']);
    assert.deepEqual(failureOf(projection.turns[0]), {
      name: 'ResumeExhaustedError',
      code: 'resume_exhausted',
      message: 'A execução foi interrompida três vezes.',
    });
    assert.equal(agentStatus(projection.turns[0]), undefined);
  });

  test('keeps the partial output of a failed run above its failure block', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'still useful' }),
      event(2, 'one', {
        type: 'agent.failed',
        error: { name: 'Error', code: 'boom', message: 'it stopped' },
      }),
      event(3, 'one', {
        type: 'prompt.finished',
        status: 'failed',
        text: 'The prompt failed.',
        source: { kind: 'user' },
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent', 'failure']);
    assert.equal(textOf(projection.turns[0]), 'still useful');
    assert.equal(failureOf(projection.turns[1])?.message, 'it stopped');
  });

  test('falls back to the finished text when a failure says nothing', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'agent.failed' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'failed',
        text: 'The prompt failed.',
        source: { kind: 'user' },
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent']);
    assert.equal(textOf(projection.turns[0]), 'The prompt failed.');
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

describe('reading a log in batches', () => {
  const log = [
    event(1, 'one', {
      type: 'prompt.accepted',
      text: 'hello',
      source: { kind: 'user' },
    }),
    event(2, 'one', { type: 'reasoning.delta', delta: 'think' }),
    event(3, 'one', { type: 'reasoning.delta', delta: ' hard' }),
    event(4, 'one', { type: 'tool.started', call: call('c1', 'read_file') }),
    event(5, 'one', {
      type: 'tool.finished',
      call: call('c1', 'read_file'),
      record: { output: 'x' },
    }),
    event(6, 'one', { type: 'text.delta', delta: 'answer' }),
    event(7, 'one', {
      type: 'prompt.finished',
      status: 'completed',
      text: 'the answer.',
    }),
    event(8, 'two', {
      type: 'prompt.accepted',
      text: 'next',
      source: { kind: 'user' },
    }),
    event(9, 'two', { type: 'reasoning.delta', delta: 'more' }),
    event(10, 'two', { type: 'reasoning.delta', delta: ' thought' }),
    event(11, 'two', {
      type: 'prompt.finished',
      status: 'completed',
      text: '',
    }),
  ];

  test('reads a batch that follows the log as the log read again', () => {
    const whole = projectEvents(emptyProjection, log);

    let step = emptyProjection;
    for (const item of log) step = projectEvents(step, [item]);

    assert.deepEqual(step.turns, whole.turns);
    assert.deepEqual(step.events, whole.events);
  });

  test('reads any batching of the log as one read of it', () => {
    const whole = projectEvents(emptyProjection, log);

    const batches = [log.slice(0, 2), log.slice(2, 5), log.slice(5)];
    let step = emptyProjection;
    for (const batch of batches) step = projectEvents(step, batch);

    assert.deepEqual(step.turns, whole.turns);
  });

  test('reads a rewind that discards part of the log as the log read again', () => {
    const rewound = [
      ...log,
      event(12, 'two', { type: 'history.truncated', afterSequence: 8 }),
      event(13, 'two', {
        type: 'prompt.accepted',
        text: 'again',
        source: { kind: 'user' },
      }),
      event(14, 'two', { type: 'text.delta', delta: 'once more' }),
    ];

    const whole = projectEvents(emptyProjection, rewound);

    let step = emptyProjection;
    for (const item of rewound) step = projectEvents(step, [item]);

    assert.deepEqual(step.turns, whole.turns);
    assert.deepEqual(step.events, whole.events);
  });
});

describe('a projection is never altered after it was returned', () => {
  test('leaves a returned projection unchanged when a later batch extends the log', () => {
    const first = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      event(2, 'one', { type: 'text.delta', delta: 'Hel' }),
    ]);
    const held = structuredClone(first);

    // Every kind of write a batch can bring: a delta extending the open turn, a
    // tool call finishing onto its own turn, and the job's finished text
    // replacing what streamed.
    projectEvents(first, [
      event(3, 'one', { type: 'text.delta', delta: 'lo' }),
      event(4, 'one', { type: 'tool.started', call: call('c1', 'read_file') }),
      event(5, 'one', {
        type: 'tool.finished',
        call: call('c1', 'read_file'),
        record: { output: 'x' },
      }),
      event(6, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'Hello',
      }),
    ]);

    assert.deepEqual(first, held);
    assert.deepEqual(emptyProjection, {
      events: [],
      turns: [],
      drafts: [],
      status: new Map(),
    });
  });

  test('leaves the projections before a rewind unchanged when it rebuilds the log', () => {
    const first = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'first',
        source: { kind: 'user' },
      }),
      event(2, 'one', { type: 'text.delta', delta: 'answer one' }),
    ]);
    const held = structuredClone(first);

    projectEvents(first, [
      event(3, 'one', { type: 'history.truncated', afterSequence: 1 }),
      event(4, 'two', {
        type: 'prompt.accepted',
        text: 'again',
        source: { kind: 'user' },
      }),
      event(5, 'two', { type: 'text.delta', delta: 'once more' }),
    ]);

    assert.deepEqual(first, held);
  });
});

describe('projecting a long log', () => {
  const deltas = 100_000;

  const longLog = (): ThreadEvent[] => {
    const log = [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
    ];
    for (let index = 0; index < deltas; index += 1) {
      log.push(event(index + 2, 'one', { type: 'text.delta', delta: 'x' }));
    }
    log.push(
      event(deltas + 2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'x'.repeat(deltas),
      }),
    );
    return log;
  };

  test('reads a turn of a hundred thousand deltas as one turn in one call', () => {
    const log = longLog();

    const started = process.hrtime.bigint();
    const projection = projectEvents(emptyProjection, log);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.deepEqual(types(projection.turns), ['user', 'agent']);
    assert.equal(textOf(projection.turns[1]), 'x'.repeat(deltas));
    assert.equal(projection.turns[1]?.events.length, deltas + 1);
    assert.equal(projection.events.length, deltas + 2);
    // Generous by design: the read is linear and takes milliseconds here. The
    // bound exists only to fail a return to copying the turn's events per
    // event, which made a log like this take seconds.
    assert.ok(
      elapsedMs < 3000,
      `projecting ${deltas} deltas took ${elapsedMs.toFixed(0)} ms`,
    );
  });

  test('reads the same log in batches as promptly as in one call', () => {
    const log = longLog();
    let step = emptyProjection;

    const started = process.hrtime.bigint();
    for (let index = 0; index < log.length; index += 5000) {
      step = projectEvents(step, log.slice(index, index + 5000));
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.deepEqual(types(step.turns), ['user', 'agent']);
    assert.equal(textOf(step.turns[1]), 'x'.repeat(deltas));
    assert.equal(step.turns[1]?.events.length, deltas + 1);
    assert.equal(step.events.length, deltas + 2);
    assert.ok(
      elapsedMs < 3000,
      `projecting ${deltas} deltas in batches took ${elapsedMs.toFixed(0)} ms`,
    );
  });
});
