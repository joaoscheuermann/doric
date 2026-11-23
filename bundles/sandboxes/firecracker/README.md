# Firecracker bundle

`firecracker` gives each Doric Project its own sandbox in a Firecracker
microVM. It provides `sandbox/v1` over a pool of microVMs built by the
[`firecracker-sandbox`](../../../packages/firecracker-sandbox/README.md)
provider, for deployments that want the agent's environment isolated by a
lightweight virtual machine. It keeps no durable workspace: every sandbox
starts from its image. The [`docker`](../docker/README.md) bundle provides the
same contract over Docker containers; a composition enables one of the two.

It has one part, the host part, and runs in the generation process next to
[`runtime`](../../runtime/runtime/README.md), which is the only bundle that
acquires sandboxes. See the [main README](../../../README.md) for Doric as a
whole, [`packages/bundle`](../../../packages/bundle/README.md) for how bundles
work, and the feature doc
[Projects and Threads](../../../docs/features/projects-and-threads.md) for how
a Project holds its sandbox lease. The feature doc
[Sandboxes](../../../docs/features/sandboxes.md) describes both sandbox
providers and how one is chosen.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                |
| `id`              | `firecracker` (equal to the `name` of [`package.json`](package.json))              |
| `version`         | `1.0.0`                                                                            |
| `engines`         | `{ "doric": "^1.0.0" }`                                                            |
| `description`     | Firecracker sandbox provider for the Doric agent: one microVM sandbox per Project. |
| `provides`        | `sandbox/v1@1.0.0`                                                                 |
| `requires`        | `hooks/v1@^1.0.0`, `log/v1@^1.0.0`                                                 |
| `optional`        | none                                                                               |
| Slots             | none                                                                               |
| Parts             | host only: [`src/host/index.ts`](src/host/index.ts) exports `activate`             |

The host part also runs as a process ([`src/host/main.ts`](src/host/main.ts), built into
`dist/host/main.mjs`) with `runBundle`,
serving `SandboxService` by lease id through the router
([`src/host/service.ts`](src/host/service.ts)). A lease belongs to the
calling instance: an unknown, released or other instance's lease fails with
`unknown_lease` (`NOT_FOUND`), and an operation the sandbox does not offer,
such as `Start` on a sandbox without live processes, with
`unsupported_operation` (`UNIMPLEMENTED`). When an instance is gone
(`context.instances.onGone`) its leases are released; `deactivate` releases
every lease and disposes the pool. The running host keeps the kernel entry
`src/host/index.ts` until the switch (phase 3, slice S44 of
[`grpc-processes.md`](../../../docs/designs/grpc-processes.md)).

The bundle declares no contract of its own and has no `src/contracts/`:
`sandbox/v1` is declared by `runtime` in
[`runtime/contracts`](../../runtime/runtime/src/contracts/sandbox.ts) and
implemented here with that module's `SandboxV1` and `sandboxMethods`
([`sandbox.ts`](src/host/sandbox.ts)). Its `package.json` exports only
`./package.json`, so no other bundle imports code from it, and depends on
`bundle`, `firecracker-sandbox`, `pino` (`^10.3.1`), `runtime`, `sandbox`,
`sandpool` and `tslib` ([`package.json`](package.json)).

## Composition

The shipped composition lists `docker` among its bundles and declares the
alternative `sandbox`, with `env: DORIC_SANDBOX_PROVIDER`, `default: docker`
and `options: [docker, firecracker]`
([`composition.json`](../../../app/backend/doric-host/composition.json)).
When `DORIC_SANDBOX_PROVIDER` is `firecracker` and `DORIC_COMPOSITION` is not
set, the host boots the shipped composition with `firecracker` enabled in
place of `docker`; any other value enables `docker`. With
`DORIC_COMPOSITION`, the operator's composition decides which provider is
enabled ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts),
[`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts),
[composition and distribution](../../../docs/architecture/bundles/composition-and-distribution.md)).
The composition requires `sandbox/v1`, so a host with neither provider enabled
does not start. `firecracker` is not `resident`, so it runs in the generation
process.

The Compose service `firecracker` of the host (profile `firecracker`) runs
the host with `DORIC_SANDBOX_PROVIDER=firecracker`, `DORIC_SANDBOX_SSH`
defaulting to `true`, privileged, with `/dev/kvm` and `/dev/net/tun`, the
cgroup filesystem, and volumes for `/var/lib/doric/firecracker` and
`/var/cache/doric/firecracker`
([`compose.yaml`](../../../app/backend/doric-host/compose.yaml)).

## `sandbox/v1`

The Project sandboxes, version `1.0.0`, a host service of cardinality `one`
([`sandbox.ts`](../../runtime/runtime/src/contracts/sandbox.ts)). The build
records it in `dist/contracts.json` with its JSON schema at
`dist/schemas/sandbox/v1.json`, and marks it local because `acquire` returns
a live object.

```ts
interface SandboxProviderApi {
  describe(): Promise<SandboxDescription>;
  acquire(input: {
    identity: string;
    signal?: AbortSignal;
  }): Promise<SandboxLease>; // local: process-local object
  discard(identity: string): Promise<void>;
  machines(): Promise<readonly RunningMachine[]>;
  machine(id: string): Promise<RunningMachine | undefined>;
}

interface SandboxDescription {
  provider: string;
  durableWorkspace: boolean;
}

interface RunningMachine {
  id: string;
  provider: string;
}

interface SandboxLease {
  sandbox: Sandbox; // see packages/sandbox
  release(): Promise<void>;
}
```

Every method also takes an optional trailing call argument. The input and
output schemas are those of `sandboxMethods`: `describe` and `machines` take
no argument; `acquire` takes a strict object, so an unknown field is refused
before the method runs; `discard` and `machine` take one string; the
description and a running machine are loose objects, so they may carry more
fields. `describe`, `discard`, `machines` and `machine` are plain data and
reach the provider across processes; `acquire` takes and returns process-local
objects (the abort signal and the lease). The contract defines no events and
no error codes: a failure rejects the call with the error described under
[Errors and failure](#errors-and-failure).

Two bundles call it. `runtime` acquires and discards each Project's sandbox
([runtime README](../../runtime/runtime/README.md)), and `transport`, which
requires `sandbox/v1`, serves `machines()` at `GET /vms` and `machine(id)` at
`GET /vms/:id/ssh`
([`vms.ts`](../../foundation/transport/src/host/routes/vms.ts),
[`app.ts`](../../foundation/transport/src/host/app.ts)).

What this bundle answers ([`sandbox.ts`](src/host/sandbox.ts)):

| Method              | Answer                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `describe()`        | `{ provider: 'firecracker', durableWorkspace: false }`.                                                                                   |
| `acquire(input)`    | `pool.acquire({ identity, signal })`, with `signal` passed only when given: a lease on a new microVM provisioned for that identity.       |
| `discard(identity)` | Resolves `undefined` and does nothing: there is no durable workspace to remove, and it does not touch a running sandbox of that identity. |
| `machines()`        | Every microVM this bundle provisioned and has not finished disposing, as `{ id, provider: 'firecracker' }`.                               |
| `machine(id)`       | That entry, or `undefined` when no such microVM is running.                                                                               |

The lease's `sandbox` is a [`Sandbox`](../../../packages/sandbox/README.md)
(`id`, `root`, `exec`, `start`, `stats`, `cloneRepo`, `readFile`,
`writeFile`, `putFile`, `getFile`, `diff`, `ssh`) whose root is `/workspace`.
After the lease is released, each of its methods throws
`Sandbox lease is no longer active` (`stats` synchronously, the others as a
rejection). `release()` disposes the microVM and is idempotent; it resolves
only when the disposal succeeds and never rejects. A released microVM is never
leased again
([`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts)).

## Contracts it uses

| Contract             | Declared as | Used for                                                                                                                                                               |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log/v1`             | `requires`  | The pool's log records, through a Pino logger that writes to `log/v1` ([`logger.ts`](src/host/logger.ts)).                                                             |
| `hooks/v1`           | `requires`  | Registering the start step on `onHostStartHook` of `doric.app.hooks/v1` ([`start.ts`](src/host/start.ts)).                                                             |
| `doric.app.hooks/v1` | platform    | `onHostStartHook`, a `sequence` hook run once at host start in activation order; a failing step stops the host ([hooks](../../../docs/architecture/bundles/hooks.md)). |
| `doric.startup/v1`   | platform    | `stage('sandbox_pool')` and the two start log lines ([`start.ts`](src/host/start.ts)).                                                                                 |

Platform contracts need no declaration in the manifest.

## Host part

### Activation

`activate` is `activateFirecrackerSandbox()` with no options
([`index.ts`](src/host/index.ts)). `activateFirecrackerSandbox(options)`
([`sandbox.ts`](src/host/sandbox.ts)) takes:

| Option        | Default                   | Meaning                                                       |
| ------------- | ------------------------- | ------------------------------------------------------------- |
| `environment` | `process.env`             | Where `DORIC_SANDBOX_IMAGE` and `DORIC_SANDBOX_SSH` are read. |
| `client`      | `createFirecrackerClient` | Builds the `SandboxProvider` the microVMs come from.          |

On activation, in this order, it:

1. reads the settings from the environment (see
   [Configuration](#configuration));
2. builds the provider with `client()`, by default `createFirecrackerClient()`
   with all its defaults;
3. wraps the provider in a VM registry named `firecracker`
   (`createVmRegistry`), which records each microVM when it is provisioned
   and forgets it once its disposal completes; `machines` and `machine` read
   that registry ([`vms.ts`](../../../packages/sandbox/src/lib/vms.ts));
4. creates the pool (`createSandpool`) with the limits below, the `log/v1`
   logger, and a factory that, for an identity, calls `createSandbox` with:
   - `provider`: the registry's provider;
   - `image`: the configured image, with `imagePullPolicy: 'if-not-present'`;
   - `resources`: `{ cpuCount: 1, memoryMiB: 512, diskMiB: 4096 }`;
   - `workspace`: the identity (the Project id); the Firecracker provider
     keeps nothing under that name;
   - `network`: `{ mode: 'egress', ssh: <DORIC_SANDBOX_SSH>, dnsServers: ['1.1.1.1'] }`;
   - no `name`, no `timeoutMs`, and the default root `/workspace`;
5. provides `sandbox/v1` as described above;
6. registers the start step.

Nothing contacts the host's Firecracker setup at activation: the pool warms
no sandbox (`minIdle` is `0`), and the provider checks the host only when it
provisions the first microVM.

Activation returns the cleanup that deactivation runs: it removes the start
step, then disposes the pool, which disposes every microVM, leased ones
included, and rejects pending acquisitions with `Sandpool is disposing`.
Deactivation completes only when every microVM is disposed.

### The pool

The pool comes from [`sandpool`](../../../packages/sandpool/README.md) with
`minIdle: 0`, `maxSandboxes: 10` and `maxCreateAttempts: 3`
([`sandbox.ts`](src/host/sandbox.ts),
[`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts)):

- Every acquisition names an identity, and the pool provisions a new microVM
  for each one; it never leases a warmed one. Two acquisitions of the same
  identity get two microVMs.
- At most 10 microVMs exist at once, counting those being created and those
  being disposed; an acquisition beyond that waits, in arrival order, until a
  disposal completes. At most 3 microVMs are created at the same time, fewer
  by each failure since the last success.
- A failed creation is retried with exponential backoff, from 250 ms doubling
  up to 5000 ms. After 3 consecutive failures the waiting acquisitions reject;
  the next acquisition starts a new batch of attempts.
- A failed disposal is retried with the same backoff and no limit:
  `release()` resolves, and the microVM leaves `machines()` and frees its
  slot, only when its disposal succeeds; `release()` never rejects.
- An aborted `signal` rejects the waiting acquisition with an `AbortError`; a
  microVM created for an acquisition that was given up is disposed, never
  leased to another identity.

### The microVMs

`createFirecrackerClient()` uses its defaults
([`firecracker.ts`](../../../packages/firecracker-sandbox/src/lib/firecracker.ts),
[firecracker-sandbox README](../../../packages/firecracker-sandbox/README.md)):
the binaries `/usr/local/bin/firecracker` and `/usr/local/bin/jailer`, the
guest assets under `/opt/doric/firecracker/`, state under
`/var/lib/doric/firecracker`, the image cache under
`/var/cache/doric/firecracker` (20 GiB), the network pool `10.231.0.0/16`, a
readiness timeout of 30000 ms, and jailer uid and gid `0`. Each provisioning
first runs the host preflight (KVM, TUN, cgroup v2, IPv4 forwarding,
nftables, the pinned assets and command-line tools) and, once per provider,
the reconciliation of stale resources left by an earlier process; then it
starts one jailed microVM with its own writable disk over the cached image,
its own TAP network and SSH management channel.

With `if-not-present`, an image already in the cache is used as it is;
otherwise it is pulled and converted. The `egress` network gives the microVM
outbound access through NAT and allows DNS to `1.1.1.1`. `ssh` sets whether
the sandbox's `ssh()` answers access details; without it, `ssh()` answers
`undefined` ([`ssh.ts`](../../../packages/firecracker-sandbox/src/lib/ssh.ts)).

### Start step

On `onHostStartHook`, the start step ([`start.ts`](src/host/start.ts)) enters
the startup stage `sandbox_pool` and writes two `info` lines through
`doric.startup/v1`, from the settings of the same environment:

| Message                    | Fields                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configuring sandbox pool` | `sandboxProviderName: 'firecracker'`                                                                                                                                                                                      |
| `Sandbox pool configured`  | `sandboxProviderName: 'firecracker'`, `sandboxImage`, `sandboxResources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 }`, `minIdle: 0`, `maxSandboxes: 10`, `maxCreateAttempts: 3`, `networkMode: 'egress'`, `sshEnabled` |

The step only reports: the pool exists from activation, and the step
provisions nothing.

### Logging

The pool logs through a Pino logger at level `debug` whose records go to
`log/v1` ([`logger.ts`](src/host/logger.ts)). Each record is parsed from
Pino's JSON line; its `level` maps to a `log/v1` method (50 and above
`error`, 40 `warn`, 30 `info`, below 30 `debug`, `info` when it is not a number), its `msg`
becomes the message (empty when not a string), `time`, `pid` and `hostname`
are dropped, and every other field is passed on, among them
`component: 'sandpool'` from the pool's child logger. A record that cannot be
parsed or written is dropped and never fails the pool.

## Data and side effects

- The bundle stores nothing: no table, key or file of its own. The VM
  registry and the pool live in memory and are lost with the process.
- Each provisioning starts Firecracker and jailer processes, writes the
  microVM's disk, keys and state under `/var/lib/doric/firecracker`, fills the
  image cache under `/var/cache/doric/firecracker`, creates a TAP device and
  nftables rules, and may pull an image over the network. Disposal removes
  what the microVM owned
  ([firecracker-sandbox README](../../../packages/firecracker-sandbox/README.md)).
- Files written in a microVM are lost when it is disposed: a Project that
  acquires again gets a new microVM from its image.
- The bundle emits no event.

## Configuration

Read at activation from the environment the generation process inherits
([`sandbox.ts`](src/host/sandbox.ts)):

| Variable                 | Default            | Meaning                                                                                                                 |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DORIC_SANDBOX_IMAGE`    | `node:22-bookworm` | The OCI image each microVM runs. Any set value is used as it is; an image that cannot be pulled fails the provisioning. |
| `DORIC_SANDBOX_SSH`      | off                | Exactly `true` enables SSH access to the sandbox; any other value leaves it off.                                        |
| `DORIC_SANDBOX_PROVIDER` | `docker`           | Read by the host, not by this bundle: `firecracker` enables this bundle in the shipped composition.                     |

Resources, pool limits and the network mode are fixed in code: no variable
changes them.

## Errors and failure

- A provisioning failure (a failed preflight, an image that cannot be pulled,
  a microVM that is not ready within 30000 ms) counts as a failed creation;
  after 3 in a row the acquisition rejects with
  `Sandpool could not create a sandbox after 3 attempts`
  ([`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts)). The
  runtime then fails the Project with `sandbox_acquisition_failed`
  ([Projects and Threads](../../../docs/features/projects-and-threads.md)).
- An acquisition whose signal aborts rejects with an `AbortError`
  (`The operation was aborted`).
- An acquisition after deactivation rejects with `Sandpool is not active`;
  one waiting during deactivation rejects with `Sandpool is disposing`.
- A call on the sandbox of a released lease throws
  `Sandbox lease is no longer active`.
- A disposal that keeps failing is retried without end: its microVM stays in
  `machines()` and holds a slot, its `release()` stays pending, and so does
  deactivation.
- An input that fails the contract's schema (an `acquire` with an unknown
  field, a `discard` without a string) is refused before this bundle's code
  runs, with a `ContractError` of code `invalid_input`
  ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts),
  [`packages/bundle`](../../../packages/bundle/README.md),
  [contracts](../../../docs/architecture/bundles/contracts.md)).
- The start step itself does not fail on a host without Firecracker support:
  such a host starts, and the failure appears at the first acquisition.

## Build and test

[`project.json`](project.json) declares the Nx project `bundle-firecracker`,
tagged `type:bundle`:

| Target      | What it runs                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | `tsc --build` to `dist/`, then the bundle build of [`packages/bundle`](../../../packages/bundle/README.md), which writes `dist/manifest.json`, `dist/contracts.json` and `dist/schemas/sandbox/v1.json`. |
| `typecheck` | `tsc --build --emitDeclarationOnly`.                                                                                                                                                                     |
| `test`      | Compiles `src/` and `tests/` to `dist-tests/` and runs `node --test` on every compiled `tests/*.test.ts` ([`tests/sandbox.test.ts`](tests/sandbox.test.ts)).                                             |

Each depends on the build of the packages it uses (`^build`).

```console
npx nx run bundle-firecracker:build
npx nx run bundle-firecracker:typecheck
npx nx run bundle-firecracker:test
```

The tests activate the host part with `createTestServices` from
`bundle/testing`, a recording `log/v1` and a fake provider, and check the
answer of `describe`, the provisioning input, the environment settings,
`machines` before and after a release, that `discard` leaves a running
microVM alone, that deactivation disposes every leased microVM, and that the
pool's records reach `log/v1` with `component: 'sandpool'`.

The host's `build-bundles` target builds and stages every bundle the host
uses:

```console
npx nx run doric-host:build-bundles
```
