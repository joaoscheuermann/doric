import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type { ProviderMessage } from 'llms';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';

import { seedHistory, testConfiguration, thread } from './support/harness.js';
import { routed, scope, sessionId } from './support/router.js';
import {
  failureOf,
  inspect,
  kernelOf,
  kernelTool,
  scriptedModel,
  seedSession,
  skills,
  usingTool,
} from './support/router-helpers.js';
import { plain, wireThread } from './support/router-wire.js';

// The prompt session a routed `executor/v1` call reaches (phase 3, slices
// S51d/S51e, contract §6, D25, D26b, D26c, D28, D28b): steers taken between
// turns, and a cancel through the session aborting the model, tool and
// summarizer calls.

/** A configuration whose compaction condenses past a 1 000-character budget (D26). */
const compactable = () =>
  ({
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: true,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        charBudget: 1000,
      },
    },
  }) as ReturnType<typeof testConfiguration>;

/** A history long enough for {@link compactable} to condense (D26). */
const longHistory = {
  messages: [
    ...Array.from({ length: 12 }, (_, index) => ({
      role: 'user' as const,
      content: `old message ${index} ${'padding '.repeat(25)}`,
    })),
    { role: 'user' as const, content: 'recent' },
  ],
  checkpoints: { early: 6, late: 12 },
};

void test('D25 steers are taken before every turn, the first too, in the kernel’s order and recorded in their envelope; a retained bundle steer is kept in meta.retained', async (t) => {
  const steer = {
    prompt: 'Keep the tests green.',
    source: {
      kind: 'bundle' as const,
      bundleId: 'reviewer',
      reason: 'standing',
      retain: true as const,
    },
  };
  const kernelOrder: string[] = [];
  const kernelModel = usingTool().provider;
  const kernelWithTool = kernelOf({
    provider: {
      ...kernelModel,
      stream: (request: Parameters<typeof kernelModel.stream>[0]) => {
        kernelOrder.push('stream');
        return kernelModel.stream(request);
      },
    },
    skills,
    tools: [kernelTool('inspect')],
  });
  const kernelSession = kernelWithTool.state.session;
  kernelWithTool.state.session = (id) => {
    const session = kernelSession(id);
    return {
      ...session,
      steers: () => {
        kernelOrder.push('takeSteers');
        return session.steers?.() ?? Promise.resolve([]);
      },
    };
  };
  kernelWithTool.state.onEvent((event) => {
    if ((event as { type?: string }).type === 'tool.started')
      kernelWithTool.state.steering.push(steer);
  });
  await kernelWithTool.run('use the tool');
  const host = routed({
    provider: usingTool().provider,
    tools: [inspect],
    skills,
  });
  t.after(() => host.router.control.stop());
  host.session.onEvent = (event) => {
    if ((event as { type?: string }).type === 'tool.started')
      host.session.steering.push(steer);
  };
  await host.activate();

  await host.run('use the tool');

  const order = host.calls
    .filter(
      ({ service, method }) =>
        (service === ModelsService.typeName && method === 'stream') ||
        (service === SessionService.typeName && method === 'takeSteers'),
    )
    .map(({ method }) => method);
  assert.deepEqual(kernelOrder.slice(0, 2), ['takeSteers', 'stream']);
  assert.deepEqual(order, kernelOrder);
  const messages = host.session.parts.messages as readonly ProviderMessage[];
  const kernelMessages = kernelWithTool.state.parts()
    .messages as readonly ProviderMessage[];
  const steered = kernelMessages.find(({ content }) =>
    String(content).includes(steer.prompt),
  );
  assert.ok(steered !== undefined, 'the kernel records the steer');
  assert.deepEqual(
    plain(
      messages.find(({ content }) => String(content).includes(steer.prompt)),
    ),
    plain(steered),
  );
  assert.ok(
    'reviewer:standing' in
      ((host.session.parts.meta as { retained?: object }).retained ?? {}),
  );
});

void test('D28 (S51e) the session cancelled while the model streams aborts the model stream; the history the run left is recorded after the cancel; the Run fails run_cancelled without being cancelled itself', async (t) => {
  let started: () => void = () => undefined;
  const streaming = new Promise<void>((resolve) => {
    started = resolve;
  });
  const host = routed({
    provider: scriptedModel([
      {
        before: async (request) => {
          started();
          await new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () =>
              reject(request.signal?.reason),
            );
          });
        },
      },
    ]).provider,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  // The Run call is never cancelled by its caller: no signal is given.
  const run = host.run('hello');
  run.catch(() => undefined);
  await streaming;
  const recordedBefore = host.session.records.length;
  await host.session.cancel();

  const error = await failureOf(run);
  assert.equal(error.code, 'run_cancelled', error.message);
  assert.equal(host.modelSignals[0]?.aborted, true);
  const late = host.session.records.slice(recordedBefore);
  const saved = late.filter(({ history }) => history !== undefined).at(-1);
  const messages = saved?.history?.parts.messages as
    | readonly ProviderMessage[]
    | undefined;
  assert.ok(
    messages?.some(({ content }) => String(content).includes('hello')),
    'the history the cancelled run left is recorded after the cancel',
  );
});

void test('D28b (S51e) the session cancelled while a tool Execute runs a slow command aborts the Execute call within one turn, not at the grace, and the history the run left is recorded', async (t) => {
  let executing: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    executing = resolve;
  });
  const host = routed({
    provider: usingTool().provider,
    tools: [
      {
        ...inspect,
        // A slow command: it ends only when its call is cancelled.
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

  const run = host.run('use the tool');
  run.catch(() => undefined);
  await inFlight;
  const recordedBefore = host.session.records.length;
  const cancelledAt = Date.now();
  await host.session.cancel();

  await failureOf(run);
  const execute = host.toolSignals.find(({ method }) => method === 'execute');
  assert.equal(execute?.signal.aborted, true, 'the Execute call is cancelled');
  assert.ok(
    Date.now() - cancelledAt < 1_000,
    'the Execute call ends with the cancel, not at the 5 s grace',
  );
  const saved = host.session.records
    .slice(recordedBefore)
    .filter(({ history }) => history !== undefined)
    .at(-1)?.history?.parts.messages as readonly ProviderMessage[] | undefined;
  assert.ok(
    saved?.some(({ content }) => String(content).includes('use the tool')),
    'the history the run left is recorded',
  );
});

void test('D26b (S51e) the session cancelled while the summarizer streams aborts the model call; compaction.failed summarizer_failed is recorded with no history and Compact answers failed summarizer_failed, as the kernel compaction aborted at the same point', async (t) => {
  let started: () => void = () => undefined;
  const summarizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const summarizer = () =>
    scriptedModel([
      {
        before: async (request) => {
          started();
          await new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () =>
              reject(request.signal?.reason),
            );
          });
        },
      },
    ]);
  const kernel = kernelOf({
    provider: summarizer().provider,
    configuration: compactable(),
  });
  kernel.activate();
  seedHistory(kernel.state, longHistory);
  const controller = new AbortController();
  const kernelAnswer = kernel.services.executor(scope).compact(
    {
      thread: thread(),
      session: kernel.state.session('compaction'),
      policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
    },
    { signal: controller.signal },
  );
  await summarizing;
  controller.abort();
  const expected = await kernelAnswer;
  started = () => undefined;
  const restarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const host = routed({
    provider: summarizer().provider,
    configuration: compactable(),
  });
  t.after(() => host.router.control.stop());
  seedSession(host.session, longHistory);
  await host.activate();

  const compacting = host.executor.compact({
    sessionId,
    thread: wireThread(),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  compacting.catch(() => undefined);
  await restarted;
  const recordedBefore = host.session.records.length;
  await host.session.cancel(sessionId);
  const answer = await compacting;

  assert.equal(host.modelSignals[0]?.aborted, true, 'the model call aborted');
  assert.deepEqual(
    { status: answer.status, code: answer.code },
    { status: 'failed', code: 'summarizer_failed' },
  );
  assert.deepEqual(plain(expected), {
    status: 'failed',
    code: 'summarizer_failed',
  });
  const late = host.session.records.slice(recordedBefore);
  assert.deepEqual(
    late.map(({ history, event }) => ({
      history: history !== undefined,
      type: (event as { type?: string } | undefined)?.type,
      code: (event as { code?: string } | undefined)?.code,
    })),
    [{ history: false, type: 'compaction.failed', code: 'summarizer_failed' }],
  );
  // The kernel's records of the same compaction, by type and code (the error each carries is its own).
  const shapeOf = (writes: typeof late) =>
    writes.map(({ history, event }) => ({
      history: history !== undefined,
      type: (event as { type?: string } | undefined)?.type,
      code: (event as { code?: string } | undefined)?.code,
    }));
  assert.deepEqual(
    shapeOf(host.session.records),
    shapeOf(kernel.state.writes),
    'the same records as the kernel',
  );
});

void test('D26c (S51e) the session cancelled before Compact reads the history fails the compaction summarizer_failed: no model answer, and no history beyond compaction.started and compaction.failed', async (t) => {
  // C-E5: no parity with the kernel, whose summarizer ignores an aborted signal; the routed one is cancelled.
  const model = scriptedModel([
    { text: 'The conversation asked for an overview.' },
  ]);
  const host = routed({
    provider: model.provider,
    configuration: compactable(),
  });
  t.after(() => host.router.control.stop());
  seedSession(host.session, longHistory);
  await host.activate();
  let release: () => void = () => undefined;
  host.session.readHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recordedBefore = host.session.records.length;

  const compacting = host.executor.compact({
    sessionId,
    thread: wireThread(),
    policy: { tailMinMessages: 2, summaryMaxChars: 6000 },
  });
  compacting.catch(() => undefined);
  const cancelled = host.session.cancel(sessionId);
  cancelled.catch(() => undefined);
  // ReadHistory holds until the item was yielded.
  try {
    await cancelled;
  } finally {
    release();
  }
  const answer = await compacting;

  assert.deepEqual(
    { status: answer.status, code: answer.code },
    { status: 'failed', code: 'summarizer_failed' },
  );
  assert.equal(model.requests.length, 0, 'no model answer');
  assert.deepEqual(
    host.session.records.slice(recordedBefore).map(({ history, event }) => ({
      history: history !== undefined,
      type: (event as { type?: string } | undefined)?.type,
      code: (event as { code?: string } | undefined)?.code,
    })),
    [
      { history: false, type: 'compaction.started', code: undefined },
      { history: false, type: 'compaction.failed', code: 'summarizer_failed' },
    ],
    'no history: the compaction starts and fails',
  );
});
