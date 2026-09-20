import assert from 'node:assert/strict';
import test from 'node:test';

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
  test(`${mode} forwards the same cancellation signal to every provider turn`, async () => {
    const controller = new AbortController();

    const provider = createProvider({
      complete: (_request, index) =>
        index === 0
          ? completeFinish('', [call('lookup')])
          : completeFinish('Done.'),
      stream: (_request, index) =>
        streamEvents(
          index === 0
            ? completeFinish('', [call('lookup')])
            : completeFinish('Done.'),
        ),
    });

    const agent = createAgent({
      provider: provider.provider,
      tools: createTools({ results: { lookup: 'found' } }).storage,
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    if (mode === 'complete') {
      await agent.complete('Find it.', { signal: controller.signal });
    } else {
      await collect(agent.stream('Find it.', { signal: controller.signal }));
    }

    assert.equal(provider.requests.length, 2);

    provider.requests.forEach((request) => {
      assert.equal(request.signal, controller.signal);
    });
  });
}
