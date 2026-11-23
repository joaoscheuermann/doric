// `withThreadSession` (phase 3, slice S54a, contract §2.2, §5 W1–W6): one
// Thread session around a task over `runtime.workspace/v1.OpenThread`. The
// `workspace` client is the boundary: a fake whose stream a case drives and
// which records the request, the call options and the stream's cancellation.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { type CallOptions, Code, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
  toConnectError,
} from 'bundle/contracts';

import {
  type OpenThreadRequestSchema,
  type OpenThreadResponse,
  OpenThreadResponseSchema,
} from '../../src/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import {
  type OpenedThreadSession,
  withThreadSession,
} from '../../src/contracts/index.js';

type OpenRequest = MessageInitShape<typeof OpenThreadRequestSchema>;

const request: OpenRequest = { threadId: 'thread-1', exclusive: true };

const session: OpenedThreadSession = {
  threadSessionId: 'session-1',
  projectId: 'project-1',
  threadId: 'thread-1',
  cwd: '/work/repo',
  sandboxId: 'vm-1',
};

const ready = (): OpenThreadResponse =>
  create(OpenThreadResponseSchema, {
    status: { case: 'ready', value: session },
  });

const refused = (
  status: 'missing' | 'inactive' | 'pending',
): OpenThreadResponse =>
  create(OpenThreadResponseSchema, { status: { case: status, value: {} } });

/** Lets pending callbacks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** `promise`, or a failure naming `what` after 5 s. */
const within = async <T>(promise: Promise<T>, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** What `promise` rejects with; fails the test when it resolves or hangs. */
const rejectionOf = async (
  promise: Promise<unknown>,
  what: string,
): Promise<unknown> => {
  const timeout = Symbol('timeout');
  let timer: NodeJS.Timeout | undefined;
  try {
    const settled = await Promise.race([
      promise.then(
        () => assert.fail(`${what} resolved`),
        (error: unknown) => error,
      ),
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), 5_000);
      }),
    ]);
    if (settled === timeout) assert.fail(`timed out waiting for ${what}`);

    return settled;
  } finally {
    clearTimeout(timer);
  }
};

/** The Doric error a rejection carries, as a caller reads it. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) return fromConnectError(error);
  assert.ok(isContractError(error), `expected a Doric error: ${String(error)}`);

  return error;
};

/** A settable promise. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
};

/**
 * A fake `openThread` whose stream answers what the case pushes, fails or
 * ends on demand, and stays open otherwise. The stream counts as cancelled
 * when the call's signal aborts or its iterator is returned; either way a
 * pending read ends, and an abort rejects it as the cancellation.
 */
const fakeWorkspace = () => {
  const queue: (
    | { readonly kind: 'item'; readonly item: OpenThreadResponse }
    | { readonly kind: 'fail'; readonly error: unknown }
    | { readonly kind: 'end' }
  )[] = [];
  let waiting: (() => void) | undefined;
  const wake = () => {
    waiting?.();
    waiting = undefined;
  };
  const record = {
    requests: [] as OpenRequest[],
    options: [] as (CallOptions | undefined)[],
    /** When the stream was cancelled, as an entry of `events`. */
    cancelled: false,
    events: [] as string[],
  };
  const cancel = (how: string) => {
    if (record.cancelled) return;
    record.cancelled = true;
    record.events.push(`cancelled (${how})`);
    wake();
  };

  const openThread = (
    input: OpenRequest,
    options?: CallOptions,
  ): AsyncIterable<OpenThreadResponse> => {
    record.requests.push(input);
    record.options.push(options);
    const signal = options?.signal;
    if (signal?.aborted === true) cancel('signal');
    signal?.addEventListener('abort', () => cancel('signal'), { once: true });

    const iterator: AsyncIterator<OpenThreadResponse> = {
      next: async () => {
        for (;;) {
          if (record.cancelled) {
            if (signal?.aborted === true)
              throw signal.reason ?? new Error('cancelled');
            return { done: true, value: undefined };
          }
          const head = queue.shift();
          if (head?.kind === 'item') return { done: false, value: head.item };
          if (head?.kind === 'fail') throw head.error;
          if (head?.kind === 'end') return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
        }
      },
      return: async () => {
        cancel('return');
        return { done: true, value: undefined };
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  };

  return {
    workspace: { openThread },
    record,
    push: (item: OpenThreadResponse) => {
      queue.push({ kind: 'item', item });
      wake();
    },
    fail: (error: unknown) => {
      queue.push({ kind: 'fail', error });
      wake();
    },
    end: () => {
      queue.push({ kind: 'end' });
      wake();
    },
  };
};

describe('withThreadSession', () => {
  test('W1: on ready, the task gets the session; the stream is cancelled after the task resolves and before the outcome resolves, which is {status: ready, value}', async () => {
    const fake = fakeWorkspace();
    fake.push(ready());
    const seen: OpenedThreadSession[] = [];

    const outcome = withThreadSession(
      fake.workspace,
      request,
      async (opened) => {
        seen.push(opened);
        await settle();
        assert.equal(fake.record.cancelled, false, 'open while the task runs');
        fake.record.events.push('task resolved');
        return 42;
      },
    ).then((value) => {
      fake.record.events.push('outcome');
      return value;
    });

    assert.deepEqual(await within(outcome, 'the outcome'), {
      status: 'ready',
      value: 42,
    });
    assert.deepEqual(fake.record.requests, [request]);
    assert.equal(seen.length, 1);
    assert.deepEqual(
      {
        threadSessionId: seen[0]?.threadSessionId,
        projectId: seen[0]?.projectId,
        threadId: seen[0]?.threadId,
        cwd: seen[0]?.cwd,
        sandboxId: seen[0]?.sandboxId,
      },
      session,
    );
    assert.equal(fake.record.events.length, 3, fake.record.events.join(', '));
    assert.equal(fake.record.events[0], 'task resolved');
    assert.match(fake.record.events[1] ?? '', /^cancelled/);
    assert.equal(fake.record.events[2], 'outcome');
  });

  test('W2: the task rejects: the stream is still cancelled, before the call rejects, and the rejection is unchanged', async () => {
    const fake = fakeWorkspace();
    fake.push(ready());
    const failure = new Error('the task failed');

    const call = withThreadSession(fake.workspace, request, async () => {
      await settle();
      throw failure;
    });
    const rejected = await rejectionOf(call, 'the rejection');

    assert.equal(rejected, failure);
    assert.equal(fake.record.cancelled, true, 'cancelled before the rejection');
  });

  for (const status of ['missing', 'inactive', 'pending'] as const) {
    test(`W3: ${status} resolves {status: ${status}} and runs no task`, async () => {
      const fake = fakeWorkspace();
      fake.push(refused(status));
      let ran = false;

      const outcome = await within(
        withThreadSession(fake.workspace, request, async () => {
          ran = true;
        }),
        `the ${status} outcome`,
      );

      assert.deepEqual(outcome, { status });
      assert.equal(ran, false);
    });
  }

  test('W4: a stream that fails before its first item rejects with its code; a stream that ends with no item rejects invalid_output; no task runs', async () => {
    let ran = false;
    const task = async () => {
      ran = true;
    };

    const failing = fakeWorkspace();
    failing.fail(
      toConnectError(new ContractError('unavailable', 'runtime is starting')),
    );
    const failed = contractErrorOf(
      await rejectionOf(
        withThreadSession(failing.workspace, request, task),
        'the failed stream',
      ),
    );
    assert.equal(failed.code, 'unavailable');
    assert.equal(failed.message, 'runtime is starting');

    const empty = fakeWorkspace();
    empty.end();
    const ended = contractErrorOf(
      await rejectionOf(
        withThreadSession(empty.workspace, request, task),
        'the empty stream',
      ),
    );
    assert.equal(ended.code, 'invalid_output');
    assert.equal(ran, false);
  });

  test('W5: a stream that fails after ready does not interrupt the task, and its value is answered', async () => {
    const fake = fakeWorkspace();
    fake.push(ready());
    fake.fail(
      toConnectError(new ContractError('shutting_down', 'runtime is stopping')),
    );
    const release = deferred<string>();
    let started = false;

    const outcome = withThreadSession(fake.workspace, request, async () => {
      started = true;
      return release.promise;
    });
    await settle();
    assert.equal(started, true, 'the task started');
    await settle();
    release.resolve('done');

    assert.deepEqual(await within(outcome, 'the outcome'), {
      status: 'ready',
      value: 'done',
    });
  });

  test('W6: options.signal aborted before ready rejects and runs no task', async () => {
    const fake = fakeWorkspace();
    const controller = new AbortController();
    let ran = false;

    const call = withThreadSession(
      fake.workspace,
      request,
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    let settled = false;
    call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await settle();
    assert.equal(settled, false, 'waits for the first item');
    controller.abort();
    const rejected = await rejectionOf(call, 'the rejection');
    fake.push(ready());
    await settle();

    assert.ok(
      rejected === controller.signal.reason ||
        (rejected instanceof ConnectError && rejected.code === Code.Canceled) ||
        (rejected instanceof Error && rejected.name === 'AbortError'),
      `the cancellation: ${String(rejected)}`,
    );
    assert.equal(ran, false);
  });
});
