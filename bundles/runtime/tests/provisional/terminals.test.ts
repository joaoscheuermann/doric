import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Sandbox,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessInput,
} from 'sandbox';

import type { WorkspacePublisher } from '../../src/host/domain/types.js';
import { createTerminalRegistry } from '../../src/host/provisional/terminals.js';
import { createHarness, deferred } from '../domain/support/harness.js';

/*
 * Ported from agents/doric tests/terminals.test.ts (design 57 §13.2): the
 * registry directly, and the prompt and manual terminals through the
 * runtime's terminal/v1 and runtime.terminals/v1.
 */

const publisher: WorkspacePublisher = {
  event: () => undefined,
  threadUpdated: () => undefined,
  threadDeleted: () => undefined,
  projectUpdated: () => undefined,
  projectDeleted: () => undefined,
};

const healthy = {
  status: 'ok' as const,
  writable: true,
  disk: { blocks: 100, availableBlocks: 50 },
};

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
  const registry = createTerminalRegistry(publisher, () => secrets);
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
  const received = deferred<string>();
  const sources: string[] = [];
  const harness = createHarness({
    sandbox: { sandbox: f.sandbox },
    execute: async ({ tools, job }) => {
      sources.push(job.source.kind);
      if (job.source.kind === 'terminal') {
        received.resolve(job.prompt);
        return 'acknowledged';
      }
      const execution = (await tools.terminal.run({
        command: 'echo done',
        cwd: '/workspace',
        timeoutMs: 0,
        background: true,
      })) as object;
      assert.ok('background' in execution);
      f.finished.resolve(result);
      return 'started';
    },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  await service.threads.prompt(created.thread.id, 'Run command');
  assert.match(await received.promise, /done/);
  assert.deepEqual(sources, ['user', 'terminal']);
  assert.equal((await harness.terminals.list(project.id)).length, 0);
  await harness.dispose();
});

void test('closes manual terminals when their owning Thread is terminated', async () => {
  const f = fixture();
  const harness = createHarness({ sandbox: { sandbox: f.sandbox } });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  const terminal = await harness.terminals.create({
    threadId: created.thread.id,
  });
  assert.ok(terminal);
  assert.equal((await harness.terminals.list(project.id)).length, 1);
  await service.threads.terminate(created.thread.id);
  assert.equal(
    await harness.terminals.snapshot({ id: terminal.id }),
    undefined,
  );
  assert.equal((await harness.terminals.list(project.id)).length, 0);
  await harness.dispose();
});

void test('interrupting a prompt terminates its foreground command', async () => {
  const f = fixture();
  const harness = createHarness({
    sandbox: { sandbox: f.sandbox },
    execute: async ({ tools, signal }) => {
      // The executor's tool call carries the prompt's signal.
      await tools.terminal.run(
        { command: 'sleep 100', cwd: '/workspace', timeoutMs: 0 },
        { ...(signal === undefined ? {} : { signal }) },
      );
      return 'finished';
    },
  });
  const { service } = harness;
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
  assert.equal((await harness.terminals.list(project.id)).length, 0);
  await harness.dispose();
});

void test('storage pressure interrupts the host-owned foreground terminal and preserves its prompt', {
  timeout: 5000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let low = false;
  const harness = createHarness({
    sandbox: { sandbox: f.sandbox },
    health: async () =>
      low ? { ...healthy, disk: { blocks: 100, availableBlocks: 1 } } : healthy,
    execute: async ({ tools, signal }) => {
      // The executor's tool call carries the prompt's signal.
      await tools.terminal.run(
        { command: 'sleep 100', cwd: '/workspace', timeoutMs: 0 },
        { ...(signal === undefined ? {} : { signal }) },
      );
      return 'finished';
    },
  });
  const { service } = harness;
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
    await harness.waitFor(
      async () =>
        (await service.threads.queue(created.thread.id))?.paused === true,
    );
    assert.equal((await harness.terminals.list(project.id)).length, 0);
    const queue = await service.threads.queue(created.thread.id);
    assert.equal(queue?.paused, true);
    assert.equal(queue?.resumable?.promptId, prompt.promptId);
    assert.equal(
      ((await service.threads.events(created.thread.id, 0))?.events ?? []).some(
        (event) => event.type === 'prompt.finished',
      ),
      false,
    );
  } finally {
    await harness.dispose();
  }
});

void test('discarding a starting terminal waits for cleanup without reviving its row', async () => {
  const provider = deferred<SandboxProcess>();
  const registry = createTerminalRegistry(publisher);
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
  const harness = createHarness({
    sandbox: { sandbox: environment as unknown as Sandbox },
  });
  const { service } = harness;
  const project = await service.projects.create('Project');
  const created = await service.threads.create(project.id, 'Thread');
  if (created.status !== 'created') throw new Error('Thread unavailable');
  assert.ok(await harness.terminals.create({ threadId: created.thread.id }));
  await service.threads.terminate(created.thread.id);
  await service.dispose();
  assert.equal(
    (await service.threads.find(created.thread.id))?.state,
    'cancelled',
  );
  await harness.dispose();
});
