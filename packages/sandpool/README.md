# sandpool

`sandpool` keeps sandboxes ready so callers do not wait on provisioning more
than they have to. It is a process-local, warmed pool of `SandboxSession`
capacity that owns acquisition, bounded creation retries, replacement and
disposal. It works with any [`sandbox`](../sandbox/README.md) provider and
stays independent of Docker and Firecracker; Doric's `docker` and
`firecracker` sandbox bundles use it to serve sandbox leases.

Part of [Doric](../../README.md).

## Highlights

- **Warm capacity.** `minIdle` sessions are created ahead of demand for
  callers that do not need a particular workspace.
- **Per-identity sessions.** `acquire({ identity })` provisions a session for
  that caller, such as one Project's durable workspace.
- **Bounded capacity and retries.** At most `maxSandboxes` sessions exist;
  failed creations retry with backoff up to `maxCreateAttempts`.
- **Fair ordering.** Provisioning follows arrival order.
- **Cancellable waits and health reporting.** `AbortSignal` support and a
  `status()` snapshot of lifecycle and capacity counts.

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

await pool.waitUntilHeated();
const lease = await pool.acquire({ identity: projectId });

try {
  await lease.sandbox.exec({ cmd: ['node', '--version'] });
} finally {
  await lease.release();
}

// Dispose the whole pool during application shutdown.
await pool.dispose();
```

## API

`createSandpool(options)` creates the pool and begins warming it in the
background.

| Option              | Notes                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `minIdle`           | Warmed sessions to keep for unnamed callers; must not exceed the maximum. |
| `maxSandboxes`      | The most sessions that may exist at once.                                 |
| `maxCreateAttempts` | Consecutive failed factory calls before pending waits fail; default 3.    |
| `create(identity?)` | The factory that creates one session.                                     |
| `logger`            | A required Pino logger.                                                   |

| Method                            | Behavior                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `acquire({ identity?, signal? })` | Resolves a `SandboxLease` (`sandbox`, `release`).                                                                      |
| `waitUntilHeated({ signal? })`    | Resolves once `minIdle` sessions are idle.                                                                             |
| `heated()`                        | Whether the pool currently holds `minIdle` idle sessions.                                                              |
| `status()`                        | Lifecycle and `idle`, `leased`, `creating`, `disposing`, `queued` and `total` counts, plus `heated` and `lastFailure`. |
| `dispose()`                       | Disposes every session; idempotent.                                                                                    |

## Behavior

### Leases

Releasing a lease destroys that sandbox, and the pool creates a replacement
when needed; a released session is never reused. `release` and `dispose` are
idempotent.

### Identified and unnamed acquisitions

`acquire({ identity })` names the caller a session serves. The pool provisions
a session of its own for an identified acquisition, because the session has to
be created for that identity, and never leases a warmed one. An acquisition
without an identity keeps the warmed path: it takes an idle session when one
is available and otherwise waits for a newly created one.

### Ordering

Provisioning is in arrival order for every caller: an identified waiter and an
unnamed one that both need a fresh session are served in the order they
arrived, within `maxSandboxes`. The one exception is that a warmed idle
session is only ever offered to an unnamed waiter, so a later unnamed caller
can take a warmed session ahead of an identified caller that queued before it.

### Warm capacity and identities

Warmed sessions only ever serve callers without an identity, so `minIdle`
holds capacity that identified callers cannot lease and would wait for: keep
`minIdle: 0` when every acquisition carries an identity. A session whose
identified caller cancelled or gave up on the acquisition while it was being
created is disposed rather than warmed, so one caller's session is never
leased to another.

### Failures and cancellation

The pool retries failed factory calls with bounded exponential backoff. After
`maxCreateAttempts` consecutive failures, pending acquisition and heat waiters
reject; later demand begins a fresh attempt batch. A failed session disposal
is retried with the same backoff. Pass an `AbortSignal` to `acquire` or
`waitUntilHeated` to cancel a wait.

### Logging and ownership

The injected Pino logger is required. Operational logs contain lifecycle and
capacity metadata; the pool does not own provider configuration or persistent
session state.

## Development

```console
npx nx build sandpool
npx nx typecheck sandpool
npx nx test sandpool
```

Run the lifecycle integration target with:

```console
npx nx run sandpool:e2e
```
