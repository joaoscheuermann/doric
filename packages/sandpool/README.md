# sandpool

`sandpool` is a process-local pool of sandbox sessions. It bounds how many
sessions exist at once, provisions them through a factory the caller supplies,
leases them out, retries failed creations and disposals, and disposes every
session it made. It works with any [`sandbox`](../sandbox/README.md) provider
and knows nothing about Docker or Firecracker; the factory decides what a
session is ([src/lib/sandpool.ts](src/lib/sandpool.ts)).

Part of [Doric](../../README.md). The feature it serves is described in
[Sandboxes](../../docs/features/sandboxes.md); its logging follows
[Observability](../../docs/architecture/bundles/observability.md).

## Who uses it

- The sandbox bundles [`docker`](../../bundles/sandboxes/docker/README.md) and
  [`firecracker`](../../bundles/sandboxes/firecracker/README.md) build one pool
  each at activation, with `minIdle: 0`, `maxSandboxes: 10` and
  `maxCreateAttempts: 3`, pass the Project id as the identity of every
  acquisition, and dispose the pool on deactivation
  ([bundles/sandboxes/docker/src/host/sandbox.ts](../../bundles/sandboxes/docker/src/host/sandbox.ts),
  [bundles/sandboxes/firecracker/src/host/sandbox.ts](../../bundles/sandboxes/firecracker/src/host/sandbox.ts)).
- The [`runtime`](../../bundles/runtime/runtime/README.md) bundle uses the
  `SandboxLease` type in its sandbox contract, its ports and its domain
  ([bundles/runtime/runtime/src/contracts/sandbox.ts](../../bundles/runtime/runtime/src/contracts/sandbox.ts),
  [bundles/runtime/runtime/src/host/routed.ts](../../bundles/runtime/runtime/src/host/routed.ts),
  [bundles/runtime/runtime/src/host/domain/runtime.ts](../../bundles/runtime/runtime/src/host/domain/runtime.ts)).
- The tests of [`docker-sandbox`](../docker-sandbox/README.md) and
  [`firecracker-sandbox`](../firecracker-sandbox/README.md) build pools over
  real sessions, with `sandpool` as a devDependency
  ([packages/docker-sandbox/tests/sandbox.e2e.ts](../docker-sandbox/tests/sandbox.e2e.ts),
  [packages/firecracker-sandbox/tests/sandbox.e2e.ts](../firecracker-sandbox/tests/sandbox.e2e.ts)).
- The host application lists it as a dependency
  ([app/backend/doric-host/package.json](../../app/backend/doric-host/package.json)).

## Entry point

The package is ESM. Its [package.json](package.json) `exports` has two
entries: `./package.json`, and the code entry point `sandpool` (`.`):
`./dist/index.js` with the types in `./dist/index.d.ts`, and `./src/index.ts`
under the workspace's `@org/source` condition. [src/index.ts](src/index.ts)
re-exports everything from [src/lib/sandpool.ts](src/lib/sandpool.ts) and
[src/lib/types/sandpool.ts](src/lib/types/sandpool.ts). It depends on `pino`
(for the `Logger` type), `sandbox` (for `Sandbox` and `SandboxSession`) and
`tslib`.

## Usage

```ts
import { createDockerClient } from 'docker-sandbox';
import pino from 'pino';
import { createSandbox } from 'sandbox';
import { createSandpool } from 'sandpool';

const provider = createDockerClient();
const pool = createSandpool({
  minIdle: 0,
  maxSandboxes: 4,
  maxCreateAttempts: 3,
  logger: pino(),
  create: (identity) =>
    createSandbox({
      provider,
      image: 'node:22-bookworm',
      resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
      network: { mode: 'disabled' },
      workspace: identity,
    }),
});

const lease = await pool.acquire({ identity: projectId });

try {
  await lease.sandbox.exec({ cmd: ['node', '--version'] });
} finally {
  await lease.release();
}

// During application shutdown:
await pool.dispose();
```

## Public API

All types are in [src/lib/types/sandpool.ts](src/lib/types/sandpool.ts); the
one function is in [src/lib/sandpool.ts](src/lib/sandpool.ts).

### `createSandpool(options: SandpoolOptions): Sandpool`

Validates the options synchronously, creates the pool and starts warming it in
the background without waiting. It throws on invalid options (see
[Errors](#errors)).

```ts
interface SandpoolOptions {
  readonly minIdle: number;
  readonly maxSandboxes: number;
  readonly maxCreateAttempts?: number;
  readonly create: (identity?: string) => Promise<SandboxSession>;
  readonly logger: Logger; // pino
}
```

| Option              | Rule                                   | Meaning                                                                                                                                         |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `minIdle`           | Integer ≥ 0, at most `maxSandboxes`    | Idle sessions without an identity the pool keeps ready.                                                                                         |
| `maxSandboxes`      | Integer > 0                            | The most sessions that exist at once, counting those being created, idle, leased and being disposed.                                            |
| `maxCreateAttempts` | Integer > 0; default `3`               | Consecutive failed factory calls after which pending waits fail; also caps how many creations run at once ([Creation](#creation-and-capacity)). |
| `create(identity?)` | A function                             | Creates one session. It is called with the acquisition's identity, or with no argument for a session that serves any caller.                    |
| `logger`            | A pino logger with `debug` and `child` | Receives the pool's log lines ([Logging](#logging)).                                                                                            |

### `Sandpool`

```ts
interface Sandpool {
  heated(): boolean;
  waitUntilHeated(options?: SandpoolWaitOptions): Promise<void>;
  acquire(options?: SandpoolAcquireOptions): Promise<SandboxLease>;
  status(): SandpoolStatus;
  dispose(): Promise<void>;
}

interface SandpoolWaitOptions {
  readonly signal?: AbortSignal;
}

type SandpoolAcquireOptions = SandpoolWaitOptions & {
  readonly identity?: string;
};
```

| Method                            | Behavior                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heated()`                        | `true` while the pool is `active` and holds at least `minIdle` idle sessions. With `minIdle: 0` it is always `true` while active.                                    |
| `waitUntilHeated({ signal? })`    | Resolves at once when heated; otherwise waits until it is. Rejects on abort, on exhausted creation attempts and on `dispose()`.                                      |
| `acquire({ identity?, signal? })` | Queues an acquisition and resolves a `SandboxLease` ([Acquisition](#acquisition-and-ordering)). Rejects on abort, on exhausted creation attempts and on `dispose()`. |
| `status()`                        | Returns a `SandpoolStatus` snapshot; works in every lifecycle.                                                                                                       |
| `dispose()`                       | Disposes the pool and every session ([Pool disposal](#pool-disposal)). Idempotent: every call returns the same promise, which never rejects.                         |

### `SandboxLease` and `PooledSandbox`

```ts
type PooledSandbox = Sandbox; // from 'sandbox'

interface SandboxLease {
  readonly sandbox: PooledSandbox;
  readonly release: () => Promise<void>;
}
```

`sandbox` is a guard over the leased session: it copies the session's `id` and
`root` and forwards `start`, `exec`, `cloneRepo`, `readFile`, `writeFile`,
`putFile`, `getFile`, `diff`, `ssh` and `stats` to it. It has no `dispose`; a
lease ends through `release`. Once the lease is released or the pool is
disposed, every method rejects with `Sandbox lease is no longer active`,
except `stats`, which throws it synchronously. `start` is always present and
rejects with `Sandbox provider does not support live processes` when the
session has none; `stats` resolves `undefined` when the session has none
([src/lib/sandpool.ts](src/lib/sandpool.ts)).

`release()` disposes the session (see [Leases](#leases-and-disposal)). It is
idempotent and returns the same promise on every call.

### `SandpoolStatus` and `SandpoolLifecycle`

```ts
type SandpoolLifecycle = 'active' | 'disposing' | 'disposed';

interface SandpoolStatus {
  readonly lifecycle: SandpoolLifecycle;
  readonly idle: number; // idle sessions
  readonly leased: number; // leased sessions
  readonly creating: number; // factory calls in flight
  readonly disposing: number; // sessions being disposed
  readonly queued: number; // pending acquisitions
  readonly total: number; // sessions that exist plus factory calls in flight
  readonly heated: boolean; // same as heated()
  readonly lastFailure: unknown;
}
```

`lastFailure` is the error of the most recent failed factory call or session
disposal; it is `undefined` until one fails and is never cleared
([src/lib/sandpool.ts](src/lib/sandpool.ts)).

## Behavior

All behavior below is in [src/lib/sandpool.ts](src/lib/sandpool.ts). The pool
keeps its state in memory only and persists nothing.

### Acquisition and ordering

- An acquisition **with an identity** is always provisioned a session of its
  own: the pool calls `create(identity)` for it and hands the result to that
  acquisition only. It never takes an idle session.
- An acquisition **without an identity** takes an idle session when one
  exists; otherwise the pool calls `create()` and the new session joins the idle
  list, from which the first waiting acquisition without an identity takes it.
- Acquisitions wait in one queue in arrival order. The one exception is that
  an idle session is offered only to acquisitions without an identity, so a
  later one of those can take an idle session ahead of an identified
  acquisition that queued before it.
- Because idle sessions serve only acquisitions without an identity, `minIdle`
  holds capacity that identified acquisitions cannot use, so when every
  acquisition carries an identity, idle sessions kept for `minIdle` are never
  leased.
- If an identified acquisition is cancelled or rejected while its session is
  being created, the session is disposed when it arrives, never leased to
  another caller. A session created for an acquisition without an identity
  stays idle when its acquisition goes away.
- The pool never trims idle sessions above `minIdle`; they stay idle until
  leased or until the pool is disposed.

### Creation and capacity

- The pool re-evaluates its state in one pass on each of these events:
  `createSandpool`, an `acquire` call, a `waitUntilHeated` call on a pool that
  is not heated, the abort of a queued acquisition, the end of a factory call
  (success or failure), the start and the end of a session's disposal, and the
  firing of the creation retry timer. A pass first hands idle sessions, oldest
  first, to queued acquisitions without an identity in arrival order, then
  starts creations.
- A pass lists the creations it needs, in queue order: one for each queued
  identified acquisition with no creation in flight, and one for each queued
  acquisition without an identity while no idle session is left. It then adds
  `minIdle − idle sessions` to refill. Creations already in flight for
  acquisitions without an identity and for refilling are not subtracted, so a
  pass can start creations for a need an earlier pass already covers. The extra
  sessions join the idle list, so the pool can hold more than `minIdle` idle
  sessions: with `minIdle: 1` and `maxSandboxes: 3`, `createSandpool` followed
  by `waitUntilHeated()` creates two.
- A creation starts only while all of these hold: the pool is `active`, no
  creation retry is pending, the creation attempts are not exhausted, and there
  is capacity.
- Capacity is `maxSandboxes − (sessions that exist + creations in flight)`. A
  session counts until its disposal completes, so a slot frees only when a
  disposal finishes, not when `release` or `dispose` is called.
- A pass starts the first `min(capacity, creations needed, maxCreateAttempts −
consecutive failures − creations in flight)` creations of that list, so
  creations in flight never exceed `maxCreateAttempts − consecutive failures`;
  with the default of 3, no more than three factory calls run together,
  whatever `maxSandboxes` is.
- A successful factory call resets the consecutive failure count and the
  backoff.

### Failures and retries

- A failed factory call counts one consecutive failure and records the error
  in `lastFailure`. Below `maxCreateAttempts` failures, the pool schedules one
  retry timer: the first delay is 250 ms, each later one doubles, up to 5 s.
  No creation starts while the timer is pending.
- At `maxCreateAttempts` consecutive failures the attempts are exhausted: the
  timer is cleared, the backoff resets, and every pending acquisition and every
  heat waiter rejects with
  `Error('Sandpool could not create a sandbox after <maxCreateAttempts> attempts')`.
  No creation starts, warming included, until the next `acquire` call, or
  `waitUntilHeated` call on a pool that is not heated, that is not rejected for
  an inactive pool or an aborted signal; it resets the count and the backoff
  and starts a fresh batch.
- An identified acquisition whose creation failed gets a new creation on a
  later pass while it is still queued.

### Leases and disposal

- Releasing a lease disposes its session; a released session is never reused,
  and the pool creates a replacement when demand or `minIdle` needs one.
- A session's disposal calls `session.dispose()`. When it fails, the error goes
  to `lastFailure` and the pool retries after 250 ms, doubling up to 5 s,
  without limit. `release()` resolves only when the disposal succeeds and never
  rejects.

### Cancellation

- An already-aborted `signal` makes `acquire` or `waitUntilHeated` reject at
  once; an abort while waiting removes the wait and rejects it. The error has
  `name: 'AbortError'` and the message `The operation was aborted`.

### Pool disposal

- `dispose()` moves the lifecycle to `disposing`, clears a pending retry timer,
  rejects every pending acquisition and heat waiter with
  `Error('Sandpool is disposing')`, and starts the disposal of every session,
  leased ones included; their leases become inactive.
- A factory call still in flight is waited for, and its session is disposed
  when it arrives. If it fails, the error goes to `lastFailure` and no retry is
  scheduled.
- The lifecycle becomes `disposed`, and the promise resolves, once no factory
  call is in flight and every disposal has completed. A disposal that keeps
  failing keeps it waiting.
- After `dispose()`, `acquire` and `waitUntilHeated` reject with
  `Error('Sandpool is not active')`; `heated()` is `false`.

### Side effects

The pool starts no processes and opens no connections itself: every effect on
the outside goes through `create` and `session.dispose()`. It uses
`setTimeout` for the creation retry and the disposal retry, and writes log
lines to the injected logger.

## Logging

`createSandpool` makes a child logger with `{ component: 'sandpool' }` and
writes every line at level `debug`. Each line carries `lifecycle`, `idle`,
`leased`, `creating`, `disposing`, `queued`, `total`, `heated`, `minIdle`,
`maxSandboxes`, `createFailures` and `maxCreateAttempts`; no line carries an
error or its cause ([src/lib/sandpool.ts](src/lib/sandpool.ts)).

| Message                                                                                                                                  | Extra fields                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sandpool started`, `sandpool heated`, `sandpool disposal started`, `sandpool disposed`                                                  | —                                                                                                                               |
| `waiting for sandpool to heat`, `sandpool heat wait cancelled`                                                                           | —                                                                                                                               |
| `sandbox acquisition queued`, `sandbox acquisition cancelled`                                                                            | —                                                                                                                               |
| `sandbox creation started`, `sandbox creation attempts resumed`                                                                          | —                                                                                                                               |
| `sandbox created`, `sandbox leased`, `sandbox lease released`, `sandbox disposal started`, `sandbox disposed`, `sandbox disposal failed` | `sandboxId`                                                                                                                     |
| `sandbox creation retry scheduled`                                                                                                       | `retryDelayMs`                                                                                                                  |
| `sandbox disposal retry scheduled`                                                                                                       | `sandboxId`, `retryDelayMs`                                                                                                     |
| `sandbox creation failed`                                                                                                                | `reason: 'sandbox_factory_rejected'`, `hint: 'Check sandbox provider availability, image access, and resource support.'`        |
| `sandbox creation attempts exhausted`, `sandbox acquisition failed`, `sandpool heat failed`                                              | `reason: 'sandbox_creation_attempts_exhausted'`, `hint: 'Retry the acquisition after restoring sandbox provider availability.'` |

`sandpool heated` is written when the pool becomes heated, not on every pass
while it stays heated. `sandbox acquisition failed` and `sandpool heat failed`
are written once for each waiter that exhausted attempts reject;
`sandbox acquisition cancelled` and `sandpool heat wait cancelled` are written
on an abort and once for each waiter that `dispose()` rejects.

## Errors

All errors come from [src/lib/sandpool.ts](src/lib/sandpool.ts).

| Where                                    | Error                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSandpool` (thrown synchronously)  | `RangeError`: `minIdle must be a non-negative integer`, `maxSandboxes must be a positive integer`, `minIdle must not exceed maxSandboxes`, `maxCreateAttempts must be a positive integer`. `TypeError`: `create must be a function`, `logger.debug must be a function`, `logger.child must be a function`, `logger.child must return a logger with a debug method`. |
| `acquire`, `waitUntilHeated` (rejection) | `Sandpool is not active`; `AbortError` (`The operation was aborted`); `Sandpool is disposing`; `Sandpool could not create a sandbox after <n> attempts`.                                                                                                                                                                                                            |
| A lease's `sandbox`                      | `Sandbox lease is no longer active`; `start` only: `Sandbox provider does not support live processes`; otherwise whatever the session's method throws.                                                                                                                                                                                                              |
| `release`, `dispose`                     | Never reject.                                                                                                                                                                                                                                                                                                                                                       |

## Development

The Nx project is `sandpool` ([project.json](project.json)). `build` and
`typecheck` are inferred by the workspace's TypeScript plugin; `build`
compiles [tsconfig.lib.json](tsconfig.lib.json) into `dist/`.

```console
npx nx build sandpool
npx nx typecheck sandpool
npx nx test sandpool
npx nx run sandpool:e2e
```

- `test` compiles [tsconfig.spec.json](tsconfig.spec.json) into `dist-tests/`
  and runs the unit tests ([tests/sandpool.test.ts](tests/sandpool.test.ts),
  [tests/logging.test.ts](tests/logging.test.ts)) with `node --test`. They use
  in-memory sessions; no provider is needed.
- `e2e` builds the package and its dependencies, compiles
  [tsconfig.e2e.json](tsconfig.e2e.json) into `dist-e2e/` and runs
  [tests/sandpool.e2e.ts](tests/sandpool.e2e.ts), which warms, leases,
  replaces, releases and disposes in-memory sessions through the built
  package.
