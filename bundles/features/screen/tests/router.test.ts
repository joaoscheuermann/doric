// `screen`'s host part through the router (phase 3, slice S49b; spec
// "Sandbox leases"): `screen.sessions/v2` served by `createTestRouter` as
// `src/host/main.ts` serves it, on fakes of `runtime.lease/v1` (`Describe`,
// `Exec` over a scripted sandbox) and `screen.relay/v1` (`Expose`,
// `Forget`). The manager is the real one with an open port probe and no
// sleep, unless a test uses a fake manager.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create, toJson } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createContextValues,
  type HandlerContext,
} from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { RelayService } from 'screen-relay/contracts/gen/doric/screen/relay/v1/relay_pb.js';

import {
  AttachRequestSchema,
  type AttachResponse,
  AttachResponseSchema,
} from '../src/contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import { createScreenSessionsService } from '../src/host/rpc/sessions.js';
import { fakeManager, harness, P, P2, T } from './support/router.js';

/** The `UNAVAILABLE` failure `runtime.lease/v1` answers for a non-ready lease. */
const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError(
    'unavailable',
    `Project lease is not ready (${leaseStatus}).`,
    { leaseStatus },
  );

/** Asserts a call failed with the gRPC code and the Doric code given. */
const failsWith =
  (grpc: Code, code: string, message?: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ConnectError, String(error));
    assert.equal(error.code, grpc, `${Code[error.code]}: ${error.rawMessage}`);
    assert.equal(fromConnectError(error).code, code, error.rawMessage);

    if (message !== undefined) {
      assert.equal(error.rawMessage, message);
    }

    return true;
  };

const jsonOf = (answer: AttachResponse) => toJson(AttachResponseSchema, answer);

/** Lets every queued in-memory call reach its handler. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const isHostname = (cmd: readonly string[]) => cmd[0] === 'hostname';

void test('B1: a ready lease runs the steps pinned to the described sandbox and exposes the session before answering ready', async (t) => {
  const h = await harness(t);

  const answer = await h.client().attach({ projectId: P });

  h.events.push('answer');

  const exposes = h.relay.calls.filter((call) => call.method === 'expose');

  assert.equal(exposes.length, 1);

  const token = exposes[0]?.token ?? '';

  assert.ok(token.length > 0);
  assert.deepEqual(jsonOf(answer), {
    ready: { path: `/screen/${token}/`, display: ':100' },
  });
  assert.equal(h.lease.describes.length, 1);
  assert.deepEqual(h.lease.describeTargets, [undefined]);
  assert.ok(
    h.lease.execs.some((exec) => isHostname(exec.cmd)),
    'hostname -I ran through Exec',
  );
  assert.ok(
    h.lease.execs.some(
      (exec) => exec.cmd[0] === 'xpra' && exec.cmd[1] === 'start',
    ),
    'xpra start ran through Exec',
  );
  assert.deepEqual(
    [...new Set(h.lease.execs.map((exec) => exec.expectSandboxId))],
    ['sb-1'],
  );
  assert.deepEqual(
    h.relay.calls.map(({ method, host, port }) => ({ method, host, port })),
    [{ method: 'expose', host: '172.17.0.2', port: 14500 }],
  );
  assert.deepEqual(h.events, [`expose ${token}`, 'answer']);
});

void test('B2: a pending lease at Describe answers pending without Exec or Expose', async (t) => {
  const h = await harness(t);

  h.lease.onDescribe = () => {
    throw leaseFailure('pending');
  };

  const answer = await h.client().attach({ projectId: P });

  assert.deepEqual(jsonOf(answer), { pending: {} });
  assert.equal(h.lease.execs.length, 0);
  assert.deepEqual(h.relay.calls, []);
});

void test('B3: an unavailable, expired or missing lease at Describe answers unavailable/sandbox without Expose', async (t) => {
  for (const status of ['unavailable', 'expired', 'missing']) {
    await t.test(status, async (st) => {
      const h = await harness(st);

      h.lease.onDescribe = () => {
        throw leaseFailure(status);
      };

      const answer = await h.client().attach({ projectId: P });

      assert.deepEqual(jsonOf(answer), {
        unavailable: { reason: 'sandbox' },
      });
      assert.deepEqual(h.relay.calls, []);
    });
  }
});

void test('B4: a sandbox replaced mid-ensure (third Exec unavailable) answers unavailable/sandbox, runs no further Exec and exposes nothing', async (t) => {
  const h = await harness(t);

  h.lease.onExec = (index) => {
    if (index === 3) {
      throw leaseFailure('unavailable');
    }
  };

  const answer = await h.client().attach({ projectId: P });

  assert.deepEqual(jsonOf(answer), { unavailable: { reason: 'sandbox' } });
  assert.equal(h.lease.execs.length, 3);
  assert.deepEqual(h.relay.calls, []);
});

void test('B5: a lease failure without leaseStatus fails Attach with its own code', async (t) => {
  await t.test('INVALID_ARGUMENT keeps its code and message', async (st) => {
    const h = await harness(st);
    const message = 'The call has no Project or Thread scope.';

    h.lease.onDescribe = () => {
      throw new ContractError('invalid_scope', message);
    };

    await assert.rejects(
      h.client().attach({ projectId: P }),
      failsWith(Code.InvalidArgument, 'invalid_scope', message),
    );
    assert.deepEqual(h.relay.calls, []);
  });

  await t.test('a plain Error of the fake fails INTERNAL', async (st) => {
    const h = await harness(st);

    h.lease.onDescribe = () => {
      throw new Error('the lease broke');
    };

    await assert.rejects(
      h.client().attach({ projectId: P }),
      failsWith(Code.Internal, 'internal'),
    );
  });
});

void test('B6: a sandbox without xpra answers unavailable/missing-xpra and logs it at warn', async (t) => {
  const h = await harness(t, { sandbox: { xpra: false } });

  const answer = await h.client().attach({ projectId: P });

  assert.deepEqual(jsonOf(answer), {
    unavailable: { reason: 'missing-xpra' },
  });
  assert.deepEqual(h.relay.calls, []);

  const warned = h.router.logs.filter(
    (record) =>
      record.level === 'warn' &&
      record.message === 'The screen session is unavailable',
  );

  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0]?.fields, {
    projectId: P,
    reason: 'missing-xpra',
  });
});

void test('B7: the lease and relay calls inherit the scope of the Attach call', async (t) => {
  const h = await harness(t);
  const scope = { projectId: P, threadId: T };

  const answer = await h.client(scope).attach({ projectId: P });

  assert.equal(answer.status.case, 'ready');
  assert.deepEqual(h.lease.describes, [scope]);
  assert.ok(h.lease.execs.length > 0);

  for (const exec of h.lease.execs) {
    assert.deepEqual(exec.scope, scope, exec.cmd.join(' '));
  }

  assert.equal(h.relay.calls.length, 1);
  assert.deepEqual(h.relay.calls[0]?.scope, scope);
});

void test('B8: concurrent Attach of one Project share one run and one answer; another Project runs its own', async (t) => {
  const manager = fakeManager(['token-a', 'token-b'], true);
  const h = await harness(t, { manager: manager.manager });
  const client = h.client();

  const first = client.attach({ projectId: P });
  const second = client.attach({ projectId: P });

  await manager.calledTimes(1);
  await settle();

  const other = client.attach({ projectId: P2 });

  await manager.calledTimes(2);
  await settle();
  manager.release();

  const [one, two, three] = await Promise.all([first, second, other]);

  assert.deepEqual(jsonOf(one), {
    ready: { path: '/screen/token-a/', display: ':100' },
  });
  assert.deepEqual(jsonOf(two), jsonOf(one));
  assert.deepEqual(jsonOf(three), {
    ready: { path: '/screen/token-b/', display: ':101' },
  });
  assert.equal(h.lease.describes.length, 2);
  assert.equal(manager.ensured.length, 2);
  assert.deepEqual(h.relayLog(), ['expose token-a', 'expose token-b']);
});

void test('B9: a new token of the Project forgets the old one before exposing; the same token is exposed again without Forget', async (t) => {
  await t.test('new token', async (st) => {
    const manager = fakeManager(['token-a', 'token-b']);
    const h = await harness(st, { manager: manager.manager });

    await h.client().attach({ projectId: P });
    const answer = await h.client().attach({ projectId: P });

    assert.deepEqual(jsonOf(answer), {
      ready: { path: '/screen/token-b/', display: ':101' },
    });
    assert.deepEqual(h.relayLog(), [
      'expose token-a',
      'forget token-a',
      'expose token-b',
    ]);
  });

  await t.test('same token', async (st) => {
    const manager = fakeManager(['token-a']);
    const h = await harness(st, { manager: manager.manager });

    await h.client().attach({ projectId: P });
    await h.client().attach({ projectId: P });

    assert.deepEqual(h.relayLog(), ['expose token-a', 'expose token-a']);
  });
});

void test('B10: an Expose failure fails Attach with its code, tracks nothing, and a later Attach exposes again', async (t) => {
  const h = await harness(t);
  let failing = true;

  h.relay.onExpose = () => {
    if (failing) {
      failing = false;
      throw new ContractError('unavailable', 'screen-relay is not served.');
    }
  };

  await assert.rejects(
    h.client().attach({ projectId: P }),
    failsWith(Code.Unavailable, 'unavailable'),
  );
  assert.equal(h.live().length, 0);

  const answer = await h.client().attach({ projectId: P });

  assert.equal(answer.status.case, 'ready');
  assert.deepEqual(
    h.relay.calls.map((call) => call.method),
    ['expose', 'expose'],
  );
  assert.equal(h.live().length, 1);
});

void test('B11: an exposed token is a tracked registration whose replay sends the same Expose; a replaced token is no longer replayed', async (t) => {
  const manager = fakeManager(['token-a', 'token-b']);
  const h = await harness(t, { manager: manager.manager });

  await h.client().attach({ projectId: P });

  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0]?.ref, RelayService);

  // A new `screen-relay` instance: the SDK calls `register` again.
  await h.live()[0]?.register(h.relayClient());

  assert.deepEqual(
    h.relay.calls.map(({ method, token, host, port }) => ({
      method,
      token,
      host,
      port,
    })),
    [
      { method: 'expose', token: 'token-a', host: '172.17.0.9', port: 14500 },
      { method: 'expose', token: 'token-a', host: '172.17.0.9', port: 14500 },
    ],
  );
  assert.equal(
    h.relay.calls[1]?.scope,
    undefined,
    'a replay runs outside any call',
  );

  await h.client().attach({ projectId: P });

  const live = h.live();

  assert.equal(live.length, 1);
  assert.equal(h.tracked[0]?.untracked, true, 'token-a was untracked');

  const before = h.relay.calls.length;

  await live[0]?.register(h.relayClient());

  assert.deepEqual(
    h.relay.calls.slice(before).map(({ method, token, host, port }) => ({
      method,
      token,
      host,
      port,
    })),
    [{ method: 'expose', token: 'token-b', host: '172.17.0.9', port: 14500 }],
  );
});

void test('B12: stop forgets and untracks every exposed token; one failed Forget neither stops the others nor fails deactivate', async (t) => {
  const manager = fakeManager(['token-a', 'token-b']);
  const h = await harness(t, { manager: manager.manager });

  await h.client().attach({ projectId: P });
  await h.client().attach({ projectId: P2 });

  h.relay.onForget = (token) => {
    if (token === 'token-a') {
      throw new ContractError('unavailable', 'screen-relay is gone.');
    }
  };

  await h.router.control.stop();

  const forgotten = h.relay.calls
    .filter((call) => call.method === 'forget')
    .map((call) => call.token)
    .sort();

  assert.deepEqual(forgotten, ['token-a', 'token-b']);
  assert.equal(h.tracked.length, 2);
  assert.equal(h.live().length, 0);
  assert.ok(
    !h.router.logs.some((record) => record.message === 'deactivate failed'),
    JSON.stringify(h.router.logs),
  );
});

void test('B13: hostname -I runs once per described sandbox id', async (t) => {
  const h = await harness(t);
  const hostnames = () =>
    h.lease.execs.filter((exec) => isHostname(exec.cmd)).length;

  await h.client().attach({ projectId: P });
  await h.client().attach({ projectId: P });

  assert.equal(hostnames(), 1);

  h.lease.sandboxId = 'sb-2';

  const before = h.lease.execs.length;
  const answer = await h.client().attach({ projectId: P });

  assert.equal(answer.status.case, 'ready');
  assert.equal(hostnames(), 2);
  assert.deepEqual(
    [
      ...new Set(
        h.lease.execs.slice(before).map((exec) => exec.expectSandboxId),
      ),
    ],
    ['sb-2'],
  );
  assert.equal(h.lease.describes.length, 3);
});

void test('B14: the answers are the 2.1.0 JSON of the status oneof', async (t) => {
  await t.test('ready', async (st) => {
    const h = await harness(st);
    const answer = await h.client().attach({ projectId: P });
    const token = h.relay.calls[0]?.token ?? '';

    assert.deepEqual(jsonOf(answer), {
      ready: { path: `/screen/${token}/`, display: ':100' },
    });
  });

  await t.test('pending', async (st) => {
    const h = await harness(st);

    h.lease.onDescribe = () => {
      throw leaseFailure('pending');
    };

    assert.deepEqual(jsonOf(await h.client().attach({ projectId: P })), {
      pending: {},
    });
  });

  await t.test('unavailable', async (st) => {
    const h = await harness(st);

    h.lease.onDescribe = () => {
      throw leaseFailure('missing');
    };

    assert.deepEqual(jsonOf(await h.client().attach({ projectId: P })), {
      unavailable: { reason: 'sandbox' },
    });
  });
});

void test('B15: with requires given, the part calls only its two declared services', async (t) => {
  const h = await harness(t);

  const answer = await h.client().attach({ projectId: P });

  assert.equal(answer.status.case, 'ready');

  const token = h.relay.calls[0]?.token ?? '';

  await h.router.control.stop();

  assert.deepEqual(h.relayLog(), [`expose ${token}`, `forget ${token}`]);
  assert.ok(
    !h.router.logs.some((record) =>
      JSON.stringify(record).includes('undeclared_requirement'),
    ),
    JSON.stringify(h.router.logs),
  );
});

void test('B16: before activate, the implementation fails unavailable', async () => {
  const handle = createScreenSessionsService();
  const context = {
    signal: new AbortController().signal,
    values: createContextValues(),
    requestHeader: new Headers(),
    responseHeader: new Headers(),
    responseTrailer: new Headers(),
  } as unknown as HandlerContext;

  await assert.rejects(
    (async () =>
      handle.implementation.attach(
        create(AttachRequestSchema, { projectId: P }),
        context,
      ))(),
    (error: unknown) => {
      const failure =
        error instanceof ConnectError ? fromConnectError(error) : error;

      assert.ok(failure instanceof ContractError, String(error));
      assert.equal(failure.code, 'unavailable');
      assert.equal(failure.message, 'The screen sessions are not ready.');

      return true;
    },
  );
});
