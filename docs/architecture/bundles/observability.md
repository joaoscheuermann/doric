# Observability and diagnosis

- Status: living document. It describes logging, tracing and diagnostics as implemented on 2026-11-20.

## Summary

A failure has to point at the bundle, the version, the generation and the call that caused it. The platform gives four mechanisms for that:

- the **bundle log**, the contract `log/v1`, whose records go to the platform contract `doric.log/v1`, which writes them to the host kernel's log or to the desktop main process's console, as [Where records go](#where-records-go) says — records written by a bundle part on the host or in a desktop generation process carry the identity of the calling bundle from `call.caller` (a field of the same name replaces it in main's line) ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)), and a window's records carry only level (`info`, `warn` or `error`), message, fields and `windowKey`, unless a field of that name replaces it, and its `debug` records are not written ([`platform.ts`](../../../packages/desktop/src/client/platform.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts));
- the **platform log**, the platform's own log, which does not depend on any bundle;
- the **startup record** of the host, the platform contract `doric.startup/v1`, which names the stage a startup failure is reported at and carries the flat log lines of the start;
- **diagnostics**, the platform contract `doric.diagnostics/v1`, which holds the catalog's bundle states, quarantine reasons, recent errors and contract consumers of a generation, and works without the core.

Every call also carries a W3C trace context, and a log record names the trace id of its call. The platform has no metrics, no log rotation and no exporter: the only timing it measures is the duration of each bundle's activation, kept in diagnostics.

## Where records go

| Process                    | Platform log                                                                                                                                 | `doric.log/v1` (records of `log/v1`)                                                                                                | Output                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host kernel                | A pino child with `component: 'platform'`                                                                                                    | A pino child with `component: 'bundles'`; the record's origin fields at the top level and its `fields` under `fields`               | One pino logger with two destinations: the console through `pino-pretty` at `info` and above, and the file named by `DORIC_LOG_FILE` (default `doric.log`, relative to the working directory) at `debug` and above |
| Host generation process    | Sent to the kernel as a `platform-log` message and written by the kernel's platform log                                                      | Answered by the kernel                                                                                                              | The kernel's                                                                                                                                                                                                       |
| Desktop main process       | One JSON line per record, `{ level, time, msg, ...fields }`, on the console: `info` to standard output, `warn` and `error` to standard error | Written to the platform log with the record's origin fields and its `fields` at the top level; `debug` is written as `info`         | The console only: the main process keeps no log file                                                                                                                                                               |
| Desktop generation process | Sent to main as a `platform-log` message and written with the generation's number                                                            | Answered by main                                                                                                                    | Main's                                                                                                                                                                                                             |
| Window (`client`)          | None                                                                                                                                         | Sent fire-and-forget to main through `doric.shell/v1.log`; main writes `message`, `fields` and the window key at the record's level | Main's                                                                                                                                                                                                             |

Sources: [`index.ts`](../../../app/backend/doric-host/src/index.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`runner.ts`](../../../packages/bundle/src/runtime/runner.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`log.ts`](../../../app/desktop/doric/src/platform/log.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts), [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts), [`platform.ts`](../../../packages/desktop/src/client/platform.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts).

In a window, main reads a `doric.shell/v1.log` input as `level` (`info`, `warn` or `error`, default `info`), `message` and `fields`, writes `fields` with the window's key, `windowKey`, which a field named `windowKey` replaces, and drops every other key of the record: a line a window writes reaches main's log without its `bundleId`, `version`, `generation`, `environment`, `scope` or `traceId`. A `debug` record fails that check and is not written; the window does not hear of it, because the call is fire-and-forget ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`bridge.ts`](../../../packages/desktop/src/client/bridge.ts)).

For a desktop generation process, main writes a `doric.log/v1` record's `fields` at the same level as its `bundleId`, `version`, `generation`, `environment`, `scope` and `traceId`, after them, so a field with one of those names replaces that origin field in main's line ([`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)). The host kernel writes `fields` under `fields`, so a field there cannot replace the identity ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)).

The desktop main process's console survives the end of its reader: both standard streams keep an `error` listener that ignores the error, so a write pending when the pipe closes, as when the development runner exits, fails with `EPIPE` without crashing the main process ([`log.ts`](../../../app/desktop/doric/src/platform/log.ts)).

## The bundle log: `log/v1`

`log/v1` is a basic contract of cardinality `one` in every environment, declared by the platform and provided by the `core` bundle by default ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). Its levels are `debug`, `info`, `warn` and `error`, each `(message: string, fields?: Record<string, unknown>, call?) → void`; a level never throws and is never awaited ([`log.ts`](../../../packages/bundle/src/contracts/basic/log.ts)). Across a process boundary the four levels are one-way: the caller does not wait for an answer ([`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). The full contract and the provider's behavior are in the [core README](../../../bundles/foundation/core/README.md#logv1).

A bundle that logs lists `log/v1` under `requires`, takes the log with `services.use(LogV1)`, and passes the `call` of the method, command, tool or hook handler it runs in, so that the line carries that call's scope and trace:

```ts
import { AppHooksV1, type HostContext, HooksV1, LogV1 } from 'bundle/contracts';

export const activate = ({ services }: HostContext) => {
  const log = services.use(LogV1);

  services
    .use(HooksV1)
    .use(AppHooksV1)
    .onHostReadyHook(async (_input, call) => {
      log.info('host ready', { pending: 0 }, call);
    });
};
```

A line written without a `call`, such as one in `activate` itself, is a hop of the calling bundle too: the dispatcher creates its call with the bundle as `caller`, a new trace and no scope, so the record names the bundle and a trace id of its own and has no `scope` ([`call.ts`](../../../packages/bundle/src/runtime/call.ts)).

The core's provider builds one `LogRecord` per line and writes it with `doric.log/v1.write` ([`core/src/shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts)):

- `bundleId`, `version` and `generation` come from `call.caller`, which the platform's dispatcher fills; `call.caller` is always the bundle that made that hop and is never inherited from a parent call ([`call.ts`](../../../packages/bundle/src/runtime/call.ts));
- `environment` is the environment of the process the provider runs in, as `doric.bundle/v1.describe` answers it ([`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts));
- `scope` is `call.scope` when the call has one. The platform does not interpret its keys: a bundle that writes a field of its own domain writes it under its own key;
- `traceId` is the trace id of `call.trace.traceparent`;
- in the host and main process parts, each secret of `secrets/v1.view().redactions()` becomes `[REDACTED]` in the message and in each string leaf of the fields; when that view cannot be read the record is written as it is. The window part does not redact;
- when the write throws, the provider reports `log_write_failed` to `doric.diagnostics/v1` for the calling bundle, and drops the line when that report throws too.

The shape of `doric.log/v1` and of `LogRecord` is in [Contexts](contexts.md#shapes-of-the-platform-contracts). Each process answers `doric.log/v1` with its own sink, as the table above says.

### Libraries that take a pino logger

`sandpool` and the provider implementations of `llms` take an injected pino `Logger` and log nothing else: there is no per-request privacy switch, and the composition root controls what they log through the logger it passes.

- `createSandpool` requires `options.logger`, makes a child with `component: 'sandpool'`, and writes only `debug` lines. Every line carries the pool's counts and lifecycle: `lifecycle`, `idle`, `leased`, `creating`, `disposing`, `queued`, `total`, `heated`, `minIdle`, `maxSandboxes`, `createFailures`, `maxCreateAttempts`. A line about one sandbox (created, leased, lease released, disposal started, disposed, disposal failed) adds its `sandboxId`; a retry line adds `retryDelayMs`; the two creation failure lines add a fixed `reason` code (`sandbox_factory_rejected`, `sandbox_creation_attempts_exhausted`) and a fixed `hint` text. No line carries the thrown cause, which the pool keeps only in memory ([`sandpool.ts`](../../../packages/sandpool/src/lib/sandpool.ts), [sandpool README](../../../packages/sandpool/README.md)).
- `withProviderLogging` wraps each provider with a child that has `component: 'llms'` and `provider`, and writes only `debug` lines: `llm provider initialized` once, then `llm <operation> <status>` (`started`, `completed`, `failed`, `cancelled`) for completion, stream, embedding, rerank, model listing and model validation. A started line holds the model id and counts (`messageCount`, `toolCount`, `documentCount`) and `hasSchema`; a completed line holds the finish reason, `toolCount`, `dimensions`, `resultCount`, `modelCount` or the validated model id, and the usage numbers (tokens, `searchUnits`, `cost`, `costUnit`, `upstreamCost`); a failed or cancelled line has no fields. No line holds a prompt, a model input or output, a credential, a URL, a header, a cause or a thrown value ([`logging.ts`](../../../packages/llms/src/lib/providers/logging.ts), [llms README](../../../packages/llms/README.md)).

The bundles that use them pass a pino logger whose lines go to `log/v1`: `logV1Logger` keeps level `debug`, maps pino's numeric level to a `log/v1` level (50 and above, `fatal` included, to `error`; 40 to `warn`; 30 to `info`; below 30 to `debug`; a level that is not a number to `info`), takes `msg` as the message, drops `time`, `pid` and `hostname`, passes every other field (the child bindings included) as the record's fields, and never throws. The sandbox bundles `docker` and `firecracker` pass it to `createSandpool`, and the provider bundles `openai`, `openrouter`, `codex` and `claude` pass it to their `llms` providers, so each pool and provider line carries the bundle's `bundleId` ([`docker/src/host/logger.ts`](../../../bundles/sandboxes/docker/src/host/logger.ts), [`docker/src/host/sandbox.ts`](../../../bundles/sandboxes/docker/src/host/sandbox.ts), [`openai/src/host/main.ts`](../../../bundles/providers/openai/src/host/main.ts), [docker README](../../../bundles/sandboxes/docker/README.md)).

## The platform log

The platform has a log of its own, `PlatformLog`, with `info`, `warn` and `error`, each `(fields, message)`. It does not go through `log/v1`, so it records what happens before any provider of `log/v1` is active, or when none activates ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). The host kernel writes to it, among other lines:

- `Bundle quarantined`, `warn`, with `bundleId` and `reasons`, for each bundle the catalog quarantines and for each bundle of a generation that failed ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)). The activation loop writes the same line, with every reason the bundle has, when a bundle fails to load, activate, settle or register, in every process that has a platform log ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts));
- `Bundle recovery mode`, `error`, with the recovery `reason` and each bundle's `id`, `state` and `reasons` ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts));
- `Bundle disabled` and `Composition reset`, `info`, for the recovery actions on the composition ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts)).

The host also writes `Bundle recovery mode` with the `reason` to its startup log when a contract or bundle the composition lists under `required` is not active, at boot and whenever a generation becomes active later ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)).

The desktop main process writes its platform log, among other lines, for a failed app hook, as [Hooks](hooks.md#doricapphooksv1) lists: `App hook failed` with the hook and the error's message ([`lifecycle.ts`](../../../app/desktop/doric/src/platform/lifecycle.ts)), `onAppReadyHook failed` ([`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)) and `onGenerationReadyHook failed` ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)); and for a diagnostic a window forwards, `Window diagnostic`, `info`, with the window key and the diagnostic as the window sent it ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

## The host's startup record: `doric.startup/v1`

`doric.startup/v1` exists only in the host, and only the host kernel answers it; elsewhere it is not provided ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). Its full shape:

```ts
// doric.startup/v1 (host): the stage a startup failure is reported at, and the flat log lines of the start
interface DoricStartup {
  stage(name: string, call?: CallArg): Promise<void>; // name: 1 to 64 characters
  log(
    record: {
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly message: string;
    },
    call?: CallArg,
  ): Promise<void>;
}
```

The input schema of `log` is strict: a record with any other key is refused with `invalid_input` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

The host keeps one current stage, which starts as `bootstrap`. `stage(name)` sets it. `log(record)` writes `fields` and `message` at `level` to the host's pino logger as a child with `component: 'startup'`; the line does not carry the calling bundle's identity ([`index.ts`](../../../app/backend/doric-host/src/index.ts), [`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)). A kernel started without a startup record answers both methods and drops what they are given ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)).

The host names only its own stages: `bootstrap`, `bundle_load` while the kernel loads the bundles, `network_binding` while the HTTP listener binds, and `ready` once it listens. Every other stage is named by the bundle whose start step runs in it, from its `onHostStartHook` handler; [Hooks](hooks.md#host-start-and-stop) lists them (`database_client`, `credential_activation`, `configuration_activation`, `sandbox_pool`, `workspace_reconciliation`) ([`index.ts`](../../../app/backend/doric-host/src/index.ts)).

The start writes these `info` lines, in this order:

| Message                                                              | Fields                                                                                                                                                    | Written by                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Doric starting`                                                     | `host`, `port`, `alternatives`: the option the composition chose for each alternative, such as `{ sandbox: 'docker' }`                                    | The host ([`index.ts`](../../../app/backend/doric-host/src/index.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts))                                                                |
| `Loading bundles`                                                    | None                                                                                                                                                      | The host                                                                                                                                                                                                   |
| `Bundles loaded`                                                     | `bundleCount` (installed bundles active), `skillCount`, `toolCount`                                                                                       | The host                                                                                                                                                                                                   |
| `Initializing PostgreSQL client`, `PostgreSQL client initialized`    | None                                                                                                                                                      | `postgres` ([`start.ts`](../../../bundles/foundation/postgres/src/host/start.ts))                                                                                                                          |
| `Activating stored credentials`                                      | None                                                                                                                                                      | `core` ([`activation.ts`](../../../bundles/foundation/core/src/host/secrets/activation.ts))                                                                                                                |
| `Activating Doric configuration`, `Doric configuration activated`    | The second: `configRevision`, `providerCount`, `executionModel`, `maxTurns`                                                                               | `host-config` ([`configuration.ts`](../../../bundles/foundation/host-config/src/host/configuration.ts))                                                                                                    |
| `Configuring sandbox pool`, `Sandbox pool configured`                | `sandboxProviderName`; the second also the image, the resources, the pool limits, `networkMode`, `sshEnabled`, and for `docker` only `dockerSocketShared` | `docker` or `firecracker` ([`docker/src/host/start.ts`](../../../bundles/sandboxes/docker/src/host/start.ts), [`firecracker/src/host/start.ts`](../../../bundles/sandboxes/firecracker/src/host/start.ts)) |
| `Reconciling persisted projects and threads`, `Workspace reconciled` | The second: `interruptedThreads`, `interruptedProjects`                                                                                                   | `runtime` ([`lifecycle.ts`](../../../bundles/runtime/runtime/src/host/lifecycle.ts))                                                                                                                       |
| `Network interfaces configured`                                      | `socketNamespaces`                                                                                                                                        | `transport` ([`kernel.ts`](../../../bundles/foundation/transport/src/kernel.ts))                                                                                                                           |
| `Binding HTTP listener`                                              | `host`, `port`                                                                                                                                            | The host                                                                                                                                                                                                   |
| `Doric listening`                                                    | `host`, `port`, `alternatives`                                                                                                                            | The host                                                                                                                                                                                                   |

From slice S62c3 of [grpc-processes.md](../../designs/grpc-processes.md) the host boots the platform (`startHostPlatform`, `app/backend/doric-host/src/lib/bundles/boot.ts`), and the table changes in four places: `Bundles loaded` (`bundleCount` is the catalog's active entries) is written first, in the platform's `beforeListen` step, before `onHostStartHook` runs the bundles' start steps; `Network interfaces configured` carries `apiServices`, written by `transport`'s process service (`src/host/process/service.ts`), instead of `socketNamespaces`; `Binding HTTP listener` carries `address` (`DORIC_HOST:DORIC_PORT`) instead of `host` and `port`, and is written with the `network_binding` stage at the end of that step, before the platform binds; and `Doric listening`'s `port` is the bound port (`platform.publicPort`). A bundle process's lines reach the host through `log/v1` and are not ordered against the host's own lines.

The bundles' lines come in activation order, which [Hooks](hooks.md#host-start-and-stop) describes. When the start fails, the host writes one `fatal` line, `Doric failed to start`, whose only field is the current `stage`, flushes the log and exits with code 1: the line holds no URL, credential, prompt, cause or thrown value ([`index.ts`](../../../app/backend/doric-host/src/index.ts)). What the platform log and the `Bundle recovery mode` lines wrote before that point, quarantine reasons included, stays in the log.

## Tracing

Every call carries `call.trace`, a W3C `traceparent` (`00-<trace id>-<span id>-<flags>`). A call made without a parent call starts a new trace; a call made with a parent call keeps the parent's trace id and flags and takes a new span id, and a malformed parent starts a new trace ([`call.ts`](../../../packages/bundle/src/runtime/call.ts), [`trace.ts`](../../../packages/bundle/src/runtime/trace.ts)). The desktop main process and each window start their own traces the same way ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`bridge.ts`](../../../packages/desktop/src/client/bridge.ts)).

Between processes, each request envelope carries the span its sender created in `trace.traceparent`, and the receiving side rebuilds the call with that trace ([`messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts), [`call-meta.ts`](../../../packages/bundle/src/runtime/envelope/call-meta.ts)); [Process isolation](process-isolation.md) describes the envelope. The trace id reaches a log line as the record's `traceId`; nothing else in the platform records it.

## Diagnostics: `doric.diagnostics/v1`

`doric.diagnostics/v1` is a platform contract in every environment. The platform answers it in each process, under the principal `doric`, so it works without the core and when the core fails ([`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)). Its full shape ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)):

```ts
// doric.diagnostics/v1 (host, desktopMain, client)
interface DoricDiagnostics {
  get(call?: CallArg): Diagnostics;
  report(entry: DiagnosticReport, call?: CallArg): void; // reachable from a desktop window
}

interface DiagnosticReport {
  readonly bundleId: string;
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

interface Diagnostics {
  readonly generation: number;
  readonly mode: 'normal' | 'recovery';
  readonly recovery?: { readonly reason: string };
  readonly issues: readonly string[];
  readonly bundles: readonly DiagnosticBundle[];
  readonly errors: readonly DiagnosticError[]; // the most recent per bundle
  readonly consumers: Readonly<Record<string, readonly string[]>>;
}

interface DiagnosticBundle {
  readonly id: string;
  readonly version: string;
  readonly state: 'active' | 'quarantined' | 'disabled' | 'inactive';
  readonly phase?: 'foundation' | 'core' | 'others';
  readonly reasons: readonly QuarantineReason[];
  readonly activationMs?: number;
}

interface QuarantineReason {
  readonly code: QuarantineCode;
  readonly message: string;
  readonly contract?: string;
}

type QuarantineCode =
  | 'invalid_manifest'
  | 'invalid_descriptor'
  | 'invalid_part'
  | 'duplicate_id'
  | 'engines_unsatisfied'
  | 'missing_dependency'
  | 'incompatible_version'
  | 'dependency_quarantined'
  | 'unchosen_provider'
  | 'cardinality_mismatch'
  | 'foundation_requires'
  | 'dependency_cycle'
  | 'activate_failed'
  | 'registration_failed'
  | 'skill_invalid'
  | 'generation_failed'
  | 'kernel_requires_generation';

interface DiagnosticError {
  readonly at: string; // ISO time of the report
  readonly bundleId: string;
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}
```

Every object schema is strict. Across a process boundary `report` is one-way ([`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)).

### What a store holds

One `DiagnosticsStore` holds the diagnostics of one environment of one generation ([`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts)):

- **Bundles.** Loading a resolution adds one entry per catalog entry, duplicates included: a scheduled bundle starts `inactive`, a disabled one `disabled`, any other `quarantined` with the resolution's reasons. A duplicate id, or an entry whose manifest could not be read, stays listed and never changes state. Activation then sets `active` with `activationMs`, the time from just before the bundle's part is loaded to the end of its activation: importing the part, running `activate`, settling its registrations and, for an installed host bundle, registering its tools and settling again ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). Otherwise it quarantines the bundle and appends the reason; deactivation sets `inactive` ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). `activationMs` is the only timing the platform keeps.
- **Mode.** `recovery` with its `reason` once the environment enters recovery mode, for instance when the core or a foundation provider the composition chose fails; the first reason is kept. `issues` holds the resolution's issues.
- **Errors.** `report` adds an entry stamped with the time of the report. The store keeps the 50 most recent entries of each bundle (`DIAGNOSTIC_ERRORS_PER_BUNDLE`) and drops the oldest of that bundle beyond them.
- **Consumers.** For each contract id, the bundles whose manifest lists it under `requires`, disabled bundles excepted, sorted, so that the consumers of any contract can be listed.

The reports come from the platform and from bundles. Among them: a hook handler that throws, answers an invalid value or passes its deadline (`hook_handler_failed`, `hook_handler_timeout`) and a platform hook that fails (`hook_execute_failed`), as [Hooks](hooks.md) describes; a log line that cannot be written (`log_write_failed`); a failed registration callback or disposal on the envelope (`when_available_failed`, `dispose_failed`, `link_close_failed`, `listener_failed`); a failed settings listener (`settings_listener_failed`); a generation process that fails, reported by the kernel under `doric` as `generation_failed` ([`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`core/src/shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`core/src/shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts), [`link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts), [`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts), [`settings/facade.ts`](../../../bundles/foundation/core/src/host/settings/facade.ts), [`core/src/shared/state.ts`](../../../bundles/foundation/core/src/shared/state.ts)).

### Stores by process

- **Host.** The kernel keeps one store for its own bundles. Each host generation process keeps its own store, answers `doric.catalog/v1`, `doric.diagnostics/v1` and `doric.bundle/v1` itself, and pushes its snapshot to the kernel after activation and after each report. The kernel answers `get` for the generation of the call, merging its own bundles, the generation's resolution and the child's pushed snapshot ([`runner.ts`](../../../packages/bundle/src/runtime/runner.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`manager.ts`](../../../packages/bundle/src/process/manager.ts)).
- **Desktop main process.** The desktop generation process keeps its store and pushes its snapshot to main, which keeps the newest generation's snapshot ([`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). When main is connected to the host, it reports each bundle its own catalog resolution quarantined to the host's `doric.diagnostics/v1` as `desktop_quarantine`, with the reasons' messages and, in `details`, the version and the reasons ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).
- **Window.** A window keeps its own store and forwards each quarantine, each report and its recovery reason fire-and-forget to main through `doric.shell/v1.diagnostic`; main writes each one to its platform log as `Window diagnostic` ([`platform.ts`](../../../packages/desktop/src/client/platform.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

### Where diagnostics are shown

The desktop splash, in its `recovery` state, carries the reason and the newest desktop generation's `Diagnostics` ([`protocol.ts`](../../../app/desktop/doric/src/platform/splash/protocol.ts), [`distribution.ts`](../../../app/desktop/doric/src/platform/catalog/distribution.ts)); [Splash and recovery](splash-and-recovery.md) describes the surface. The host has no recovery surface of its own. In recovery mode at boot, the kernel writes `Bundle recovery mode` with the reason and each bundle's state ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)), and the host stops the kernel and takes its fatal startup path ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)). When a contract or bundle the composition lists under `required` is not active in a generation that becomes active after the start, the host writes `Bundle recovery mode` with the reason, flushes the log and exits with code 1, without a `Doric failed to start` line (`watchStructural` in [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)). Like the host's other services, `doric.diagnostics/v1` is no network route; `report` is reachable from a desktop window and `get` is not ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).

## What logs never hold

- **Credentials, where the platform redacts.** Redaction applies in two places. The host and main process parts of the core's `log/v1` provider redact the secrets of `secrets/v1` before a record leaves the process (above). `events/v1.append` turns each secret of `secrets/v1.redactions()` into `[REDACTED]` and makes the payload storable before it writes the event ([`facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts), [`redact.ts`](../../../bundles/foundation/core/src/shared/redact.ts)). Every other path writes what its caller passes, unredacted: the platform log, `doric.startup/v1.log`, main's `Window diagnostic` lines and the window part of `log/v1`. A caller of those keeps credentials out of what it passes.
- **Event bodies.** A Thread's events carry the agent's reasoning, provider replay data, tool input and output, results and serialized errors, redacted before they are stored with the runtime's redaction list: the secrets the store holds followed by every secret the runtime registers itself, such as a Git token it applies to a sandbox ([`serialization.ts`](../../../bundles/runtime/runtime/src/host/domain/serialization.ts), [`redactor.ts`](../../../bundles/runtime/runtime/src/host/domain/redactor.ts)). Those bodies are read through the events and the Thread APIs and are not written to the operational log: `onEventAppendedHook` gives observers only the `stream` and the `type` ([`facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts)).
- **Library payloads.** `sandpool` and the `llms` providers write counts and identifiers only, as [above](#libraries-that-take-a-pino-logger).
- **Startup failures.** The fatal startup line names only the stage (above).

## Related documents

- [Contexts](contexts.md): the call with `caller`, `scope` and `trace`, the basic contract `log/v1`, and the shapes of `doric.log/v1` and `doric.bundle/v1`.
- [Hooks](hooks.md): the start steps and their stages, and how hook failures reach diagnostics.
- [Core](core.md): the core as provider of `log/v1`, quarantine and recovery mode.
- [Process isolation](process-isolation.md): generation processes and the envelope that carries the trace.
- [Splash and recovery](splash-and-recovery.md): the surface that shows diagnostics.
- [Contracts](contracts.md): contract ids, including the `doric.*` platform contracts.
- [Boundaries](boundaries.md): which unit owns each platform contract.
- [Manifest](manifest.md): `requires`, which diagnostics reads for contract consumers.
