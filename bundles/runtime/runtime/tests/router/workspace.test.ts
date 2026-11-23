// `runtime.workspace/v1` over the router (phase 3, slice S47b, contract §2.7,
// §2.8, §4): the calling prompt's working directory, Thread sessions bound to
// the opening instance, and how a session ends (cancellation, the instance
// gone, stop, deactivate, drain). Tests 23–38 of the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Caller, CallScope, ContractError } from 'bundle/contracts';
import type { BundleInstance } from 'bundle/host';
import type { Sandbox, SandboxExecInput } from 'sandbox';
import type { SandboxLease } from 'sandpool';

import type {
  StartRequestSchema,
  StartResponse,
} from '../../src/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { LeaseService } from '../../src/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  type OpenThreadRequestSchema,
  type OpenThreadResponse,
  WorkspaceService,
} from '../../src/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import type { ScriptedRun } from '../support/executor.js';
import { fakeSandbox } from '../support/sandbox.js';
import { recordingSandbox } from './sandbox.js';
import {
  type Collector,
  callsOf,
  collect,
  contractErrorOf,
  eventually,
  failingBackend,
  type Gate,
  gate,
  type Harness,
  handleHostStop,
  harness,
  projectState,
  putsOf,
  rejectionOf,
  seedThread,
  settle,
  started,
  storageTypes,
  within,
} from './support.js';

const unknownId = '00000000-0000-4000-8000-00000000ffff';

/** The instance the test router's default caller is (`test`, generation 1). */
const opener: BundleInstance = {
  bundleId: 'test',
  generation: 1,
  incarnation: 1,
};
/** Another bundle. */
const otherBundle: Caller = {
  bundleId: 'other',
  version: '1.0.0',
  generation: 1,
};
/** The opener's bundle, another generation. */
const nextGeneration: Caller = {
  bundleId: 'test',
  version: '0.0.0',
  generation: 2,
};
/** The runtime instance the test router runs, as a generation event names it. */
const self = { bundleId: 'runtime', generation: 1, incarnation: 1 };
const successor = { bundleId: 'runtime', generation: 2, incarnation: 1 };

type OpenRequest = MessageInitShape<typeof OpenThreadRequestSchema>;
type StartItem = MessageInitShape<typeof StartRequestSchema>;

/** A `Start` head on the sandbox of Thread session `threadSessionId`. */
const sessionHead = (
  threadSessionId: string,
  cmd: readonly string[],
): StartItem => ({
  item: {
    case: 'head',
    value: { target: { threadSessionId }, request: { cmd: [...cmd] } },
  },
});

/** `Start` answers as `[case]`, `[output, stream, data]` or `[exit, code]`. */
const startItems = (items: readonly StartResponse[]) =>
  items.map(({ item }) => {
    if (item.case === 'output')
      return [item.case, item.value.stream, item.value.data];
    if (item.case === 'exit') return [item.case, item.value.exitCode];

    return [item.case];
  });

/** Resolves when `held` opens or the run is stopped. */
const holdUntil = (held: Gate, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    void held.promise.then(resolve);
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

/** The failure of `promise`: its gRPC code and its Doric error. */
const failure = async (
  promise: Promise<unknown>,
): Promise<{ readonly grpc: Code; readonly error: ContractError }> => {
  const rejected = await rejectionOf(promise);
  assert.ok(rejected instanceof ConnectError, String(rejected));

  return { grpc: rejected.code, error: contractErrorOf(rejected) };
};

/** The failure a collected stream ended with: its gRPC code and its Doric error. */
const streamFailure = (items: Collector<unknown>) => {
  const rejected = items.error();
  assert.ok(rejected instanceof ConnectError, String(rejected));

  return { grpc: rejected.code, error: contractErrorOf(rejected) };
};

/** A ready Project created through `runtime/v2`. */
const readyProject = async (h: Harness, name = 'Project') => {
  const { project } = await h.runtime().createProject({ name });
  assert.ok(project !== undefined);
  await projectState(h, project.id, 'ready');

  return project;
};

/** A Thread created in `projectId` through `runtime.threads/v1`. */
const newThread = async (h: Harness, projectId: string, name = 'Thread') => {
  const { thread } = await h.threads().createThread({ projectId, name });
  assert.ok(thread !== undefined);

  return thread;
};

/** The stored record of Thread `id`. */
const threadRecord = async (h: Harness, id: string) => {
  const { thread } = await h.threads().thread({ id });
  assert.ok(thread !== undefined);

  return thread;
};

/** Waits until Thread `id` reads `state`. */
const threadState = (h: Harness, id: string, state: string) =>
  eventually(
    async () => (await h.threads().thread({ id })).thread?.state === state,
    `Thread ${id} ${state}`,
  );

/** An `OpenThread` stream read in the background, and how to cancel it. */
const open = (h: Harness, request: OpenRequest, caller?: Caller) => {
  const controller = new AbortController();
  const items = collect(
    h
      .workspace(undefined, caller)
      .openThread(request, { signal: controller.signal }),
  );

  return { items, cancel: () => controller.abort() };
};

/** The first item of `items`; fails when the stream ends without one. */
const firstItem = async (
  items: Collector<OpenThreadResponse>,
): Promise<OpenThreadResponse> => {
  await eventually(
    () => items.items.length > 0 || items.ended(),
    'the first OpenThread item',
  );
  const [first] = items.items;
  if (first === undefined)
    assert.fail(
      `OpenThread ended without an item: ${String(items.error() ?? 'no error')}`,
    );

  return first;
};

/** An open session: its `ready` item, its stream and how to cancel it. */
const session = async (h: Harness, request: OpenRequest, caller?: Caller) => {
  const opened = open(h, request, caller);
  const first = await firstItem(opened.items);
  assert.equal(first.status.case, 'ready');
  if (first.status.case !== 'ready') throw new Error('not ready');

  return { ...opened, ready: first.status.value };
};

/** A request stream a case pushes into and half-closes. */
const pushable = <T>() => {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const rouse = () => {
    wake?.();
    wake = undefined;
  };

  return {
    push: (item: T) => {
      items.push(item);
      rouse();
    },
    end: () => {
      closed = true;
      rouse();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

/** The `sandbox/v1.Exec` calls whose command is `cmd`, as JSON. */
const execsOf = (h: Harness, cmd: readonly string[]) =>
  (
    callsOf(h, 'sandbox.exec') as {
      leaseId?: string;
      request?: { cmd?: string[] };
    }[]
  ).filter(
    ({ request }) => JSON.stringify(request?.cmd) === JSON.stringify(cmd),
  );

/** The `hooks/v1.Run`s of `onThreadCwdChangedHook`. */
const cwdChangedRuns = (h: Harness) =>
  h.runs.filter(({ hook }) => hook === 'onThreadCwdChangedHook');

/** One sandbox holding repository `alpha` (a GitHub origin), its subdirectory and a file. */
const sandboxWithAlpha = () =>
  fakeSandbox({
    id: 'vm-7',
    entries: [
      { path: 'alpha' },
      { path: 'alpha/src' },
      { path: 'alpha/README.md', content: 'x' },
    ],
    repositories: [
      { path: 'alpha', git: { origin: 'git@github.com:owner/repo.git' } },
    ],
  }) as unknown as Sandbox;

/**
 * A sandbox whose root gains a repository (GitHub origin) on `addRepository`,
 * recording the path of every repository-hint probe.
 */
const hintedSandbox = () => {
  let withRepository = false;
  const plain = fakeSandbox({ id: 'vm-7' });
  const repository = fakeSandbox({
    id: 'vm-7',
    repositories: [
      { path: '', git: { origin: 'git@github.com:owner/repo.git' } },
    ],
  });
  const handle = fakeSandbox({ id: 'vm-7' });
  const probes: string[] = [];
  handle.exec = async (input: SandboxExecInput) => {
    if (input.cmd.includes('git-hint'))
      probes.push(input.cmd[input.cmd.length - 1] ?? '');

    return (withRepository ? repository : plain).exec(input);
  };

  return {
    sandbox: handle as unknown as Sandbox,
    probes,
    addRepository: () => {
      withRepository = true;
    },
    removeRepository: () => {
      withRepository = false;
    },
  };
};

/** A started harness over one scripted sandbox and an executor whose runs it records. */
const workspaceHarness = async (
  t: Parameters<typeof started>[0],
  sandbox: Sandbox = fakeSandbox({ id: 'vm-7' }) as unknown as Sandbox,
  execute: (run: ScriptedRun) => Promise<string> = async () => 'done',
) => {
  const runs: ScriptedRun[] = [];
  const h = await started(t, {
    sandbox: { sandbox },
    // A cancelled run (e.g. by TerminateProject) ends when its session is cancelled, as with a real
    // executor, rather than after the 5 s cancel grace (S51e).
    executorWatchCancel: true,
    execute: async (run) => {
      runs.push(run);

      return execute(run);
    },
  });

  return { h, runs };
};

describe('runtime.workspace/v1', () => {
  test('23: before activate resolved, OpenThread fails UNAVAILABLE, code unavailable', async (t) => {
    const held = gate();
    const h = harness({ defineTypeGate: held.promise });
    t.after(() => h.stop());
    const activation = h.activate();
    await settle();

    const { items } = open(h, { threadId: unknownId, exclusive: false });
    await within(items.done, 'the refused OpenThread');

    assert.deepEqual(items.items, []);
    const { grpc, error } = streamFailure(items);
    assert.equal(grpc, Code.Unavailable, error.message);
    assert.equal(error.code, 'unavailable');
    held.open();
    await within(activation, 'activate');
  });

  test('24: OpenThread answers one refusal item, then ends: missing for an unknown Thread, inactive for a terminal Thread, pending for a Project whose Acquire is held', async (t) => {
    const acquireHeld = gate();
    t.after(() => acquireHeld.open());
    let holdNext = false;
    const h = await started(t, {
      sandbox: {
        acquire: async ({ signal }) => {
          if (holdNext) await holdUntil(acquireHeld, signal);

          return {
            sandbox: fakeSandbox({ id: 'vm-7' }),
            release: async () => undefined,
          } as unknown as SandboxLease;
        },
      },
    });
    const refusal = async (threadId: string, status: string) => {
      const { items } = open(h, { threadId, exclusive: true });
      await within(items.done, `the ${status} OpenThread`);
      assert.equal(items.error(), undefined, String(items.error()));
      assert.deepEqual(
        items.items.map(({ status: outcome }) => outcome.case),
        [status],
      );
    };

    await refusal(unknownId, 'missing');

    const project = await readyProject(h);
    const ended = await newThread(h, project.id, 'Ended');
    await h.threads().terminateThread({ id: ended.id });
    await threadState(h, ended.id, 'cancelled');
    await refusal(ended.id, 'inactive');

    holdNext = true;
    const { project: pending } = await h
      .runtime()
      .createProject({ name: 'Pending' });
    assert.ok(pending !== undefined);
    await eventually(
      () => callsOf(h, 'sandbox.acquire').length === 2,
      'the held Acquire',
    );
    const waiting = await newThread(h, pending.id, 'Waiting');
    await refusal(waiting.id, 'pending');
  });

  test("25: OpenThread on a live Thread answers ready with the session id, the Project, the Thread, its cwd and the lease's sandbox id, then nothing while it stays open", async (t) => {
    const { h } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const { cwd } = await threadRecord(h, thread.id);

    const opened = await session(h, { threadId: thread.id, exclusive: false });

    assert.ok(opened.ready.threadSessionId.length > 0);
    assert.equal(opened.ready.projectId, project.id);
    assert.equal(opened.ready.threadId, thread.id);
    assert.equal(opened.ready.cwd, cwd);
    assert.equal(opened.ready.cwd, '/workspace');
    assert.equal(opened.ready.sandboxId, 'vm-7');
    await settle();
    assert.equal(opened.items.items.length, 1);
    assert.equal(opened.items.ended(), false);

    opened.cancel();
    await within(opened.items.done, 'the cancelled OpenThread');
  });

  test('26: an exclusive session holds the Project lock: a prompt sent meanwhile runs only once the stream is cancelled; a non-exclusive session does not block it (T3.6)', async (t) => {
    const { h, runs } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);

    const exclusive = await session(h, {
      threadId: thread.id,
      exclusive: true,
    });
    const prompted = h.threads().prompt({ id: thread.id, prompt: 'First.' });
    await settle();
    await settle();
    assert.equal(runs.length, 0, 'no run while the exclusive session is open');

    exclusive.cancel();
    await eventually(() => runs.length === 1, 'the run after the session');
    await within(prompted, 'the first Prompt');
    await threadState(h, thread.id, 'ready');

    const shared = await session(h, { threadId: thread.id, exclusive: false });
    const second = h.threads().prompt({ id: thread.id, prompt: 'Second.' });
    await eventually(
      () => runs.length === 2,
      'the run beside a non-exclusive session',
    );
    await within(second, 'the second Prompt');
    assert.equal(shared.items.ended(), false);
    shared.cancel();
    await within(shared.items.done, 'the cancelled OpenThread');
  });

  test('27: ThreadState answers closing false and the cwds of Threads with an active prompt; closing true once the Project starts closing', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const { h, runs } = await workspaceHarness(t, undefined, async (run) => {
      await holdUntil(held, run.signal);

      return 'done';
    });
    const project = await readyProject(h);
    const watched = await newThread(h, project.id, 'Watched');
    const busy = await newThread(h, project.id, 'Busy');
    const { cwd: busyCwd } = await threadRecord(h, busy.id);
    const opened = await session(h, { threadId: watched.id, exclusive: false });
    const workspace = h.workspace();
    const id = opened.ready.threadSessionId;

    const idle = await workspace.threadState({ threadSessionId: id });
    assert.equal(idle.closing, false);
    assert.deepEqual(idle.busyCwds, []);

    await h.threads().prompt({ id: busy.id, prompt: 'Hold.' });
    await eventually(() => runs.length === 1, 'the held run');
    const state = await workspace.threadState({ threadSessionId: id });
    assert.equal(state.closing, false);
    assert.deepEqual(state.busyCwds, [busyCwd]);

    await h.runtime().terminateProject({ id: project.id });
    await eventually(
      async () =>
        (await workspace.threadState({ threadSessionId: id })).closing,
      'closing: true',
    );
    opened.cancel();
    await projectState(h, project.id, 'cancelled');
  });

  test("28: a lease operation naming the session's threadSessionId runs on the session's sandbox with no scope at all", async (t) => {
    const recording = recordingSandbox({ id: 'vm-5', root: '/srv' });
    const h = await started(t, { sandbox: { sandbox: recording.sandbox } });
    const project = await readyProject(h);
    const [leaseId] = h.sandboxProvider.leases();
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: false });
    const target = { threadSessionId: opened.ready.threadSessionId };

    const described = await h.lease().describe({ target });
    assert.equal(described.id, 'vm-5');
    assert.equal(described.root, '/srv');
    const { response } = await h.lease().exec({
      target,
      request: { cmd: ['echo', 'session'] },
    });
    assert.equal(response?.stdout, 'out');
    assert.deepEqual(
      execsOf(h, ['echo', 'session']).map(({ leaseId: id }) => id),
      [leaseId],
    );

    opened.cancel();
  });

  test('29: a threadSessionId from another bundle or another generation of the same bundle fails NOT_FOUND unknown_session on ThreadState and lease ops; so does any use after the stream is cancelled', async (t) => {
    const { h } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: false });
    const threadSessionId = opened.ready.threadSessionId;
    const assertUnknown = async (promise: Promise<unknown>, what: string) => {
      const { grpc, error } = await failure(promise);
      assert.equal(grpc, Code.NotFound, `${what}: ${error.message}`);
      assert.equal(error.code, 'unknown_session', what);
    };

    for (const caller of [otherBundle, nextGeneration]) {
      const who = `${caller.bundleId}@${String(caller.generation)}`;
      await assertUnknown(
        h.workspace(undefined, caller).threadState({ threadSessionId }),
        `ThreadState from ${who}`,
      );
      await assertUnknown(
        h.lease(undefined, caller).describe({ target: { threadSessionId } }),
        `Describe from ${who}`,
      );
    }
    const own = await h.workspace().threadState({ threadSessionId });
    assert.equal(own.closing, false);

    opened.cancel();
    await within(opened.items.done, 'the cancelled OpenThread');
    await eventually(async () => {
      try {
        await h.workspace().threadState({ threadSessionId });
        return false;
      } catch (error) {
        return contractErrorOf(error).code === 'unknown_session';
      }
    }, 'the ended session to be unknown');
    await assertUnknown(
      h.workspace().threadState({ threadSessionId }),
      'ThreadState after the end',
    );
    await assertUnknown(
      h.lease().describe({ target: { threadSessionId } }),
      'Describe after the end',
    );
  });

  test("30: a Start on the session's sandbox keeps running after the session's stream is cancelled once it answered started: the fake's Start is not aborted and its output still arrives (S54a L3)", async (t) => {
    const recording = recordingSandbox({
      id: 'vm-5',
      root: '/srv',
      startable: true,
    });
    const h = await started(t, { sandbox: { sandbox: recording.sandbox } });
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: false });
    const requests = pushable<StartItem>();

    const output = collect(h.lease().start(requests));
    requests.push({
      item: {
        case: 'head',
        value: {
          target: { threadSessionId: opened.ready.threadSessionId },
          request: { cmd: ['tail', '-f'] },
        },
      },
    });
    await output.waitFor(1, 'the started item');
    assert.equal(output.items[0]?.item.case, 'started');

    opened.cancel();
    await within(opened.items.done, 'the cancelled OpenThread');
    await settle();
    assert.equal(h.sandboxProvider.starts[0]?.signal.aborted, false);
    assert.equal(recording.processes[0]?.terminated, false);
    recording.processes[0]?.input.onOutput?.({
      stream: 'stdout',
      data: 'still here',
    });
    await output.waitFor(2, 'the output after the session ended');
    recording.processes[0]?.finish({
      exitCode: 0,
      stdout: 'still here',
      stderr: '',
      stdoutBytes: new TextEncoder().encode('still here'),
      stderrBytes: new Uint8Array(),
    });
    requests.end();
    await within(output.done, 'the end of Start');
    assert.equal(output.error(), undefined);
    assert.deepEqual(startItems(output.items), [
      ['started'],
      ['output', 'stdout', 'still here'],
      ['exit', 0],
    ]);
  });

  test('S54a L1: Start on a session answers started first, then the output the process produced before start resolved, in order, then later output, then exit', async (t) => {
    const recording = recordingSandbox({
      id: 'vm-5',
      root: '/srv',
      startable: true,
      startOutput: [
        { stream: 'stdout', data: 'early one' },
        { stream: 'stderr', data: 'early two' },
      ],
    });
    const h = await started(t, { sandbox: { sandbox: recording.sandbox } });
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: false });
    t.after(() => opened.cancel());
    const requests = pushable<StartItem>();

    const output = collect(h.lease().start(requests));
    requests.push(sessionHead(opened.ready.threadSessionId, ['bash']));
    await output.waitFor(3, 'started and the early output');
    recording.processes[0]?.input.onOutput?.({
      stream: 'stdout',
      data: 'late',
    });
    await output.waitFor(4, 'the later output');
    recording.processes[0]?.finish({
      exitCode: 0,
      stdout: 'early onelate',
      stderr: 'early two',
      stdoutBytes: new TextEncoder().encode('early onelate'),
      stderrBytes: new TextEncoder().encode('early two'),
    });
    requests.end();
    await within(output.done, 'the end of Start');

    assert.equal(output.error(), undefined);
    assert.deepEqual(startItems(output.items), [
      ['started'],
      ['output', 'stdout', 'early one'],
      ['output', 'stderr', 'early two'],
      ['output', 'stdout', 'late'],
      ['exit', 0],
    ]);
  });

  test('S54a L2: a head refused (a sandbox without start: unsupported_operation; an unknown session: unknown_session) fails the call with no started item', async (t) => {
    const recording = recordingSandbox({ id: 'vm-5', root: '/srv' });
    const h = await started(t, { sandbox: { sandbox: recording.sandbox } });
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: false });
    t.after(() => opened.cancel());

    for (const [threadSessionId, code] of [
      [opened.ready.threadSessionId, 'unsupported_operation'],
      [unknownId, 'unknown_session'],
    ] as const) {
      const requests = pushable<StartItem>();
      const output = collect(h.lease().start(requests));
      requests.push(sessionHead(threadSessionId, ['bash']));
      await within(output.done, `the refused Start (${code})`);
      requests.end();

      assert.equal(contractErrorOf(output.error()).code, code);
      assert.deepEqual(startItems(output.items), [], `no item (${code})`);
    }
  });

  test('31: with refreshHint, the end of the session probes the hint on the sandbox and a changed hint fires onThreadCwdChangedHook; without it, no probe', async (t) => {
    const hinted = hintedSandbox();
    const { h } = await workspaceHarness(t, hinted.sandbox);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    assert.equal((await threadRecord(h, thread.id)).cwdRepo, undefined);

    const refreshed = await session(h, {
      threadId: thread.id,
      exclusive: true,
      refreshHint: true,
    });
    hinted.addRepository();
    const probes = hinted.probes.length;
    refreshed.cancel();
    await eventually(
      () => cwdChangedRuns(h).length === 1,
      'onThreadCwdChangedHook after the session',
    );
    assert.ok(hinted.probes.length > probes, 'the hint was probed');
    assert.equal((await threadRecord(h, thread.id)).cwdRepo, 'github');

    hinted.removeRepository();
    const plain = await session(h, { threadId: thread.id, exclusive: true });
    const before = hinted.probes.length;
    plain.cancel();
    await within(plain.items.done, 'the cancelled OpenThread');
    await settle();
    await settle();
    assert.equal(hinted.probes.length, before, 'no probe without refreshHint');
    assert.equal(cwdChangedRuns(h).length, 1);
    assert.equal((await threadRecord(h, thread.id)).cwdRepo, 'github');
  });

  test('32: resume brings back a suspended Project (one Acquire) before ready; cancelling OpenThread while that Acquire is held does not abort it, and no session opens', async (t) => {
    const acquireHeld = gate();
    t.after(() => acquireHeld.open());
    const signals: (AbortSignal | undefined)[] = [];
    let holdNext = false;
    const h = await started(t, {
      sandbox: {
        acquire: async ({ signal }) => {
          signals.push(signal);
          if (holdNext) await acquireHeld.promise;

          return {
            sandbox: fakeSandbox({ id: 'vm-7' }),
            release: async () => undefined,
          } as unknown as SandboxLease;
        },
      },
    });

    const suspended = await seedThread(h);
    const resumed = await session(h, {
      threadId: suspended.thread.id,
      exclusive: true,
      resume: true,
    });
    assert.equal(resumed.ready.projectId, suspended.project.id);
    assert.equal(resumed.ready.sandboxId, 'vm-7');
    assert.equal(callsOf(h, 'sandbox.acquire').length, 1);
    resumed.cancel();
    await within(resumed.items.done, 'the first session');

    holdNext = true;
    const second = await seedThread(h);
    const abandoned = open(h, {
      threadId: second.thread.id,
      exclusive: true,
      resume: true,
    });
    await eventually(
      () => callsOf(h, 'sandbox.acquire').length === 2,
      'the held Acquire',
    );
    abandoned.cancel();
    await within(abandoned.items.done, 'the cancelled OpenThread');
    await settle();
    assert.equal(signals[1]?.aborted ?? false, false, 'Acquire not aborted');
    assert.deepEqual(abandoned.items.items, []);

    acquireHeld.open();
    // No session took the lock: an exclusive session on the same Thread opens
    // on the Project the held Acquire brought back.
    const after = await session(h, {
      threadId: second.thread.id,
      exclusive: true,
      resume: true,
    });
    assert.equal(after.ready.projectId, second.project.id);
    assert.equal(callsOf(h, 'sandbox.acquire').length, 2);
    after.cancel();
  });

  test("33: the opener's instance gone ends its sessions: the lock is released (the waiting prompt runs) and their ids answer unknown_session, while another instance's session stays open (RK15)", async (t) => {
    const { h, runs } = await workspaceHarness(t);
    const project = await readyProject(h);
    const locked = await newThread(h, project.id, 'Locked');
    const kept = await newThread(h, project.id, 'Kept');
    const mine = await session(h, { threadId: locked.id, exclusive: true });
    const theirs = await session(
      h,
      { threadId: kept.id, exclusive: false },
      otherBundle,
    );
    t.after(() => {
      mine.cancel();
      theirs.cancel();
    });
    const prompted = h.threads().prompt({ id: locked.id, prompt: 'Wait.' });
    await settle();
    assert.equal(runs.length, 0, 'the prompt waits for the lock');

    h.gone(opener);

    await eventually(() => runs.length === 1, 'the prompt after the gone');
    await within(prompted, 'the Prompt');
    const { grpc, error } = await failure(
      h
        .workspace()
        .threadState({ threadSessionId: mine.ready.threadSessionId }),
    );
    assert.equal(grpc, Code.NotFound, error.message);
    assert.equal(error.code, 'unknown_session');
    const state = await h
      .workspace(undefined, otherBundle)
      .threadState({ threadSessionId: theirs.ready.threadSessionId });
    assert.equal(state.closing, false);
    assert.equal(theirs.items.ended(), false);
  });

  test('34: onHostStopHook with an open exclusive session fails the stream FAILED_PRECONDITION shutting_down and completes (no deadlock)', async (t) => {
    const { h } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: true });

    await within(handleHostStop(h), 'onHostStopHook');
    await within(opened.items.done, 'the ended session');

    const { grpc, error } = streamFailure(opened.items);
    assert.equal(grpc, Code.FailedPrecondition, error.message);
    assert.equal(error.code, 'shutting_down');
  });

  test('34: deactivate with an open exclusive session fails the stream FAILED_PRECONDITION shutting_down and completes (no deadlock)', async (t) => {
    const { h } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: true });

    await within(h.deactivate(), 'deactivate');
    await within(opened.items.done, 'the ended session');

    const { grpc, error } = streamFailure(opened.items);
    assert.equal(grpc, Code.FailedPrecondition, error.message);
    assert.equal(error.code, 'shutting_down');
  });

  test('35: a handover drain with an open exclusive session ends it with shutting_down and the drain completes', async (t) => {
    const { h } = await workspaceHarness(t);
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const opened = await session(h, { threadId: thread.id, exclusive: true });

    await h.control.generationChanged({
      event: 'draining',
      subject: self,
      live: [
        { instance: self, state: 'draining' },
        { instance: successor, state: 'active' },
      ],
    });

    await within(opened.items.done, 'the ended session');
    const { grpc, error } = streamFailure(opened.items);
    assert.equal(grpc, Code.FailedPrecondition, error.message);
    assert.equal(error.code, 'shutting_down');
    await eventually(
      () => callsOf(h, 'generation.release').length === 1,
      'the drain to end',
    );
  });

  test("36: Cwd, SetCwd (set, outside, missing, not-directory) and Location during a run answer today's values; after the run each fails FAILED_PRECONDITION thread_control_inactive", async (t) => {
    const held = gate();
    t.after(() => held.open());
    const { h, runs } = await workspaceHarness(
      t,
      sandboxWithAlpha(),
      async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    );
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const { promptResult } = await h
      .threads()
      .prompt({ id: thread.id, prompt: 'Run.' });
    assert.ok(promptResult?.promptId !== undefined);
    await eventually(() => runs.length === 1, 'the running prompt');
    const scope: CallScope = {
      projectId: project.id,
      threadId: thread.id,
      promptId: promptResult.promptId,
    };
    const workspace = h.workspace(scope);

    assert.equal((await workspace.cwd({})).cwd, '/workspace');
    for (const [path, status] of [
      ['/etc', 'outside'],
      ['alpha/nowhere', 'missing'],
      ['alpha/README.md', 'not-directory'],
    ] as const) {
      const refused = await workspace.setCwd({ path });
      assert.equal(refused.status, status, path);
      assert.equal(refused.cwd, undefined, path);
    }
    const moved = await workspace.setCwd({ path: 'alpha' });
    assert.equal(moved.status, 'set');
    assert.equal(moved.cwd, '/workspace/alpha');
    assert.equal((await workspace.cwd({})).cwd, '/workspace/alpha');
    const location = await workspace.location({});
    assert.equal(location.cwd, '/workspace/alpha');
    assert.equal(location.repo, 'github');

    held.open();
    await threadState(h, thread.id, 'ready');
    for (const [name, call] of [
      ['Cwd', () => workspace.cwd({})],
      ['SetCwd', () => workspace.setCwd({ path: 'alpha' })],
      ['Location', () => workspace.location({})],
    ] as const) {
      const { grpc, error } = await failure(call());
      assert.equal(grpc, Code.FailedPrecondition, `${name}: ${error.message}`);
      assert.equal(error.code, 'thread_control_inactive', name);
    }
  });

  test("37: SetCwd{path:'x'} answers cwd exactly when the status is set (the CEL rule holds on every answer)", async (t) => {
    const held = gate();
    t.after(() => held.open());
    const { h, runs } = await workspaceHarness(
      t,
      fakeSandbox({
        id: 'vm-7',
        entries: [{ path: 'x' }],
      }) as unknown as Sandbox,
      async (run) => {
        await holdUntil(held, run.signal);

        return 'done';
      },
    );
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);
    const { promptResult } = await h
      .threads()
      .prompt({ id: thread.id, prompt: 'Run.' });
    assert.ok(promptResult?.promptId !== undefined);
    await eventually(() => runs.length === 1, 'the running prompt');
    const workspace = h.workspace({
      projectId: project.id,
      threadId: thread.id,
      promptId: promptResult.promptId,
    });

    const set = await workspace.setCwd({ path: 'x' });
    assert.equal(set.status, 'set');
    assert.equal(set.cwd, '/workspace/x');
    // From /workspace/x, `x` names /workspace/x/x, which does not exist.
    const missing = await workspace.setCwd({ path: 'x' });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.cwd, undefined);
    for (const answer of [set, missing])
      assert.equal(answer.status === 'set', answer.cwd !== undefined);
  });

  test('38: the harness serves LeaseService and WorkspaceService as main.ts will, and the router accepts both', async (t) => {
    const { h } = await workspaceHarness(t);

    assert.ok(h.served().includes(LeaseService.typeName));
    assert.ok(h.served().includes(WorkspaceService.typeName));
    for (const [what, call] of [
      [
        'ThreadState',
        () => h.workspace().threadState({ threadSessionId: 'no-session' }),
      ],
      [
        'Describe',
        () => h.lease().describe({ target: { threadSessionId: 'no-session' } }),
      ],
    ] as const) {
      const { grpc, error } = await failure(call());
      assert.equal(grpc, Code.NotFound, `${what}: ${error.message}`);
      assert.equal(error.code, 'unknown_session', what);
    }
  });
});

describe('runtime.workspace/v1: the hint refresh after a session (S48b, S47b carry-over)', () => {
  /** The hint-refresh warnings `log` recorded. */
  const hintWarnings = (h: Harness) =>
    h.logs.filter(
      ({ level, message }) =>
        level === 'warn' && message === 'Thread session hint refresh failed',
    );

  test('26: a hint write that fails after the session ended is logged at warn with threadId and err; the ended stream had no error', async (t) => {
    let failing = false;
    const backend = failingBackend(
      (method, input) =>
        failing &&
        method === 'commit' &&
        putsOf(
          input,
          storageTypes.thread,
          (document) => document.cwdRepo === 'github',
        ),
    );
    t.after(() => backend.close());
    const hinted = hintedSandbox();
    const h = await started(t, {
      sandbox: { sandbox: hinted.sandbox },
      backend,
    });
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);

    const refreshed = await session(h, {
      threadId: thread.id,
      exclusive: true,
      refreshHint: true,
    });
    hinted.addRepository();
    failing = true;
    h.gone(opener);
    await within(refreshed.items.done, 'the ended OpenThread');

    assert.equal(refreshed.items.error(), undefined);
    await eventually(
      () => hintWarnings(h).length > 0,
      'the hint refresh warning',
    );
    await settle();
    const warnings = hintWarnings(h);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.fields?.threadId, thread.id);
    assert.ok(warnings[0]?.fields?.err !== undefined, 'err is logged');
    assert.equal(
      (await threadRecord(h, thread.id)).cwdRepo,
      undefined,
      'the hint write failed',
    );
  });

  test('27: a withThread failure before any session opened still fails the stream with it, and nothing is logged', async (t) => {
    let failing: string | undefined;
    const backend = failingBackend(
      (method, input) =>
        method === 'get' &&
        failing !== undefined &&
        (input as { type?: unknown; id?: unknown } | undefined)?.type ===
          storageTypes.thread &&
        (input as { id?: unknown }).id === failing,
    );
    t.after(() => backend.close());
    const h = await started(t, { backend });
    const project = await readyProject(h);
    const thread = await newThread(h, project.id);

    failing = thread.id;
    const { items } = open(h, {
      threadId: thread.id,
      exclusive: true,
      refreshHint: true,
    });
    await within(items.done, 'the failed OpenThread');
    failing = undefined;

    assert.deepEqual(items.items, []);
    assert.ok(items.error() instanceof ConnectError, String(items.error()));
    await settle();
    assert.deepEqual(hintWarnings(h), []);
  });
});
