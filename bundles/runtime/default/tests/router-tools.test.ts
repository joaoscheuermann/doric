import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ProviderMessage, ProviderRequest } from 'llms';
import { type ToolError, ToolErrorObject } from 'tool';

import { skill } from './support/harness.js';
import {
  type RecordedWrite,
  type RoutedTool,
  routed,
} from './support/router.js';
import {
  callsOf,
  eventually,
  failureOf,
  kernelOf,
  kernelTool,
  scriptedModel,
} from './support/router-helpers.js';
import { plain } from './support/router-wire.js';

// `default`'s host part through the router (phase 3, slice S51d, contract §6,
// D9-D13): the tools a routed run offers are `tools/v1`'s, checked with
// `Check` and run with `Execute`; their failures read as in process.

const callA = (payload: object) => ({
  name: 'a',
  arguments: JSON.stringify(payload),
});

/** The text of the last message of `request`: what the model read last. */
const lastText = (request: ProviderRequest | undefined): string =>
  String(request?.messages.at(-1)?.content);

/** The `tool.failed` events among `writes`, as plain JSON. */
const failedEvents = (writes: readonly RecordedWrite[]) =>
  writes
    .map(({ event }) => plain(event) as { type?: string; error?: unknown })
    .filter((event) => event?.type === 'tool.failed');

/** An error's `code`, at the top or under `data` (as the chat reads it). */
const codeOf = (error: unknown): unknown => {
  const value = error as { code?: unknown; data?: { code?: unknown } };
  return value?.code ?? value?.data?.code;
};

/** An error's `issues`, at the top or under `data`. */
const issuesOf = (error: unknown): unknown => {
  const value = error as { issues?: unknown; data?: { issues?: unknown } };
  return value?.issues ?? value?.data?.issues;
};

/**
 * The correction the kernel's repair turn reads after a call fails its
 * check: the agent's generic one, carrying none of the check's issues.
 */
const kernelCorrection = async (): Promise<string> => {
  const model = scriptedModel([
    { calls: [{ name: 'a', arguments: JSON.stringify(1) }] },
    { text: 'repaired' },
  ]);
  const kernel = kernelOf({
    provider: model.provider,
    tools: [kernelTool('a')],
  });
  await kernel.run('find');
  assert.equal(model.requests.length, 2, 'the kernel run repairs once');
  return lastText(model.requests[1]);
};

const schemaA = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
  additionalProperties: false,
};

void test('D9 (S51e) the model is offered List’s tools in order with their JSON Schemas, minus one whose results it cannot read, plus load_skill; a call is checked exactly once, then executed with Check’s data', async (t) => {
  const model = scriptedModel([
    { calls: [callA({ q: 'x' })] },
    { text: 'answer' },
  ]);
  const host = routed({
    provider: model.provider,
    inputModalities: ['text'],
    skills: [skill('later', 'Later body.', { alwaysAvailable: false })],
    tools: [
      {
        name: 'a',
        description: 'Finds things.',
        inputSchema: schemaA,
        check: (payload) => ({
          success: true,
          data: { ...(payload as object), limit: 10 },
        }),
        execute: () => ({ found: 1 }),
      },
      { name: 'images', resultModalities: ['image'] },
      { name: 'b', description: 'Does b.' },
    ],
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  assert.equal(await host.run('find x'), 'answer');

  const offered = model.requests[0]?.tools ?? [];
  assert.deepEqual(
    offered.map(({ name }) => name),
    ['a', 'b', 'load_skill'],
  );
  assert.deepEqual(offered[0]?.inputSchema, schemaA);
  assert.equal(offered[0]?.description, 'Finds things.');
  const tools = callsOf(host.calls, ToolsService).filter(
    ({ method }) => method !== 'list',
  );
  // The tool storage checks an async tool to validate the call and again
  // before it runs it (packages/tool); the second check takes the first's
  // answer, so one tool call makes exactly one `Check` (S51e, E2).
  const executeAt = tools.findIndex(({ method }) => method === 'execute');
  const checks = tools.filter(({ method }) => method === 'check');
  assert.equal(checks.length, 1, 'exactly one Check for the tool call');
  assert.ok(
    tools.slice(0, executeAt).every(({ method }) => method === 'check') &&
      checks.length === executeAt,
    'every Check comes before Execute',
  );
  for (const { request } of checks) {
    assert.deepEqual(request, { name: 'a', payload: { q: 'x' } });
  }
  assert.deepEqual(
    tools.slice(executeAt).map(({ method, request }) => ({ method, request })),
    [
      {
        method: 'execute',
        request: { name: 'a', payload: { q: 'x', limit: 10 } },
      },
    ],
  );
  const messages = host.session.parts.messages as readonly ProviderMessage[];
  const result = messages.find(
    ({ role, toolCallId }) => role === 'tool' && toolCallId === 'call-1',
  );
  assert.match(String(result?.content), /"found"/);
});

void test('D10 a Check answering issues is a repair turn without Execute', async (t) => {
  const model = scriptedModel([
    { calls: [callA({ q: 1 })] },
    { text: 'repaired' },
  ]);
  const host = routed({
    provider: model.provider,
    tools: [
      {
        name: 'a',
        inputSchema: schemaA,
        check: () => ({
          success: false,
          issues: [{ path: 'q', message: 'Expected a string.' }],
        }),
      },
    ],
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  assert.equal(await host.run('find'), 'repaired');

  assert.deepEqual(callsOf(host.calls, ToolsService, 'execute'), []);
  assert.equal(model.requests.length, 2);
  assert.equal(lastText(model.requests[1]), await kernelCorrection());
  assert.doesNotMatch(
    JSON.stringify(model.requests[1]?.messages),
    /Expected a string\./,
  );
});

void test('D10 one invalid call of a turn leaves every call of the turn unexecuted', async (t) => {
  const model = scriptedModel([
    {
      calls: [
        { name: 'a', arguments: JSON.stringify({ q: 'fine' }) },
        { name: 'b', arguments: JSON.stringify({ q: 2 }) },
      ],
    },
    { text: 'repaired' },
  ]);
  const host = routed({
    provider: model.provider,
    tools: [
      { name: 'a', inputSchema: schemaA },
      {
        name: 'b',
        inputSchema: schemaA,
        check: () => ({
          success: false,
          issues: [{ path: 'q', message: 'Expected a string.' }],
        }),
      },
    ],
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('find');

  assert.deepEqual(callsOf(host.calls, ToolsService, 'execute'), []);
  assert.equal(lastText(model.requests[1]), await kernelCorrection());
});

/** The kernel and the routed run of one tool failing with `error` (in process) or its routed form (`remote`). */
const failingRuns = async (
  t: test.TestContext,
  error: () => Error,
  remote: () => Error,
) => {
  const kernelModel = scriptedModel([
    { calls: [{ name: 'a', arguments: '{}' }] },
    { text: 'answer' },
  ]);
  const kernel = kernelOf({
    provider: kernelModel.provider,
    tools: [
      kernelTool('a', () => {
        throw error();
      }),
    ],
  });
  await kernel.run('run a');
  const model = scriptedModel([
    { calls: [{ name: 'a', arguments: '{}' }] },
    { text: 'answer' },
  ]);
  const host = routed({
    provider: model.provider,
    tools: [
      {
        name: 'a',
        execute: () => {
          throw remote();
        },
      },
    ],
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  await host.run('run a');

  return { kernel, kernelModel, host, model };
};

/** `data` as the SDK's tool handlers answer it: `tool_error` with the whole data in `details.toolError`. */
const toolErrorOf = (data: ToolError) =>
  new ContractError('tool_error', data.message, { toolError: data });

void test('D11 an Execute failing tool_error invalid_output reaches the run unwrapped, with its issues, as in process', async (t) => {
  const data: ToolError = {
    code: 'invalid_output',
    message: 'The output is invalid.',
    toolName: 'a',
    issues: [{ path: 'found', message: 'Expected a number.' }],
  };
  const { kernel, kernelModel, host, model } = await failingRuns(
    t,
    () => new ToolErrorObject(data),
    () => toolErrorOf(data),
  );

  const [failed] = failedEvents(host.session.records);
  assert.equal(codeOf(failed?.error), 'invalid_output');
  assert.deepEqual(issuesOf(failed?.error), data.issues);
  assert.deepEqual(
    failedEvents(host.session.records),
    failedEvents(kernel.state.writes),
  );
  assert.equal(lastText(model.requests[1]), lastText(kernelModel.requests[1]));
});

void test('D11 an Execute failing tool_error with another code is wrapped in handler_failed with that tool error as cause, as in process', async (t) => {
  const data: ToolError = {
    code: 'invalid_payload',
    message: 'The payload was refused.',
    toolName: 'a',
  };
  const { kernel, kernelModel, host, model } = await failingRuns(
    t,
    () => new ToolErrorObject(data),
    () => toolErrorOf(data),
  );

  const [failed] = failedEvents(host.session.records);
  assert.equal(codeOf(failed?.error), 'handler_failed');
  // The model reads the cause chain: the tool error, with its code and message.
  assert.match(lastText(model.requests[1]), /The payload was refused\./);
  assert.deepEqual(
    failedEvents(host.session.records),
    failedEvents(kernel.state.writes),
  );
  assert.equal(lastText(model.requests[1]), lastText(kernelModel.requests[1]));
});

void test('D12 an Execute failing internal reaches the model as its message, without the internal prefix', async (t) => {
  const { model } = await failingRuns(
    t,
    () => new Error('boom'),
    () => new Error('boom'),
  );

  const text = lastText(model.requests[1]);
  assert.match(text, /boom/);
  assert.doesNotMatch(text, /internal:/);
});

void test('D13 (S51e) the session cancelled while Execute is in flight cancels the Execute call; the Run fails run_cancelled; the last history holds the call with an incomplete result and tool.failed is recorded', async (t) => {
  let executing: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    executing = resolve;
  });
  const host = routed({
    provider: scriptedModel([
      { calls: [{ name: 'a', arguments: '{}' }] },
      { text: 'answer' },
    ]).provider,
    tools: [
      {
        name: 'a',
        execute: (_payload, signal) => {
          executing();
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        },
      },
    ],
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  const run = host.run('run a');
  run.catch(() => undefined);
  await inFlight;
  await host.session.cancel();
  const error = await failureOf(run);

  assert.equal(error.code, 'run_cancelled', error.message);
  const execute = host.toolSignals.find(({ method }) => method === 'execute');
  assert.equal(execute?.signal.aborted, true, 'the Execute call is cancelled');
  await eventually(() => {
    const records = host.session.records;
    const saved = records.filter(({ history }) => history !== undefined).at(-1)
      ?.history?.parts.messages as readonly ProviderMessage[] | undefined;
    const call = saved?.findIndex(
      ({ role, toolCalls }) =>
        role === 'assistant' && toolCalls?.[0]?.id === 'call-1',
    );
    assert.ok(call !== undefined && call >= 0, 'the call is in the history');
    // The agent's release() answers the unanswered call as incomplete (C-E4).
    const results = saved?.filter(
      ({ role, toolCallId }) => role === 'tool' && toolCallId === 'call-1',
    );
    assert.equal(results?.length, 1, 'one tool result for the cancelled call');
    assert.equal(results?.[0]?.toolResultStatus, 'incomplete');
    assert.equal(
      results?.[0]?.content,
      'Tool call did not complete. Execution may have been interrupted.',
    );
    assert.ok(
      failedEvents(records).some(
        (event) => (event as { call?: { id?: string } }).call?.id === 'call-1',
      ),
      'tool.failed is recorded for call-1',
    );
  });
});

void test('D9b (S51e) two calls of one tool with the same payload in a turn make two Checks and two Executes; the same payload in the next turn one more Check', async (t) => {
  const host = routed({
    provider: scriptedModel([
      { calls: [callA({ q: 'x' }), callA({ q: 'x' })] },
      { calls: [callA({ q: 'x' })] },
      { text: 'answer' },
    ]).provider,
    tools: [{ name: 'a', inputSchema: schemaA }],
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  assert.equal(await host.run('find x three times'), 'answer');

  const tools = callsOf(host.calls, ToolsService);
  assert.equal(
    tools.filter(({ method }) => method === 'check').length,
    3,
    'one Check per tool call',
  );
  assert.equal(tools.filter(({ method }) => method === 'execute').length, 3);
});

void test('D9c (S51e) a failed Check answer and a failed Check call are not reused: the repeated payload is checked again', async (t) => {
  const repeated = (check: NonNullable<RoutedTool['check']>) =>
    routed({
      provider: scriptedModel([
        { calls: [callA({ q: 'x' })] },
        { calls: [callA({ q: 'x' })] },
        { text: 'answer' },
      ]).provider,
      tools: [{ name: 'a', inputSchema: schemaA, check }],
    });
  const counted = async (host: ReturnType<typeof routed>) => {
    t.after(() => host.router.control.stop());
    await host.activate();
    assert.equal(await host.run('find x'), 'answer');
    const tools = callsOf(host.calls, ToolsService);
    return {
      checks: tools.filter(({ method }) => method === 'check').length,
      executes: tools.filter(({ method }) => method === 'execute').length,
    };
  };

  let refused = 0;
  const refusing = repeated((payload) => {
    refused += 1;
    return refused === 1
      ? { success: false, issues: [{ path: 'q', message: 'Not yet.' }] }
      : { success: true, data: payload };
  });
  assert.deepEqual(await counted(refusing), { checks: 2, executes: 1 });

  let failed = 0;
  const failing = repeated((payload) => {
    failed += 1;
    if (failed === 1)
      throw new ContractError('unavailable', 'The tool bundle restarts.');
    return { success: true, data: payload };
  });
  assert.deepEqual(await counted(failing), { checks: 2, executes: 1 });
});
