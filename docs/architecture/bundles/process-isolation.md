# Process isolation

- Status: living document. It describes which processes run bundle code as implemented on 2026-11-20.

## Summary

The host runs its bundles in two kinds of process. The **kernel** is the host process itself: it reads the composition, owns the HTTP and Socket.IO listeners, and activates the bundles that must outlive any code change. Every other host bundle runs in a **generation process**, one Node process per bundle generation, forked by the kernel. A new generation is a new process, so bundle code changes without restarting the host, and a crash ends one generation process, which the kernel starts again, not the host (the host exits only when the restarts fail and a provider the composition requires is lost, as [Losing a generation process](#losing-a-generation-process) states) ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)).

The desktop app follows the same rule for its `desktopMain` parts: the Electron main process plays the kernel, and each desktop generation runs in one Electron `utilityProcess` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)).

The kernel and a generation call each other's services through one RPC envelope over the process's IPC channel. A bundle does not see the boundary: its part receives the same `services` in either process, and a provider in the other process is reached through a stub ([`link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts), [`remote.ts`](../../../packages/bundle/src/runtime/envelope/remote.ts)).

## The host kernel

### What runs where

A bundle of the host catalog runs in the kernel when it is in the foundation, is the core, is embedded in the host, or is listed in the composition's `resident` array; every other scheduled bundle runs in the generation process ([`partition.ts`](../../../packages/bundle/src/process/partition.ts)). The foundation is the set of providers the composition chooses under `providers` for contracts the core provides or consumes ([Hooks](hooks.md#replacing-the-provider-of-hooksv1), [Core](core.md)).

| Process    | What it runs                                                                                                                        | In the shipped composition                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Kernel     | The platform (catalog, diagnostics, dispatcher, generation manager), the foundation, the core, embedded bundles, `resident` bundles | `postgres` (`storage.backend/v1`, `secrets.backend/v1`), `core`, `host-config`, `transport`, `screen-relay` |
| Generation | Every other scheduled bundle of the host catalog, with the tools and skills those bundles register                                  | `runtime`, `default`, `git`, `files`, `web`, `resources`, the model providers, the sandbox, and the rest    |

The shipped composition is [`composition.json`](../../../app/backend/doric-host/composition.json). The catalog is resolved once, by the kernel, and split into a kernel order and a generation order; the published order lists the kernel's bundles first ([`partition.ts`](../../../packages/bundle/src/process/partition.ts)).

The kernel activates its own bundles in its own process, in their order. The generation's bundles count as already active for the kernel's dependency check, so a kernel bundle may depend on a generation bundle: its calls resolve the provider in the active generation at call time ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). Installed kernel bundles register their tools after each activates and their skills once the whole kernel phase has activated ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)).

Because the core runs in the kernel, the basic contracts it provides (`hooks/v1`, `log/v1`, `settings/v1`, `secrets/v1`, `storage/v1`, `tools/v1`, `skills/v1`, `events/v1`, `models/v1`) are kernel providers, and a generation bundle reaches them across the envelope. A tool a generation bundle registers is kept by the core's `tools/v1` in the kernel as a handle to the generation ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)).

The core's `tools/v1` and `skills/v1` keep each registration with its generation (0 for a kernel registration) and answer a call with the kernel's registrations plus those of the call's generation, or of the active generation for a kernel call. A name must be unique within that view: a registration that collides is refused with `duplicate_tool` or `duplicate_skill`. A draining generation therefore keeps its tools and skills for the calls pinned to it until it stops ([`tools.ts`](../../../bundles/foundation/core/src/host/tools.ts), [`skills.ts`](../../../bundles/foundation/core/src/host/skills.ts), [`partition.ts`](../../../bundles/foundation/core/src/shared/partition.ts), [core README](../../../bundles/foundation/core/README.md)).

### The host process

From slice S62c3 of [grpc-processes.md](../../designs/grpc-processes.md) the host boots the platform, and the steps below describe the kernel path it replaces: every host part runs in its own process, the host creates no Express app, Socket.IO server or desktop bridge, the platform's gateway binds the public listener, and `required` is checked by the platform after the bundle processes start. The current order is in the host README's [Startup and failures](../../../app/backend/doric-host/README.md#startup-and-failures).

The host's entry point is the kernel's owner ([`index.ts`](../../../app/backend/doric-host/src/index.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). In order, it:

1. reads `DORIC_BUNDLES_PATH` and `DORIC_COMPOSITION`, or else the staged bundles and the shipped composition, and applies the composition's alternatives: without `DORIC_COMPOSITION`, each alternative takes the option its variable chooses (`DORIC_SANDBOX_PROVIDER` for `sandbox`), and an operator composition boots as written;
2. logs `Doric starting` with the chosen alternatives, and creates the Express app, the `http.Server` and the Socket.IO server;
3. starts the kernel (`startKernel` from `bundle`), which activates the kernel's bundles and starts generation 1, and fails at the stage `bundle_load` if the kernel is in recovery mode: the composition cannot be read or is invalid, the core is missing, disabled or quarantined, a contract the core requires has no active foundation provider at a satisfying version, or a chosen foundation provider is quarantined ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [Core](core.md));
4. checks the composition's `required` block: every contract it lists has a provider among the active bundles, and every bundle it lists is active; otherwise it logs `Bundle recovery mode` and exits;
5. logs `Bundles loaded` with the number of installed bundles, of skills (`skills/v1.list`) and of tools (`tools/v1.list`);
6. runs `onHostStartHook` through `platform.start()`;
7. watches `required` for the rest of its life: when a generation becomes active without a required provider, it logs `Bundle recovery mode` and exits, so its supervisor restarts it;
8. installs the generic desktop bridge, the Socket.IO namespace `/doric/bridge` ([`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts));
9. runs `onHostReadyHook`, then binds the port (`DORIC_HOST`, default `0.0.0.0`; `DORIC_PORT`, default `3000`) and logs `Doric listening`.

On `SIGINT` or `SIGTERM` it closes the HTTP server and the sockets, runs `onHostStopHook`, then stops the generations, the kernel's bundles and the platform. The host process names no bundle contract: it reads only the basic contracts `tools/v1` and `skills/v1`, to count them, and the routes and namespaces are registered by bundles. The start and stop hooks are described in [Hooks](hooks.md#host-start-and-stop).

### `doric.network/v1`

The native listeners live only in the kernel. The kernel provides `doric.network/v1`, a host-only platform contract whose one method, `register`, runs a listener at once with the host's Express app, its `http.Server` and its Socket.IO server ([`network.ts`](../../../packages/bundle/src/contracts/network.ts), [`process/network.ts`](../../../packages/bundle/src/process/network.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). Its shape is in [Contexts](contexts.md#shapes-of-the-platform-contracts); the cleanup and the refusal from a generation process are in [Services and channels](services-and-channels.md#native-handles-doricnetworkv1). A bundle never calls `listen`: the kernel owns the address, the bind and the close. The handles are local to the kernel process and never serialized, so a bundle that serves routes or sockets is listed under `resident`: `transport` ([README](../../../bundles/foundation/transport/README.md)) and `screen-relay` ([README](../../../bundles/features/screen-relay/README.md)).

## Generations

### Starting a generation

A generation is numbered: the boot starts generation 1, and each publish takes the next number. The kernel forks the compiled runner, `runner-main.js`, with V8 serialization over the IPC channel, `stdin` ignored and `stdout`/`stderr` inherited ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). The runner ignores `SIGINT` and `SIGTERM`, so only the kernel ends it, and exits as soon as its channel to the kernel disconnects, so a dead kernel leaves no orphan ([`runner-main.ts`](../../../packages/bundle/src/process/runner-main.ts)).

The kernel then sends one `init` control message, the `GenerationInit` ([`runner.ts`](../../../packages/bundle/src/runtime/runner.ts)):

| Field              | What it carries                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `environment`      | `host`, or `desktopMain` for a desktop generation                                                           |
| `generation`       | The generation number                                                                                       |
| `incarnation`      | The process's attempt number for that generation, from 1                                                    |
| `platformVersion`  | The platform version                                                                                        |
| `composition`      | The composition the catalog was resolved from                                                               |
| `entries`, `order` | The catalog entries of this process, already resolved by the kernel, and their activation order             |
| `contracts`        | The resolved contracts with their providers                                                                 |
| `preActive`        | The bundles active in the kernel, which satisfy this process's dependency check                             |
| `kernelProviders`  | A descriptor of every kernel provider the generation may call                                               |
| `hooksProvider`    | `remote` on the host: `hooks/v1` is the kernel's, so the platform defines its hooks before the first bundle |
| `catalog`          | The catalog snapshot `doric.catalog/v1.get` answers in this process                                         |

The runner registers a stub for each kernel provider, provides `doric.catalog/v1`, `doric.diagnostics/v1` and `doric.bundle/v1` itself, activates its bundles in order (installed bundles' tools after each activates, their skills once all have), and sends `ready` ([`runner.ts`](../../../packages/bundle/src/runtime/runner.ts), [`runner-main.ts`](../../../packages/bundle/src/process/runner-main.ts)). Each provider a generation bundle registers is announced to the kernel with a `provide` control message, and withdrawn with `unprovide`; the kernel announces its own later providers the same way. The generation pushes its diagnostics to the kernel, and its platform log lines as `platform-log` messages, which the kernel writes to its own log ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)).

A process that exits before `ready` is started again, up to three attempts (`startAttempts`), each a new incarnation ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)).

### The envelope

The kernel and a generation each hold one end of a `ProcessLink`: request correlation, cancellation, deadlines, handles exported to the other side, and the close of the channel ([`link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts)). The full shapes of the init, the wire messages, the link and the value encoding are in the bundle package README: [Generation processes and the envelope](../../../packages/bundle/README.md#generation-processes-and-the-envelope), [Wire messages](../../../packages/bundle/README.md#wire-messages), [`ProcessLink` and `Transport`](../../../packages/bundle/README.md#processlink-and-transport) and [Values, errors and calls](../../../packages/bundle/README.md#values-errors-and-calls). Every request carries the hop's call metadata ([`messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts)):

```ts
interface WireCall {
  caller: Caller; // filled by the sending dispatcher: bundleId, version, generation
  scope?: CallScope;
  trace: TraceContext; // { traceparent }
  deadline: number; // epoch milliseconds; 0 means none
  generation: number; // the operation generation the call chain is pinned to; 0 = unpinned
}
```

The messages are `call` (a service method: `contract`, `method`, encoded `input`, the resolved `provider` and `record`, and `oneway` for a fire-and-forget method such as `doric.log/v1.write`), `invoke` (a handle the other side exported: a callback, a tool's `execute` or `check`), `result`, `cancel` and `release`. The control plane, never routed to bundles, is `init`, `ready`, `provide`, `unprovide`, `diagnostics`, `catalog`, `platform-log`, `stop` and `stopped`; the kernel also sends `catalog` to every live generation each time the active generation changes, so `doric.catalog/v1.get` in each process answers the current catalog ([`messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). The type also declares `lifecycle` and `lifecycle-result`, which no process sends. How `call` propagates from hop to hop is in [Services and channels](services-and-channels.md); how a contract's schemas are declared is in [Contracts](contracts.md).

A value that is local to its process crosses as a handle when the member's schema allows it: a callback, a `Disposable`, an object, a tool, a hooks contract or a definition. A local value the member does not allow is refused with `local_only` ([`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). A handle that comes back to the process that exported it resolves to the original value: a tool a generation bundle registered in the kernel's `tools/v1` is, when a bundle of the same generation lists it, the local tool itself. A tool registered in another process is a `RemoteTool`, whose `check` and `execute` run in the tool's own process with its own schemas ([`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). A prompt's tools take this path: the `default` bundle's executor, in the generation process, lists `tools/v1` with the prompt's call and receives its own generation's tools as local tools, whose `check` and `execute` do not cross the envelope; only a kernel bundle's tool is a `RemoteTool` ([`executor.ts`](../../../bundles/runtime/default/src/host/executor.ts), [default README](../../../bundles/runtime/default/README.md)).

Where work runs follows from this. `GET /resources` is a route of `transport` ([transport README](../../../bundles/foundation/transport/README.md)), in the kernel, and calls `resources/v1.host()`, whose CPU sample runs in the `resources` bundle, in the generation process ([`routes/resources.ts`](../../../bundles/foundation/transport/src/host/routes/resources.ts), [`machine.ts`](../../../bundles/features/resources/src/host/machine.ts), [resources README](../../../bundles/features/resources/README.md)). The `web` tool's `fetch` runs in the `web` bundle, in the generation process ([`web.ts`](../../../bundles/features/web/src/host/tools/web.ts), [web README](../../../bundles/features/web/README.md)). Both run on the host machine.

### Which generation a call reaches

The kernel keeps one directory of its own providers and, per generation, a view that layers that generation's providers over the kernel's. The active view overlays the active generation's providers, so a kernel bundle that calls a contract a generation provides reaches the active generation ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). A call that leaves a generation carries its generation, and the platform answers it from that generation's view: its catalog, its diagnostics and its `doric.generation/v1` ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)).

While no generation is active, during a respawn, a kernel call to a contract the generation provides waits for the next activation instead of failing `unavailable`; its call signal aborts the wait ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)).

### Publishing a new generation

`publish` is kernel-internal. It reads the bundles and the composition again, resolves the next generation's catalog, and compares its kernel partition — the kernel bundles' ids, versions, phases, states and sources, the providers they publish, and the catalog's recovery reason — with the one the host booted ([`partition.ts`](../../../packages/bundle/src/process/partition.ts)). If the partition changed, publish answers `kernel_restart_required` and starts nothing. Otherwise it starts the new generation's process; if all attempts fail, it reports `generation_failed` and answers `failed`, and the active generation stays. On success it switches the active view to the new generation and puts the previous one in `draining`. Concurrent calls share one run, and a publish while the host stops answers `failed` ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)).

The callers of `publish` are `doric.catalog/v1.disable` and `doric.catalog/v1.resetComposition`, which write or clear the composition overrides and then publish; when the answer is not `published`, they log `Composition change applies at the next host start` and fail with `unavailable` ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts)). The recovery surface that calls them is in [Splash and recovery](splash-and-recovery.md).

A generation's state is one of `starting`, `active`, `draining`, `stopped` and `failed` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).

### Work holds and draining

A generation keeps running while it holds work. A **work hold** is a `{ key, label? }` taken through `doric.generation/v1.hold`; its owner is the calling bundle, taken from `call.caller.bundleId`, never from the input, and the key is opaque to the platform ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). A draining generation stops once it has no work hold and no call in flight on its link in either direction ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)). The manager's hold type also has a window variant, which does not count toward the drain; no host code takes one.

To stop a generation the kernel sends `stop`; the runner deactivates its bundles in reverse order, pushes its last diagnostics and answers `stopped`. A process still alive after `stopTimeoutMs` (10 seconds) is killed with `SIGKILL`. When the host itself stops, every live generation is stopped this way and no change is announced ([`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`runner.ts`](../../../packages/bundle/src/runtime/runner.ts)).

### `doric.generation/v1`

The kernel provides `doric.generation/v1`, a host-only platform contract that a bundle uses without declaring it ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)). A host with no generation manager does not provide it.

A bundle uses it to learn which generation it serves, to keep that generation alive while it drains, and to signal its own bundle in the other live generations. Its shape is in [Contexts](contexts.md#shapes-of-the-platform-contracts). Its three methods behave as follows:

- `describe` answers `{ generation, incarnation, state }` for the caller's generation: the generation the call is pinned to while it is not stopped, else the active one, or during a respawn the generation being started again. With no generation at all it fails `unavailable` ([`manager.ts`](../../../packages/bundle/src/process/manager.ts)).
- `hold` takes a work hold `{ key, label? }`, a key of 1 to 256 characters and a label of at most 256, on the generation `describe` resolves to and returns its `Disposable`; disposing of it ends the hold and may end a drain. It fails `unavailable` when there is no generation, or when the one it resolves to is stopped, as when the host is stopping.
- `signal` takes `{ topic, payload? }`, a topic of 1 to 128 characters, and delivers `onPeerSignalHook` to every other live generation, with the sender's bundle as `from.bundleId` and, as the sender generation, the caller's generation as `describe` resolves it; while the host stops, or with no generation, it sends nothing.

An input outside these bounds fails `invalid_input` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

### Generation hooks

The kernel announces each change of the generation set as `doric.app.hooks/v1` hooks ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). Each is executed once per live generation, with a call pinned to that generation, so a bundle's handler runs in its own process; a failed execution is reported as `hook_execute_failed` and never stops the transition.

- `onGenerationChangedHook`, input `{ event, generation, incarnation, self, live, holds? }`. `event` is `activated`, `draining`, `lost` or `stopped`; `self` is the receiving generation and incarnation; `live` lists every active or draining generation with its state. `holds`, set for `lost` only, lists the lost generation's work holds as `{ bundleId, key, label? }`, and each handler receives only its own bundle's holds. A lost or stopped generation does not hear its own change. On a switch the draining generation hears `draining` first, before the drain check, so a hold it takes in that handler keeps it alive; then every live generation hears `activated`. The boot announces no change.
- `onPeerSignalHook`, input `{ topic, payload, from, self, live }`, delivered only to the handlers of the bundle that sent it.
- `onGenerationReadyHook`, input `{ generation }`, fired after a publish or a respawn has activated a generation.

The full table of the platform's hooks is in [Hooks](hooks.md#doricapphooksv1).

### Losing a generation process

A generation process that exits after `ready`, without the kernel asking it to stop, is lost ([`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts)):

1. Its pending calls reject with `generation_lost`, and every later call through its link does too. Each stream registration it served ends once with `generation_lost`, unless it was disposed or had ended; a stream registration the other process refuses ends with that refusal instead ([`link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts)). The desktop bridge ends each desktop stream it relays with the same error code ([`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)).
2. The kernel reports `generation_lost` to diagnostics with the generation, the incarnation and the exit code or signal, and announces `lost`, with the generation's work holds, to every other live generation.
3. A lost draining generation is stopped. A lost active generation leaves no generation active, and the kernel starts the same generation again, as the next incarnation, with up to three attempts.
4. If every attempt fails while no other generation is active, the generation becomes `failed` with an empty view: its bundles show as quarantined with `generation_failed`, and the kernel keeps serving with only its own providers. The host then exits through its `required` watch whenever a required provider was among them, as with the shipped composition ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)).

A tool call whose process died fails with `generation_lost` in its cause; when the run's signal is also aborted, the `default` bundle's executor records no `tool.failed` for it, saves the history with the call unanswered and pauses the run instead ([`executor.ts`](../../../bundles/runtime/default/src/host/executor.ts), [default README](../../../bundles/runtime/default/README.md)). Client parts treat `generation_lost` like a dropped connection and subscribe again, as the runtime's Project watch does ([`project-watch.ts`](../../../bundles/runtime/runtime/src/client/api/project-watch.ts)).

### How the runtime hands over

The `runtime` bundle runs in every generation process and builds its handover on these hooks: it records its `{ generation, incarnation }` as the owner of each Project it holds; a generation that becomes active recovers in the background and leaves the draining generations' Projects in standby; a draining generation takes the work hold `runtime.drain`, lets each Project's prompts finish, and signals `runtime.released` with the Project id; the active runtime adopts each released Project, and every Project of a lost or stopped generation, pausing an interrupted prompt with `host_restarted` before it resumes ([`rpc/handover.ts`](../../../bundles/runtime/runtime/src/host/rpc/handover.ts), [`threads.ts`](../../../bundles/runtime/runtime/src/host/store/threads.ts)). The detail is in the [runtime README](../../../bundles/runtime/runtime/README.md#recovery-host-stop-and-handover).

## Desktop generations

The Electron main process runs each desktop generation's `desktopMain` parts in one `utilityProcess`, forked with the service name `Doric desktopMain g<N>` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The process runs the same generation runner as the host, over Electron's `parentPort`, with every scheduled `desktopMain` part of the generation, loaded from the verified artifact cache ([`runner-entry.ts`](../../../app/desktop/doric/src/platform/generation/runner-entry.ts), [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)). It differs from a host generation in four ways ([`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)):

- Main provides the platform contracts `doric.windows/v1`, `doric.menus/v1`, `doric.cache/v1`, `doric.migrations/v1`, `doric.tokens/v1`, `doric.notifications/v1` and `doric.log/v1`; everything else, `hooks/v1` included, is provided in the generation process (`hooksProvider: 'local'`), and main runs its app lifecycle hooks through that process's `hooks/v1`. With no provider there, a `decide` hook allows and the others do nothing.
- A process lost after `ready` is respawned once.
- An older generation stops once no window is pinned to it; its stop kills the process after 10 seconds ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).
- It has no `doric.generation/v1` and no work holds.

How the desktop resolves and downloads a generation is in [Composition and distribution](composition-and-distribution.md); its windows are in [Windows](windows.md).

## Related documents

- [Boundaries](boundaries.md): what a bundle may import and depend on, in either process.
- [Contracts](contracts.md): the schemas the envelope validates.
- [Manifest](manifest.md): `provides`, `requires` and `optional`.
- [Services and channels](services-and-channels.md): the service directory, stubs and the propagation of `call`.
- [Hooks](hooks.md): the platform's hooks and the provider of `hooks/v1` in the kernel.
- [Core](core.md): the core and quarantine.
- [Composition and distribution](composition-and-distribution.md): the composition, `resident`, `required` and alternatives.
- [Splash and recovery](splash-and-recovery.md): the surface that disables a bundle and publishes.
- [Observability](observability.md): diagnostics and the trace context the envelope carries.
