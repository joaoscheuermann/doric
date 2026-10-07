import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type {
  Sandbox,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';

import { StoragePressureError } from '../src/lib/workspace/disk.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { createTerminalRegistry } from '../src/lib/workspace/terminals.js';
import { deferred, pool, workspace } from './helpers/workspace.js';

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
  const harness = workspace();
  const registry = createTerminalRegistry(
    harness.dependencies.publisher,
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
    start,
    finished,
    sandbox,
    keys,
    sizes,
    running: running.promise,
    output: (data: string) => input?.onOutput?.({ stream: 'stdout', data }),
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

void test('delivers a fast background result once after the originating prompt', async () => {
  const f = fixture();
  const harness = workspace();
  const received = deferred<string>();
  const sources: string[] = [];
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, f.sandbox),
    execute: async ({ host, job }) => {
      sources.push(job.source.kind);
      if (job.source.kind === 'terminal') {
        received.resolve(job.prompt);
        return 'acknowledged';
      }
      assert.ok(host.terminals);
      const execution = await host.terminals.run({
        command: 'echo done',
        cwd: '/workspace',
        timeoutMs: 0,
        background: true,
      });
      assert.ok('background' in execution);
      f.finished.resolve(result);
      return 'started';
    },
  });
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  await service.threads.prompt(created.thread.id, 'Run command');
  assert.match(await received.promise, /done/);
  assert.deepEqual(sources, ['user', 'terminal']);
  assert.equal(service.terminals.list(project.id).length, 0);
  await service.dispose();
});

void test('closes manual terminals when their owning Thread is terminated', async () => {
  const f = fixture();
  const harness = workspace();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, f.sandbox),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  const terminal = await service.terminals.create(created.thread.id);
  assert.ok(terminal);
  await service.threads.terminate(created.thread.id);
  assert.equal(service.terminals.snapshot(terminal.id), undefined);
  assert.equal(service.terminals.list(project.id).length, 0);
  await service.dispose();
});

void test('interrupting a prompt terminates its foreground command', async () => {
  const f = fixture();
  const harness = workspace();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, f.sandbox),
    execute: async ({ host }) => {
      if (host.terminals === undefined)
        throw new Error('Terminals are unavailable.');

      await host.terminals.run({
        command: 'sleep 100',
        cwd: '/workspace',
        timeoutMs: 0,
      });
      return 'finished';
    },
  });
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  const prompt = await service.threads.prompt(created.thread.id, 'Run');
  if (prompt.status !== 'accepted') throw new Error('Prompt unavailable');
  await f.running;
  assert.equal(
    await service.threads.interrupt(created.thread.id, prompt.promptId),
    'interrupted',
  );
  await f.finished.promise;
  await service.dispose();
  assert.equal(service.terminals.list(project.id).length, 0);
});

void test('storage pressure interrupts the host-owned foreground terminal and preserves its prompt', {
  timeout: 5000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const harness = workspace();
  let low = false;
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, f.sandbox),
    checkStorage: async () => {
      if (low) throw new StoragePressureError();
    },
    execute: async ({ host }) => {
      if (host.terminals === undefined)
        throw new Error('Terminals unavailable');
      await host.terminals.run({
        command: 'sleep 100',
        cwd: '/workspace',
        timeoutMs: 0,
      });
      return 'finished';
    },
  });
  try {
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    if (created.status !== 'created') throw new Error('Thread unavailable');
    const prompt = await service.threads.prompt(created.thread.id, 'Run');
    if (prompt.status !== 'accepted') throw new Error('Prompt unavailable');
    await f.running;
    low = true;
    t.mock.timers.tick(3000);
    await f.finished.promise;
    await setImmediate();
    assert.equal(service.terminals.list(project.id).length, 0);
    const queue = await service.threads.queue(created.thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, prompt.promptId);
    assert.equal(
      harness.events.some((event) => event.type === 'prompt.finished'),
      false,
    );
  } finally {
    await service.dispose();
  }
});

void test('discarding a starting terminal waits for cleanup without reviving its row', async () => {
  const provider = deferred<SandboxProcess>();
  const harness = workspace();
  const registry = createTerminalRegistry(harness.dependencies.publisher);
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

void test('a provider cleanup failure does not strand Thread or Project termination', async () => {
  const f = fixture();
  const harness = workspace();
  const environment = {
    ...f.sandbox,
    start: async (input: SandboxProcessInput) => {
      if (f.sandbox.start === undefined)
        throw new Error('Sandbox process provider is unavailable.');

      const process = await f.sandbox.start(input);
      return {
        ...process,
        terminate: async () => {
          throw new Error('Provider unavailable');
        },
      };
    },
  };
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, environment),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  assert.ok(await service.terminals.create(created.thread.id));
  await service.threads.terminate(created.thread.id);
  await service.dispose();
  assert.equal(
    (await service.threads.find(created.thread.id))?.state,
    'cancelled',
  );
});
