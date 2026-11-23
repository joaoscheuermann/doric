// `terminal`'s host part through the router (phase 3, S54b, R10–R16, R20):
// the manual shells (`Create`) and the session controls, the Project stream,
// the closing hook, the redaction list and `deactivate`. The harness is
// `./support/router.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { OnThreadsClosingHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import { type Harness, promptScope } from './support/router.js';
import {
  activated,
  codeOf,
  processAt,
  sleep,
  until,
  watching,
} from './support/router-fixtures.js';

const twoThreads = {
  'thread-1': { projectId: 'project-1', cwd: '/workspace/app' },
  'thread-2': { projectId: 'project-1', cwd: '/workspace/app' },
};

/** Creates a manual shell on `threadId` and answers its id and `Start`. */
const shell = async (h: Harness, threadId = 'thread-1') => {
  const creating = h.terminal().create({ threadId });
  const process = await processAt(h, h.processes.length);
  const { terminalSession } = await creating;

  assert.ok(terminalSession, 'Create answered a session');

  return { id: terminalSession.id, process };
};

/** Reads the snapshot's output into `box.output` on every poll. */
const pollSnapshot = (h: Harness, terminalId: string, after = 0) => {
  const box: { output?: string; offset?: number; truncated?: boolean } = {};
  let stopped = false;

  void (async () => {
    while (!stopped) {
      const { terminalSnapshot } = await h
        .terminal()
        .snapshot({ terminalId, after })
        .catch(() => ({ terminalSnapshot: undefined }));

      box.output = terminalSnapshot?.output;
      box.offset = terminalSnapshot?.offset;
      box.truncated = terminalSnapshot?.truncated;
      await sleep(5);
    }
  })();

  return { box, stop: () => (stopped = true) };
};

void test('R10: Create opens an exclusive resumed session, starts the manual PTY shell and answers the running session', async (t) => {
  const h = await activated(t);
  const creating = h
    .terminal()
    .create({ threadId: 'thread-1', cols: 100, rows: 30 });
  const process = await processAt(h);
  const { terminalSession } = await creating;
  const head = process.head as unknown as {
    readonly target: unknown;
    readonly request: { readonly cmd: readonly string[] };
  };
  const { cmd, ...request } = head.request;

  assert.deepEqual(h.sessions[0]?.request, {
    threadId: 'thread-1',
    exclusive: true,
    resume: true,
  });
  assert.deepEqual(head.target, { threadSessionId: 'session-1' });
  assert.deepEqual(cmd.slice(0, 2), ['bash', '-c']);
  assert.match(cmd[2] ?? '', /DORIC_SHELL_INIT/);
  assert.deepEqual(request, {
    cwd: '/workspace/app',
    env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
    tty: true,
    cols: 100,
    rows: 30,
  });
  assert.ok(terminalSession);
  assert.equal(terminalSession.origin, 'user');
  assert.equal(terminalSession.projectId, 'project-1');
  assert.equal(terminalSession.threadId, 'thread-1');
  assert.equal(terminalSession.state, 'running');
  assert.equal(terminalSession.command, 'bash');
  assert.equal(terminalSession.cwd, '/workspace/app');
  assert.equal(terminalSession.pty, true);
  assert.equal(terminalSession.timeoutMs, undefined);
  assert.equal(terminalSession.name, undefined);
  await until(() => h.sessions[0]?.cancelled === true, 'the session ended');
  assert.equal(process.signal.aborted, false);

  const refused = await activated(t, { threads: {} });

  assert.equal(
    (await refused.terminal().create({ threadId: 'thread-1' })).terminalSession,
    undefined,
  );
  assert.equal(refused.processes.length, 0);
});

void test('R11: Input, Resize and Stop drive the Start of a created shell; unknown ids answer false or nothing', async (t) => {
  const h = await activated(t);
  const { id, process } = await shell(h);
  const client = h.terminal();

  assert.deepEqual(
    (await client.input({ terminalId: id, data: 'ls\n' })).sent,
    true,
  );
  await until(() => process.writes.length === 1, 'the write item');
  assert.deepEqual(process.writes, ['ls\n']);

  assert.equal(
    (await client.resize({ terminalId: id, cols: 120, rows: 40 })).resized,
    true,
  );
  await until(() => process.resizes.length === 1, 'the resize item');
  assert.deepEqual(process.resizes, [{ cols: 120, rows: 40 }]);

  assert.equal((await client.stop({ terminalId: id })).stopped, true);
  await until(() => process.signal.aborted, 'Start cancelled');
  assert.equal((await client.stop({ terminalId: id })).stopped, false);

  assert.equal(
    (await client.input({ terminalId: 'nope', data: 'x' })).sent,
    false,
  );
  assert.equal(
    (await client.resize({ terminalId: 'nope', cols: 1, rows: 1 })).resized,
    false,
  );
  assert.equal(
    (await client.rename({ terminalId: 'nope', name: 'x' })).renamed,
    false,
  );
  assert.equal(
    (await client.snapshot({ terminalId: 'nope' })).terminalSnapshot,
    undefined,
  );
});

void test('R12: Snapshot answers the retained output after a cursor; List answers in start order', async (t) => {
  const h = await activated(t);
  const first = await shell(h);
  const second = await shell(h);
  const poll = pollSnapshot(h, first.id, 6);

  t.after(poll.stop);
  first.process.output('stdout', 'hello world');
  await until(() => poll.box.output === 'world', 'the output after 6');
  assert.equal(poll.box.offset, 11);
  assert.equal(poll.box.truncated, false);

  const { terminals } = await h.terminal().list({ projectId: 'project-1' });

  assert.deepEqual(
    terminals.map((terminal) => terminal.id),
    [first.id, second.id],
  );
});

void test('R13: Rename trims, clears on blank or absent, shows in updated; over 80 characters or an empty id is invalid_input', async (t) => {
  const h = await activated(t);
  const { id } = await shell(h);
  const watch = watching(h, 'project-1');
  const client = h.terminal();
  const nameOf = async () =>
    (await client.list({ projectId: 'project-1' })).terminals[0]?.name;

  t.after(() => watch.stop());
  await until(() => watch.kinds().includes('snapshot'), 'the snapshot');

  assert.equal(
    (await client.rename({ terminalId: id, name: ' build ' })).renamed,
    true,
  );
  assert.equal(await nameOf(), 'build');
  await until(
    () =>
      watch.items.some(
        (item) =>
          (item as { updated?: { name?: string } }).updated?.name === 'build',
      ),
    'the named update',
  );

  await client.rename({ terminalId: id, name: '   ' });
  assert.equal(await nameOf(), undefined);
  await client.rename({ terminalId: id, name: 'again' });
  await client.rename({ terminalId: id });
  assert.equal(await nameOf(), undefined);

  assert.equal(
    await codeOf(client.rename({ terminalId: id, name: 'x'.repeat(81) })),
    'invalid_input',
  );
  assert.equal(
    await codeOf(client.rename({ terminalId: '', name: 'x' })),
    'invalid_input',
  );
});

void test('R14: WatchProject yields the snapshot first, then this Project’s items only, and stops when cancelled', async (t) => {
  const h = await activated(t, {
    threads: {
      'thread-1': { projectId: 'project-1', cwd: '/workspace/app' },
      'thread-2': { projectId: 'project-2', cwd: '/workspace/other' },
    },
  });
  const mine = await shell(h);
  const poll = pollSnapshot(h, mine.id);

  t.after(poll.stop);
  mine.process.output('stdout', 'before');
  await until(() => poll.box.output === 'before', 'the early output');

  const watch = watching(h, 'project-1');

  t.after(() => watch.stop());
  await until(() => watch.items.length >= 1, 'the snapshot');

  const snapshot = (
    watch.items[0] as {
      snapshot?: { projectId: string; terminals: { id: string }[] };
    }
  ).snapshot;

  assert.equal(snapshot?.projectId, 'project-1');
  assert.deepEqual(
    snapshot?.terminals.map((terminal) => terminal.id),
    [mine.id],
  );

  const other = await shell(h, 'thread-2');

  other.process.output('stdout', 'elsewhere');
  mine.process.output('stdout', 'after');
  await until(
    () =>
      watch.items.some(
        (item) =>
          (item as { output?: { data?: string } }).output?.data === 'after',
      ),
    'the later output',
  );
  await h.terminal().stop({ terminalId: mine.id });
  await until(() => watch.kinds().includes('removed'), 'the removal');

  const text = JSON.stringify(watch.items);

  assert.doesNotMatch(text, /before|elsewhere|project-2|thread-2/);

  watch.stop();
  await sleep(20);
  const seen = watch.items.length;

  other.process.output('stdout', 'unseen');
  await h.terminal().rename({ terminalId: other.id, name: 'quiet' });
  await sleep(20);
  assert.equal(watch.items.length, seen);
});

void test('R15: the closing hook cancels the Start of the closing Thread’s terminals only and answers {}', async (t) => {
  const h = await activated(t, { threads: twoThreads });
  const closing = await shell(h, 'thread-1');
  const staying = await shell(h, 'thread-2');
  const response = await h.hooks().handle({
    contract: 'runtime.hooks/v1',
    hook: 'onThreadsClosingHook',
    input: anyPack(
      OnThreadsClosingHookInputSchema,
      create(OnThreadsClosingHookInputSchema, {
        projectId: 'project-1',
        threadIds: ['thread-1'],
      }),
    ),
  });

  assert.equal(response.output, undefined);
  assert.equal(response.decision, undefined);
  await until(
    () => closing.process.signal.aborted,
    'the closing Start cancelled',
  );
  assert.equal(staying.process.signal.aborted, false);
});

void test('R16: the redaction list redacts later, split and command text, and is read before each start', async (t) => {
  const h = await activated(t);

  h.setRedactions(['s3cret']);
  const reads = () =>
    h.calls.filter((call) => call.method === 'secrets.redactions').length;
  const split = await shell(h);

  assert.equal(reads(), 1);

  const poll = pollSnapshot(h, split.id);

  t.after(poll.stop);
  split.process.output('stdout', 'a s3c');
  split.process.output('stdout', 'ret b');
  await until(
    () => poll.box.output === 'a [REDACTED] b',
    'the split secret redacted',
  );

  h.setRedactions([]);
  const later = await shell(h);

  assert.equal(reads(), 2);

  const laterPoll = pollSnapshot(h, later.id);

  t.after(laterPoll.stop);
  h.watches[0]?.push(['later-secret']);
  await sleep(50);
  later.process.output('stdout', 'x later-secret y');
  await until(
    () => laterPoll.box.output === 'x [REDACTED] y',
    'the watched secret redacted',
  );

  h.setRedactions(['s3cret']);
  await h.terminal(promptScope).run({
    command: 'echo s3cret',
    cwd: '/workspace/app',
    timeoutMs: 0,
    background: true,
  });
  assert.equal(reads(), 3);

  const { terminals } = await h.terminal().list({ projectId: 'project-1' });

  assert.equal(terminals.at(-1)?.command, 'echo [REDACTED]');
});

void test('R20: deactivate cancels WatchRedactions and leaves running Start streams open', async (t) => {
  const h = await activated(t);
  const { process } = await shell(h);

  h.host.deactivate();
  await until(
    () => h.watches[0]?.signal.aborted === true,
    'WatchRedactions cancelled',
  );
  assert.equal(process.signal.aborted, false);
});
