// `terminal`'s host part through the router (phase 3, S54b, R1–R9, R18,
// R19): `activate`'s registrations, `Run` on a routed Thread session and its
// `runtime.lease/v1.Start` stream, the background delivery, and the failures
// of the session and the start. The harness is `./support/router.ts`.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { type CallScope, ContractError } from 'bundle/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import { backgroundResultText } from '../src/host/provider.js';
import { createTool } from '../src/host/tool.js';
import {
  type FakeThread,
  type Harness,
  harness,
  promptScope,
  REQUIRES,
} from './support/router.js';
import {
  activated,
  codeOf,
  processAt,
  rejectionOf,
  sleep,
  until,
  watching,
} from './support/router-fixtures.js';

const command = (overrides: Record<string, unknown> = {}) => ({
  command: 'echo hi',
  cwd: '/workspace/app',
  timeoutMs: 0,
  ...overrides,
});

const methodCalls = (h: Harness, method: string) =>
  h.calls.filter((call) => call.method === method);

const first = async <T>(stream: AsyncIterable<T>): Promise<T | undefined> => {
  for await (const item of stream) return item;

  return undefined;
};

/** The `Start` head a foreground `Run` of `cmd` on `session-1` sends. */
const agentHead = (cmd: string, threadSessionId = 'session-1') => ({
  target: { threadSessionId },
  request: { cmd: ['sh', '-lc', cmd], cwd: '/workspace/app', tty: false },
});

void test('R1: activate registers the terminal tool and the closing hook, opens one WatchRedactions, and opens no session', async (t) => {
  const h = await activated(t);
  const tool = createTool();
  const registers = h.toolRegisters as {
    readonly tool: {
      readonly name: string;
      readonly definition: {
        readonly inputSchema: string;
        readonly outputSchema: string;
      };
    };
    readonly options: unknown;
  }[];

  assert.equal(registers.length, 1);
  assert.equal(registers[0]?.tool.name, 'terminal');
  assert.equal(
    registers[0]?.tool.definition.inputSchema,
    JSON.stringify(tool.definition.inputSchema),
  );
  assert.equal(
    registers[0]?.tool.definition.outputSchema,
    JSON.stringify(tool.definition.outputSchema),
  );
  assert.deepEqual(registers[0]?.options, {
    alwaysAvailable: true,
    order: 500,
  });
  assert.deepEqual(h.hookRegisters, [
    { contract: 'runtime.hooks/v1', hook: 'onThreadsClosingHook' },
  ]);
  assert.equal(methodCalls(h, 'secrets.watchRedactions').length, 1);
  assert.equal(methodCalls(h, 'workspace.openThread').length, 0);
  assert.equal(methodCalls(h, 'lease.start').length, 0);
});

void test('R2: before activate every TerminalService method fails unavailable', async (t) => {
  const h = harness();

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  const client = h.terminal(promptScope);
  const calls: readonly (readonly [string, Promise<unknown>])[] = [
    ['Run', client.run(command())],
    ['List', client.list({ projectId: 'project-1' })],
    ['Create', client.create({ threadId: 'thread-1' })],
    ['Snapshot', client.snapshot({ terminalId: 'terminal-1' })],
    ['Input', client.input({ terminalId: 'terminal-1', data: 'x' })],
    ['Resize', client.resize({ terminalId: 'terminal-1', cols: 1, rows: 1 })],
    ['Stop', client.stop({ terminalId: 'terminal-1' })],
    ['Rename', client.rename({ terminalId: 'terminal-1' })],
    ['WatchProject', first(client.watchProject({ projectId: 'project-1' }))],
  ];

  for (const [name, call] of calls) {
    assert.equal(await codeOf(call), 'unavailable', name);
  }
});

void test('R3: a foreground Run opens a session under its scope, starts on it, ends the session at started and answers the exit', async (t) => {
  const h = await activated(t);
  const running = h.terminal(promptScope).run(command());
  const process = await processAt(h);

  assert.deepEqual(
    h.timeline.filter((entry) =>
      [
        'workspace.openThread',
        'workspace.threadState',
        'secrets.redactions',
        'lease.start',
      ].includes(entry),
    ),
    [
      'workspace.openThread',
      'workspace.threadState',
      'secrets.redactions',
      'lease.start',
    ],
  );
  assert.deepEqual(h.sessions[0]?.request, {
    threadId: 'thread-1',
    exclusive: false,
  });
  assert.deepEqual(h.sessions[0]?.scope, promptScope);
  assert.deepEqual(process.head, agentHead('echo hi'));

  await until(() => h.sessions[0]?.cancelled === true, 'the session ended');
  assert.equal(process.signal.aborted, false, 'Start stays open');
  assert.ok(
    h.timeline.indexOf('workspace.session.cancelled') >
      h.timeline.indexOf('lease.started'),
  );

  process.exit({ stdout: 'hi\n' });
  const answer = await running;

  assert.ok(answer.terminalId !== '');
  assert.equal(answer.background, undefined);
  assert.equal(answer.stdout, 'hi\n');
  assert.equal(answer.stderr, '');
  assert.equal(answer.exitCode, -1);
  assert.equal(answer.reason, 'exited');
});

void test('R4: Run without a prompt, on a refused session or on a closing Thread fails internal "Thread is inactive." and starts nothing', async (t) => {
  const cases: readonly {
    readonly label: string;
    readonly threads: Readonly<Record<string, FakeThread>> | undefined;
    readonly scope: CallScope;
  }[] = [
    {
      label: 'no promptId',
      threads: undefined,
      scope: { projectId: 'project-1', threadId: 'thread-1' },
    },
    { label: 'missing', threads: {}, scope: promptScope },
    ...(['inactive', 'pending'] as const).map((status) => ({
      label: status,
      threads: { 'thread-1': { projectId: 'project-1', cwd: '/w', status } },
      scope: promptScope,
    })),
    {
      label: 'closing',
      threads: {
        'thread-1': { projectId: 'project-1', cwd: '/w', closing: true },
      },
      scope: promptScope,
    },
  ];

  for (const { label, threads, scope } of cases) {
    const h = await activated(t, threads === undefined ? {} : { threads });
    const error = await rejectionOf(h.terminal(scope).run(command()));

    assert.equal(error.code, 'internal', label);
    assert.equal(error.message, 'Thread is inactive.', label);
    assert.equal(methodCalls(h, 'lease.start').length, 0, label);
    await until(
      () => h.sessions.every((session) => session.cancelled),
      `${label}: every session ended`,
    );
  }
});

void test('R5: a background Run answers at started, then enqueues backgroundResultText with no scope', async (t) => {
  const h = await activated(t);
  const answer = await h
    .terminal(promptScope)
    .run(command({ command: 'make', background: true }));
  const process = await processAt(h);

  assert.equal(answer.background, true);
  assert.ok(answer.terminalId !== '');
  assert.equal(answer.stdout, undefined);
  assert.equal(methodCalls(h, 'threads.enqueueTerminalResult').length, 0);

  process.exit({ exitCode: 0, stdout: 'built\n' });
  await until(
    () => methodCalls(h, 'threads.enqueueTerminalResult').length === 1,
    'EnqueueTerminalResult',
  );

  const [enqueued] = methodCalls(h, 'threads.enqueueTerminalResult');
  const request = enqueued?.request as {
    readonly threadId: string;
    readonly promptId: string;
    readonly terminalId: string;
    readonly text: string;
  };
  const durationMs = Number(/Duration: (\d+) ms/.exec(request.text)?.[1]);

  assert.equal(enqueued?.scope, undefined);
  assert.equal(request.threadId, 'thread-1');
  assert.equal(request.promptId, 'prompt-1');
  assert.equal(request.terminalId, answer.terminalId);
  assert.equal(
    request.text,
    backgroundResultText('prompt-1', 'make', {
      terminalId: answer.terminalId,
      stdout: 'built\n',
      stderr: '',
      exitCode: 0,
      durationMs,
      reason: 'exited',
    }),
  );
});

void test('R5: a rejected Enqueue sends FailTerminalResult; a rejected Fail logs the delivery failure', async (t) => {
  const failure = new ContractError('unavailable', 'runtime is down');
  const deliver = async (h: Harness) => {
    await h.terminal(promptScope).run(command({ background: true }));
    (await processAt(h)).exit({ exitCode: 0 });
  };

  const failed = await activated(t, { enqueueError: failure });

  await deliver(failed);
  await until(
    () => methodCalls(failed, 'threads.failTerminalResult').length === 1,
    'FailTerminalResult',
  );
  assert.deepEqual(
    methodCalls(failed, 'threads.failTerminalResult')[0]?.request,
    {
      threadId: 'thread-1',
    },
  );

  const logged = await activated(t, {
    enqueueError: failure,
    failError: failure,
  });

  await deliver(logged);
  await until(
    () =>
      logged.router.logs.some(
        (record) =>
          record.level === 'error' &&
          record.message === 'Terminal result delivery failed',
      ),
    'the delivery failure log',
  );
});

void test('R6: the Start of a background Run outlives the Run’s deadline and keeps streaming', async (t) => {
  const h = await activated(t);
  const watch = watching(h, 'project-1');

  t.after(() => watch.stop());
  await h
    .terminal(promptScope)
    .run(command({ background: true }), { timeoutMs: 1_000 });

  const process = await processAt(h);

  assert.equal(process.deadline, 0);
  await sleep(1_100);
  assert.equal(process.signal.aborted, false);

  process.output('stdout', 'late\n');
  await until(
    () =>
      watch.items.some(
        (item) =>
          (item as { output?: { data?: string } }).output?.data === 'late\n',
      ),
    'the late output on WatchProject',
  );
});

void test('R7: cancelling a foreground Run cancels its Start; timeoutMs 50 answers reason timeout', async (t) => {
  const h = await activated(t);
  const watch = watching(h, 'project-1');
  const controller = new AbortController();

  t.after(() => watch.stop());

  const cancelled = h
    .terminal(promptScope)
    .run(command(), { signal: controller.signal });
  const process = await processAt(h);

  controller.abort();
  await assert.rejects(cancelled);
  await until(() => process.signal.aborted, 'Start cancelled');
  await until(() => watch.kinds().includes('removed'), 'the removal');

  const timed = await h.terminal(promptScope).run(command({ timeoutMs: 50 }));

  assert.equal(timed.reason, 'timeout');
  assert.equal((await processAt(h, 1)).signal.aborted, true);
});

void test('R8: Start refused before started fails unsupported_operation "Live terminals are unavailable." and removes the session', async (t) => {
  const h = await activated(t, {
    startError: new ContractError(
      'unsupported_operation',
      'Sandbox sandbox-1 does not support live processes.',
    ),
  });
  const watch = watching(h, 'project-1');

  t.after(() => watch.stop());
  await until(() => watch.kinds().includes('snapshot'), 'the snapshot');

  const error = await rejectionOf(h.terminal(promptScope).run(command()));

  assert.equal(error.code, 'unsupported_operation');
  assert.equal(error.message, 'Live terminals are unavailable.');
  await until(() => h.sessions[0]?.cancelled === true, 'the session ended');
  await until(() => watch.items.length >= 3, 'updated and removed');
  assert.deepEqual(watch.kinds(), ['snapshot', 'updated', 'removed']);
  assert.equal(
    (watch.items[1] as { updated: { state: string } }).updated.state,
    'starting',
  );
});

void test('R9: Start failing after started answers reason failed with the execution failure text', async (t) => {
  const h = await activated(t);
  const running = h.terminal(promptScope).run(command());

  (await processAt(h)).fail(new ContractError('internal', 'boom'));

  const answer = await running;

  assert.equal(answer.reason, 'failed');
  assert.equal(answer.stdout, '');
  assert.equal(answer.stderr, 'Terminal execution failed.');
  assert.equal(answer.exitCode, -1);
});

void test('R18: without runtime.lease/v1 declared, Run fails undeclared_requirement', async (t) => {
  const h = await activated(t, {
    requires: REQUIRES.filter((name) => name !== LeaseService.typeName),
  });

  assert.equal(
    await codeOf(h.terminal(promptScope).run(command())),
    'undeclared_requirement',
  );
});

void test('R19: Runs on two Threads open two sessions, each Start naming its own', async (t: TestContext) => {
  const h = await activated(t, {
    threads: {
      'thread-1': { projectId: 'project-1', cwd: '/workspace/app' },
      'thread-2': { projectId: 'project-1', cwd: '/workspace/app' },
    },
  });

  await h
    .terminal(promptScope)
    .run(command({ command: 'one', background: true }));
  await processAt(h);
  await h
    .terminal({ ...promptScope, threadId: 'thread-2', promptId: 'prompt-2' })
    .run(command({ command: 'two', background: true }));
  await processAt(h, 1);

  const sessionOf = (threadId: string) =>
    h.sessions.find(
      (session) =>
        (session.request as { threadId: string }).threadId === threadId,
    )?.threadSessionId;

  assert.notEqual(sessionOf('thread-1'), sessionOf('thread-2'));
  assert.deepEqual(
    h.processes[0]?.head,
    agentHead('one', sessionOf('thread-1')),
  );
  assert.deepEqual(
    h.processes[1]?.head,
    agentHead('two', sessionOf('thread-2')),
  );
});
