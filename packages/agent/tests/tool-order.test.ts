import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';
import { createToolStorage, defineTool } from 'tool';

import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  streamEvents,
} from './fakes.js';

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} finishes each tool before starting the next provider-ordered call`, async () => {
    const trace: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;

    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const tools = createToolStorage([
      defineTool({
        name: 'first',
        input: z.object({}),
        output: z.string(),
        execute: async () => {
          trace.push('first.started');

          markFirstStarted();

          await firstMayFinish;

          trace.push('first.finished');

          return 'first result';
        },
      })(undefined as never),
      defineTool({
        name: 'second',
        input: z.object({}),
        output: z.string(),
        execute: () => {
          trace.push('second.started');

          return 'second result';
        },
      })(undefined as never),
    ]);

    const provider = createProvider({
      complete: (_request, index) =>
        index === 0
          ? completeFinish('', [call('first'), call('second')])
          : completeFinish('Done.'),
      stream: (_request, index) =>
        streamEvents(
          index === 0
            ? completeFinish('', [call('first'), call('second')])
            : completeFinish('Done.'),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    const operation =
      mode === 'complete'
        ? agent.complete('Run in order.')
        : collect(agent.stream('Run in order.'));

    await firstStarted;

    assert.deepEqual(trace, ['first.started']);

    releaseFirst();

    await operation;

    assert.deepEqual(trace, [
      'first.started',
      'first.finished',
      'second.started',
    ]);
  });
}
