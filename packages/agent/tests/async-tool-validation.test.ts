import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageStorage } from 'messages';
import {
  createToolStorage,
  type Tool,
  ToolErrorObject,
  type ToolPayloadCheck,
} from 'tool';
import { z } from 'zod';

import type { Agent, AgentRunOptions } from '../src/index.js';
import {
  call,
  collect,
  completeFinish,
  createTestAgent as createAgent,
  createProvider,
  streamEvents,
} from './fakes.js';

type Mode = 'complete' | 'stream';

const invoke = (
  agent: Agent,
  mode: Mode,
  options: AgentRunOptions = {},
): Promise<unknown> =>
  mode === 'complete'
    ? agent.complete('Run tools.', options)
    : collect(agent.stream('Run tools.', options));

/** A tool double validated only by an asynchronous `check`, like a remote tool. */
const remoteTool = (
  name: string,
  log: { checks: string[]; executions: string[] },
): Tool => ({
  name,
  input: z.looseObject({}),
  output: z.unknown(),
  definition: {
    name,
    inputSchema: { type: 'object' },
    outputSchema: {},
    strict: true,
  },
  execute: async () => {
    log.executions.push(name);

    return `${name} done`;
  },
  check: async (payload): Promise<ToolPayloadCheck> => {
    log.checks.push(name);
    await Promise.resolve();

    return typeof (payload as { value?: unknown }).value === 'string'
      ? { success: true, data: payload }
      : {
          success: false,
          issues: [{ path: 'value', message: 'expected string' }],
        };
  },
});

for (const mode of ['complete', 'stream'] as const) {
  void test(`${mode} repairs a turn whose second call fails asynchronous validation`, async () => {
    const log = { checks: [] as string[], executions: [] as string[] };
    const rejected = completeFinish('', [
      call('first', { value: 'ok' }, 'call-first'),
      call('second', { value: 42 }, 'call-second'),
    ]);
    const accepted = completeFinish('', [
      call('first', { value: 'ok' }, 'call-first-2'),
      call('second', { value: 'ok' }, 'call-second-2'),
    ]);
    const finishes = [rejected, accepted, completeFinish('all done')];
    const provider = createProvider({
      complete: (_request, index) => finishes[index] ?? completeFinish('x'),
      stream: (_request, index) =>
        streamEvents(finishes[index] ?? completeFinish('x')),
    });
    const repairs: number[] = [];
    const agent = createAgent({
      provider: provider.provider,
      tools: createToolStorage([
        remoteTool('first', log),
        remoteTool('second', log),
      ]),
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    await invoke(agent, mode, {
      onToolCallRepair: ({ attempt }) => {
        repairs.push(attempt);
      },
    });

    assert.deepEqual(repairs, [1]);

    assert.deepEqual(log.executions, ['first', 'second']);

    assert.equal(provider.requests.length, 3);
  });

  void test(`${mode} stops validating at the first asynchronously rejected call`, async () => {
    const log = { checks: [] as string[], executions: [] as string[] };
    const finish = completeFinish('', [
      call('first', { value: 1 }, 'call-first'),
      call('second', { value: 'ok' }, 'call-second'),
    ]);
    const provider = createProvider({
      complete: () => finish,
      stream: () => streamEvents(finish),
    });
    const agent = createAgent({
      provider: provider.provider,
      tools: createToolStorage([
        remoteTool('first', log),
        remoteTool('second', log),
      ]),
      messages: createMessageStorage(),
      system: '',
      model: 'fake-model',
    });

    await assert.rejects(
      invoke(agent, mode, { maxToolCallRepairs: 0 }),
      (error: unknown) =>
        error instanceof ToolErrorObject &&
        error.data.code === 'invalid_payload' &&
        error.data.callId === 'call-first',
    );

    assert.deepEqual(log.checks, ['first']);

    assert.deepEqual(log.executions, []);
  });
}
