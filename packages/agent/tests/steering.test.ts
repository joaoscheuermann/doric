import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';
import { createMessageStorage } from 'messages';
import { z } from 'zod';

import type { Agent, AgentRunOptions } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createTestAgent as createAgent,
  createProvider,
  createTools,
  streamEvents,
} from './fakes.js';

/** The steering messages a caller holds until the loop takes them. */
const createSteering = () => {
  const pending: string[] = [];
  return {
    pending,
    send: (input: string) => pending.push(input),
    steering: () => pending.splice(0),
  };
};

const createHarness = (
  answer: (index: number) => ReturnType<typeof completeFinish>,
  onRequest?: (index: number) => void,
) => {
  const turn = (_request: ProviderRequest<unknown>, index: number) => {
    onRequest?.(index);
    return answer(index);
  };
  const provider = createProvider({
    complete: turn,
    stream: (request, index) => streamEvents(turn(request, index)),
  });
  const messages = createMessageStorage();
  const agent = createAgent({
    provider: provider.provider,
    tools: createTools({ results: { lookup: { found: true } } }).storage,
    messages,
    system: '',
    model: 'fake-model',
  });
  return { agent, messages, provider };
};

type Mode = 'complete' | 'stream';

/** Runs one mode to its end and returns its text and any steered inputs. */
const run = async (
  agent: Agent,
  mode: Mode,
  options: AgentRunOptions,
): Promise<{ readonly text: string; readonly steered: readonly string[] }> => {
  if (mode === 'complete') {
    const response = await agent.complete('Start.', options);
    return { text: response.text, steered: [] };
  }
  const events = await collect(agent.stream('Start.', options));
  const finished = events.filter((event) => event.type === 'agent.finished');
  assert.equal(finished.length, 1);
  return {
    text:
      finished[0]?.type === 'agent.finished' ? finished[0].response.text : '',
    steered: events.flatMap((event) =>
      event.type === 'agent.steered' ? [event.input] : [],
    ),
  };
};

const lastUser = (request: ProviderRequest<unknown> | undefined) =>
  request?.messages.filter((message) => message.role === 'user').at(-1)
    ?.content;

for (const mode of ['complete', 'stream'] as const) {
  void test(`${mode}: steering sent during a tool batch reaches the next turn`, async () => {
    const steer = createSteering();
    const harness = createHarness(
      (index) =>
        index === 0
          ? completeFinish('', [call('lookup')])
          : completeFinish('Adjusted.'),
      (index) => {
        if (index === 0) steer.send('Use the other file.');
      },
    );

    const result = await run(harness.agent, mode, {
      steering: steer.steering,
    });

    assert.equal(result.text, 'Adjusted.');
    assert.equal(harness.provider.requests.length, 2);
    // The steer follows the tool result, so the provider history stays valid.
    const [toolResult, steered] =
      harness.provider.requests[1]?.messages.slice(-2) ?? [];
    assert.equal(toolResult?.role, 'tool');
    assert.deepEqual(steered, { role: 'user', content: 'Use the other file.' });
    if (mode === 'stream')
      assert.deepEqual(result.steered, ['Use the other file.']);
    assert.deepEqual(steer.pending, []);
  });

  void test(`${mode}: steering sent during the final answer continues the run`, async () => {
    const steer = createSteering();
    const harness = createHarness(
      (index) =>
        completeFinish(index === 0 ? 'First answer.' : 'Second answer.'),
      (index) => {
        if (index === 0) steer.send('Also check the tests.');
      },
    );

    const result = await run(harness.agent, mode, {
      steering: steer.steering,
    });

    assert.equal(result.text, 'Second answer.');
    assert.equal(
      lastUser(harness.provider.requests[1]),
      'Also check the tests.',
    );
    assert.deepEqual(
      harness.messages.list().map((message) => message.content),
      ['Start.', 'First answer.', 'Also check the tests.', 'Second answer.'],
    );
  });

  void test(`${mode}: a run without steering finishes on its first answer`, async () => {
    const steer = createSteering();
    const harness = createHarness(() => completeFinish('Only answer.'));

    const result = await run(harness.agent, mode, {
      steering: steer.steering,
    });

    assert.equal(result.text, 'Only answer.');
    assert.equal(harness.provider.requests.length, 1);
  });

  void test(`${mode}: a run with no turn left leaves steering with the caller`, async () => {
    const steer = createSteering();
    const harness = createHarness(
      () => completeFinish('Last answer.'),
      () => steer.send('Too late.'),
    );

    const result = await run(harness.agent, mode, {
      maxTurns: 1,
      steering: steer.steering,
    });

    assert.equal(result.text, 'Last answer.');
    assert.deepEqual(steer.pending, ['Too late.']);
    assert.ok(
      harness.messages
        .list()
        .every((message) => message.content !== 'Too late.'),
    );
  });

  void test(`${mode}: a structured result leaves steering with the caller`, async () => {
    const steer = createSteering();
    const provider = createProvider({
      complete: (request) => {
        steer.send('After the result.');
        return completeFinish('', [
          call(request.tools?.[0]?.name ?? '', { answer: 'Done' }),
        ]);
      },
      stream: (request) => {
        steer.send('After the result.');
        return streamEvents(
          completeFinish('', [
            call(request.tools?.[0]?.name ?? '', { answer: 'Done' }),
          ]),
        );
      },
    });
    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const schema = z.object({ answer: z.string() });

    if (mode === 'complete') {
      const response = await agent.complete('Return JSON.', {
        schema,
        steering: steer.steering,
      });
      assert.deepEqual(response.structured, { answer: 'Done' });
    } else {
      const events = await collect(
        agent.stream('Return JSON.', { schema, steering: steer.steering }),
      );
      assert.ok(events.some((event) => event.type === 'agent.finished'));
    }

    assert.equal(provider.requests.length, 1);
    assert.deepEqual(steer.pending, ['After the result.']);
  });

  void test(`${mode}: a resumed run reads waiting steering before its first turn`, async () => {
    const steer = createSteering();
    steer.send('Change course.');
    const harness = createHarness(() => completeFinish('Changed.'));
    harness.messages.push({ role: 'user', content: 'Start.' });

    const result = await run(harness.agent, mode, {
      resume: true,
      steering: steer.steering,
    });

    assert.equal(result.text, 'Changed.');
    assert.equal(harness.provider.requests.length, 1);
    assert.equal(lastUser(harness.provider.requests[0]), 'Change course.');
    if (mode === 'stream') assert.deepEqual(result.steered, ['Change course.']);
  });
}
