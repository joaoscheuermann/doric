import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type ActivityTurn,
  type CompactionTurn,
  emptyProjection,
  type LifecycleTurn,
  projectEvents,
  sandboxWrites,
  type ToolTurn,
  type Turn,
} from '../src/client/domain/projector.js';
import type { PromptFailure } from '../src/client/domain/prompt-lifecycle.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

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

  test('attributes a bundle instruction to its bundle, not the human', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: '# Coding in a repository',
        source: {
          kind: 'bundle',
          bundleId: 'default',
          reason: 'coding-workflow',
        },
      }),
    ]);

    const turn = projection.turns[0];
    assert.deepEqual(turn?.type === 'user' ? turn.instruction : undefined, {
      bundleId: 'default',
      reason: 'coding-workflow',
    });
    assert.equal(textOf(turn), '# Coding in a repository');
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

  test("carries a background terminal result as the turn's own block", () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: [
          '# Background terminal result',
          '',
          'Terminal: terminal-3f8a',
          'Originating prompt: prompt-9',
          'Command: npm test',
          'Exit code: 3',
          'Reason: exited',
          'Duration: 1940 ms',
          '',
          '## Standard output (last 12000 characters)',
          '',
          'ok',
          '',
          '## Standard error (last 12000 characters)',
          '',
        ].join('\n'),
        source: { kind: 'terminal', terminalId: 'terminal-3f8a' },
      }),
    ]);

    const turn = projection.turns[0];
    const terminal = turn?.type === 'user' ? turn.terminal : undefined;
    assert.equal(terminal?.terminalId, 'terminal-3f8a');
    assert.equal(terminal?.command, 'npm test');
    assert.equal(terminal?.exitCode, 3);
    assert.equal(terminal?.stdout, 'ok');
    assert.equal(terminal?.stderr, '');
    assert.equal(textOf(turn), '');
  });

  test('shows a terminal prompt the host did not frame as its own text', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'output without the host header',
        source: { kind: 'terminal', terminalId: 'terminal-3f8a' },
      }),
    ]);

    const turn = projection.turns[0];
    assert.equal(turn?.type === 'user' ? turn.terminal : 'x', undefined);
    assert.equal(textOf(turn), 'output without the host header');
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

  test('a text delta of only whitespace opens no answer between thinking and tools', () => {
    // Some models emit a lone "\n\n" between their reasoning and a tool call:
    // an answer of blank lines would draw an empty block and split the run.
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'Let me look.' }),
      event(2, 'one', { type: 'text.delta', delta: '\n\n' }),
      event(3, 'one', { type: 'tool.started', call: call('a', 'grep') }),
      event(4, 'one', { type: 'tool.finished', call: call('a', 'grep') }),
    ]);

    assert.deepEqual(types(projection.turns), ['thinking', 'tool_call']);
  });

  test('keeps whitespace inside an answer already written', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'text.delta', delta: 'First.' }),
      event(2, 'one', { type: 'text.delta', delta: '\n\n' }),
      event(3, 'one', { type: 'text.delta', delta: 'Second.' }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent']);
    assert.equal(textOf(projection.turns[0]), 'First.\n\nSecond.');
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

  test('keeps edit calls outside the activity summary while grouping terminal calls inside it', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'inspect' }),
      event(2, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'npm test' }),
      }),
      event(3, 'one', {
        type: 'tool.finished',
        call: call('c1', 'terminal', { command: 'npm test' }),
        record: { output: 'pass' },
      }),
      event(4, 'one', {
        type: 'tool.started',
        call: call('c2', 'edit', { path: 'src/a.ts', edits: [] }),
      }),
      event(5, 'one', {
        type: 'tool.finished',
        call: call('c2', 'edit', { path: 'src/a.ts', edits: [] }),
        record: { output: '{"success":true,"diff":"1 +ok"}' },
      }),
      event(6, 'one', { type: 'reasoning.delta', delta: 'verify' }),
      event(7, 'one', {
        type: 'tool.started',
        call: call('c3', 'terminal', { command: 'npm run check' }),
      }),
      event(8, 'one', {
        type: 'tool.finished',
        call: call('c3', 'terminal', { command: 'npm run check' }),
        record: { output: 'clean' },
      }),
      event(9, 'one', { type: 'text.delta', delta: 'All set.' }),
    ]);

    assert.deepEqual(types(projection.turns), [
      'activity',
      'tool_call',
      'activity',
      'agent',
    ]);
    assert.equal(toolOf(projection.turns[1])?.name, 'edit');
    assert.equal(activityOf(projection.turns[0])?.tools, 1);
    assert.equal(activityOf(projection.turns[2])?.tools, 1);
  });

  test('a thread-spawn call stands on its own between the bursts on either side of it', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'reasoning.delta', delta: 'inspect' }),
      event(2, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(3, 'one', {
        type: 'tool.finished',
        call: call('c1', 'terminal', { command: 'ls' }),
        record: { output: 'src' },
      }),
      event(4, 'one', {
        type: 'tool.started',
        call: call('c2', 'thread-spawn', { prompt: 'Audit the contrast' }),
      }),
      event(5, 'one', {
        type: 'tool.finished',
        call: call('c2', 'thread-spawn', { prompt: 'Audit the contrast' }),
        record: { output: '{"threadId":"thread-2","promptId":"prompt-2"}' },
      }),
      event(6, 'one', { type: 'reasoning.delta', delta: 'wait' }),
      event(7, 'one', {
        type: 'tool.started',
        call: call('c3', 'terminal', { command: 'npm test' }),
      }),
      event(8, 'one', {
        type: 'tool.finished',
        call: call('c3', 'terminal', { command: 'npm test' }),
        record: { output: 'pass' },
      }),
      event(9, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: { kind: 'user' },
      }),
    ]);

    // The spawn reads as a block of its own, so the bursts around it are the
    // summaries that stand either side of it, as an `edit` call's are.
    assert.deepEqual(types(projection.turns), [
      'activity',
      'tool_call',
      'activity',
    ]);
    assert.equal(toolOf(projection.turns[1])?.name, 'thread-spawn');
    assert.equal(activityOf(projection.turns[0])?.tools, 1);
    assert.equal(activityOf(projection.turns[2])?.tools, 1);
  });

  test('a burst that spawned a Thread does not list the spawn among its steps', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Delegate the audit and run the suite',
        source: { kind: 'user' },
      }),
      event(2, 'one', {
        type: 'tool.started',
        call: call('c1', 'terminal', { command: 'ls' }),
      }),
      event(3, 'one', {
        type: 'tool.finished',
        call: call('c1', 'terminal', { command: 'ls' }),
        record: { output: 'src' },
      }),
      event(4, 'one', {
        type: 'tool.started',
        call: call('c2', 'terminal', { command: 'cat package.json' }),
      }),
      event(5, 'one', {
        type: 'tool.finished',
        call: call('c2', 'terminal', { command: 'cat package.json' }),
        record: { output: '{}' },
      }),
      event(6, 'one', {
        type: 'tool.started',
        call: call('c3', 'thread-spawn', { prompt: 'Audit the contrast' }),
      }),
      event(7, 'one', {
        type: 'tool.finished',
        call: call('c3', 'thread-spawn', { prompt: 'Audit the contrast' }),
        record: { output: '{"threadId":"thread-2","promptId":"prompt-2"}' },
      }),
      event(8, 'one', {
        type: 'tool.started',
        call: call('c4', 'terminal', { command: 'npm test' }),
      }),
      event(9, 'one', {
        type: 'tool.finished',
        call: call('c4', 'terminal', { command: 'npm test' }),
        record: { output: 'pass' },
      }),
      event(10, 'one', {
        type: 'tool.started',
        call: call('c5', 'terminal', { command: 'npm run check' }),
      }),
      event(11, 'one', {
        type: 'tool.finished',
        call: call('c5', 'terminal', { command: 'npm run check' }),
        record: { output: 'clean' },
      }),
      event(12, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: '',
        source: { kind: 'user' },
      }),
    ]);

    const activities = projection.turns.filter(
      (turn): turn is ActivityTurn => turn.type === 'activity',
    );
    const named = activities
      .flatMap((turn) => turn.items)
      .flatMap((item) => (item.kind === 'tool' ? [item.name] : []));

    // The spawn has its own block, so no summary offers it as one of its steps.
    assert.deepEqual(named, ['terminal', 'terminal', 'terminal', 'terminal']);
    // And the calls that did fold into a summary still count as its tools.
    assert.deepEqual(
      activities.map((turn) => turn.tools),
      [2, 2],
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

  test('a failed call shows what the tool threw, not the wrapper', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'tool.started',
        call: call('c1', 'papercraft_preview', { path: 'a.tsx' }),
      }),
      event(2, 'one', {
        type: 'tool.failed',
        call: call('c1', 'papercraft_preview', { path: 'a.tsx' }),
        error: {
          message: 'Tool handler failed: papercraft_preview',
          data: { code: 'handler_failed' },
          cause: { code: 'invalid_input', message: 'a.tsx did not compile' },
        },
      }),
    ]);

    assert.equal(toolOf(projection.turns[0])?.error, 'a.tsx did not compile');
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
  test('waits for an interrupted prompt to start again and never labels queued first execution as resumed', () => {
    const log = [
      event(1, 'running', { type: 'prompt.accepted', text: 'first result' }),
      event(2, 'running', { type: 'agent.started' }),
      event(3, 'running', { type: 'text.delta', delta: 'before' }),
      event(4, 'queued', { type: 'prompt.accepted', text: 'second result' }),
      event(5, 'running', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(6, 'running', { type: 'prompt.resumed', attempt: 1 }),
      event(7, 'queued', { type: 'prompt.resumed', attempt: 1 }),
      event(8, 'running', { type: 'agent.started' }),
      event(9, 'running', { type: 'text.delta', delta: 'continued' }),
      event(10, 'running', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'continued',
      }),
      event(11, 'queued', { type: 'agent.started' }),
      event(12, 'queued', { type: 'text.delta', delta: 'first execution' }),
    ];
    const recovered = projectEvents(emptyProjection, log.slice(0, 7));
    assert.equal(
      recovered.turns.filter((turn) => lifecycleOf(turn)?.kind === 'resume')
        .length,
      0,
    );
    assert.equal(
      standingOf(recovered.turns.at(-1)),
      false,
      'a recovered prompt cannot be manually resumed twice',
    );
    const whole = projectEvents(emptyProjection, log);
    const markers = whole.turns.filter(
      (turn) => lifecycleOf(turn)?.kind === 'resume',
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.promptId, 'running');
    assert.equal(textOf(whole.turns.at(-1)), 'first execution');
    for (let split = 1; split < log.length; split += 1) {
      const first = projectEvents(emptyProjection, log.slice(0, split));
      const held = structuredClone(first);
      const live = projectEvents(first, log.slice(split));
      assert.deepEqual(live.turns, whole.turns);
      assert.deepEqual(
        projectEvents(live, log).turns,
        whole.turns,
        'replayed events do not duplicate markers',
      );
      assert.deepEqual(first, held);
    }
  });

  test('places a delayed restart marker at actual execution, after intervening work', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'agent.started' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 2 }),
      event(4, 'two', { type: 'text.delta', delta: 'intervening work' }),
      event(5, 'one', { type: 'agent.started' }),
      event(6, 'one', { type: 'text.delta', delta: 'continued' }),
    ]);
    assert.deepEqual(types(projection.turns), [
      'lifecycle',
      'agent',
      'lifecycle',
      'agent',
    ]);
    assert.equal(lifecycleOf(projection.turns[2])?.kind, 'resume');
    assert.equal(standingOf(projection.turns[0]), false);
  });

  test('does not carry a recovered execution across a rewind', () => {
    const before = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.accepted', text: 'work' }),
      event(2, 'one', { type: 'agent.started' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
    ]);
    const after = projectEvents(before, [
      event(4, 'one', { type: 'history.truncated', afterSequence: 1 }),
      event(5, 'one', { type: 'agent.started' }),
    ]);
    assert.equal(
      after.turns.filter((turn) => turn.type === 'lifecycle').length,
      0,
    );
  });

  test('uses the latest recovered attempt once and preserves a later manual pause', () => {
    const restarted = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'agent.started' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', { type: 'prompt.resumed', attempt: 2 }),
      event(5, 'one', { type: 'agent.started' }),
    ]);
    assert.deepEqual(restarted.turns.map(lifecycleOf), [
      {
        kind: 'resume',
        attempt: 2,
        pause: { reason: 'host_stopped', at: '2026-01-01T00:00:02.000Z' },
      },
    ]);
    const paused = projectEvents(restarted, [
      event(6, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
    ]);
    assert.equal(standingOf(paused.turns.at(-1)), true);
    const queued = projectEvents(paused, [
      event(7, 'one', { type: 'prompt.resumed', attempt: 3 }),
    ]);
    assert.equal(standingOf(queued.turns.at(-1)), false);
    const cancelled = projectEvents(queued, [
      event(8, 'one', {
        type: 'prompt.finished',
        status: 'cancelled',
        text: '',
      }),
    ]);
    assert.equal(
      cancelled.turns.filter((turn) => lifecycleOf(turn)?.kind === 'resume')
        .length,
      1,
    );
  });

  test('places a resumed final answer after its marker without replacing earlier output', () => {
    const projection = projectEvents(emptyProjection, [
      event(0, 'one', { type: 'agent.started' }),
      event(1, 'one', { type: 'text.delta', delta: 'Earlier output' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', { type: 'agent.started' }),
      event(5, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'Final answer',
      }),
    ]);
    assert.deepEqual(types(projection.turns), ['agent', 'lifecycle', 'agent']);
    assert.equal(textOf(projection.turns[0]), 'Earlier output');
    assert.equal(textOf(projection.turns[2]), 'Final answer');
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

  test('combines adjacent pause and resume into one marker preserving the pause reason', () => {
    const projection = projectEvents(emptyProjection, [
      event(0, 'one', { type: 'agent.started' }),
      event(1, 'one', { type: 'text.delta', delta: 'before' }),
      event(2, 'one', { type: 'prompt.paused', reason: 'host_stopped' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', { type: 'agent.started' }),
      event(5, 'one', { type: 'text.delta', delta: 'after' }),
    ]);

    assert.deepEqual(types(projection.turns), ['agent', 'lifecycle', 'agent']);
    assert.deepEqual(lifecycleOf(projection.turns[1]), {
      attempt: 1,
      kind: 'resume',
      pause: { at: '2026-01-01T00:00:02.000Z', reason: 'host_stopped' },
    });
    assert.equal(textOf(projection.turns[0]), 'before');
    assert.equal(textOf(projection.turns[2]), 'after');
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
    assert.equal(lifecycleOf(after.turns[0])?.kind, 'pause');
    assert.equal(standingOf(after.turns[0]), false);
  });

  test('removes resume after a newer user prompt, including replay and later completion', () => {
    const paused = [
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
    ];
    const newer = [
      event(2, 'two', {
        type: 'prompt.accepted',
        text: 'new work',
        source: { kind: 'user' },
      }),
      event(3, 'two', {
        type: 'prompt.finished',
        text: 'done',
        status: 'completed',
      }),
    ];
    const first = projectEvents(emptyProjection, paused);
    const live = projectEvents(first, newer);
    assert.equal(standingOf(first.turns[0]), true);
    assert.equal(standingOf(live.turns[0]), false);
    assert.deepEqual(
      live.turns,
      projectEvents(emptyProjection, [...paused, ...newer]).turns,
    );
  });

  test('keeps separate markers when another prompt intervenes', () => {
    const projection = projectEvents(emptyProjection, [
      event(0, 'one', { type: 'agent.started' }),
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
      event(2, 'two', { type: 'prompt.accepted', text: 'new work' }),
      event(3, 'one', { type: 'prompt.resumed', attempt: 1 }),
      event(4, 'one', { type: 'agent.started' }),
    ]);
    assert.deepEqual(types(projection.turns), [
      'lifecycle',
      'user',
      'lifecycle',
    ]);
  });

  test('does not supersede a pause when delegated input arrives', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'prompt.paused', reason: 'reader_stopped' }),
      event(2, 'two', {
        type: 'prompt.accepted',
        text: 'child result',
        source: {
          kind: 'result',
          threadId: 'child',
          promptId: 'child-prompt',
          requestPromptId: 'one',
          status: 'completed',
        },
      }),
    ]);
    assert.equal(standingOf(projection.turns[0]), true);
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

describe('a compaction bracket in the log', () => {
  const compactionOf = (turn: Turn | undefined): CompactionTurn | undefined =>
    turn?.type === 'compaction' ? turn : undefined;

  test('closes a started bracket into one completed compaction turn', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'compaction.started', trigger: 'automatic' }),
      event(2, 'one', {
        type: 'compaction.finished',
        summaryId: 's1',
        summary: '[Context summary]\n\nKeep the agreed design.',
        condensedMessages: 12,
        retainedMessages: 3,
        tokensFreed: 4500,
        summaryChars: 800,
      }),
    ]);

    assert.deepEqual(types(projection.turns), ['compaction']);
    const turn = compactionOf(projection.turns[0]);
    assert.equal(turn?.promptId, 'one');
    assert.equal(turn?.status, 'completed');
    assert.equal(turn?.trigger, 'automatic');
    assert.equal(turn?.condensedMessages, 12);
    assert.equal(turn?.summaryId, 's1');
    assert.equal(turn?.summary, '[Context summary]\n\nKeep the agreed design.');
    assert.equal(turn?.tokensFreed, 4500);
    assert.equal(turn?.code, undefined);
    assert.deepEqual(
      turn?.events.map((item) => item.type),
      ['compaction.started', 'compaction.finished'],
    );
  });

  test('closes a started bracket into one failed compaction turn', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'compaction.started', trigger: 'manual' }),
      event(2, 'one', { type: 'compaction.failed', code: 'unsafe_boundary' }),
    ]);

    assert.deepEqual(types(projection.turns), ['compaction']);
    const turn = compactionOf(projection.turns[0]);
    assert.equal(turn?.status, 'failed');
    assert.equal(turn?.code, 'unsafe_boundary');
    assert.equal(turn?.trigger, 'manual');
    assert.equal(turn?.condensedMessages, undefined);
    assert.equal(turn?.tokensFreed, undefined);
  });

  test('shows an open compaction turn as soon as the bracket starts', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'compaction.started', trigger: 'automatic' }),
    ]);

    assert.deepEqual(types(projection.turns), ['compaction']);
    assert.equal(compactionOf(projection.turns[0])?.status, 'open');
  });

  test('reads a closing half with no started one as nothing', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'compaction.finished',
        summaryId: 's1',
        condensedMessages: 12,
        retainedMessages: 3,
        tokensFreed: 4500,
        summaryChars: 800,
      }),
    ]);

    assert.deepEqual(types(projection.turns), []);
  });

  test('leaves the prompts around the bracket as they project alone', () => {
    const projection = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      event(2, 'one', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'done',
        source: {},
      }),
      event(3, 'one', { type: 'compaction.started', trigger: 'manual' }),
      event(4, 'one', {
        type: 'compaction.finished',
        summaryId: 's1',
        condensedMessages: 2,
        retainedMessages: 4,
        tokensFreed: 900,
        summaryChars: 300,
      }),
      event(5, 'two', {
        type: 'prompt.accepted',
        text: 'Next',
        source: { kind: 'user' },
      }),
      event(6, 'two', {
        type: 'prompt.finished',
        status: 'completed',
        text: 'next done',
        source: {},
      }),
    ]);

    assert.deepEqual(types(projection.turns), [
      'user',
      'agent',
      'compaction',
      'user',
      'agent',
    ]);
    assert.equal(textOf(projection.turns[1]), 'done');
    assert.equal(agentStatus(projection.turns[1]), 'completed');
    const turn = compactionOf(projection.turns[2]);
    assert.equal(turn?.promptId, 'one');
    assert.equal(turn?.status, 'completed');
    assert.equal(turn?.condensedMessages, 2);
    assert.equal(turn?.tokensFreed, 900);
    assert.equal(projection.turns[3]?.promptId, 'two');
    assert.equal(textOf(projection.turns[4]), 'next done');
    assert.equal(agentStatus(projection.turns[4]), 'completed');
  });

  test('closes a bracket the log delivered in batches', () => {
    let step = projectEvents(emptyProjection, [
      event(1, 'one', { type: 'compaction.started', trigger: 'automatic' }),
    ]);
    assert.deepEqual(types(step.turns), ['compaction']);
    assert.equal(compactionOf(step.turns[0])?.status, 'open');

    step = projectEvents(step, [
      event(2, 'one', {
        type: 'compaction.finished',
        summaryId: 's1',
        condensedMessages: 5,
        retainedMessages: 2,
        tokensFreed: 1200,
        summaryChars: 400,
      }),
    ]);

    assert.deepEqual(types(step.turns), ['compaction']);
    assert.equal(compactionOf(step.turns[0])?.status, 'completed');
    assert.equal(compactionOf(step.turns[0])?.tokensFreed, 1200);
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
        finished(6, 'git'),
      ]),
      4,
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
    assert.deepEqual(emptyProjection.events, []);
    assert.deepEqual(emptyProjection.turns, []);
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

  test('keeps the comment threads it holds across a batch that writes no comment', () => {
    const first = projectEvents(emptyProjection, [
      event(1, 'one', {
        type: 'prompt.accepted',
        text: 'Hi',
        source: { kind: 'user' },
      }),
      event(2, 'one', {
        type: 'comments.added/v1',
        commentId: 'c1',
        author: 'user',
        text: 'look here',
        target: { kind: 'message', id: 'm1' },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      event(3, 'one', { type: 'text.delta', delta: 'Hel' }),
    ]);
    assert.equal(first.threads.size, 1);

    // A flush of deltas changes no thread: the threads a surface was handed
    // are the threads it is handed again, so nothing that draws them is told
    // they changed.
    const streamed = projectEvents(first, [
      event(4, 'one', { type: 'text.delta', delta: 'lo' }),
      event(5, 'one', { type: 'tool.started', call: call('c1', 'read_file') }),
    ]);
    assert.equal(streamed.threads, first.threads);

    // A resolution is a new reading, and the one before keeps its own.
    const resolved = projectEvents(streamed, [
      event(6, 'one', {
        type: 'comments.resolved/v1',
        commentId: 'c1',
        resolved: true,
      }),
    ]);
    assert.notEqual(resolved.threads, streamed.threads);
    assert.equal(resolved.threads.get('c1')?.resolved, true);
    assert.equal(first.threads.get('c1')?.resolved, false);
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
