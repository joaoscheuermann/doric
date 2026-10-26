// How the loop answers a provider turn that is not an ordinary answer: a
// resumed history that already ends in its answer, a rejected turn's
// correction, a turn cut off by the output limit, a refused turn, and a
// provider failure that asking again may fix.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ProviderError,
  ProviderErrorObject,
  type ProviderStreamEvent,
} from 'llms';
import { createMessageStorage } from 'messages';
import { z } from 'zod';

import {
  type Agent,
  AgentErrorObject,
  type AgentRunOptions,
} from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createTestAgent as createAgent,
  createProvider,
  createTools,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';
const modes: readonly Mode[] = ['complete', 'stream'];

const invoke = async (
  agent: Agent,
  mode: Mode,
  options: AgentRunOptions = {},
): Promise<string> => {
  if (mode === 'complete') return (await agent.complete('Go.', options)).text;
  const events = await collect(agent.stream('Go.', options));
  const finished = events.find((event) => event.type === 'agent.finished');
  return finished?.type === 'agent.finished' ? finished.response.text : '';
};

const agentCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof AgentErrorObject && error.data.code === code;

const lookup = {
  name: 'lookup',
  inputSchema: { type: 'object' as const },
  outputSchema: {},
};

const providerError = (data: Partial<ProviderError>): ProviderErrorObject =>
  new ProviderErrorObject({
    provider: 'fake',
    code: 'provider_error',
    message: 'Provider failed.',
    ...data,
  });

for (const mode of modes) {
  void test(`${mode}: a resumed history that ends in its answer finishes without asking the model`, async () => {
    const provider = createProvider({});
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage([
        { role: 'user', content: 'Question.' },
        { role: 'assistant', content: 'The stored answer.' },
      ]),
      system: '',
      model: 'fake-model',
    });

    assert.equal(
      await invoke(agent, mode, { resume: true }),
      'The stored answer.',
    );
    assert.equal(provider.requests.length, 0);
  });

  void test(`${mode}: a resumed answer followed by steering asks the model, ending on the steering`, async () => {
    const provider = createProvider({
      complete: () => completeFinish('Steered answer.'),
      stream: () => streamEvents(completeFinish('Steered answer.')),
    });
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage([
        { role: 'user', content: 'Question.' },
        { role: 'assistant', content: 'The stored answer.' },
      ]),
      system: '',
      model: 'fake-model',
    });

    assert.equal(
      await invoke(agent, mode, {
        resume: true,
        steering: (() => {
          let sent = false;
          return () => {
            if (sent) return [];
            sent = true;
            return ['One more thing.'];
          };
        })(),
      }),
      'Steered answer.',
    );
    assert.deepEqual(provider.requests[0]?.messages.at(-1), {
      role: 'user',
      content: 'One more thing.',
    });
  });

  void test(`${mode}: a rejected tool call is corrected by a user turn that stays in the history`, async () => {
    const provider = createProvider({
      complete: (_, index) =>
        index === 0
          ? completeFinish('', [
              { id: 'call_bad', name: 'lookup', arguments: '{"broken' },
            ])
          : completeFinish('Done.'),
      stream: (_, index) =>
        streamEvents(
          index === 0
            ? completeFinish('', [
                { id: 'call_bad', name: 'lookup', arguments: '{"broken' },
              ])
            : completeFinish('Done.'),
        ),
    });
    const messages = createMessageStorage();
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools({ definitions: [lookup] }).storage,
      messages,
      system: 'Policy.',
      model: 'fake-model',
    });

    assert.equal(await invoke(agent, mode), 'Done.');

    const second = provider.requests[1];
    const last = second?.messages.at(-1);
    assert.equal(last?.role, 'user');
    assert.match(String(last?.content), /^# Tool call correction/u);
    // The system prompt is the same on every request.
    assert.deepEqual(
      provider.requests.map((request) =>
        request.messages.filter(({ role }) => role === 'system'),
      ),
      [
        [{ role: 'system', content: 'Policy.' }],
        [{ role: 'system', content: 'Policy.' }],
      ],
    );
    // The correction stays where it was given.
    assert.equal(
      messages
        .list()
        .some(
          (message) =>
            message.role === 'user' &&
            String(message.content).startsWith('# Tool call correction'),
        ),
      true,
    );
  });

  void test(`${mode}: a tool call the output limit cut short fails as truncated, runs nothing and is not repaired`, async () => {
    const truncated = {
      text: '',
      finishReason: 'length' as const,
      toolCalls: [
        { id: 'call_cut', name: 'lookup', arguments: '{"path":"a.tx' },
      ],
    };
    const provider = createProvider({
      complete: () => truncated,
      stream: () => streamEvents(truncated),
    });
    const tools = createTools({ definitions: [lookup] });
    const messages = createMessageStorage();
    const agent = createAgent({
      provider: provider.provider,
      tools: tools.storage,
      messages,
      system: '',
      model: 'fake-model',
    });

    await assert.rejects(invoke(agent, mode), agentCode('output_truncated'));
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(tools.calls, []);
    // The history stays valid: the cut call has its incomplete result.
    assert.equal(messages.list().at(-1)?.role, 'tool');
    assert.equal(messages.list().at(-1)?.toolResultStatus, 'incomplete');
  });

  void test(`${mode}: a structured submission the output limit cut short fails as truncated`, async () => {
    const provider = createProvider({
      complete: (request) => ({
        text: '',
        finishReason: 'length',
        toolCalls: [
          {
            id: 'call_out',
            name: request.tools?.at(-1)?.name ?? '',
            arguments: '{"answer":"hal',
          },
        ],
      }),
      stream: (request) =>
        streamEvents({
          text: '',
          finishReason: 'length',
          toolCalls: [
            {
              id: 'call_out',
              name: request.tools?.at(-1)?.name ?? '',
              arguments: '{"answer":"hal',
            },
          ],
        }),
    });
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const schema = z.object({ answer: z.string() });

    await assert.rejects(
      mode === 'complete'
        ? agent.complete('Go.', { schema })
        : collect(agent.stream('Go.', { schema })),
      agentCode('output_truncated'),
    );
    assert.equal(provider.requests.length, 1);
  });

  void test(`${mode}: a refused turn fails with the refusal and runs none of its calls`, async () => {
    const refused = {
      text: 'Sure, the first step',
      refusal: 'cyber',
      finishReason: 'content_filter' as const,
      toolCalls: [call('lookup', { query: 'x' })],
    };
    const provider = createProvider({
      complete: () => refused,
      stream: () => streamEvents(refused),
    });
    const tools = createTools({ definitions: [lookup] });
    const messages = createMessageStorage();
    const agent = createAgent({
      provider: provider.provider,
      tools: tools.storage,
      messages,
      system: '',
      model: 'fake-model',
    });

    await assert.rejects(invoke(agent, mode), (error: unknown) => {
      assert.ok(agentCode('provider_refusal')(error));
      assert.match((error as Error).message, /cyber/u);
      return true;
    });
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(tools.calls, []);
    const last = messages.list().at(-1);
    assert.equal(last?.role, 'assistant');
    assert.equal(last?.toolCalls, undefined);
  });

  void test(`${mode}: a retryable failure before any output is asked again`, async () => {
    const provider = createProvider({
      complete: (_, index) => {
        if (index < 2) throw providerError({ retryable: true, status: 529 });
        return completeFinish('Recovered.');
      },
      stream: (_, index) =>
        (async function* (): AsyncGenerator<ProviderStreamEvent<unknown>> {
          if (index < 2) {
            yield {
              type: 'response.started',
              provider: 'fake',
              model: 'fake-model',
            };
            yield {
              type: 'error',
              error: {
                provider: 'fake',
                code: 'overloaded_error',
                message: 'Overloaded.',
                retryable: true,
              },
            };
            return;
          }
          yield* streamEvents(completeFinish('Recovered.'));
        })(),
    });
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
      retry: { baseDelayMs: 0 },
    });

    if (mode === 'complete') {
      assert.equal((await agent.complete('Go.')).text, 'Recovered.');
    } else {
      const events = await collect(agent.stream('Go.'));
      // The failed attempts leave no trace: no error and no extra start.
      assert.equal(events.filter((event) => event.type === 'error').length, 0);
      assert.equal(
        events.filter((event) => event.type === 'response.started').length,
        1,
      );
    }
    assert.equal(provider.requests.length, 3);
  });

  void test(`${mode}: a failure that is not retryable, or keeps failing, is the run's error`, async () => {
    for (const [retryable, expected] of [
      [false, 1],
      [true, 3],
    ] as const) {
      const provider = createProvider({
        complete: () => {
          throw providerError({ retryable, message: 'Bad request.' });
        },
        stream: () =>
          (async function* (): AsyncGenerator<ProviderStreamEvent<unknown>> {
            yield {
              type: 'error',
              error: {
                provider: 'fake',
                code: 'bad_request',
                message: 'Bad request.',
                retryable,
              },
            };
          })(),
      });
      const agent = createAgent({
        provider: provider.provider,
        tools: createTools().storage,
        messages: createMessageStorage(),
        system: '',
        model: 'fake-model',
        retry: { baseDelayMs: 0 },
      });

      await assert.rejects(
        mode === 'complete'
          ? agent.complete('Go.')
          : collect(agent.stream('Go.')),
        (error: unknown) =>
          error instanceof ProviderErrorObject &&
          error.message === 'Bad request.',
      );
      assert.equal(provider.requests.length, expected);
    }
  });
}

void test('stream: a failure after output has flowed is never asked again', async () => {
  const provider = createProvider({
    stream: () =>
      (async function* (): AsyncGenerator<ProviderStreamEvent<unknown>> {
        yield { type: 'response.started', provider: 'fake', model: 'm' };
        yield { type: 'text.delta', delta: 'Partial' };
        yield {
          type: 'error',
          error: {
            provider: 'fake',
            code: 'incomplete_stream',
            message: 'The stream ended early.',
            retryable: true,
          },
        };
      })(),
  });
  const agent = createAgent({
    provider: provider.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
    retry: { baseDelayMs: 0 },
  });

  await assert.rejects(
    collect(agent.stream('Go.')),
    (error: unknown) =>
      error instanceof ProviderErrorObject &&
      error.data.code === 'incomplete_stream',
  );
  assert.equal(provider.requests.length, 1);
});

void test('complete: the wait before a retry honours the provider delay and the abort signal', async () => {
  const provider = createProvider({
    complete: () => {
      throw providerError({ retryable: true, retryAfterMs: 60_000 } as never);
    },
  });
  const agent = createAgent({
    provider: provider.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
    retry: { baseDelayMs: 0, maxDelayMs: 60_000 },
  });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error('Stopped.')), 20);

  await assert.rejects(
    agent.complete('Go.', { signal: controller.signal }),
    /Stopped\./u,
  );
  // The 60-second wait the provider asked for ended with the abort.
  assert.ok(Date.now() - started < 5_000);
  assert.equal(provider.requests.length, 1);
});
