import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';

import { type AgentStructuredAttemptEvent } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

const schema = z.object({ answer: z.string() });

const terminal = (request: {
  readonly tools?: readonly { readonly name: string }[];
}): string => request.tools?.at(-1)?.name ?? 'missing';

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} awaits safe structured-attempt events in submission order`, async () => {
    const provider = createProvider({
      complete: (request, index) =>
        completeFinish('', [
          call(terminal(request), { answer: index === 0 ? 42 : 'done' }),
        ]),
      stream: (request, index) =>
        streamEvents(
          completeFinish('', [
            call(terminal(request), { answer: index === 0 ? 42 : 'done' }),
          ]),
        ),
    });
    const events: AgentStructuredAttemptEvent[] = [];
    let observerActive = false;

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    const options = {
      schema,
      onStructuredAttempt: async (event: AgentStructuredAttemptEvent) => {
        assert.equal(observerActive, false);

        observerActive = true;

        await Promise.resolve();

        events.push(event);

        observerActive = false;
      },
    };

    if (mode === 'complete') {
      await agent.complete('Return it.', options);
    } else {
      await collect(agent.stream('Return it.', options));
    }

    assert.equal(events.length, 2);

    assert.deepEqual(events[0], {
      schemaVersion: 1,
      attempt: 1,
      runtimeAccepted: false,
      feedbackSent: true,
      diagnostic: events[0]?.diagnostic,
    });

    assert.match(events[0]?.diagnostic ?? '', /Field: answer/);

    assert.deepEqual(events[1], {
      schemaVersion: 1,
      attempt: 2,
      runtimeAccepted: true,
      feedbackSent: false,
    });
  });

  test(`${mode} aborts immediately when the structured-attempt callback fails`, async () => {
    const failure = new Error('observer stopped the run');

    const provider = createProvider({
      complete: (request) =>
        completeFinish('', [call(terminal(request), { answer: 'done' })]),
      stream: (request) =>
        streamEvents(
          completeFinish('', [call(terminal(request), { answer: 'done' })]),
        ),
    });
    const messages = createMessageStorage();

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages,
      system: '',
      model: 'fake-model',
    });

    const operation =
      mode === 'complete'
        ? agent.complete('Return it.', {
            schema,
            onStructuredAttempt: () => {
              throw failure;
            },
          })
        : collect(
            agent.stream('Return it.', {
              schema,
              onStructuredAttempt: () => {
                throw failure;
              },
            }),
          );

    await assert.rejects(operation, (error: unknown) => error === failure);

    assert.equal(provider.requests.length, 1);

    assert.deepEqual(messages.list(), [
      { role: 'user', content: 'Return it.' },
    ]);
  });

  test(`${mode} reports no feedback after the final rejected submission`, async () => {
    const provider = createProvider({
      complete: (request) =>
        completeFinish('', [call(terminal(request), { answer: 42 })]),
      stream: (request) =>
        streamEvents(
          completeFinish('', [call(terminal(request), { answer: 42 })]),
        ),
    });
    const feedback: boolean[] = [];

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    const options = {
      schema,
      onStructuredAttempt: (event: AgentStructuredAttemptEvent) => {
        feedback.push(event.feedbackSent);
      },
    };

    const operation =
      mode === 'complete'
        ? agent.complete('Return it.', options)
        : collect(agent.stream('Return it.', options));

    await assert.rejects(operation);

    assert.deepEqual(feedback, [true, true, false]);
  });
}
