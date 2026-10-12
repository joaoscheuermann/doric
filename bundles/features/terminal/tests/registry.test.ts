import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Sandbox,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';

import {
  createTerminalRegistry,
  type TerminalNotice,
} from '../src/host/registry.js';
import { deferred } from './support/deferred.js';

/*
 * The registry directly (moved from the runtime's
 * `tests/provisional/terminals.test.ts`, before that agents/doric
 * `tests/terminals.test.ts`): snapshot truncation, OSC 633;E command
 * tracking, redaction across chunk boundaries, manual sessions kept
 * `exited`, agent sessions removed. The prompt-level cases go through the
 * provider in `provider.test.ts`.
 */

const result: SandboxExecResult = {
  stdout: 'done',
  stderr: '',
  exitCode: 0,
  stdoutBytes: Buffer.from('done'),
  stderrBytes: new Uint8Array(),
};
const fixture = (secrets: readonly string[] = []) => {
  const finished = deferred<SandboxExecResult>();
  const running = deferred<void>();
  let input: SandboxProcessInput | undefined;
  const keys: string[] = [];
  const notices: TerminalNotice[] = [];
  const sizes: number[][] = [];
  const sandbox = {
    root: '/workspace',
    start: async (value: SandboxProcessInput) => {
      input = value;
      running.resolve();
      value.signal?.addEventListener('abort', () => finished.resolve(result));
      return {
        result: finished.promise,
        write: async (data: string) => {
          keys.push(data);
        },
        resize: async (cols: number, rows: number) => {
          sizes.push([cols, rows]);
        },
        terminate: async () => {
          finished.resolve(result);
        },
      };
    },
  } as unknown as Sandbox;
  const registry = createTerminalRegistry(
    (notice) => notices.push(notice),
    () => secrets,
  );
  const start = (origin: 'agent' | 'user' = 'agent', timeoutMs = 0) =>
    registry.start({
      sandbox,
      projectId: 'p',
      threadId: 't',
      origin,
      input: {
        command: 'npm run dev',
        cwd: '/workspace',
        timeoutMs,
        pty: origin === 'user',
      },
    });
  return {
    registry,
    notices,
    start,
    finished,
    sandbox,
    keys,
    sizes,
    running: running.promise,
    output: (data: string) => input?.onOutput?.({ stream: 'stdout', data }),
    input: () => input,
  };
};

void test('replays output after a cursor and removes completed agent terminals', async () => {
  const f = fixture();
  const session = await f.start();
  f.output('hello');
  f.output(' world');
  assert.equal(f.registry.snapshot(session.terminal.id, 5)?.output, ' world');
  assert.equal(f.registry.snapshot(session.terminal.id)?.offset, 11);
  f.finished.resolve(result);
  assert.equal((await session.result).stdout, 'done');
  assert.equal(f.registry.list('p').length, 0);
  assert.equal(f.registry.snapshot(session.terminal.id), undefined);
});

void test('keeps manual sessions after shell exit until explicitly discarded', async () => {
  const f = fixture();
  const session = await f.start('user');
  await f.registry.input(session.terminal.id, '\u0003');
  await f.registry.resize(session.terminal.id, 100, 30);
  assert.deepEqual(f.keys, ['\u0003']);
  assert.deepEqual(f.sizes, [[100, 30]]);
  f.finished.resolve(result);
  await session.result;
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.state,
    'exited',
  );
  await f.registry.stop(session.terminal.id);
  assert.equal(f.registry.list('p').length, 0);
});

void test('bounds live output and marks a cursor older than the retained buffer', async () => {
  const f = fixture();
  const session = await f.start();
  f.output('x'.repeat(1_100_000));
  const snapshot = f.registry.snapshot(session.terminal.id);
  assert.equal(snapshot?.truncated, true);
  assert.ok(snapshot.output.length < 1_100_000);
  await f.registry.stop(session.terminal.id);
});

void test('reports timeout even when the killed provider process resolves normally', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const session = await f.start('agent', 10);
  t.mock.timers.tick(11);
  assert.equal((await session.result).reason, 'timeout');
  assert.equal(f.registry.list('p').length, 0);
});

void test('updates the manual command from shell metadata split across chunks', async () => {
  const f = fixture();
  const session = await f.start('user');
  f.output('\u001b]633;');
  f.output('E;npm run dev\u0007hello');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.command,
    'npm run dev',
  );
  assert.equal(f.registry.snapshot(session.terminal.id)?.output, 'hello');
  f.output('\u001b]633;E;bash\u0007');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.command,
    'bash',
  );
  await f.registry.stop(session.terminal.id);
});

void test('redacts configured secrets even when output splits them across chunks', async () => {
  const f = fixture(['secret-token']);
  const session = await f.start('user');
  f.output('value=secret-');
  assert.equal(f.registry.snapshot(session.terminal.id)?.output, 'value=');
  f.output('token end');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.output,
    'value=[REDACTED] end',
  );
  await f.registry.stop(session.terminal.id);
});

void test('replays output after a cursor and removes completed agent terminals', async () => {
  const f = fixture();
  const session = await f.start();
  f.output('hello');
  f.output(' world');
  assert.equal(f.registry.snapshot(session.terminal.id, 5)?.output, ' world');
  assert.equal(f.registry.snapshot(session.terminal.id)?.offset, 11);
  f.finished.resolve(result);
  assert.equal((await session.result).stdout, 'done');
  assert.equal(f.registry.list('p').length, 0);
  assert.equal(f.registry.snapshot(session.terminal.id), undefined);
});

void test('keeps manual sessions after shell exit until explicitly discarded', async () => {
  const f = fixture();
  const session = await f.start('user');
  await f.registry.input(session.terminal.id, '\u0003');
  await f.registry.resize(session.terminal.id, 100, 30);
  assert.deepEqual(f.keys, ['\u0003']);
  assert.deepEqual(f.sizes, [[100, 30]]);
  f.finished.resolve(result);
  await session.result;
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.state,
    'exited',
  );
  await f.registry.stop(session.terminal.id);
  assert.equal(f.registry.list('p').length, 0);
});

void test('bounds live output and marks a cursor older than the retained buffer', async () => {
  const f = fixture();
  const session = await f.start();
  f.output('x'.repeat(1_100_000));
  const snapshot = f.registry.snapshot(session.terminal.id);
  assert.equal(snapshot?.truncated, true);
  assert.ok(snapshot.output.length < 1_100_000);
  await f.registry.stop(session.terminal.id);
});

void test('reports timeout even when the killed provider process resolves normally', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const session = await f.start('agent', 10);
  t.mock.timers.tick(11);
  assert.equal((await session.result).reason, 'timeout');
  assert.equal(f.registry.list('p').length, 0);
});

void test('updates the manual command from shell metadata split across chunks', async () => {
  const f = fixture();
  const session = await f.start('user');
  f.output('\u001b]633;');
  f.output('E;npm run dev\u0007hello');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.command,
    'npm run dev',
  );
  assert.equal(f.registry.snapshot(session.terminal.id)?.output, 'hello');
  f.output('\u001b]633;E;bash\u0007');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.terminal.command,
    'bash',
  );
  await f.registry.stop(session.terminal.id);
});

void test('redacts configured secrets even when output splits them across chunks', async () => {
  const f = fixture(['secret-token']);
  const session = await f.start('user');
  f.output('value=secret-');
  assert.equal(f.registry.snapshot(session.terminal.id)?.output, 'value=');
  f.output('token end');
  assert.equal(
    f.registry.snapshot(session.terminal.id)?.output,
    'value=[REDACTED] end',
  );
  await f.registry.stop(session.terminal.id);
});

void test('discarding a starting terminal waits for cleanup without reviving its row', async () => {
  const provider = deferred<SandboxProcess>();
  const registry = createTerminalRegistry(() => undefined);
  let killed = false;
  const starting = registry.start({
    sandbox: { start: () => provider.promise } as unknown as Sandbox,
    projectId: 'p',
    threadId: 't',
    origin: 'user',
    input: { command: 'bash', cwd: '/workspace', pty: true, timeoutMs: 0 },
  });
  const id = registry.list('p')[0].id;
  const discarded = registry.stop(id);
  provider.resolve({
    result: Promise.resolve(result),
    write: async () => undefined,
    resize: async () => undefined,
    terminate: async () => {
      killed = true;
    },
  });
  await discarded;
  await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(killed, true);
  assert.equal(registry.list('p').length, 0);
});

void test('announces each session change and its output through the emitter', async () => {
  const f = fixture();
  const session = await f.start('user');
  f.output('hi');
  const id = session.terminal.id;
  assert.deepEqual(
    f.notices.map((notice) =>
      notice.kind === 'updated'
        ? [notice.kind, notice.terminal.state]
        : notice.kind === 'output'
          ? [notice.kind, notice.output.data, notice.output.offset]
          : [notice.kind, notice.terminalId],
    ),
    [
      ['updated', 'starting'],
      ['updated', 'running'],
      ['output', 'hi', 2],
    ],
  );
  await f.registry.stop(id);
  assert.deepEqual(f.notices.at(-1), {
    kind: 'removed',
    projectId: 'p',
    threadId: 't',
    terminalId: id,
  });
});

void test('close stops only the sessions of the named Threads', async () => {
  const f = fixture();
  const session = await f.start('user');
  await f.registry.close(['other']);
  assert.equal(f.registry.list('p').length, 1);
  await f.registry.close(['t']);
  assert.equal(f.registry.snapshot(session.terminal.id), undefined);
  assert.equal(f.registry.list('p').length, 0);
});

void test('input and resize report a terminal without a process as missing', async () => {
  const f = fixture();
  assert.equal(await f.registry.input('nope', 'x'), false);
  assert.equal(await f.registry.resize('nope', 80, 24), false);
  assert.equal(await f.registry.stop('nope'), false);
});

void test('a sandbox without live processes refuses to start', async () => {
  const registry = createTerminalRegistry(() => undefined);
  await assert.rejects(
    registry.start({
      sandbox: {} as Sandbox,
      projectId: 'p',
      threadId: 't',
      origin: 'agent',
      input: { command: 'ls', cwd: '/workspace', timeoutMs: 0 },
    }),
    /Live terminals are unavailable\./u,
  );
});

void test('starts manual shells with terminal metadata and agent commands with sh -lc', async () => {
  const f = fixture();
  await f.start('user');
  const manual = f.input();
  assert.equal(manual?.cmd[0], 'bash');
  assert.match(manual?.cmd[2] ?? '', /633;E/u);
  assert.equal(manual?.tty, true);
  assert.deepEqual(manual?.env, ['TERM=xterm-256color', 'COLORTERM=truecolor']);
  const g = fixture();
  await g.start('agent');
  assert.deepEqual(g.input()?.cmd, ['sh', '-lc', 'npm run dev']);
  assert.equal(g.input()?.tty, false);
});
