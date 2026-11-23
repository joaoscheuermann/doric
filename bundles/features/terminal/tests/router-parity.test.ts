// `terminal`'s host part through the router against the kernel (phase 3,
// S54b, R17, P3): the `terminal` tool served from `ToolHandlerService` runs
// on the local operations and answers the kernel tool's compact output, and
// one scripted command answers the same result and lists the same session on
// the kernel host (`tests/support/host.ts`) and on the process.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { createTestServices } from 'bundle/testing';
import type { Sandbox, SandboxExecResult, SandboxProcessInput } from 'sandbox';

import { TerminalSessionSchema } from '../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import type {
  TerminalResult,
  TerminalSession,
} from '../src/contracts/index.js';
import { createTool } from '../src/host/tool.js';
import { deferred } from './support/deferred.js';
import { activatedHost } from './support/host.js';
import { type Harness, promptScope } from './support/router.js';
import { activated, processAt, until } from './support/router-fixtures.js';

/** What a compact output keeps once its timing is left out. */
const timeless = (output: JsonValue): JsonValue => {
  const { duration_ms: _duration, ...rest } = output as Record<
    string,
    JsonValue
  >;

  return rest;
};

/** `name` through `ToolHandlerService.Execute` under `scope`, as JSON. */
const execute = async (h: Harness, payload: JsonValue): Promise<JsonValue> => {
  const { result } = await h.tools(promptScope).execute({
    name: 'terminal',
    payload: fromJson(ValueSchema, payload),
  });

  assert.ok(result, 'Execute answered a result');

  return toJson(ValueSchema, result);
};

/** A kernel sandbox whose processes finish when the test says so. */
const kernelSandbox = () => {
  const started: SandboxProcessInput[] = [];
  const finishes: ((value: SandboxExecResult) => void)[] = [];
  const sandbox = {
    id: 'sandbox-1',
    root: '/workspace',
    start: async (input: SandboxProcessInput) => {
      const finished = deferred<SandboxExecResult>();

      started.push(input);
      finishes.push(finished.resolve);
      input.signal?.addEventListener('abort', () =>
        finished.reject(new Error('terminated')),
      );

      return {
        result: finished.promise,
        write: async () => undefined,
        resize: async () => undefined,
        terminate: async () => finished.reject(new Error('terminated')),
      };
    },
  } as unknown as Sandbox;

  return { sandbox, started, finishes };
};

const exitOf = (stdout: string): SandboxExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
  stdoutBytes: new TextEncoder().encode(stdout),
  stderrBytes: new Uint8Array(),
});

/** A session without the fields two hosts never share. */
const comparable = (session: TerminalSession | Record<string, unknown>) => {
  const {
    id: _id,
    startedAt: _startedAt,
    $typeName: _type,
    ...rest
  } = session as Record<string, unknown>;

  return rest;
};

void test('R17: Execute of terminal asks Cwd under the prompt scope, runs on the local operations and answers the kernel tool’s output', async (t) => {
  const h = await activated(t);
  const executing = execute(h, { command: 'echo hi' });
  const process = await processAt(h);

  process.exit({ exitCode: 0, stdout: 'hi\n' });

  const answer = await executing;
  const cwdCalls = h.calls.filter((call) => call.method === 'workspace.cwd');

  assert.equal(cwdCalls.length, 1);
  assert.deepEqual(cwdCalls[0]?.scope, promptScope);
  assert.deepEqual(h.sessions[0]?.scope, promptScope);
  assert.deepEqual(process.head, {
    target: { threadSessionId: 'session-1' },
    request: {
      cmd: ['sh', '-lc', 'echo hi'],
      cwd: '/workspace/app',
      tty: false,
    },
  });

  const kernel = createTool()
    .bind({
      cwd: async () => '/workspace/app',
      run: async () =>
        ({
          terminalId: 'kernel-1',
          stdout: 'hi\n',
          stderr: '',
          exitCode: 0,
          durationMs: 0,
          reason: 'exited',
        }) satisfies TerminalResult,
    })
    .execute(
      { command: 'echo hi' },
      createTestServices({ bundle: { id: 'terminal' } }).call(promptScope),
    );

  assert.deepEqual(
    timeless(answer),
    timeless(JSON.parse(JSON.stringify(await kernel)) as JsonValue),
  );

  const background = await execute(h, { command: 'serve', background: true });
  const terminalId = (background as { terminal_id?: unknown }).terminal_id;

  assert.equal(typeof terminalId, 'string');
  assert.deepEqual(background, { terminal_id: terminalId, background: true });
});

void test('P3: one scripted command answers the same result and lists the same session on the kernel and the process', async (t) => {
  const box = kernelSandbox();
  const kernel = await activatedHost({
    'thread-1': {
      projectId: 'project-1',
      cwd: '/workspace/app',
      sandbox: box.sandbox,
    },
  });

  t.after(() => kernel.dispose());

  const h = await activated(t);
  const input = { command: 'echo done', cwd: '/workspace/app', timeoutMs: 0 };

  const kernelRunning = kernel.terminal.run(input, kernel.call('thread-1'));

  await until(() => box.started.length === 1, 'the kernel start');
  box.finishes[0]?.(exitOf('done\n'));

  const processRunning = h.terminal(promptScope).run(input);

  (await processAt(h)).exit({ exitCode: 0, stdout: 'done\n' });

  const kernelResult = (await kernelRunning) as TerminalResult;
  const processResult = await processRunning;
  const outcome = (result: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
    readonly reason?: string;
  }) => ({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    reason: result.reason,
  });

  assert.deepEqual(outcome(processResult), outcome(kernelResult));

  const background = {
    ...input,
    command: 'sleep 9',
    timeoutMs: 5_000,
    background: true,
  };

  await kernel.terminal.run(background, kernel.call('thread-1'));
  await h.terminal(promptScope).run(background);
  await processAt(h, 1);

  const kernelSessions = await kernel.terminal.list('project-1');
  const { terminals } = await h.terminal().list({ projectId: 'project-1' });

  assert.equal(kernelSessions.length, 1);
  assert.equal(terminals.length, 1);
  assert.deepEqual(
    comparable(
      toJson(TerminalSessionSchema, terminals[0] as never, {
        alwaysEmitImplicit: true,
      }) as Record<string, unknown>,
    ),
    comparable(kernelSessions[0] as TerminalSession),
  );
});
