import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  ProviderErrorObject,
  type ProviderFinished,
  type ProviderRequest,
} from 'llms';
import { createMessageStorage } from 'messages';
import type { ToolCallRequest } from 'tool';

import { type Agent, AgentErrorObject } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

const terminalDescription =
  'Submit the final structured output and end the agent run.';
const answerSchema = z.object({ answer: z.string() });

const lookupDefinition = {
  name: 'lookup',
  inputSchema: { type: 'object' as const },
  outputSchema: {},
};

type Mode = 'complete' | 'stream';

type InvalidSubmission = {
  readonly name: string;
  readonly reason: RegExp;
  readonly finish: (request: ProviderRequest<unknown>) => ProviderFinished;
};

const terminalName = (request: ProviderRequest<unknown>): string => {
  const terminal = request.tools?.find(
    ({ description }) => description === terminalDescription,
  );

  assert.ok(terminal);

  return terminal.name;
};

const malformedCall = (name: string): ToolCallRequest => ({
  id: 'call_malformed',
  name,
  arguments: '{"answer":',
});

const correctionFrom = (
  request: ProviderRequest<unknown> | undefined,
): string | undefined =>
  request?.messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => (typeof content === 'string' ? content : ''))
    .find((content) => content.startsWith('# Structured output correction'));

const invoke = async (agent: Agent, mode: Mode) => {
  if (mode === 'complete') {
    return agent.complete('Return evidence.', { schema: answerSchema });
  }

  const events = await collect(
    agent.stream('Return evidence.', { schema: answerSchema }),
  );
  const final = events.at(-1);

  assert.equal(final?.type, 'agent.finished');

  if (final?.type !== 'agent.finished') {
    assert.fail('Expected the stream to finish successfully.');
  }

  return final.response;
};

const invalidSubmissions: readonly InvalidSubmission[] = [
  {
    name: 'a missing terminal call',
    reason: /ended without terminal structured output/i,
    finish: () => completeFinish('Unstructured answer.'),
  },
  {
    name: 'malformed terminal arguments',
    reason: /arguments must be valid JSON/i,
    finish: (request) =>
      completeFinish('', [malformedCall(terminalName(request))]),
  },
  {
    name: 'terminal arguments that fail the schema',
    reason: /failed schema validation/i,
    finish: (request) =>
      completeFinish('', [call(terminalName(request), { answer: 42 })]),
  },
  {
    name: 'duplicate terminal calls',
    reason: /must be the only tool call/i,
    finish: (request) => {
      const name = terminalName(request);

      return completeFinish('', [
        call(name, { answer: 'First' }, 'call_terminal_1'),
        call(name, { answer: 'Second' }, 'call_terminal_2'),
      ]);
    },
  },
  {
    name: 'mixed terminal and executable calls',
    reason: /must be the only tool call/i,
    finish: (request) =>
      completeFinish('', [
        call('lookup', { query: 'must-not-run' }),
        call(terminalName(request), { answer: 'Done' }),
      ]),
  },
];

for (const mode of ['complete', 'stream'] as const) {
  for (const submission of invalidSubmissions) {
    test(`${mode} repairs ${submission.name} without executing it`, async () => {
      const fake = createProvider({
        complete: (request, index) =>
          index === 0
            ? submission.finish(request)
            : completeFinish('', [
                call(terminalName(request), { answer: 'Done' }),
              ]),
        stream: (request, index) =>
          streamEvents(
            index === 0
              ? submission.finish(request)
              : completeFinish('', [
                  call(terminalName(request), { answer: 'Done' }),
                ]),
          ),
      });
      const tools = createTools({ definitions: [lookupDefinition] });
      const messages = createMessageStorage();

      const agent = createAgent({
        provider: fake.provider,
        tools: tools.storage,
        messages,
        system: '',
        model: 'fake-model',
      });
      const response = await invoke(agent, mode);

      assert.deepEqual(response.structured, { answer: 'Done' });

      assert.equal(fake.requests.length, 2);

      assert.equal(correctionFrom(fake.requests[0]), undefined);

      const correction = correctionFrom(fake.requests[1]);

      assert.ok(correction);

      assert.match(correction, new RegExp(terminalName(fake.requests[1])));

      assert.match(correction, submission.reason);

      assert.deepEqual(tools.calls, []);

      const stored = messages.list();

      assert.deepEqual(stored[0], {
        role: 'user',
        content: 'Return evidence.',
      });

      assert.deepEqual(stored.at(-1), {
        role: 'assistant',
        content: '{"answer":"Done"}',
      });

      assert.equal(
        stored.filter(
          ({ role, toolResultStatus }) =>
            role === 'tool' && toolResultStatus === 'incomplete',
        ).length,
        submission.finish(fake.requests[0]).toolCalls.length,
      );
    });
  }
}

test('correction feedback includes at most ten normalized issues without rejected values', async () => {
  const schema = z.object({
    items: z.array(z.object({ count: z.number() })),
  });

  const rejected = {
    items: Array.from({ length: 12 }, (_, index) => ({
      count: `private-value-${index}`,
    })),
  };

  const accepted = {
    items: Array.from({ length: 12 }, (_, index) => ({ count: index })),
  };

  const fake = createProvider({
    complete: (request, index) =>
      completeFinish('', [
        call(terminalName(request), index === 0 ? rejected : accepted),
      ]),
  });

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({ definitions: [lookupDefinition] }).storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await agent.complete('Return counts.', { schema });

  const correction = correctionFrom(fake.requests[1]);

  assert.ok(correction);

  assert.match(
    correction,
    /Only the following rejected paths will be applied/u,
  );

  assert.match(correction, /Do not encode objects or arrays as JSON strings\./);

  assert.match(
    correction,
    /Field: items\.0\.count\n {2}Kind: invalid_type\n {2}Expected: number\n {2}Problem:/,
  );

  assert.match(correction, /Field: items\.9\.count/);

  assert.doesNotMatch(correction, /Field: items\.10\.count/);

  assert.doesNotMatch(correction, /private-value/);
});

test('correction feedback preserves additional diagnostic lines', async () => {
  const schema = z.object({
    answer: z.string().superRefine((_, context) => {
      context.addIssue({
        code: 'custom',
        message: [
          'The answer is not authorized.',
          'Most similar valid answer: public-answer',
          'Other valid answers: none.',
        ].join('\n'),
      });
    }),
  });

  const fake = createProvider({
    complete: (request, index) =>
      completeFinish('', [
        call(terminalName(request), {
          answer: index === 0 ? 'private-answer' : 'public-answer',
        }),
      ]),
  });

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools().storage,
    messages: createMessageStorage(),
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Return an answer.', { schema, maxToolCallRepairs: 1 }),
  );

  const correction = correctionFrom(fake.requests[1]);

  assert.ok(correction);

  assert.match(
    correction,
    /Problem: The answer is not authorized\.\n {2}Most similar valid answer: public-answer\n {2}Other valid answers: none\./u,
  );

  assert.doesNotMatch(correction, /private-answer/u);
});

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} throws after two repair attempts with its latest error`, async () => {
    const fake = createProvider({
      complete: (request, index) => exhaustionFinish(request, index),
      stream: (request, index) =>
        streamEvents(exhaustionFinish(request, index)),
    });
    const messages = createMessageStorage();

    const agent = createAgent({
      provider: fake.provider,
      tools: createTools({ definitions: [lookupDefinition] }).storage,
      messages,
      system: '',
      model: 'fake-model',
    });
    let caught: unknown;

    try {
      await invoke(agent, mode);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AgentErrorObject);

    assert.equal(caught.data.code, 'invalid_structured_output');

    assert.match(caught.data.message, /must be the only tool call/i);

    assert.equal(caught.data.diagnostic, undefined);

    assert.equal(fake.requests.length, 3);

    assert.equal(correctionFrom(fake.requests[0]), undefined);

    assert.ok(correctionFrom(fake.requests[1]));

    assert.ok(correctionFrom(fake.requests[2]));

    assert.equal(
      messages.list().filter(({ role }) => role === 'assistant').length,
      3,
    );
  });
}

test('ordinary tool turns consume transient corrections without changing the retry budget', async () => {
  const sequence = ['first', 'second', 'third'] as const;

  const fake = createProvider({
    complete: (request, index) => {
      if (index === 0) {
        return completeFinish('Missing terminal.');
      }

      if (index === 1) {
        return completeFinish('', [call(sequence[0])]);
      }

      if (index === 2) {
        return completeFinish('', [malformedCall(terminalName(request))]);
      }

      if (index === 3) {
        return completeFinish('', [call(sequence[1])]);
      }

      if (index === 4) {
        return completeFinish('', [
          call(terminalName(request), { answer: 42 }),
        ]);
      }

      if (index === 5) {
        return completeFinish('', [call(sequence[2])]);
      }

      if (index === 6) {
        return completeFinish('', [
          call('lookup', { query: 'must-not-run' }),
          call(terminalName(request), { answer: 'Done' }),
        ]);
      }

      throw new Error('Retry budget was reset by an ordinary tool turn.');
    },
  });

  const tools = createTools({
    definitions: [
      lookupDefinition,
      ...sequence.map((name) => ({
        name,
        inputSchema: { type: 'object' as const },
        outputSchema: {},
      })),
    ],
  });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: fake.provider,
    tools: tools.storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  await assert.rejects(
    agent.complete('Use tools and return evidence.', { schema: answerSchema }),
    (error: unknown) =>
      error instanceof AgentErrorObject &&
      error.data.code === 'invalid_structured_output',
  );

  assert.equal(fake.requests.length, 5);

  assert.deepEqual(
    fake.requests.map((request) => correctionFrom(request) !== undefined),
    [false, true, false, true, false],
  );

  assert.deepEqual(
    tools.calls.map(({ name }) => name),
    sequence.slice(0, 2),
  );

  assert.deepEqual(
    messages
      .list()
      .filter(({ role }) => role === 'assistant')
      .flatMap(({ toolCalls }) => toolCalls?.map(({ name }) => name) ?? []),
    [
      sequence[0],
      terminalName(fake.requests[2]),
      sequence[1],
      terminalName(fake.requests[4]),
    ],
  );
});

test('stream suppresses invalid deltas and the invalid finished event', async () => {
  const fake = createProvider({
    stream: (request, index) =>
      streamEvents(
        index === 0
          ? {
              ...completeFinish('visible rejected delta', [
                call(terminalName(request), { answer: 42 }),
              ]),
            }
          : completeFinish('', [
              call(terminalName(request), { answer: 'Done' }),
            ]),
      ),
  });
  const messages = createMessageStorage();

  const agent = createAgent({
    provider: fake.provider,
    tools: createTools({ definitions: [lookupDefinition] }).storage,
    messages,
    system: '',
    model: 'fake-model',
  });

  const events = await collect(
    agent.stream('Return evidence.', { schema: answerSchema }),
  );

  assert.equal(
    events.filter(({ type }) => type === 'response.finished').length,
    1,
  );

  assert.equal(
    events.filter(({ type }) => type === 'agent.finished').length,
    1,
  );

  assert.equal(
    events.some(
      (event) =>
        event.type === 'text.delta' && event.delta === 'visible rejected delta',
    ),
    false,
  );

  assert.deepEqual(messages.list().at(-1), {
    role: 'assistant',
    content: '{"answer":"Done"}',
  });

  assert.equal(
    messages
      .list()
      .some(
        ({ role, toolResultStatus }) =>
          role === 'tool' && toolResultStatus === 'incomplete',
      ),
    true,
  );
});

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} leaves provider failures unchanged for structured runs`, async () => {
    const failure = new ProviderErrorObject({
      provider: 'fake',
      code: 'invalid_structured_output',
      message: 'Fake provider rejected native structured output.',
    });

    const fake = createProvider({
      complete: () => {
        throw failure;
      },
      stream: () => {
        throw failure;
      },
    });

    const agent = createAgent({
      provider: fake.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    const operation =
      mode === 'complete'
        ? agent.complete('Return evidence.', { schema: answerSchema })
        : collect(agent.stream('Return evidence.', { schema: answerSchema }));

    await assert.rejects(operation, (error: unknown) => error === failure);

    assert.equal(fake.requests.length, 1);

    assert.equal(fake.requests[0]?.schema, undefined);

    assert.equal(fake.requests[0]?.tools?.length, 1);

    assert.equal(fake.requests[0]?.toolChoice, undefined);

    assert.equal(fake.requests[0]?.parallelToolCalls, false);

    assert.equal(
      fake.requests[0]?.tools?.[0]?.name,
      'submit_structured_output',
    );
  });
}

const exhaustionFinish = (
  request: ProviderRequest<unknown>,
  index: number,
): ProviderFinished => {
  if (index === 0) {
    return completeFinish('Missing terminal.');
  }

  if (index === 1) {
    return completeFinish('', [malformedCall(terminalName(request))]);
  }

  if (index === 2) {
    const name = terminalName(request);

    return completeFinish('', [
      call(name, { answer: 'First' }, 'call_terminal_1'),
      call(name, { answer: 'Second' }, 'call_terminal_2'),
    ]);
  }

  return completeFinish('', [call(terminalName(request), { answer: index })]);
};
