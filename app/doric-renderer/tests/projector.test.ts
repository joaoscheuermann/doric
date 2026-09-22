import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ThreadEvent } from '../src/app/workspace';
import {
  emptyProjection,
  projectEvents,
  type PromptTurn,
  type TextSegment,
  type ToolSegment,
} from '../src/chat/projector';

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

/** The concatenated text segments: the agent's user-visible answer. */
const answer = (turn: PromptTurn | undefined): string =>
  (turn?.segments ?? [])
    .filter((segment): segment is TextSegment => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('');

const kinds = (turn: PromptTurn | undefined): readonly string[] =>
  (turn?.segments ?? []).map(({ kind }) => kind);

const textAt = (
  turn: PromptTurn | undefined,
  index: number,
): string | undefined => {
  const segment = turn?.segments[index];
  return segment?.kind === 'text' ? segment.text : undefined;
};

const toolAt = (
  turn: PromptTurn | undefined,
  index: number,
): ToolSegment | undefined => {
  const segment = turn?.segments[index];
  return segment?.kind === 'tool' ? segment : undefined;
};

describe('thread event projection', () => {
  test('orders events and deduplicates a replayed sequence per prompt', () => {
    const delta = event(2, 'one', { type: 'text.delta', delta: 'Hello' });
    const projection = projectEvents(emptyProjection, [
      delta,
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: {},
      }),
      delta,
    ]);

    assert.deepEqual(
      projection.events.map(({ sequence }) => sequence),
      [1, 2],
    );
    assert.equal(projection.turns[0]?.userMarkdown, 'Hi');
    assert.equal(answer(projection.turns[0]), 'Hello');
  });

  test('attributes delegated input to the agent rather than the user', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Delegated task',
        source: { kind: 'parent' },
      }),
    ]);

    assert.equal(projection.turns[0]?.inputRole, 'agent');
  });

  test('keeps earlier turns when a reconnect snapshot only carries newer events', () => {
    const first = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'question',
        source: { kind: 'user' },
      }),
      event(2, 'one', { type: 'text.delta', delta: 'partial answer' }),
    ]);
    const merged = projectEvents(first, [
      event(3, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'complete answer',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(merged.turns[0]?.userMarkdown, 'question');
    assert.equal(answer(merged.turns[0]), 'complete answer');
    assert.equal(merged.turns[0]?.status, 'completed');
  });

  test('carries a child result as a delegated input instead of a user prompt', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: [
          '# Delegated task result',
          '',
          'Child thread: 2a9ba487-632d-4397-abd9-3987354aefd1',
          'Child prompt: 92f6930f',
          'Originating prompt: 4ac62e86',
          'Status: completed',
          '',
          '## Result',
          '',
          'El workspace está vacío.',
        ].join('\n'),
        source: {
          kind: 'result',
          threadId: '2a9ba487-632d-4397-abd9-3987354aefd1',
        },
      }),
    ]);

    assert.equal(projection.turns[0]?.delegated?.kind, 'result');
    assert.equal(projection.turns[0]?.delegated?.status, 'completed');
    assert.equal(
      projection.turns[0]?.delegated?.text,
      'El workspace está vacío.',
    );
    assert.equal(projection.turns[0]?.userMarkdown, '');
  });

  test('keeps a human prompt on the band with no delegated input', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Olá',
        source: { kind: 'user' },
      }),
    ]);

    assert.equal(projection.turns[0]?.delegated, undefined);
    assert.equal(projection.turns[0]?.userMarkdown, 'Olá');
    assert.equal(projection.turns[0]?.inputRole, 'user');
  });

  test('keeps an accepted prompt visible when its recorded text is absent', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.accepted', source: { kind: 'user' } }),
      event(2, 'one', { type: 'text.delta', delta: 'answer' }),
    ]);

    assert.equal(projection.turns[0]?.accepted, true);
    assert.equal(projection.turns[0]?.userMarkdown, '');
    assert.equal(answer(projection.turns[0]), 'answer');
  });

  test('uses finished text as the authoritative final result', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'draft' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'final answer',
        source: {},
      }),
    ]);

    assert.equal(answer(projection.turns[0]), 'final answer');
    assert.equal(projection.turns[0]?.status, 'completed');
  });

  test('appends the finished text when the turn streamed no text', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'thought' }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'answer',
        source: {},
      }),
    ]);

    assert.deepEqual(kinds(projection.turns[0]), ['thinking', 'text']);
    assert.equal(textAt(projection.turns[0], 1), 'answer');
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

    assert.equal(answer(projection.turns[0]), 'still useful');
    assert.equal(projection.turns[0]?.status, 'failed');
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

    assert.equal(answer(projection.turns[0]), 'partial answer');
    assert.equal(projection.turns[0]?.status, 'cancelled');
  });

  test('keeps prompt order independent from prompt identifiers', () => {
    const projection = projectEvents(emptyProjection, [
      event(2, 'alpha', { type: 'text.delta', delta: 'second' }),
      event(1, 'zulu', { type: 'text.delta', delta: 'first' }),
    ]);

    assert.deepEqual(
      projection.turns.map(({ promptId }) => promptId),
      ['zulu', 'alpha'],
    );
  });

  test('accumulates consecutive reasoning deltas into one thinking segment', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'Let me ' }),
      event(2, 'one', { type: 'reasoning.delta', delta: 'think.' }),
      event(3, 'one', { type: 'text.delta', delta: 'Answer' }),
    ]);

    assert.deepEqual(kinds(projection.turns[0]), ['thinking', 'text']);
    assert.deepEqual(projection.turns[0]?.segments[0], {
      kind: 'thinking',
      text: 'Let me think.',
    });
  });

  test('keeps text, tool, and text segments in event order', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'before' }),
      event(2, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(3, 'one', { type: 'text.delta', delta: 'after' }),
    ]);

    assert.deepEqual(kinds(projection.turns[0]), ['text', 'tool', 'text']);
    assert.equal(textAt(projection.turns[0], 0), 'before');
    assert.equal(textAt(projection.turns[0], 2), 'after');
  });

  test('pairs a finished call with its started segment by call id', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(2, 'one', {
        type: 'tool.finished',
        call: call('c1', 'terminal', { command: 'ls' }),
        result: 'a\n',
        content: '<content>',
        record: {
          id: 'r1',
          callId: 'c1',
          toolName: 'terminal',
          input: { command: 'ls' },
          output: '/workspace',
        },
      }),
    ]);

    const tools = (projection.turns[0]?.segments ?? []).filter(
      (segment): segment is ToolSegment => segment.kind === 'tool',
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.status, 'finished');
    assert.equal(tools[0]?.result, '/workspace');
    assert.equal(tools[0]?.name, 'terminal');
    assert.equal(tools[0]?.args, '{"command":"ls"}');
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

    const tool = toolAt(projection.turns[0], 0);
    assert.equal(tool?.status, 'failed');
    assert.equal(tool?.error, 'command failed');
  });

  test('leaves a call running when the turn ends without a result', () => {
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

    assert.equal(toolAt(projection.turns[0], 0)?.status, 'running');
    assert.equal(projection.turns[0]?.status, 'completed');
  });

  test('applies the authoritative finish text only to the last text segment', () => {
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

    assert.deepEqual(kinds(projection.turns[0]), ['text', 'tool', 'text']);
    assert.equal(textAt(projection.turns[0], 0), 'first');
    assert.equal(textAt(projection.turns[0], 2), 'final');
  });

  test('ignores duplicate and unknown stream events', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'answer' }),
      event(1, 'one', { type: 'text.delta', delta: 'answer' }),
      event(2, 'one', { type: 'tool_call.delta', call: call('x', 'terminal') }),
      event(3, 'one', { type: 'tool_call.done', call: call('x', 'terminal') }),
    ]);

    assert.equal(answer(projection.turns[0]), 'answer');
    assert.deepEqual(kinds(projection.turns[0]), ['text']);
  });

  test('ignores a result for a call that never started', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.finished',
        call: call('ghost', 'terminal'),
        record: { output: 'orphan' },
      }),
    ]);

    assert.deepEqual(kinds(projection.turns[0]), []);
  });

  test('leaves a completed turn with no response text empty', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: {},
      }),
    ]);

    assert.deepEqual(kinds(projection.turns[0]), []);
    assert.equal(answer(projection.turns[0]), '');
  });
});
