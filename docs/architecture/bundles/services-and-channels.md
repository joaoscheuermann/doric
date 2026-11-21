# Services and message channels

- Status: living document. It describes how bundles call one another, the call envelope and the message channels as implemented on 2026-11-20.

## Summary

Bundles call one another through **versioned services**. A service is a contract with an id that carries its major version (`runtime.workspace/v1`); one bundle provides it with `services.provide(definition)`, and another reaches it with `services.use(ref)`, which returns a typed stub. The stub does not tell where the provider runs: in the same process, in another process of the same machine, in the desktop process or in the host behind the desktop bridge ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

Every method a provider implements receives `(input, call, services)`. `call` is the envelope of one hop: who made it, the scope it acts on, its cancellation signal and its trace. The platform fills `call` and transports its scope without reading it, except `windowKey`, the one key it reserves ([`call.ts`](../../../packages/bundle/src/contracts/call.ts), [`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)).

A desktop window serves the contracts its own client parts provide; it reaches every other service only through the desktop process, over one IPC channel, `doric:desktop`, and the desktop process alone talks to the host. A method is reachable from a window only when its contract exposes it to the desktop; the default is deny ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`exposure.ts`](../../../packages/bundle/src/runtime/exposure.ts)).

A service call is one of several message channels. Durable events, hooks, streams and DOM events each keep a delivery contract of their own ([The message channels](#the-message-channels)).

## The service directory

Each process keeps one directory of active providers per contract id ([`directory.ts`](../../../packages/bundle/src/runtime/directory.ts)). A provider record holds the contract id, the providing bundle and its version, the contract version declared in `provides`, the environment, the cardinality, the method specifications and an `invoke(method, input, call)` that runs the method.

A contract has one of two cardinalities, `one` by default and `many` when it is defined with `defineService(id, methods, { cardinality: 'many' })`; any other options object throws a `TypeError` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)):

| Cardinality | Providers                                                         | How a consumer reaches it                                                                                |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `one`       | One active provider per environment                               | `services.use(ref)`, or `services.whenAvailable(ref, callback)` for an optional contract                 |
| `many`      | Any number, all active at once (for example `models.provider/v1`) | Only `services.whenAvailable(ref, callback)`, called once per provider; `use` throws `many_contract_use` |

`services.provide(definition)` registers the definition in the directory of the part's process and returns a `Disposable`. It refuses, each with a `ContractError` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`directory.ts`](../../../packages/bundle/src/runtime/directory.ts)):

| Code                   | When                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_input`        | The argument is not a definition created with `defineService`                                                                                                               |
| `undeclared_provide`   | The bundle's manifest does not list the contract under `provides`                                                                                                           |
| `cardinality_mismatch` | The definition's cardinality differs from the one the catalog publishes                                                                                                     |
| `contract_mismatch`    | A basic contract whose methods or schemas differ from the platform's specification, or a method that declares a desktop exposure the platform's specification does not give |
| `provider_conflict`    | The contract is `one` and the directory already holds an active provider                                                                                                    |

Every refusal but `invalid_input` is marked as a registration error of the bundle and thrown to it. When the error escapes the bundle's `activate`, the bundle is quarantined with `cardinality_mismatch` if that is the error's code, or `registration_failed` otherwise, instead of `activate_failed`. A refusal the bundle catches, or one that happens after activation, quarantines nothing ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [Core](core.md#quarantine)). When the composition chooses another bundle under `providers` for a `one` contract, `provide` registers nothing and returns an inert `Disposable`, so the chosen provider is the one the directory holds ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [Core](core.md#replacing-a-contract-the-core-provides)). A registration is tracked in the bundle's disposal scope and removed when the bundle deactivates ([Contexts](contexts.md#lifetimes)).

How a contract, its methods and its schemas are declared is in [Contracts](contracts.md); how `provides`, `requires` and `optional` are written is in [The bundle manifest](manifest.md).

## Stubs

`services.use(ref, scope?)` returns a stub: a proxy on which every method name dispatches to the provider when it is called, except `then`, `toJSON`, `constructor`, `valueOf` and `toString`, which read as `undefined`, so a stub is never mistaken for a Promise. The stub binds late: each call resolves the active provider of the contract at that moment, so a provider that is replaced, or that appears after the stub was taken, serves the next call ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). `scope`, when given, is bound to every call made through the stub ([The scope](#the-scope)).

`use` is checked against the manifest: it is allowed on a contract the bundle lists under `requires` or `optional`, on a contract it provides, on a `doric.*` contract, and, for the composition's core, on a basic contract; otherwise it throws `undeclared_requirement` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

`services.whenAvailable(ref, callback)` calls `callback(api, { bundleId, version })` once for each provider in the directory, now and whenever one is registered later, with a stub pinned to that provider. What the callback registers, and the cleanup it returns, are disposed when that provider goes away or the registration is disposed. A callback that throws or rejects is reported to diagnostics as `when_available_failed`. `whenAvailable` is not checked against the manifest ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).

A consumer example, from the `terminal` tool, which runs in a prompt and passes on the prompt's scope ([`tool.ts`](../../../bundles/features/terminal/src/host/tool.ts)):

```ts
execute: async (input, call, services) => {
  const cwd = await services.use(RuntimeWorkspaceV1, call.scope).cwd(call);
  const terminals = services.use(TerminalV1, call.scope);
  // ...
};
```

The `terminal` manifest lists `runtime.workspace/v1@^1.1.0` under `requires`, and provides `terminal/v1` itself ([`manifest.json`](../../../bundles/features/terminal/manifest.json)). The contracts of a bundle are described in its README: [runtime](../../../bundles/runtime/runtime/README.md), [terminal](../../../bundles/features/terminal/README.md).

### One call

A stub call runs these steps in the caller's process ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)):

1. When the calling bundle is not active, the call throws `unavailable`.
2. It resolves the provider: the one pinned by `whenAvailable`, else the active provider of the contract. With none, the call throws `unavailable` (`No active provider of "<id>".`), except in a host kernel during a generation respawn, where it waits for the next generation and its signal aborts the wait ([Process isolation](process-isolation.md#which-generation-a-call-reaches)).
3. A method the provider does not have throws `unavailable`.
4. It splits the arguments into the input and an optional last call argument, a parent `Call` or `{ signal?, deadline? }`. For a method whose input is a tuple, a trailing `{ signal?, deadline? }` counts as the call argument only beyond the tuple's length or where the tuple item at that position rejects it.
5. It validates the input against the method's zod schema; a failure throws `invalid_input` with the issues.
6. It builds the hop's `call` ([The call](#the-call)).
7. It invokes the provider. A provider in the same process runs `execute(input, call, services)` directly, where `services` are the provider's own; a provider in another process is reached through the process envelope, which validates against the published JSON Schemas ([Process isolation](process-isolation.md#the-envelope)).
8. It validates the output; a failure throws `invalid_output`. A `Disposable` the provider returns is tracked in the caller's current disposal scope, so it is released when the caller's scope ends. The original value is returned, not the parsed copy.
9. When the provider throws or rejects with a registration-conflict code (`duplicate_tool`, `duplicate_skill`, `registration_conflict`, `not_owner`, `unavailable_tool`, `provider_conflict`, `undeclared_provide`, `cardinality_mismatch` or `contract_mismatch`), the error is marked as a registration error of the calling bundle and thrown on to the caller. When it escapes that bundle's `activate`, the bundle is quarantined with `cardinality_mismatch` if that is the error's code, or `registration_failed` otherwise, instead of `activate_failed`. A refusal the bundle catches, or a call made after activation, such as from a tool, a handler or a `whenAvailable` callback, quarantines nothing ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [Core](core.md#quarantine)).

The call is asynchronous when the provider returns a Promise and synchronous when it returns a value, so a local service such as `navigation/v1` can answer synchronous reads ([Navigation](navigation.md)). Between processes of one machine, a process-local value (a callback, a `Disposable`, a definition) crosses as a handle when the member's schema allows it and is refused with `local_only` otherwise ([`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). Across the desktop bridge only plain JSON and streams cross: a method with any other process-local value in its input, or in the output of a call, is local and refused with `local_only` ([`protocol.ts`](../../../packages/desktop/src/client/protocol.ts), [Contracts](contracts.md#services-and-methods)).

### Errors

Every boundary speaks `ContractError`: a stable `code`, a `message` and optional `details`. An error that is not a `ContractError` crosses a boundary as code `internal` with its message ([`error.ts`](../../../packages/bundle/src/contracts/error.ts)). The codes are an open set; those of the call path are:

| Code                     | Raised by                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`            | No active provider or method; a calling bundle that is not active; a host that is not connected; a method not exposed to the desktop   |
| `undeclared_requirement` | `use` of a contract the manifest does not list; a window call to such a contract                                                       |
| `invalid_input`          | Input that fails the schema; a scope key the provider's `desktopScope` does not list; a stream called as a call, or a call as a stream |
| `invalid_output`         | Output that fails the schema                                                                                                           |
| `local_only`             | A process-local value the member does not allow, across a process; a local method across the desktop bridge                            |
| `many_contract_use`      | `use` of a `many` contract                                                                                                             |
| `generation_lost`        | The generation process serving the call ended ([Process isolation](process-isolation.md#losing-a-generation-process))                  |
| `disconnected`           | A stream over the host bridge ended because the bridge went down                                                                       |

A provider rejects with a `ContractError` of its own code, and the code and message reach the caller unchanged across processes and across the desktop bridge ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)).

## The call

Every `execute` of a method, a command or a tool, and every hook handler, receives the `call` of its hop ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)):

```ts
type CallScope = Readonly<Record<string, string>>;

interface Caller {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
}

interface Call {
  readonly caller: Caller; // the bundle that made this hop
  readonly scope?: CallScope;
  readonly signal: AbortSignal;
  readonly trace: { readonly traceparent: string }; // W3C: 00-<32 hex>-<16 hex>-01
}

interface CallOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number; // epoch milliseconds; 0 or absent means none
}

type CallArg = Call | CallOptions;
```

A bundle never builds a `call`. The dispatcher of the calling process builds one per hop ([`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)):

- **`caller`** is always the bundle making this hop, never inherited from a parent call. It identifies the caller for logs and diagnostics; no provider in the platform uses it for access control.
- **`signal`.** With a parent call, the parent's signal and deadline. Without one, the given signal or, by default, a signal that aborts when the caller's generation ends; with a deadline it also aborts at the deadline, with a `TimeoutError`.
- **`trace`.** A child span of the parent's trace, or a new trace without a parent.
- **Generation.** A non-enumerable mark carries the generation the operation is pinned to, inherited from the parent call; a call without a parent is pinned to the generation of the runtime that dispatches it, and `0` means unpinned ([Process isolation](process-isolation.md#which-generation-a-call-reaches)).

A provider passes the call it received as the last argument of every stub call it makes, so cancellation, scope and trace follow the chain. A runtime-created call is frozen and branded, and only a branded call counts as a parent; any other last argument is read as `{ signal?, deadline? }` only when it is a plain object whose own keys are a non-empty subset of `signal` and `deadline` ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)).

### The scope

`call.scope` is a record the platform transports and does not read. `callScopeSchema` bounds it: keys match `scopeKeyPattern` (`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`), at most `SCOPE_MAX_KEYS` (16) keys, each value at most `SCOPE_MAX_VALUE` (512) characters ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)). The scope of a hop is built in this order, later sources winning ([`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)):

1. the parent call's scope;
2. the scope bound by `services.use(ref, scope)`;
3. `windowKey`, when the dispatcher of a window or the desktop process sets it.

A scope with no key is absent. The keys belong to the bundles that read them; the core's providers also read some of them: `tools/v1` reads `projectId`, `events/v1` the keys its event sink names, and `hooks/v1` and `menus/v1` read `windowKey` ([Core](core.md#the-scope-keys-the-core-reads)):

- **`windowKey`** is the platform's. In a window, every call a provider of that window receives carries the window's key ([`activate.ts`](../../../packages/desktop/src/client/activate.ts)). A call that leaves the window drops the exact key `windowKey` ([`bridge.ts`](../../../packages/desktop/src/client/bridge.ts)); a scope that names it in another letter case is sent as it is, and the desktop process refuses the whole request when it parses it ([`protocol.ts`](../../../packages/desktop/src/client/protocol.ts), [The dispatcher in the desktop process](#the-dispatcher-in-the-desktop-process)). The desktop process then sets it, from the window the request came from, on every call it forwards ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). No manifest may list it under `desktopScope` ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). In a host or `desktopMain` process the dispatcher does not remove a `windowKey` a bundle binds with `use`.
- **`projectId`, `threadId` and `promptId`** are the `runtime` bundle's. A caller binds them with `services.use(ref, { projectId, threadId, promptId })` or passes on the scope it serves with `services.use(ref, call.scope)`; a provider reads them from `call.scope`. `runtime/contracts` exports `runtimeScope(scope)`, which builds that record and leaves absent keys out, and `readRuntimeScope(call)`, which returns the three keys of a call, absent ones `undefined` ([`scope.ts`](../../../bundles/runtime/runtime/src/contracts/scope.ts)). The runtime's own providers read the keys with `readRuntimeScope` ([`bindings.ts`](../../../bundles/runtime/runtime/src/host/domain/bindings.ts), [`lease.ts`](../../../bundles/runtime/runtime/src/host/services/lease.ts), [`attachments.ts`](../../../bundles/runtime/runtime/src/host/services/attachments.ts)); other bundles write the record and read `call.scope` directly, and no source outside the runtime's tests calls `runtimeScope` ([`library.ts`](../../../bundles/features/papercraft/src/host/library.ts), [`provider.ts`](../../../bundles/features/terminal/src/host/provider.ts)).

### A running prompt's controls

The runtime runs each prompt's executor with a scope that names its Project, Thread and prompt, and binds the prompt's Host facade and sandbox to that scope while it runs ([`runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts), [`ports.ts`](../../../bundles/runtime/runtime/src/host/ports.ts), [`bindings.ts`](../../../bundles/runtime/runtime/src/host/domain/bindings.ts)). The prompt-scoped methods of `runtime.threads/v1` and `runtime.workspace/v1`, and `runtime.lease/v1` when the scope names a prompt, act on the binding of `scope.promptId` when its `threadId` and `projectId` match the scope, and otherwise fail with `Thread control is no longer active.` ([`threads.ts`](../../../bundles/runtime/runtime/src/host/services/threads.ts), [`workspace.ts`](../../../bundles/runtime/runtime/src/host/services/workspace.ts), [`lease.ts`](../../../bundles/runtime/runtime/src/host/services/lease.ts)). `terminal/v1` does not go through these bindings: its `run` reads `threadId` and `promptId` from `call.scope`, fails with `Thread is inactive.` only when one of them is missing or the Thread is closing or not ready, and runs the command in that Thread's sandbox through `runtime.workspace/v1.withThread`; it checks neither `projectId` nor whether the named prompt is still running ([`provider.ts`](../../../bundles/features/terminal/src/host/provider.ts)).

The rule this sets: a running prompt's controls are reached by call scope, not by caller. Any bundle that lists the runtime's contracts and builds a scope naming a running prompt reaches that prompt's controls through them, and a prompt that has ended has none ([runtime README](../../../bundles/runtime/runtime/README.md)). Through `terminal/v1`, a scope naming any live Thread and any prompt id runs a terminal in that Thread, whether the prompt runs or not ([terminal README](../../../bundles/features/terminal/README.md)).

## Streams

A stream method is a method whose input is a tuple ending in a listener, declared with `streamListener(itemSchema)`; its JSON Schema records the item schema under `x-doric-stream` ([`common.ts`](../../../packages/bundle/src/contracts/basic/common.ts), [`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts)). The listener is a function, read as `{ next }`, or a `StreamObserver`:

```ts
interface StreamObserver<T> {
  next(item: T): void;
  end?(error?: ContractError): void; // at most once; no error when the provider closed it
}
```

The method returns a `Disposable` that unsubscribes. A stream delivers items as they happen: it keeps no buffer and replays nothing, unless its contract takes a cursor, as `runtime.threads/v1.watchThread` takes `afterSequence` ([runtime README](../../../bundles/runtime/runtime/README.md)). Across the desktop bridge a window opens a stream with `subscribe`, not `call`; each side refuses the other with `invalid_input` ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)).

## Calls from a desktop window

### Who talks to the host

The desktop process (Electron main) is the only client of the host. It reaches the host at `http://127.0.0.1:3000`, or at `DORIC_HOST_URL` when that variable is set; the host bridge and the connection monitor both follow it ([`main.ts`](../../../app/desktop/doric/src/main.ts), [`host-bridge.ts`](../../../app/desktop/doric/src/platform/bridge/host-bridge.ts)). An app window never opens HTTP or Socket.IO: its sandboxed preload exposes one object, `window.doric.desktop`, and nothing else ([`preload.ts`](../../../app/desktop/doric/src/app/api/preload.ts)). A view window is the exception: it has no preload and no bundle contracts, and its own `WebContents` loads a page of the host origin in a session of its own ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

`window.doric.desktop` speaks over exactly two channels: `doric:desktop`, a request to main, and `doric:desktop:push`, main's pushes to the window ([`desktop.ts`](../../../app/desktop/doric/src/app/api/desktop.ts), [`push.ts`](../../../app/desktop/doric/src/platform/windows/push.ts)):

```ts
interface DoricDesktopApi {
  describeWindow(): Promise<WindowDescription>;
  ready(): Promise<void>;
  reportFailure(info: WindowFailure): Promise<void>;
  onCloseRequested(
    handler: (request: CloseRequest) => Promise<CloseAnswer | undefined>,
  ): () => void;
  onChromeChanged(listener: (chrome: WindowChrome) => void): () => void;
  catalog(): Promise<WindowCatalog>;
  call(envelope: BridgeCallEnvelope): Promise<BridgeResultPayload>;
  cancel(id: string): void;
  subscribe(
    envelope: BridgeCallEnvelope,
    listener: (event: BridgeStreamEvent) => void,
  ): () => void;
}

interface BridgeCallEnvelope {
  readonly id: string; // unique in the window
  readonly contract: string;
  readonly method: string;
  readonly input: unknown;
  readonly bundleId: string | null; // the calling client bundle; null for the window platform
  readonly scope?: CallScope; // never windowKey
  readonly deadline: number; // epoch milliseconds; 0 means none
  readonly traceparent: string;
}

type BridgeResultPayload =
  | { ok: true; output: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type BridgeStreamEvent =
  | { type: 'event'; event: unknown }
  | {
      type: 'end';
      error?: { code: string; message: string; details?: unknown };
    };
```

Under that API, the preload sends one request per operation on `doric:desktop`, and main pushes on `doric:desktop:push`. Both are unions of strict objects; every request carries an optional `generation`, the generation the window's page was rendered with, which main uses to pin a window that is not pinned yet:

```ts
type DesktopRequest =
  | { op: 'describeWindow'; generation?: number }
  | { op: 'ready'; generation?: number }
  | { op: 'reportFailure'; info: WindowFailure; generation?: number }
  | { op: 'catalog'; generation?: number }
  | { op: 'call'; envelope: BridgeCallEnvelope; generation?: number }
  | { op: 'cancel'; id: string; generation?: number }
  | { op: 'subscribe'; envelope: BridgeCallEnvelope; generation?: number }
  | { op: 'unsubscribe'; id: string; generation?: number }
  | { op: 'closeAnswer'; id: string; answer: CloseAnswer; generation?: number };

type DesktopPush =
  | { type: 'close-requested'; id: string; request: CloseRequest }
  | { type: 'chrome'; chrome: WindowChrome }
  | { type: 'event'; id: string; event: unknown } // one stream item
  | { type: 'end'; id: string; error?: BridgeError }; // the stream ended
```

These are the types and schemas (`desktopRequestSchema`, `desktopPushSchema`) of [`protocol.ts`](../../../packages/desktop/src/client/protocol.ts). Every operation a window asks of the host or of the desktop process is a contract call or stream on this channel: Projects, Threads, configuration, terminals, usage, each Thread watch, the selected Project's tree, the connection status and native notifications alike. Main handles `doric:desktop` with one dispatcher ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).

### Routing in the window

A window's directory holds its own client parts' providers and one remote record for each contract its generation's catalog routes to the desktop process. A contract a client part in the window provides is served in the window, and no remote record is registered for it ([`activate.ts`](../../../packages/desktop/src/client/activate.ts)). A stub call to a remote record crosses as a `BridgeCallEnvelope`: `bundleId` is the bundle the stub belongs to, `scope` is the call's scope without `windowKey`, and the call's abort sends `cancel` ([`bridge.ts`](../../../packages/desktop/src/client/bridge.ts)).

### The dispatcher in the desktop process

One dispatcher routes every window call by contract: to the provider in the window's pinned `desktopMain` generation, else to the host provider ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`client-routing.ts`](../../../app/desktop/doric/src/platform/bridge/client-routing.ts)). For each request it:

1. Accepts it only from the main frame of a registered window or of the splash, loaded from `doric://app` ([`sender.ts`](../../../app/desktop/doric/src/platform/bridge/sender.ts)).
2. Parses the request against `desktopRequestSchema`; this is where a scope naming `windowKey` in any letter case is refused.

   A request refused at step 1 or 2 is not answered with a `ContractError` result: the IPC call itself rejects with a plain `Error`, `The request source is not allowed.` or `Invalid desktop request: …`. In the window a `call` then rejects with that error, and a `subscribe` ends with `unavailable` and its message ([`desktop.ts`](../../../app/desktop/doric/src/app/api/desktop.ts)). Every later refusal of a `call` or `subscribe` is a `BridgeResultPayload` with `ok: false`. `describeWindow` and `catalog` instead reject the IPC call when the window cannot be pinned: with `unavailable`, `This window has no generation.`, or `Generation N is no longer available; the window reloads.`, in which case main also reloads the window. A `catalog` from the splash rejects with `The splash has no catalog.` ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).

3. For `bundleId: null`, serves the window platform's own contract, `doric.shell/v1`, and nothing else. The splash may only call `doric.splash/v1` `act` and subscribe to its `state` ([`splash/protocol.ts`](../../../app/desktop/doric/src/platform/splash/protocol.ts)).
4. For a bundle call, resolves it in the generation the window is pinned to:
   - the bundle must have an active client part in that generation, else `unavailable`;
   - the contract must not be `doric.*`, and the bundle must list it under `requires` or `optional` or provide it, else `undeclared_requirement`;
   - a provider must be routed for the contract and the method, else `unavailable`;
   - the method must be exposed to the desktop, else `unavailable` ([Exposure to a desktop window](#exposure-to-a-desktop-window));
   - every scope key must be listed for the contract in the provider's `desktopScope`, else `invalid_input`;
   - the method must not be local (`local_only`), and must be a stream exactly when the request is `subscribe` (`invalid_input`).
5. Validates the input against the published JSON Schema (`invalid_input`), and the output of a call (`invalid_output`); stream items are not validated here.
6. Builds the hop's wire call: `caller` is the window's bundle with its version and the generation, `scope` is the window's scope with `windowKey` set to the window's key, and the trace and deadline are the window's.
7. Forwards it: to the `desktopMain` provider record in the generation's `utilityProcess` (`unavailable` when that process or provider is not running), or over the host bridge (`unavailable`, `Doric backend is unavailable.`, when the window's generation is not connected or the bridge is down).

A main-frame navigation, a reload or the destruction of a window aborts every open call and disposes every open stream of that window ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

Main sends each stream item and end as a push. A stream to a `desktopMain` provider is the exception for the end: main passes the provider only an item callback, so the provider's own end never reaches the window. Such a stream ends for the window only when the provider's method rejects (an `end` with its error), when the window unsubscribes, or when the window navigates or goes away ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). A stream to a host provider receives the provider's end. A push to a window whose `WebContents` is destroyed, or whose main frame is detached or destroyed, is skipped, and so is one whose frame disappears during the native send ([`push.ts`](../../../app/desktop/doric/src/platform/windows/push.ts)).

### The host bridge

Main reaches host services through the Socket.IO namespace `/doric/bridge`, over a WebSocket. Each message is emitted under its kind and carries the whole envelope message: main sends `call`, `cancel`, `subscribe` and `unsubscribe`; the host answers `result`, `event` and `end` ([`host-bridge.ts`](../../../app/desktop/doric/src/platform/bridge/host-bridge.ts), [`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)). The kernel installs the namespace ([`doric-host/src/index.ts`](../../../app/backend/doric-host/src/index.ts)). The bridge uses seven kinds of the process envelope's messages ([`messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts)); `invoke`, `release` and the control kinds (`init`, `ready`, `provide` and the rest) belong to the process link. The host validates each message it receives with the envelope's `wireMessageSchema`. Main never sends the optional `provider`, `record` and `oneway` fields of `call`, and the host ignores them, so `oneway` does not suppress the `result`. `WireCall` (`caller`, `scope`, `trace`, `deadline`, `generation`) is described in [Process isolation](process-isolation.md#the-envelope):

```ts
type BridgeMessage =
  | ({
      kind: 'call';
      id: string;
      contract: string;
      method: string;
      input: unknown;
    } & WireCall)
  | ({
      kind: 'subscribe';
      id: string;
      contract: string;
      method: string;
      input: unknown;
    } & WireCall)
  | { kind: 'cancel'; id: string }
  | { kind: 'unsubscribe'; id: string }
  | { kind: 'result'; id: string; ok: true; output: unknown }
  | {
      kind: 'result';
      id: string;
      ok: false;
      error: { code: string; message: string; details?: unknown };
    }
  | { kind: 'event'; id: string; values: unknown[] } // the host sends one item per message
  | {
      kind: 'end';
      id: string;
      error?: { code: string; message: string; details?: unknown };
    };
```

The `input` of a stream is the argument tuple without the listener. `id` is unique per sending side.

On the host, each request is checked and run in the kernel's active view, as the platform principal `doric` ([`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)):

- A malformed message is refused: a `call` gets a `result` and a `subscribe` an `end`, both with `invalid_input`. Parsing first drops each scope entry whose key does not match `scopeKeyPattern` or whose value is not a string, then applies the `callScopeSchema` bounds (16 keys, 512 characters a value) to what remains, and strips unknown fields. A message is therefore refused only for a missing or mistyped field, or for a scope over those bounds.
- The method must be exposed to the desktop by its active provider, else `unavailable`; when a generation is respawning, the check waits for its provider.
- A stream must be subscribed and a call called, else `invalid_input`; a tuple input must arrive as the argument array.
- The call runs through a stub bound to the request's scope, `windowKey` included, with the request's deadline and a signal that `cancel`, `unsubscribe` or the socket's disconnect aborts. The provider therefore sees `doric` as `call.caller`, the window's scope, and a new trace.

On main's side, a call made while the bridge is down rejects at once with `unavailable` (`Doric backend is unavailable.`), and so does a call whose deadline elapses before the answer, after main sends `cancel`. When the socket disconnects, every pending call rejects with `unavailable` and every open stream ends with `disconnected`; a `subscribe` while disconnected ends with `disconnected`. The socket reconnects every second, including after the host refuses the connection ([`host-bridge.ts`](../../../app/desktop/doric/src/platform/bridge/host-bridge.ts)).

The same bridge serves main's own calls to the host's platform contracts, such as `doric.catalog/v1` and `doric.diagnostics/v1`, under the same exposure check ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

## Exposure to a desktop window

The default is deny: a method reaches a desktop window only when it declares `expose: 'desktop'` ([`expose.ts`](../../../packages/bundle/src/contracts/expose.ts), [`exposure.ts`](../../../packages/bundle/src/runtime/exposure.ts)):

- **A basic or platform contract** takes its exposure from the platform's specification of its methods in `packages/bundle`. A provider cannot change it: a definition that declares an exposure the specification does not give fails the build with `<contract> <method> may not be exposed to the desktop: the platform specification decides.` ([`record.ts`](../../../packages/bundle/src/build/record.ts)), and is refused with `contract_mismatch` at `services.provide` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).
- **A bundle contract** takes its exposure from the provider's definition, `defineMethod({ ..., expose: 'desktop' })`. The build writes it into the contract document under `x-doric-expose`, a map from method name to `desktop` ([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts)). The desktop process reads that key to route the contract; an entry that names no method of the document, or an unknown target, leaves the whole contract unrouted ([`client-routing.ts`](../../../app/desktop/doric/src/platform/bridge/client-routing.ts)).
- **Scope keys.** A provider's manifest names, under `desktopScope`, the scope keys a window may send to each contract it provides; any other key is refused with `invalid_input`. The format of `desktopScope` is in [The bundle manifest](manifest.md#desktopscope).
- **No provider.** A contract with no active provider is unavailable.

The exposed set is pinned by a snapshot test: [`bridge-exposure.test.ts`](../../../app/backend/doric-host/tests/bridge-exposure.test.ts) compares the methods every bundle of the built composition exposes, and the scope keys each exposed contract accepts, with [`bridge-exposure.snapshot.json`](../../../app/backend/doric-host/tests/bridge-exposure.snapshot.json). A change to what a window may reach therefore changes that file, in review.

## Native handles: `doric.network/v1`

The kernel owns the host's HTTP listener, its Socket.IO server and the generic `/doric/bridge` namespace. Bundles reach the listeners through `doric.network/v1`, a host-only platform contract the kernel provides ([`network.ts`](../../../packages/bundle/src/contracts/network.ts), [`process/network.ts`](../../../packages/bundle/src/process/network.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)):

```ts
interface NetworkResources {
  readonly http: object; // the host's Express app, on which the routes are registered
  readonly server: object; // the http.Server both are attached to, for an `upgrade` listener
  readonly sockets: object; // the Socket.IO server over the same listener
}

type NetworkListener = (
  resources: NetworkResources,
) => (() => void) | undefined;

interface DoricNetwork {
  register(listener: NetworkListener): Disposable;
}
```

`register` runs the listener at once with the resources and returns a `Disposable`; disposing of it runs the cleanup the listener returned, once. Like every `Disposable` a stub returns, it is tracked in the bundle's scope, so the cleanup runs when the bundle deactivates. The resources are local to the kernel process and never serialized, so only a bundle that runs in the kernel uses the contract; from a generation process, `register` is refused with `local_only`, because its listener is a function that the envelope does not carry ([Process isolation](process-isolation.md#doricnetworkv1), [`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). The kernel passes the resources it created: the Express app, the `http.Server` and the Socket.IO server ([`doric-host/src/index.ts`](../../../app/backend/doric-host/src/index.ts)). A bundle never calls `listen`: the kernel owns the address, the bind and the close.

The `transport` bundle registers every product route and namespace through it ([`transport/src/host/index.ts`](../../../bundles/foundation/transport/src/host/index.ts), [transport README](../../../bundles/foundation/transport/README.md)); `screen-relay` attaches a WebSocket `upgrade` listener to `server` ([`screen-relay/src/host/index.ts`](../../../bundles/features/screen-relay/src/host/index.ts), [screen-relay README](../../../bundles/features/screen-relay/README.md)).

## The message channels

Each channel has its own delivery contract; none promises another's:

| Channel       | Declared with                                       | Delivery                                                                                                                                                                |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service call  | `defineService`, `defineMethod`                     | Request and response, with validation, errors, cancellation and a deadline; no replay. Cancellation does not undo effects already made                                  |
| Stream        | A method whose input ends in `streamListener(item)` | Items while subscribed, then at most one end (from a window to a `desktopMain` provider, only an error end); no buffer and no replay unless the contract takes a cursor |
| Durable event | `defineEvent`, appended through `events/v1`         | Committed before it is published, with a per-Thread sequence a reader resumes from ([Events and nodes](events-and-nodes.md))                                            |
| Hook          | `defineHook`, `defineHooks`, fired with `execute`   | Ordered handlers, awaited, with validated output and one failure rule ([Hooks](hooks.md))                                                                               |
| DOM event     | `CustomEvent` in a window                           | Synchronous and local between a Web Component and its parents; never crosses a process ([UI composition](ui-composition.md))                                            |

Work that must survive a failure is driven by a durable event or a durable stream with a cursor, never by a stream subscription or a DOM event ([Storage](storage.md)).

### Recovering a stream

A stream over the bridge ends with `disconnected` or `unavailable` when the bridge is lost, and with `generation_lost` when the host generation serving it ends. The client watches of the shipped bundles treat these three codes alike: the watch reports nothing, and subscribes again from its cursor when `doric.connection/v1` reports `connected`, or one second later when the status already reads `connected`, because the connection status follows a socket of its own that can return before the bridge does; it keeps doing so for as long as each new subscription ends the same way. Any other end stays ended: an end with another error is reported by the Thread, Project tree and terminal watches, an end without an error is silent, and the canvas window's Thread log reports no end and keeps what it holds. The watches that follow this rule are the Thread watch, the selected Project's tree watch, the terminal output watches and the canvas window's shared Thread log, which extends its events from the replay ([`thread-watch.ts`](../../../bundles/desktop/chat/src/client/api/thread-watch.ts), [`project-watch.ts`](../../../bundles/runtime/runtime/src/client/api/project-watch.ts), [`output-watch.ts`](../../../bundles/features/terminal/src/client/output-watch.ts), [`thread-log.ts`](../../../bundles/features/papercraft/src/client/surface/thread-log.ts)). Each implements the rule itself; no shared helper does.

## Related documents

- [Contexts](contexts.md): `HostContext`, `DesktopContext`, `ClientContext`, the `Services` interface, lifetimes and the shapes of the platform contracts.
- [Contracts](contracts.md): `defineService`, `defineMethod`, the contract document and the import rules.
- [The bundle manifest](manifest.md): `provides`, `requires`, `optional` and `desktopScope`.
- [Boundaries](boundaries.md): the rules a bundle follows to reach another.
- [Core](core.md): the default providers of the basic contracts, provider choice and quarantine.
- [Process isolation](process-isolation.md): the kernel, generation processes and the process envelope.
- [Hooks](hooks.md) and [Events and nodes](events-and-nodes.md): the hook and durable event channels.
- [Menus and keybindings](menus-and-keybindings.md): `menus/v1`, a contract a window reaches in the desktop process.
- [Observability](observability.md): how `call.caller` and the trace reach logs and diagnostics.
