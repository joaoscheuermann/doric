import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageStorage } from 'messages';
import { createToolStorage, defineTool } from 'tool';
import { z } from 'zod';

import { createAgent, createToolCallStorage } from '../src/index.js';
import type { AgentRunOptions } from '../src/index.js';
import { call, collect, completeFinish, createProvider } from './fakes.js';

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const setup = (
  hooks: {
    provider?: () => Promise<void>;
    tool?: () => Promise<void>;
  } = {},
) => {
  const executions: string[] = [];
  const messages = createMessageStorage();
  const toolCalls = createToolCallStorage();
  const calls = [call('first'), call('second')];
  const response = async (index: number) => {
    if (index > 0) return completeFinish('Recovered.');
    await hooks.provider?.();
    return completeFinish('Run tools.', calls);
  };
  const fake = createProvider({
    complete: (_request, index) => response(index),
    stream: (_request, index) =>
      (async function* () {
        yield { type: 'response.finished', finish: await response(index) };
      })(),
  });
  const tools = createToolStorage(
    calls.map(({ name }) =>
      defineTool({
        name,
        input: z.object({}),
        output: z.string(),
        execute: async () => {
          executions.push(name);
          await hooks.tool?.();
          return name;
        },
      })(undefined as never),
    ),
  );
  const agent = createAgent({
    provider: fake.provider,
    tools,
    messages,
    toolCalls,
    system: '',
    model: 'fake',
  });
  return { agent, messages, toolCalls, executions, requests: fake.requests };
};

// Only the interrupted batch and follow-up input matter to provider replay.
const recoveryHistory = (fixture: ReturnType<typeof setup>) =>
  fixture.requests[1]?.messages.slice(1).map((message) => {
    if (message.role === 'assistant')
      return ['assistant', message.toolCalls?.map(({ id }) => id)];
    if (message.role === 'tool')
      return ['tool', message.toolCallId, message.toolResultStatus];
    return [message.role, message.content];
  });

for (const mode of ['complete', 'stream'] as const) {
  const run = (
    fixture: ReturnType<typeof setup>,
    options: AgentRunOptions = {},
  ) =>
    mode === 'complete'
      ? fixture.agent.complete('Run.', options)
      : collect(fixture.agent.stream('Run.', options));

  test(`${mode} starts no provider or tools with an already aborted signal`, async () => {
    const fixture = setup();
    const reason = new Error('cancelled');
    await assert.rejects(
      run(fixture, { signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.executions, []);
  });

  test(`${mode} abandons a returned tool batch when cancellation occurs inside the provider`, async () => {
    const entered = barrier();
    const resume = barrier();
    const controller = new AbortController();
    const fixture = setup({
      provider: async () => {
        entered.release();
        await resume.promise;
      },
    });
    const pending = run(fixture, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    resume.release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(fixture.executions, []);
    assert.equal(fixture.toolCalls.list().length, 0);
    await fixture.agent.complete('Continue.');
    assert.deepEqual(recoveryHistory(fixture), [
      ['assistant', ['call_first', 'call_second']],
      ['tool', 'call_first', 'incomplete'],
      ['tool', 'call_second', 'incomplete'],
      ['user', 'Continue.'],
    ]);
  });

  test(`${mode} lets an active tool finish but starts neither the next tool nor provider after cancellation`, async () => {
    const entered = barrier();
    const resume = barrier();
    const controller = new AbortController();
    const fixture = setup({
      tool: async () => {
        entered.release();
        await resume.promise;
      },
    });
    const pending = run(fixture, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    resume.release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(fixture.executions, ['first']);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(
      fixture.toolCalls.list().map(({ callId }) => callId),
      ['call_first'],
    );
    await fixture.agent.complete('Continue.');
    assert.deepEqual(
      fixture.requests[1]?.messages
        .filter(({ role }) => role === 'tool')
        .map(({ toolCallId, toolResultStatus }) => [
          toolCallId,
          toolResultStatus,
        ]),
      [
        ['call_first', undefined],
        ['call_second', 'incomplete'],
      ],
    );
  });

  test(`${mode} rechecks cancellation after an awaited tool.started callback`, async () => {
    const entered = barrier();
    const resume = barrier();
    const controller = new AbortController();
    const fixture = setup();
    const pending = run(fixture, {
      signal: controller.signal,
      onToolEvent: async (event) => {
        if (event.type === 'tool.started') {
          entered.release();
          await resume.promise;
        }
      },
    });
    await entered.promise;
    controller.abort();
    resume.release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(fixture.executions, []);
    assert.equal(
      fixture.messages
        .list()
        .filter(({ toolResultStatus }) => toolResultStatus === 'incomplete')
        .length,
      2,
    );
  });

  test(`${mode} preserves callback error identity without reporting a completed tool as failed`, async () => {
    const fixture = setup();
    const failure = new Error('callback failure');
    const events: string[] = [];
    const entered = barrier();
    const resume = barrier();
    const outcome = run(fixture, {
      onToolEvent: async (event) => {
        events.push(event.type);
        if (event.type === 'tool.finished') {
          entered.release();
          await resume.promise;
          throw failure;
        }
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    // Let runnable work drain while the callback remains blocked.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.deepEqual(fixture.executions, ['first']);
      assert.equal(fixture.requests.length, 1);
    } finally {
      resume.release();
    }
    assert.equal(await outcome, failure);
    assert.deepEqual(events, ['tool.started', 'tool.finished']);
    await fixture.agent.complete('Continue.');
    assert.deepEqual(
      fixture.requests[1]?.messages
        .filter(({ role }) => role === 'tool')
        .map(({ toolCallId, toolResultStatus }) => [
          toolCallId,
          toolResultStatus,
        ]),
      [
        ['call_first', undefined],
        ['call_second', 'incomplete'],
      ],
    );
  });
}

for (const boundary of [
  'response.finished',
  'tool.started',
  'tool.finished',
] as const) {
  test(`aborting a stream at ${boundary} prevents further tool and provider starts`, async () => {
    const fixture = setup();
    const controller = new AbortController();
    await assert.rejects(
      async () => {
        for await (const event of fixture.agent.stream('Run.', {
          signal: controller.signal,
        })) {
          if (event.type === boundary) controller.abort();
        }
      },
      { name: 'AbortError' },
    );
    assert.deepEqual(
      fixture.executions,
      boundary === 'tool.finished' ? ['first'] : [],
    );
    assert.equal(fixture.requests.length, 1);
  });

  test(`closing a stream at ${boundary} completes abandoned calls without execution records`, async () => {
    const fixture = setup();
    for await (const event of fixture.agent.stream('Run.')) {
      if (event.type === boundary) break;
    }
    const completed = boundary === 'tool.finished';
    assert.deepEqual(fixture.executions, completed ? ['first'] : []);
    assert.equal(fixture.toolCalls.list().length, completed ? 1 : 0);
    await fixture.agent.complete('Continue.');
    assert.deepEqual(recoveryHistory(fixture), [
      ['assistant', ['call_first', 'call_second']],
      ['tool', 'call_first', completed ? undefined : 'incomplete'],
      ['tool', 'call_second', 'incomplete'],
      ['user', 'Continue.'],
    ]);
  });
}

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} handler failure leaves the abandoned batch ready for the next run without records`, async () => {
    const failure = new Error('handler failed');
    const fixture = setup({
      tool: async () => {
        throw failure;
      },
    });
    await assert.rejects(
      mode === 'complete'
        ? fixture.agent.complete('Run.')
        : collect(fixture.agent.stream('Run.')),
      (error) => error instanceof Error && error.cause === failure,
    );
    assert.deepEqual(fixture.executions, ['first']);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.toolCalls.list(), []);
    await fixture.agent.complete('Continue.');
    assert.deepEqual(recoveryHistory(fixture), [
      ['assistant', ['call_first', 'call_second']],
      ['tool', 'call_first', 'incomplete'],
      ['tool', 'call_second', 'incomplete'],
      ['user', 'Continue.'],
    ]);
  });
}
