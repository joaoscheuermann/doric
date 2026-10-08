# sandpool

`sandpool` is a process-local, warmed pool of `SandboxSession` capacity.
It owns acquisition, bounded creation retries, replacement, and disposal while
remaining independent of Docker and Firecracker.

## Use

```ts
import { createDockerClient } from 'docker';
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

Identified acquisitions are provisioned in arrival order: each names a session
of its own, and the pool creates those sessions in the order their callers
arrived. An unnamed acquisition is served in arrival order too, except that a
warmed idle session is only ever offered to an unnamed waiter, so a later
unnamed caller can take a warmed session ahead of an identified caller that
queued before it. Releasing a lease destroys that sandbox and the pool creates a
replacement when needed; a released session is never reused. `release` and
`dispose` are idempotent.

`acquire({ identity })` names the caller a session serves. The pool provisions a
session of its own for an identified acquisition, because the session has to be
created for that identity, and never leases a warmed one. An acquisition without
an identity keeps the warmed path: it takes an idle session when one is available
and otherwise waits for a newly created one. Provisioning is in arrival order
for every caller: an identified waiter and an unnamed one that both need a fresh
session are served in the order they arrived, within `maxSandboxes`.

Warmed sessions only ever serve callers without an identity, so `minIdle` holds
capacity that identified callers cannot lease and would wait for: keep
`minIdle: 0` when every acquisition carries an identity. A session whose
identified caller cancelled or gave up on the acquisition while it was being
created is disposed rather than warmed, so one caller's session is never leased
to another.

The pool retries failed factory calls with bounded backoff. After
`maxCreateAttempts` consecutive failures, pending acquisition and heat waiters
reject; later demand begins a fresh attempt batch. Pass an `AbortSignal` to
`acquire` or `waitUntilHeated` to cancel a wait. `status()` exposes lifecycle
and capacity counts for health reporting.

The injected Pino logger is required. Operational logs contain lifecycle and
capacity metadata; the pool does not own provider configuration or persistent
session state.

## Development

```console
npx nx build sandpool
npx nx test sandpool
```

Run the lifecycle integration target with:

```console
npx nx run sandpool:e2e
```
