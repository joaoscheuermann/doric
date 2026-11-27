// `threads`' host part through the router (phase 3, slice S52b, tests
// T1–T12, T14): `activate` registers the eight delegation tools with
// `tools/v1` as the kernel entry did (always available, positions 1000–1650),
// and `core`'s `ToolHandlerService` calls run them over
// `runtime.threads/v1`'s `ThreadsService` and `default.agents/v1`'s
// `AgentsService` under the relayed prompt scope. A tool's text answer is
// compared as parsed JSON (key order may differ).

import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonValue } from '@bufbuild/protobuf';

import { tool as eventsTool } from '../src/host/tools/thread-events.js';
import { tool as getTool } from '../src/host/tools/thread-get.js';
import { tool as interruptTool } from '../src/host/tools/thread-interrupt.js';
import { tool as listTool } from '../src/host/tools/thread-list.js';
import { tool as restartTool } from '../src/host/tools/thread-restart.js';
import { tool as sendTool } from '../src/host/tools/thread-send.js';
import { tool as spawnTool } from '../src/host/tools/thread-spawn.js';
import { tool as terminateTool } from '../src/host/tools/thread-terminate.js';
import { promptScope } from './support/router.js';
import {
  activated,
  callsOf,
  control,
  eventView,
  execute,
  promptId,
  review,
  threadId,
  toValue,
  view,
} from './support/router-fixtures.js';

// T1.
void test('T1: activate sends eight tools/v1.Register in catalog order, always available, with the definitions’ schemas as JSON text', async (t) => {
  const h = await activated(t);
  const expected = [
    [spawnTool, 1000],
    [listTool, 1100],
    [getTool, 1200],
    [eventsTool, 1300],
    [sendTool, 1400],
    [interruptTool, 1500],
    [terminateTool, 1600],
    [restartTool, 1650],
  ] as const;

  assert.deepEqual(
    h.registers,
    expected.map(([tool, order]) =>
      JSON.parse(
        JSON.stringify({
          tool: {
            name: tool.name,
            description: tool.description,
            definition: {
              name: tool.definition.name,
              description: tool.definition.description,
              inputSchema: JSON.stringify(tool.definition.inputSchema),
              outputSchema: JSON.stringify(tool.definition.outputSchema),
              strict: tool.definition.strict,
            },
          },
          options: { alwaysAvailable: true, order },
        }),
      ),
    ),
  );
});

// T2.
void test('T2: each control tool sends its ThreadsService request under the prompt scope and answers the control’s result as JSON', async (t) => {
  const h = await activated(t, { control });
  const accepted = { status: 'accepted', promptId };
  const listed = { items: [view], nextCursor: 'cursor-2' };
  const digested = {
    events: [
      { sequence: 1, type: 'assistant.message', promptId, summary: 'hello' },
    ],
    nextSequence: 1,
  };
  const cases: readonly (readonly [
    string,
    JsonValue,
    string,
    JsonValue,
    unknown,
  ])[] = [
    [
      'thread-spawn',
      { prompt: ' task ', title: ' Task ' },
      'spawn',
      { prompt: ' task ', title: ' Task ' },
      { threadId, promptId },
    ],
    ['thread-list', {}, 'list', { limit: 50 }, listed],
    [
      'thread-list',
      { limit: 5, cursor: '00000000-0000-4000-8000-000000000001' },
      'list',
      { limit: 5, cursor: '00000000-0000-4000-8000-000000000001' },
      listed,
    ],
    [
      'thread-get',
      { threadId },
      'get',
      { threadId },
      {
        thread: view,
        result: {
          status: 'completed',
          text: 'Done.',
          promptId,
          at: '2026-10-09T00:00:03.000Z',
        },
      },
    ],
    [
      'thread-events',
      { threadId },
      'events',
      { threadId, afterSequence: 0, limit: 20 },
      digested,
    ],
    [
      'thread-events',
      { threadId, afterSequence: 3, limit: 7 },
      'events',
      { threadId, afterSequence: 3, limit: 7 },
      digested,
    ],
    [
      'thread-send',
      { threadId, prompt: ' follow-up ' },
      'send',
      { threadId, prompt: ' follow-up ' },
      accepted,
    ],
    [
      'thread-terminate',
      { threadId },
      'terminate',
      { threadId },
      { ...view, state: 'cancelled' },
    ],
    ['thread-restart', { threadId }, 'restart', { threadId }, accepted],
    [
      'thread-restart',
      { threadId, prompt: ' again ' },
      'restart',
      { threadId, prompt: ' again ' },
      accepted,
    ],
  ];

  for (const [name, payload, method, request, expected] of cases) {
    const before = h.calls.length;
    const answer = await execute(h, name, payload);

    assert.deepEqual(
      h.calls.slice(before),
      [{ method, request, scope: promptScope }],
      name,
    );
    assert.deepEqual(JSON.parse(answer), expected, name);
  }
});

// T3.
void test('T3: thread-events digests each event as the kernel tool does, with nextSequence only when answered', async (t) => {
  const large = { data: 'x'.repeat(500) };
  const events = [
    eventView(1, 'plain text'),
    eventView(2, { text: 'said' }),
    eventView(3, { delta: 'partial' }),
    eventView(4, large),
  ];
  const pages = [{ events, nextSequence: 4 }, { events }];
  let page = 0;
  const h = await activated(t, {
    control: {
      events: async () => {
        const answer = pages[page];

        page += 1;

        return answer ?? assert.fail('a third events call');
      },
    },
  });

  const first = JSON.parse(await execute(h, 'thread-events', { threadId }));
  const second = JSON.parse(await execute(h, 'thread-events', { threadId }));
  const digests = [
    {
      sequence: 1,
      type: 'assistant.message',
      promptId,
      summary: 'plain text',
    },
    { sequence: 2, type: 'assistant.message', promptId, summary: 'said' },
    { sequence: 3, type: 'assistant.message', promptId, summary: 'partial' },
    {
      sequence: 4,
      type: 'assistant.message',
      promptId,
      summary: `${JSON.stringify(large).slice(0, 400)}…`,
    },
  ];

  assert.deepEqual(first, { events: digests, nextSequence: 4 });
  assert.deepEqual(second, { events: digests });
  assert.equal('nextSequence' in second, false);
});

// T4.
void test('T4: thread-interrupt answers the bare result string', async (t) => {
  const h = await activated(t, {
    control: { interrupt: async () => 'not_running' },
  });

  assert.equal(
    await execute(h, 'thread-interrupt', { threadId, promptId }),
    'not_running',
  );
  assert.deepEqual(callsOf(h, 'interrupt'), [
    {
      method: 'interrupt',
      request: { threadId, promptId },
      scope: promptScope,
    },
  ]);
});

// T5.
void test('T5: Check refuses the kernel’s invalid inputs and calls no service', async (t) => {
  const h = await activated(t, { control, agents: () => review });

  for (const [name, payload] of [
    ['thread-spawn', { prompt: '   ' }],
    ['thread-spawn', { prompt: 'task', title: '  ' }],
    ['thread-spawn', { prompt: 'task', agent: 'Foo Bar' }],
    ['thread-spawn', { prompt: 'task', effort: 'turbo' }],
    ['thread-spawn', { prompt: 'task', model: '' }],
    ['thread-send', { threadId, prompt: '' }],
    ['thread-list', { limit: 0 }],
    ['thread-list', { limit: 101 }],
    ['thread-get', { threadId: 'invalid' }],
    ['thread-events', { threadId, afterSequence: -1 }],
    ['thread-events', { threadId, limit: 0 }],
    ['thread-events', { threadId, limit: 51 }],
    ['thread-interrupt', { threadId, promptId: 'invalid' }],
    ['thread-terminate', { threadId, extra: true }],
    ['thread-restart', { threadId: 'invalid' }],
    ['thread-restart', { threadId, prompt: '' }],
    ['thread-restart', { threadId, prompt: '   ' }],
    ['thread-restart', { threadId, extra: true }],
  ] as const) {
    const answer = await h.client.check({
      name,
      payload: toValue(payload),
    });

    assert.equal(answer.success, false, `${name} ${JSON.stringify(payload)}`);
  }

  assert.deepEqual(h.calls, []);
});
