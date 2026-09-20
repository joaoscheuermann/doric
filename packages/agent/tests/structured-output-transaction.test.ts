import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import type { JsonValue, ProviderRequest } from 'llms';
import { createMessageStorage } from 'messages';

import type { Agent, AgentResponse } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';

const terminal = (request: ProviderRequest<unknown>): string =>
  request.tools?.at(-1)?.name ?? 'missing-terminal';

const correction = (request: ProviderRequest<unknown>): string =>
  request.messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => (typeof content === 'string' ? content : ''))
    .find((content) => content.startsWith('# Structured output correction')) ??
  '';

const invoke = async <Output>(
  agent: Agent,
  mode: Mode,
  schema: z.ZodType<Output>,
): Promise<AgentResponse<Output>> => {
  if (mode === 'complete') {
    return agent.complete('Return it.', { schema });
  }

  const events = await collect(agent.stream('Return it.', { schema }));
  const finished = events.at(-1);

  assert.equal(finished?.type, 'agent.finished');

  if (finished?.type !== 'agent.finished') {
    assert.fail('Expected completion.');
  }

  return finished.response;
};

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} repairs one nested leaf without accepting collateral changes`, async () => {
    const schema = z.object({
      profile: z.object({ name: z.string(), age: z.number() }),
      stable: z.string(),
    });
    const first = { profile: { name: 'Ada', age: 'private' }, stable: 'keep' };
    const retry = { profile: { name: 'corrupt', age: 42 }, stable: 'corrupt' };

    const provider = createProvider({
      complete: (request, index) =>
        completeFinish('', [
          call(terminal(request), index === 0 ? first : retry),
        ]),
      stream: (request, index) =>
        streamEvents(
          completeFinish('', [
            call(terminal(request), index === 0 ? first : retry),
          ]),
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
    const response = await invoke(agent, mode, schema);
    const composed = { profile: { name: 'Ada', age: 42 }, stable: 'keep' };

    assert.deepEqual(response.structured, composed);

    assert.equal(response.text, JSON.stringify(composed));

    assert.equal(response.finish.text, JSON.stringify(composed));

    assert.deepEqual(messages.list().at(-1), {
      role: 'assistant',
      content: JSON.stringify(composed),
    });

    assert.match(correction(provider.requests[1]), /profile\.age/u);

    assert.match(
      correction(provider.requests[1]),
      /every other path will be ignored/u,
    );

    assert.doesNotMatch(correction(provider.requests[1]), /private|corrupt/u);
  });

  test(`${mode} repairs criteria 12 while preserving valid criteria 5 and 7`, async () => {
    const criterion = z.object({
      criterionIndex: z.number(),
      satisfied: z.boolean(),
      evidence: z.string(),
      observationId: z.literal('abc123'),
    });
    const schema = z.object({ criteria: z.array(criterion).length(13) });

    const criteria = Array.from({ length: 13 }, (_, index) => ({
      criterionIndex: index,
      satisfied: true,
      evidence: `proof-${index}`,
      observationId: 'abc123' as const,
    }));
    const first = structuredClone({ criteria });

    first.criteria[12].observationId = 'invalid' as 'abc123';

    const retry = structuredClone({ criteria });

    retry.criteria[5].evidence = 5 as unknown as string;

    retry.criteria[7].satisfied = 'no' as unknown as boolean;

    const provider = createProvider({
      complete: (request, index) =>
        completeFinish('', [
          call(terminal(request), index === 0 ? first : retry),
        ]),
      stream: (request, index) =>
        streamEvents(
          completeFinish('', [
            call(terminal(request), index === 0 ? first : retry),
          ]),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const response = await invoke(agent, mode, schema);

    assert.deepEqual(response.structured, { criteria });

    assert.match(
      correction(provider.requests[1]),
      /criteria\[12\]\.observationId/u,
    );

    assert.doesNotMatch(
      correction(provider.requests[1]),
      /criteria\[5\]|criteria\[7\]/u,
    );
  });

  test(`${mode} repairs multiple primitive paths including a missing field`, async () => {
    const schema = z.object({
      count: z.number(),
      nested: z.object({ enabled: z.boolean(), label: z.string() }),
      stable: z.string(),
    });

    const first = {
      count: 'wrong',
      nested: { enabled: 'wrong' },
      stable: 'keep',
    };

    const retry = {
      count: 3,
      nested: { enabled: true, label: 'ready' },
      stable: 'corrupt',
    };

    const provider = createProvider({
      complete: (request, index) =>
        completeFinish('', [
          call(terminal(request), index === 0 ? first : retry),
        ]),
      stream: (request, index) =>
        streamEvents(
          completeFinish('', [
            call(terminal(request), index === 0 ? first : retry),
          ]),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const response = await invoke(agent, mode, schema);

    assert.deepEqual(response.structured, {
      count: 3,
      nested: { enabled: true, label: 'ready' },
      stable: 'keep',
    });

    assert.match(correction(provider.requests[1]), /count/u);

    assert.match(correction(provider.requests[1]), /nested\.enabled/u);

    assert.match(correction(provider.requests[1]), /nested\.label/u);
  });

  test(`${mode} accepts the whole retry when composition fails a cross-field refinement`, async () => {
    const schema = z
      .object({ left: z.number(), right: z.number() })
      .refine(({ left, right }) => left === right, 'Values must match.');
    const first = { left: 1, right: 'wrong' };
    const retry = { left: 2, right: 2 };

    const provider = createProvider({
      complete: (request, index) =>
        completeFinish('', [
          call(terminal(request), index === 0 ? first : retry),
        ]),
      stream: (request, index) =>
        streamEvents(
          completeFinish('', [
            call(terminal(request), index === 0 ? first : retry),
          ]),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const response = await invoke(agent, mode, schema);

    assert.deepEqual(response.structured, retry);

    assert.equal(response.text, JSON.stringify(retry));
  });

  test(`${mode} clears the baseline after an ordinary tool turn`, async () => {
    const schema = z.object({ fixed: z.number(), stable: z.string() });

    const lookup = {
      name: 'lookup',
      inputSchema: { type: 'object' as const },
      outputSchema: {},
    };

    const provider = createProvider({
      complete: (request, index) => {
        if (index === 0) {
          return completeFinish('', [
            call(terminal(request), { fixed: 'wrong', stable: 'first' }),
          ]);
        }

        if (index === 1) {
          return completeFinish('', [call('lookup')]);
        }

        return completeFinish('', [
          call(terminal(request), { fixed: 2, stable: 'replacement' }),
        ]);
      },
      stream: (request, index) =>
        streamEvents(
          index === 0
            ? completeFinish('', [
                call(terminal(request), { fixed: 'wrong', stable: 'first' }),
              ])
            : index === 1
              ? completeFinish('', [call('lookup')])
              : completeFinish('', [
                  call(terminal(request), { fixed: 2, stable: 'replacement' }),
                ]),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools({ definitions: [lookup] }).storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const response = await invoke(agent, mode, schema);

    assert.deepEqual(response.structured, { fixed: 2, stable: 'replacement' });

    assert.equal(correction(provider.requests[2]), '');
  });
}

test('stream suppresses every rejected provider event and candidate value', async () => {
  const schema = z.object({ answer: z.string() });

  const provider = createProvider({
    stream: (request, index) =>
      streamEvents(
        index === 0
          ? completeFinish('private-rejected-delta', [
              call(terminal(request), { answer: 42 as unknown as JsonValue }),
            ])
          : completeFinish('', [call(terminal(request), { answer: 'done' })]),
      ),
  });

  const agent = createAgent({
    provider: provider.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });
  const events = await collect(agent.stream('Return it.', { schema }));

  assert.doesNotMatch(
    JSON.stringify(events),
    /private-rejected-delta|"answer":42/u,
  );

  assert.equal(
    events.filter(({ type }) => type === 'response.finished').length,
    1,
  );
});
