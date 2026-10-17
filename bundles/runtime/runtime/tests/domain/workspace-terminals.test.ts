import assert from 'node:assert/strict';
import test from 'node:test';

import type { Sandbox, SandboxExecResult, SandboxProcessInput } from 'sandbox';
import type { TerminalWatchItem } from 'terminal/contracts';

import { createHarness, deferred } from './support/harness.js';

/*
 * Terminal ownership after the stage-10 host switch: the commands an agent
 * runs and the manual shells a user opens are the `terminal` bundle's
 * sessions. They are listed by its terminal/v1 (the route
 * `GET /projects/:id/terminals`) and by runtime.terminals/v1, streamed on its
 * project watch, and closed when their Thread closes, as agents/doric's
 * workspace registry behaved.
 */

const result: SandboxExecResult = {
  stdout: 'done',
  stderr: '',
  exitCode: 0,
  stdoutBytes: Buffer.from('done'),
  stderrBytes: new Uint8Array(),
};

/** A sandbox whose processes run until terminated, aborted or finished. */
const fixture = () => {
  const finished = deferred<SandboxExecResult>();
  const running = deferred<void>();
  const sandbox = {
    root: '/workspace',
    stats: async () => ({ cpuPercent: 12, cpuCount: 2 }),
    start: async (value: SandboxProcessInput) => {
      running.resolve();
      value.signal?.addEventListener('abort', () => finished.resolve(result));
      return {
        result: finished.promise,
        write: async () => undefined,
        resize: async () => undefined,
        terminate: async () => {
          finished.resolve(result);
        },
      };
    },
  } as unknown as Sandbox;
  return { sandbox, finished, running: running.promise };
};

const recorder = () => {
  const items: TerminalWatchItem[] = [];
  return {
    items,
    listener: {
      next: (item: TerminalWatchItem) => {
        items.push(item);
      },
      error: () => undefined,
      complete: () => undefined,
    },
  };
};

void test('an agent terminal is the terminal bundle’s session and closes with its Thread', {
  timeout: 10_000,
}, async () => {
  const f = fixture();
  const harness = createHarness({
    sandbox: { sandbox: f.sandbox },
    execute: async ({ tools }) => {
      await tools.terminal.run({
        command: 'npm run dev',
        cwd: '/workspace',
        timeoutMs: 0,
      });
      return 'finished';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const seen = recorder();
    const watch = harness.terminal.watchProject(project.id, seen.listener);
    await harness.waitFor(() => seen.items.length === 1, 'the snapshot');

    await harness.service.threads.prompt(thread.id, 'Run the server');
    await f.running;
    await harness.waitFor(
      async () =>
        (await harness.terminal.list(project.id))[0]?.state === 'running',
      'the running agent terminal',
    );

    const [listed] = await harness.terminal.list(project.id);
    assert.equal(listed?.origin, 'agent');
    assert.equal(listed?.threadId, thread.id);
    assert.equal(listed?.command, 'npm run dev');
    // The desktop's runtime.terminals/v1 reads the same sessions.
    assert.deepEqual(await harness.terminals.list(project.id), [listed]);

    await harness.service.threads.terminate(thread.id);
    await harness.waitFor(
      () => seen.items.some((item) => item.kind === 'removed'),
      'the removal',
    );
    assert.deepEqual(await harness.terminal.list(project.id), []);
    assert.deepEqual(await harness.terminals.list(project.id), []);
    assert.deepEqual(
      seen.items.map((item) =>
        item.kind === 'updated' ? `updated:${item.terminal.state}` : item.kind,
      ),
      ['snapshot', 'updated:starting', 'updated:running', 'removed'],
    );
    assert.deepEqual(seen.items.at(-1), {
      kind: 'removed',
      projectId: project.id,
      threadId: thread.id,
      terminalId: listed?.id,
    });
    watch.dispose();
  } finally {
    await harness.dispose();
  }
});

void test('a manual terminal closes when its owning Thread is terminated', async () => {
  const f = fixture();
  const harness = createHarness({ sandbox: { sandbox: f.sandbox } });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const terminal = await harness.terminals.create({ threadId: thread.id });
    assert.equal(terminal?.origin, 'user');
    assert.deepEqual(
      (await harness.terminal.list(project.id)).map(({ id }) => id),
      [terminal?.id],
    );

    await harness.service.threads.terminate(thread.id);

    assert.equal(
      await harness.terminals.snapshot({ id: terminal?.id ?? '' }),
      undefined,
    );
    assert.deepEqual(await harness.terminal.list(project.id), []);
  } finally {
    await harness.dispose();
  }
});

void test('a host stop closes the agent terminals of its suspended Threads', async () => {
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
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    await harness.service.threads.prompt(thread.id, 'Run');
    await f.running;
    assert.equal((await harness.terminal.list(project.id)).length, 1);

    await harness.service.dispose();

    assert.deepEqual(await harness.terminal.list(project.id), []);
    assert.equal(
      (await harness.service.threads.find(thread.id))?.state,
      'ready',
    );
  } finally {
    await harness.dispose();
  }
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
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);
    const prompt = await harness.service.threads.prompt(thread.id, 'Run');
    if (prompt.status !== 'accepted') throw new Error('Prompt unavailable');
    await f.running;

    assert.equal(
      await harness.service.threads.interrupt(thread.id, prompt.promptId),
      'interrupted',
    );

    await f.finished.promise;
    await harness.waitFor(
      async () => (await harness.terminal.list(project.id)).length === 0,
      'the agent terminal to close',
    );
  } finally {
    await harness.dispose();
  }
});

void test('a background result reaches its Thread once, after the originating prompt', async () => {
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
      await tools.terminal.run({
        command: 'echo done',
        cwd: '/workspace',
        timeoutMs: 0,
        background: true,
      });
      f.finished.resolve(result);
      return 'started';
    },
  });
  try {
    const project = await harness.readyProject();
    const thread = await harness.createThread(project.id);

    await harness.service.threads.prompt(thread.id, 'Run command');

    assert.match(await received.promise, /done/);
    assert.deepEqual(sources, ['user', 'terminal']);
    assert.deepEqual(await harness.terminal.list(project.id), []);
  } finally {
    await harness.dispose();
  }
});

void test('a Project’s resources are read through resources/v1 on its scope', async () => {
  const f = fixture();
  const harness = createHarness({ sandbox: { sandbox: f.sandbox } });
  try {
    const project = await harness.readyProject();

    const resources = await harness
      .lease({ projectId: project.id })
      .resources();

    assert.equal(resources.status, 'ready');
    assert.equal(
      resources.status === 'ready' ? resources.container.cpuPercent : undefined,
      12,
    );
    assert.deepEqual(harness.resourceReads, [project.id]);
  } finally {
    await harness.dispose();
  }
});
