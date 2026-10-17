import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Sandbox, SandboxExecResult, SandboxProcessInput } from 'sandbox';

import type {
  TerminalResult,
  TerminalWatchItem,
} from '../src/contracts/index.js';
import { backgroundResultText } from '../src/host/provider.js';
import { deferred } from './support/deferred.js';
import { activatedHost, type FakeThread } from './support/host.js';

/*
 * terminal/v1 through the contract, over fake runtime, core and sandbox
 * providers: the prompt control the runner had (`run`), the manual shells
 * of `WorkspaceService.terminals`, the Project stream and the cleanup on
 * `onThreadsClosingHook`.
 */

const done: SandboxExecResult = {
  stdout: 'done\n',
  stderr: '',
  exitCode: 0,
  stdoutBytes: Buffer.from('done\n'),
  stderrBytes: new Uint8Array(),
};

/** A sandbox whose processes finish when the test says so. */
const fakeSandbox = (options: { failTerminate?: boolean } = {}) => {
  const started: SandboxProcessInput[] = [];
  const finishes: ((value: SandboxExecResult) => void)[] = [];
  const running = deferred();
  const sandbox = {
    id: 'sandbox-1',
    root: '/workspace',
    start: async (input: SandboxProcessInput) => {
      started.push(input);
      const finished = deferred<SandboxExecResult>();
      finishes.push(finished.resolve);
      input.signal?.addEventListener('abort', () => finished.resolve(done));
      running.resolve();
      return {
        result: finished.promise,
        write: async () => undefined,
        resize: async () => undefined,
        terminate: async () => {
          if (options.failTerminate) throw new Error('Provider unavailable');
          finished.resolve(done);
        },
      };
    },
  } as unknown as Sandbox;
  return {
    sandbox,
    started,
    running: running.promise,
    /** Writes output to the newest process. */
    output: (data: string) =>
      started.at(-1)?.onOutput?.({ stream: 'stdout', data }),
    finish: (value: SandboxExecResult = done) => finishes.at(-1)?.(value),
  };
};

const thread = (sandbox: Sandbox, extra: Partial<FakeThread> = {}) => ({
  projectId: 'project-1',
  cwd: '/workspace/app',
  sandbox,
  ...extra,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

void describe('terminal/v1', () => {
  void test('registers the terminal tool at its model-visible position, always available', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      assert.deepEqual(
        host
          .tools(host.call('thread-1'))
          .map(({ tool, alwaysAvailable, order }) => [
            tool.name,
            alwaysAvailable,
            order,
          ]),
        [['terminal', true, 500]],
      );
    } finally {
      await host.dispose();
    }
  });

  void test('the tool runs a foreground command on the prompt Thread and compacts its result', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      const [{ tool }] = host.tools(host.call('thread-1'));
      const running = tool.execute({ command: 'echo done' });
      await box.running;
      box.finish();
      const result = (await running) as {
        readonly schema: string;
        readonly working_directory: string;
        readonly stdout: { readonly head: readonly string[] };
        readonly success: boolean;
      };
      assert.equal(result.schema, 'terminal.compact.v1');
      assert.equal(result.working_directory, '/workspace/app');
      assert.deepEqual(result.stdout.head, ['done']);
      assert.equal(result.success, true);
      assert.deepEqual(box.started[0]?.cmd, ['sh', '-lc', 'echo done']);
      assert.equal(box.started[0]?.cwd, '/workspace/app');
      assert.deepEqual(host.withThreadCalls, [
        { threadId: 'thread-1', options: { exclusive: false } },
      ]);
      assert.deepEqual(await host.terminal.list('project-1'), []);
    } finally {
      await host.dispose();
    }
  });

  void test('a background result reaches the Thread with the runner text', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      const started = await host.terminal.run(
        {
          command: 'npm test',
          cwd: '/workspace',
          timeoutMs: 0,
          background: true,
        },
        host.call('thread-1', 'prompt-7'),
      );
      assert.ok('background' in started);
      const terminalId = started.terminalId;
      box.finish({ ...done, stdout: 'ok', exitCode: 3 });
      await tick();
      await tick();
      assert.equal(host.enqueued.length, 1);
      const [entry] = host.enqueued as {
        threadId: string;
        promptId: string;
        terminalId: string;
        text: string;
      }[];
      assert.equal(entry.threadId, 'thread-1');
      assert.equal(entry.promptId, 'prompt-7');
      assert.equal(entry.terminalId, terminalId);
      assert.match(
        entry.text,
        new RegExp(
          `^# Background terminal result\\n\\nTerminal: ${terminalId}\\nOriginating prompt: prompt-7\\nCommand: npm test\\nExit code: 3\\nReason: exited\\nDuration: \\d+ ms\\n\\n## Standard output \\(last 12000 characters\\)\\n\\nok\\n\\n## Standard error \\(last 12000 characters\\)\\n\\n$`,
          'u',
        ),
      );
      assert.deepEqual(host.failed, []);
    } finally {
      await host.dispose();
    }
  });

  void test('the background text keeps the last 12000 characters of each stream', () => {
    const result: TerminalResult = {
      terminalId: 't-1',
      stdout: `${'a'.repeat(5)}${'b'.repeat(12000)}`,
      stderr: 'err',
      exitCode: -1,
      durationMs: 9,
      reason: 'timeout',
    };
    assert.equal(
      backgroundResultText('p-1', 'make', result),
      `# Background terminal result\n\nTerminal: t-1\nOriginating prompt: p-1\nCommand: make\nExit code: -1\nReason: timeout\nDuration: 9 ms\n\n## Standard output (last 12000 characters)\n\n${'b'.repeat(12000)}\n\n## Standard error (last 12000 characters)\n\nerr`,
    );
  });

  void test('a rejected delivery fails the terminal result of that Thread', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      host.failEnqueue();
      await host.terminal.run(
        {
          command: 'sleep 1',
          cwd: '/workspace',
          timeoutMs: 0,
          background: true,
        },
        host.call('thread-1'),
      );
      box.finish();
      for (let index = 0; index < 5; index++) await tick();
      assert.deepEqual(host.failed, [{ threadId: 'thread-1' }]);
    } finally {
      await host.dispose();
    }
  });

  void test('run on a closing or inactive Thread throws "Thread is inactive." and starts nothing', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({
      closing: thread(box.sandbox, { closing: true }),
      inactive: thread(box.sandbox, { status: 'inactive' }),
    });
    try {
      for (const threadId of ['closing', 'inactive', 'missing'])
        await assert.rejects(
          host.terminal.run(
            { command: 'ls', cwd: '/workspace', timeoutMs: 0 },
            host.call(threadId),
          ),
          /Thread is inactive\./u,
        );
      assert.deepEqual(box.started, []);
    } finally {
      await host.dispose();
    }
  });

  void test('create opens a manual bash PTY in the Thread cwd, resuming its Project', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      const session = await host.terminal.create('thread-1', {
        cols: 120,
        rows: 40,
      });
      assert.ok(session);
      assert.equal(session.origin, 'user');
      assert.equal(session.command, 'bash');
      assert.equal(session.cwd, '/workspace/app');
      assert.equal(session.pty, true);
      assert.equal(session.timeoutMs, null);
      assert.equal(box.started[0]?.cols, 120);
      assert.equal(box.started[0]?.rows, 40);
      assert.equal(box.started[0]?.tty, true);
      assert.deepEqual(host.withThreadCalls, [
        { threadId: 'thread-1', options: { exclusive: true, resume: true } },
      ]);
      assert.deepEqual(
        (await host.terminal.list('project-1')).map(({ id, state }) => [
          id,
          state,
        ]),
        [[session.id, 'running']],
      );
      box.finish();
      await tick();
      assert.equal(
        (await host.terminal.snapshot(session.id, 0))?.terminal.state,
        'exited',
      );
      assert.equal(await host.terminal.stop(session.id), true);
      assert.equal(await host.terminal.stop(session.id), false);
      assert.equal(await host.terminal.snapshot(session.id, 0), undefined);
    } finally {
      await host.dispose();
    }
  });

  void test('create answers undefined (terminal_unavailable) for a Thread it cannot serve', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({
      pending: thread(box.sandbox, { status: 'pending' }),
    });
    try {
      assert.equal(await host.terminal.create('pending', {}), undefined);
      assert.equal(await host.terminal.create('missing', {}), undefined);
      assert.deepEqual(box.started, []);
    } finally {
      await host.dispose();
    }
  });

  void test('output is redacted with the store list read at start and every rotation after it', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      host.setStored(['first-secret']);
      const session = await host.terminal.create('thread-1', {});
      assert.ok(session);
      box.output('a first-');
      box.output('secret b ');
      host.setSecrets(['second-secret']);
      box.output('second-secret c');
      assert.equal(
        (await host.terminal.snapshot(session.id, 0))?.output,
        'a [REDACTED] b [REDACTED] c',
      );
    } finally {
      await host.dispose();
    }
  });

  void test('onThreadsClosingHook stops the sessions of the closing Threads only', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({
      'thread-1': thread(box.sandbox),
      'thread-2': thread(box.sandbox),
    });
    try {
      const closing = await host.terminal.create('thread-1', {});
      const kept = await host.terminal.create('thread-2', {});
      assert.ok(closing && kept);
      await host.threadsClosing('project-1', ['thread-1']);
      assert.deepEqual(
        (await host.terminal.list('project-1')).map(({ id }) => id),
        [kept.id],
      );
    } finally {
      await host.dispose();
    }
  });

  void test('a failed cleanup is logged and never fails the close', async () => {
    const box = fakeSandbox({ failTerminate: true });
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      assert.ok(await host.terminal.create('thread-1', {}));
      await host.threadsClosing('project-1', ['thread-1']);
      assert.deepEqual(
        host.logs.filter(({ level }) => level === 'error'),
        [
          {
            level: 'error',
            message: 'Terminal cleanup failed',
            fields: { projectId: 'project-1' },
          },
        ],
      );
    } finally {
      await host.dispose();
    }
  });

  void test('watchProject sends the snapshot first, then updates, live output and removals', async () => {
    const box = fakeSandbox();
    const host = await activatedHost({ 'thread-1': thread(box.sandbox) });
    try {
      const existing = await host.terminal.create('thread-1', {});
      assert.ok(existing);
      const items: TerminalWatchItem[] = [];
      const watch = host.terminal.watchProject('project-1', (item) => {
        items.push(item);
      });
      // Output before the snapshot is never buffered.
      box.output('early');
      await tick();
      box.output('late');
      await host.terminal.stop(existing.id);
      await tick();
      assert.deepEqual(
        items.map((item) => item.kind),
        // Stopping a manual shell first reports it exited, then removed.
        ['snapshot', 'output', 'updated', 'removed'],
      );
      const [snapshot, output, updated] = items;
      assert.ok(updated?.kind === 'updated');
      assert.equal(updated.terminal.state, 'exited');
      assert.ok(snapshot?.kind === 'snapshot');
      assert.deepEqual(
        snapshot.terminals.map(({ id }) => id),
        [existing.id],
      );
      assert.ok(output?.kind === 'output');
      assert.equal(output.output.data, 'late');
      assert.equal(output.output.offset, 9);
      watch.dispose();
      await host.terminal.create('thread-1', {});
      await tick();
      assert.equal(items.length, 4);
    } finally {
      await host.dispose();
    }
  });
});
