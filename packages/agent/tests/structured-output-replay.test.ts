import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { createMessageStorage } from 'messages';

import {
  call,
  collect,
  completeFinish,
  createProvider,
  createTestAgent as createAgent,
  createTools,
  streamEvents,
} from './fakes.js';

for (const mode of ['complete', 'stream'] as const) {
  test(`${mode} retains opaque replay from a rejected structured submission`, async () => {
    const replay = [{ type: 'opaque-reasoning', id: `replay-${mode}` }];

    const provider = createProvider({
      complete: (request, index) => {
        const terminal = request.tools?.at(-1)?.name ?? 'missing-terminal';

        const finish = completeFinish('', [
          call(terminal, { answer: index === 0 ? 42 : 'done' }),
        ]);

        return index === 0 ? { ...finish, replay } : finish;
      },
      stream: (request, index) => {
        const terminal = request.tools?.at(-1)?.name ?? 'missing-terminal';

        const finish = completeFinish('', [
          call(terminal, { answer: index === 0 ? 42 : 'done' }),
        ]);

        return streamEvents(index === 0 ? { ...finish, replay } : finish);
      },
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools().storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });
    const options = { schema: z.object({ answer: z.string() }) };

    if (mode === 'complete') {
      await agent.complete('Return it.', options);
    } else {
      await collect(agent.stream('Return it.', options));
    }

    const rejected = provider.requests[1]?.messages.find(
      (message) => message.role === 'assistant' && message.replay !== undefined,
    );

    assert.deepEqual(rejected?.replay, replay);
  });
}
