# Contexts and capabilities

- Status: living document. It describes what a bundle part receives at activation, and how it reaches every capability through services, as implemented on 2026-11-20.

## Summary

A bundle part never receives an object of the host, the desktop process or the window. Its `activate(ctx)` receives a context with one member, `services`: a `host` part receives `HostContext`, a `desktopMain` part `DesktopContext` and a `client` part `ClientContext`, and the three have the same shape ([`context.ts`](../../../packages/bundle/src/contracts/context.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). The `core` bundle receives the same context as any other bundle.

Every capability is a service contract reached through `services`. The basic capabilities — hooks, log, settings, secrets, tools, skills, storage, events, models, commands, UI, navigation, regions, windows and menus — are service contracts that the platform declares and the `core` bundle provides by default; another bundle may provide any of them instead, when the composition chooses it in `providers`. The capabilities of the platform itself are the `doric.*` contracts, which the platform provides in the environments each names; `doric.about/v1` and `doric.appearance/v1` exist from platform version 1.2.0 and 1.3.0 ([Platform contracts](#platform-contracts), [`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts), [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).

Every use of a contract is a line of the bundle's manifest: a part uses a contract only when its bundle provides it or lists it under `requires` or `optional`, and only a `doric.*` contract, and a basic contract used by the composition's core, is used without a line ([The manifest line of every use](#the-manifest-line-of-every-use)).

## The context

```ts
interface Services {
  /** Provides a service declared in `provides`; each execute gets (input, call, services). */
  provide<D extends AnyServiceDefinition>(definition: D): Disposable;
  /** A typed stub of a contract in `requires` (or `doric.*`), optionally bound to a scope. */
  use<R extends AnyServiceRef>(contract: R, scope?: CallScope): ApiOf<R>;
  /** Runs the callback for each compatible provider, now and when one activates later. */
  whenAvailable<R extends AnyServiceRef>(
    contract: R,
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ): Disposable;
}

interface HostContext {
  readonly services: Services;
}
interface DesktopContext {
  readonly services: Services;
}
interface ClientContext {
  readonly services: Services;
}

type Activate<
  Ctx extends HostContext | DesktopContext | ClientContext = HostContext,
> = (ctx: Ctx) => void | Cleanup | Promise<void | Cleanup>;
type Cleanup = () => void | Promise<void>;
interface Disposable {
  dispose(): void;
} // idempotent
interface ProviderInfo {
  readonly bundleId: string;
  readonly version: string;
}
```

(Abridged from [`context.ts`](../../../packages/bundle/src/contracts/context.ts); the types are exported by `bundle/contracts`, whose home is the [package README](../../../packages/bundle/README.md#services-and-the-part-contexts).)

- **`provide(definition)`** registers a service built with `defineService`. It throws `invalid_input` for anything other than a definition built with `defineService`; `undeclared_provide` when the bundle does not provide the contract in this environment, as its built descriptor for the environment lists; `cardinality_mismatch` when the definition's cardinality differs from the one the catalog publishes; `contract_mismatch` when the definition of a basic contract does not match the platform's method specification — every method but the optional ones, any of those, nothing else, each with input and output schemas whose JSON Schema equals the platform's (`navigation/v1` may omit `forward` and `history`) — or when a method declares an exposure the platform specification does not give it; and `provider_conflict` when another provider of a `one` contract is already registered. When the contract has cardinality `one` and the composition chose another bundle as its provider in this environment, `provide` registers nothing and returns a `Disposable` that does nothing ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`directory.ts`](../../../packages/bundle/src/runtime/directory.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)).
- **`use(contract, scope?)`** returns a typed stub of the contract. The stub binds late: each method call looks up the contract's active provider at the time of the call, so a stub kept from activation reaches whichever provider is active then ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). A call throws `unavailable` with `No active provider of "<contract>".` when no provider is active, with one exception: when the call is made in the kernel of an environment whose bundles run in generation processes, while no generation is active and the latest generation provides the contract, the call waits until a generation activates, and rejects when its signal aborts ([`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [Process isolation](process-isolation.md)). A call of a method the active provider does not have throws `unavailable`, and a call through a stub of a bundle that is no longer active throws `unavailable` ([Lifetimes](#lifetimes)). `use` itself throws `undeclared_requirement` for a contract the manifest does not list, and `many_contract_use` for a contract of cardinality `many`, whose providers are aggregated with `whenAvailable` instead ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)). A `scope` binds the stub: every call it makes carries those scope keys ([Scope keys](#scope-keys)). `use` and `whenAvailable` throw `invalid_input` for an argument that is not a ref made with `ref()` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).
- **`whenAvailable(contract, callback)`** runs the callback once for each live provider of the contract, now and whenever one activates later, with a stub pinned to that provider and its `{ bundleId, version }`. The cleanup the callback returns, directly or from a promise, runs when that provider goes away or the returned `Disposable` is disposed; an exception or a rejected promise of the callback is reported as `when_available_failed` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).

What a part can reach depends on its environment. A `host` part is served by providers in `host`, a `desktopMain` part by providers in `desktopMain`, and a `client` part by providers in `client`, `desktopMain` and `host` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A window reaches a method of a `desktopMain` or `host` provider only when that method is exposed with `expose: 'desktop'`; any other method is refused as unavailable ([`exposure.ts`](../../../packages/bundle/src/runtime/exposure.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`socket.ts`](../../../app/backend/doric-host/src/lib/bridge/socket.ts)). Exposure and the bridges are described in [Services and channels](services-and-channels.md).

### An example

The `host` part of `git` registers a credential kind and a tool from its `activate`, and serves its own service `git.commands/v1`, whose busy check lists the `terminal` bundle's sessions when one is served ([`git/src/host/part.ts`](../../../bundles/features/git/src/host/part.ts)):

```ts
activate: async (context) => {
  await context.registrations.track(SecretsService, (client) =>
    client.registerKind({ credentialKindDefinition: gitKind }),
  );
  await tools.register(
    context,
    createTool().bind(routedGitToolPorts(context.services)),
    { alwaysAvailable: false, order: 900 },
  );
},
```

Each contract it touches is a line of its manifest: `secrets/v1` and `tools/v1` under `requires`, `terminal/v1` under `optional`, and `git.commands/v1`, the service it provides, under `provides`. The tool's `execute` receives `(input, call, services)` and reaches the Project's working directory and sandbox through `runtime.workspace/v1` and `runtime.lease/v1`, bound to the scope of the call, so both are under `requires` as well ([`git/manifest.json`](../../../bundles/features/git/manifest.json), [`tools/git.ts`](../../../bundles/features/git/src/host/tools/git.ts), [`sandbox.ts`](../../../bundles/features/git/src/host/sandbox.ts)). The contracts of `git` are described in its [README](../../../bundles/features/git/README.md).

## The manifest line of every use

A part uses a contract through `services` only when its bundle's manifest has a line for it. This is the test of rule M3 of the [boundary rules](boundaries.md): an edge between two bundles exists only as a manifest line, so every edge is visible and the `cycles` check can see it. The line is:

| The part                                                          | The line                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Provides the contract                                             | Under `provides`, with the full version (`git.commands/v1@1.1.0`)                                                                           |
| Cannot activate without the contract                              | Under `requires`, with a range (`tools/v1@^1.2.0`)                                                                                          |
| Uses the contract when a provider is active, and works without it | Under `optional`, by id (`terminal/v1`)                                                                                                     |
| Uses a `doric.*` contract                                         | None: the schema refuses a `doric.*` id under `provides` and `requires` ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)) |

The basic contracts are no exception: a bundle that calls `services.use(LogV1)` lists `log/v1` like any other contract. The one bundle exempt is the bundle the composition names as its core, which may use any basic contract without listing it at run time ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

Three checks hold the rule ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`record.ts`](../../../packages/bundle/src/build/record.ts), [`boundaries.mjs`](../../../tests/support/boundaries.mjs)):

- **At run time**, `services.use` and `use` of `hooks/v1` throw `undeclared_requirement` for a contract that is not listed under `requires` or `optional`, not provided by the bundle and not a `doric.*` contract.
- **At build time**, the dry activation of each part applies the same rule to `use`, with no exemption for the core, and the build fails on an unlisted contract.
- **In the repository**, the `declared` check of `npm run lint:test` reads each bundle's sources, with comment lines blanked, and counts as a use every whole string literal of a contract id that some manifest provides and every value imported from `<other>/contracts` or `bundle/contracts` that stands for a contract id; an `import type` is not a use, and the uses `core` makes through symbols imported from `bundle/contracts` are skipped. It fails on a use the bundle neither provides nor lists, and on a line whose id no manifest provides, unless the id starts with `doric.`.

`whenAvailable` is not checked at run time or at build time; a contract reached only through it is held to the rule by the repository check. What `requires` and `optional` mean for activation — the catalog reads `requires` to order and quarantine, and does not read `optional` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)) — is described in [The bundle manifest](manifest.md); contract ids, refs and the `define*` family in [Contracts](contracts.md).

## The call

Every `execute` of a service method, a command or a tool receives `(input, call, services)`, and every hook handler receives `(input, call)` ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)). A `call` describes one hop and carries `caller` (`{ bundleId, version, generation }`), an optional `scope`, a `signal` and a W3C `trace`. The call has its home in [Contracts](contracts.md#the-call), which states its full shape and rules; the exported types are listed in the [`bundle` README](../../../packages/bundle/README.md#call). This section states what a part relies on.

A bundle never builds a `call`. On every hop the dispatcher sets `caller` to the bundle that makes the call. The optional last argument of a stub method, `CallArg`, is one of two values ([`call.ts`](../../../packages/bundle/src/contracts/call.ts), [`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)):

- **The parent `call`** the handler received. Only a call the runtime created counts as a parent: the runtime freezes each call and brands it with a non-enumerable symbol, so a copy such as `{ ...call }` is not a parent. The new hop inherits the parent's signal, its deadline, the generation it is pinned to and its scope, and takes a child of its trace.
- **`{ signal?, deadline? }`**. Only a plain object whose own keys are a non-empty subset of `signal` and `deadline`, with an `AbortSignal` and a finite number, counts as this argument. The new hop starts a new trace and is pinned to the generation of the runtime that dispatches it. Its signal is the one given or, by default, one that aborts when the caller's generation ends. A deadline, in epoch milliseconds, greater than `0` also aborts the signal when it passes, with an error named `TimeoutError`; a deadline of `0` or less, or none, sets no deadline.

Any other last value is not a call argument ([Contracts](contracts.md#the-call)). The `log/v1` the core provides marks each record with the bundle, version and generation of `call.caller` ([`core/src/shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts)).

### Scope keys

`call.scope` is a record the platform transports and does not read: at most 16 keys, each a letter followed by up to 63 letters, digits, `_`, `.` or `-`, and values of at most 512 characters ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)). The keys belong to the bundles that read them. The scope of a hop is the parent's scope, then the keys bound by `services.use(contract, scope)`, which win over the parent's, then `windowKey` ([`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)).

| Key                                 | Owner                | Who sets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windowKey`                         | The platform         | In a window, the bootstrap, on every call a provider of that window receives; the desktop dispatcher, on every call that leaves a window, sets it to the key of that window. The window's bridge removes `windowKey` from the scope before the call leaves. The desktop process parses each request with `desktopRequestSchema` and refuses one whose scope names `windowKey` in any letter case, before it routes the call: the IPC call rejects with a plain `Error`, `Invalid desktop request: …`, not with a `ContractError`. No manifest may list `windowKey`, in any letter case, under `desktopScope`. In a host or `desktopMain` process nothing removes a `windowKey` that a bundle binds with `services.use(contract, scope)`: the provider receives it as bound. Which core providers read it is in [The core bundle](core.md#the-scope-keys-the-core-reads) ([`activate.ts`](../../../packages/desktop/src/client/activate.ts), [`bridge.ts`](../../../packages/desktop/src/client/bridge.ts), [`protocol.ts`](../../../packages/desktop/src/client/protocol.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)) |
| `projectId`, `threadId`, `promptId` | The `runtime` bundle | The bundle that calls a Project-, Thread- or prompt-scoped contract binds the keys with `services.use(contract, { projectId, threadId, promptId })`, or passes on the scope of the call it serves with `services.use(contract, call.scope)`; `runtimeScope({ projectId, threadId, promptId })`, exported by `runtime/contracts`, builds that record and leaves absent keys out. A provider reads the keys from `call.scope`; the runtime's own providers read them with `readRuntimeScope(call)`. The runtime runs each prompt's executor bound to all three ([`scope.ts`](../../../bundles/runtime/runtime/src/contracts/scope.ts), [`routed.ts`](../../../bundles/runtime/runtime/src/host/routed.ts), [`runner.ts`](../../../bundles/runtime/runtime/src/host/domain/runner.ts), [`git/src/host/sandbox.ts`](../../../bundles/features/git/src/host/sandbox.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                  |

A window does not filter the scope it sends: its bridge removes only a key named exactly `windowKey` and sends every other key of the hop's scope ([`bridge.ts`](../../../packages/desktop/src/client/bridge.ts)). The desktop process accepts only the scope keys that the provider's manifest lists for the contract under `desktopScope`, and refuses a request with any other key with `invalid_input`, `Scope key "<key>" is not declared for <contract>.`, except a `windowKey` in any letter case, which is refused before, when the request is parsed (see the table) ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [The bundle manifest](manifest.md)). So a call from a window whose scope has keys outside the provider's `desktopScope` fails. Binding a scope with `services.use(contract, scope)` cannot remove such a key, because the hop's scope starts from the parent call's keys and the bound keys only overlay them ([`runtime/call.ts`](../../../packages/bundle/src/runtime/call.ts)). A window caller whose parent call carries undeclared keys passes `{ signal, deadline }` instead of the parent call, and binds only the declared keys. The Project-, Thread- and prompt-scoped contracts of the runtime are described in its [README](../../../bundles/runtime/runtime/README.md).

A `client` part registers `onCloseHook` and `onFlushHook` of `doric.window.hooks/v1` from its `activate`: the call carries the window's `windowKey`, and the hooks are defined by the bootstrap of each window in that window's `hooks/v1` ([`packages/desktop/src/client/activate.ts`](../../../packages/desktop/src/client/activate.ts), [Hooks](hooks.md)).

## Lifetimes

Every registration a part makes through `services` — a provided service, a hook handler, a tool, a command, an event type, a UI element — is tracked in a disposal scope and disposed in reverse order ([`scope.ts`](../../../packages/bundle/src/runtime/scope.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). A `Disposable` that a stub call returns is tracked in the caller's current scope, the scope of the activation, the `whenAvailable` callback or the element that makes the call ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). Anything tracked in a scope that is already disposed is disposed at once. Disposal never throws: a disposable that fails is reported against the bundle as `dispose_failed`, and the rest are still disposed ([`scope.ts`](../../../packages/bundle/src/runtime/scope.ts), [`principal.ts`](../../../packages/bundle/src/runtime/principal.ts)). Three scopes exist:

| Scope      | Holds                                                                         | Ends                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation | What `activate` registers, and what is registered later outside the two below | When the bundle deactivates or its activation fails ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts))                       |
| Provider   | What a `whenAvailable` callback registers for one provider                    | When that provider goes away, or the `whenAvailable` registration is disposed ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)) |
| Element    | What a custom element registers through the `services` property it receives   | When the element is released ([`elements.ts`](../../../packages/desktop/src/client/elements.ts))                                                  |

An element created through `ui/v1` receives a `services` property when the provider of `ui/v1` attaches it with `doric.elements/v1`; every `provide`, stub call and `whenAvailable` made through it runs in a child of the owning bundle's activation scope, and ends when the provider releases the element. Only the active provider of `ui/v1` may call `doric.elements/v1`; any other caller gets `not_owner` ([`elements.ts`](../../../packages/desktop/src/client/elements.ts), [`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)).

When a bundle deactivates, the platform fires `onDeactivateHook` for it, disposes the activation scope, runs the cleanup that `activate` returned and closes the bundle's principal. `onDeactivateHook` fires only for a bundle that activated after the platform defined `doric.app.hooks/v1`, the bundles that `onActivateHook` observed; a failure of one of its handlers is reported as `hook_execute_failed`. A cleanup that throws is reported as `cleanup_failed`, and deactivation goes on. Once the principal is closed, every call through a stub the bundle kept throws `unavailable`, `Bundle "<id>" is no longer active.`. When the environment stops, its bundles deactivate one at a time in reverse activation order ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`principal.ts`](../../../packages/bundle/src/runtime/principal.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

An activation attempt fails when loading the part, `activate`, or a step the environment runs after `activate` to settle the bundle's registrations throws. On any such failure the registrations the attempt made are disposed, the cleanup runs when `activate` returned one, the principal is closed and the bundle is quarantined with one of these codes ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)):

| Code                   | When                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_part`         | The part cannot be loaded                                                                                                                                                                                                                                                                                                                                                                                                    |
| `activate_failed`      | `activate`, or the settle step that runs right after it, throws any error that is not a registration refusal: one of the bundle's own code, or a platform refusal such as `undeclared_requirement`, `many_contract_use` or `invalid_input` from `services.use`, `invalid_input` from `provide`, or `unavailable` from a stub call                                                                                            |
| `registration_failed`  | A registration the bundle made through `services` is refused, inside `activate` or when it settles: a `provide` refusal other than `invalid_input`, or a stub call refused with `duplicate_tool`, `duplicate_skill`, `registration_conflict`, `not_owner`, `unavailable_tool`, `provider_conflict`, `undeclared_provide` or `contract_mismatch`; such a refusal that escapes `activate` has this code, not `activate_failed` |
| `cardinality_mismatch` | The refused registration is a `provide` whose cardinality differs from the one the catalog publishes                                                                                                                                                                                                                                                                                                                         |

When the quarantined bundle is the core or a foundation provider the composition chose, the environment enters [recovery mode](core.md#recovery-mode). The full table of quarantine codes is in [Core](core.md#quarantine). Each operation's cancellation reaches its handler as `call.signal`.

## The basic contracts

The platform declares each basic contract — its id, cardinality, environments and method specification — and exports its ref from `bundle/contracts`; the `core` bundle provides each one in the table below ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts), [`core/manifest.json`](../../../bundles/foundation/core/manifest.json)):

| Contract (ref)                                                                 | Environments              | What it serves                                                                                              | Described in                                                             |
| ------------------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `hooks/v1` (`HooksV1`)                                                         | host, desktopMain, client | Declaring, firing and observing hooks                                                                       | [Hooks](hooks.md)                                                        |
| `log/v1` (`LogV1`)                                                             | host, desktopMain, client | `debug`, `info`, `warn`, `error`, marked from `call.caller` and written to `doric.log/v1`                   | [Observability](observability.md)                                        |
| `tools/v1` (`ToolsV1`), `skills/v1` (`SkillsV1`)                               | host                      | Registering tools and skills, and listing them                                                              | [Core README](../../../bundles/foundation/core/README.md)                |
| `settings/v1` (`SettingsV1`)                                                   | host, desktopMain         | `register`, `get`, `entry`, `set` and `subscribe` of typed settings                                         | [Core README](../../../bundles/foundation/core/README.md)                |
| `secrets/v1` (`SecretsV1`)                                                     | host                      | Credentials and their kinds, over `secrets.backend/v1`                                                      | [Core README](../../../bundles/foundation/core/README.md)                |
| `storage/v1` (`StorageV1`)                                                     | host                      | Typed documents, streams and blobs, over `storage.backend/v1`                                               | [Storage](storage.md)                                                    |
| `events/v1` (`EventsV1`)                                                       | host                      | `register` of event types and `append` of durable events                                                    | [Events and nodes](events-and-nodes.md)                                  |
| `models/v1` (`ModelsV1`)                                                       | host                      | Resolving models, aggregating every `models.provider/v1`                                                    | [Core README](../../../bundles/foundation/core/README.md)                |
| `commands/v1` (`CommandsV1`)                                                   | desktopMain, client       | `register` and `execute` of commands                                                                        | [Menus and keybindings](menus-and-keybindings.md#dispatching-a-command)  |
| `ui/v1` (`UiV1`), `navigation/v1` (`NavigationV1`), `regions/v1` (`RegionsV1`) | client                    | Elements by tag, routes by path, named regions                                                              | [UI composition](ui-composition.md), [Navigation](navigation.md)         |
| `windows/v1` (`WindowsV1`), `menus/v1` (`MenusV1`)                             | desktopMain               | Opening windows, and menu items, keybindings and `setContext`, over `doric.windows/v1` and `doric.menus/v1` | [Windows](windows.md), [Menus and keybindings](menus-and-keybindings.md) |

Every basic contract has cardinality `one` except `models.provider/v1` (`ModelsProviderV1`), which has cardinality `many`: `openai`, `openrouter`, `codex` and `claude` each provide one record of it ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). Two more basic contracts are the backends of the core's facades, `storage.backend/v1` (`StorageBackendV1`) and `secrets.backend/v1` (`SecretsBackendV1`), provided by `postgres` ([`postgres/manifest.json`](../../../bundles/foundation/postgres/manifest.json)).

In each environment the core provides only the contracts of that environment: in `host` `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`, `settings/v1`, `secrets/v1`, `storage/v1`, `events/v1` and `models/v1`; in `desktopMain` `hooks/v1`, `log/v1`, `settings/v1`, `windows/v1`, `menus/v1` and `commands/v1`; in `client` `hooks/v1`, `log/v1`, `ui/v1`, `navigation/v1`, `regions/v1` and `commands/v1`, with the elements `<core-outlet>`, `<core-region>`, `<core-not-found>` and `<core-unavailable>` ([`core/src/host/index.ts`](../../../bundles/foundation/core/src/host/index.ts), [`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`core/src/client/index.ts`](../../../bundles/foundation/core/src/client/index.ts)). The core also provides contracts of its own, `core.*`, described in its [README](../../../bundles/foundation/core/README.md).

## Platform contracts

A `doric.*` contract is provided by the platform in the environments it names and always exists there, except `doric.about/v1` and `doric.appearance/v1`, which the platform provides from platform version 1.2.0 and 1.3.0: a bundle on an older app finds no provider, and detects them with `services.whenAvailable`. No bundle can provide one: `defineService` refuses an id with the `doric.` prefix, so only the platform defines these contracts. A part uses them without a manifest line ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). The ref and the interface that `bundle/contracts` exports for each contract are listed in the [package README](../../../packages/bundle/README.md#platform-contracts). Each contract's full shape has one home:

| Contract                                                                                                | Environments                                       | Shape in                                                        |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `doric.catalog/v1`                                                                                      | host, desktopMain, client                          | [Composition and distribution](composition-and-distribution.md) |
| `doric.diagnostics/v1`                                                                                  | host, desktopMain, client                          | [Observability](observability.md)                               |
| `doric.startup/v1`                                                                                      | host                                               | [Observability](observability.md)                               |
| `doric.windows/v1`                                                                                      | desktopMain                                        | [Windows](windows.md)                                           |
| `doric.menus/v1`                                                                                        | desktopMain                                        | [Menus and keybindings](menus-and-keybindings.md)               |
| `doric.app.hooks/v1`, `doric.window.hooks/v1`                                                           | Hooks contracts the platform defines in `hooks/v1` | [Hooks](hooks.md)                                               |
| `doric.bundle/v1`, `doric.log/v1`                                                                       | host, desktopMain, client                          | [Below](#shapes-of-the-platform-contracts)                      |
| `doric.network/v1`, `doric.generation/v1`                                                               | host                                               | [Below](#shapes-of-the-platform-contracts)                      |
| `doric.cache/v1`, `doric.migrations/v1`, `doric.notifications/v1`                                       | desktopMain                                        | [Below](#shapes-of-the-platform-contracts)                      |
| `doric.tokens/v1`                                                                                       | desktopMain, client                                | [Below](#shapes-of-the-platform-contracts)                      |
| `doric.about/v1`, `doric.elements/v1`, `doric.connection/v1`, `doric.browser/v1`, `doric.appearance/v1` | client                                             | [Below](#shapes-of-the-platform-contracts)                      |

### Shapes of the platform contracts

The shapes below are those of [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts) and [`network.ts`](../../../packages/bundle/src/contracts/network.ts). Every method except `register` of `doric.network/v1` takes a last optional `call?: CallArg`, the parent call or `{ signal?, deadline? }`; `Caller` is the type of `call.caller`, `Disposable` the one of [The context](#the-context), and `ElementConstructor` is `abstract new (...args: never[]) => object` ([`ui.ts`](../../../packages/bundle/src/contracts/basic/ui.ts)).

```ts
type Environment = 'host' | 'desktopMain' | 'client';

// doric.bundle/v1 (host, desktopMain, client)
interface DoricBundle {
  /** Identity of the calling bundle in this generation and environment. */
  describe(call?: CallArg): {
    bundleId: string;
    version: string;
    generation: number; // integer
    environment: Environment;
  };
}

// doric.log/v1 (host, desktopMain, client): the sink through which a log/v1 provider reaches the platform's log files
interface DoricLog {
  write(record: LogRecord, call?: CallArg): void;
}
interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
  readonly environment: Environment;
  readonly scope?: CallScope;
  readonly traceId?: string;
}

// doric.network/v1 (host): installs handlers on the host's shared listeners during activation
interface DoricNetwork {
  register(listener: NetworkListener): Disposable;
}
type NetworkListener = (
  resources: NetworkResources,
) => (() => void) | undefined;
interface NetworkResources {
  readonly http: object; // the shared request router
  readonly server: object; // the shared http.Server; a bundle attaches `upgrade` here
  readonly sockets: object; // the Socket.IO server over the same listener
}

// doric.generation/v1 (host): the bundle generation of the caller's operation
interface DoricGeneration {
  describe(call?: CallArg): Promise<GenerationDescription>;
  hold(work: WorkHold, call?: CallArg): Disposable;
  signal(signal: PeerSignal, call?: CallArg): Promise<void>;
}
interface GenerationDescription {
  readonly generation: number; // integer
  readonly incarnation: number; // integer
  readonly state: 'starting' | 'active' | 'draining' | 'stopped' | 'failed';
}
interface WorkHold {
  readonly key: string; // 1–256 characters
  readonly label?: string; // at most 256 characters
}
interface PeerSignal {
  readonly topic: string; // 1–128 characters
  readonly payload?: unknown;
}

// doric.cache/v1 (desktopMain)
interface DoricCache {
  /** Absolute cache directory of the calling bundle. */
  directory(call?: CallArg): Promise<string>;
}

// doric.migrations/v1 (desktopMain)
interface DoricMigrations {
  storage(
    request: {
      readonly key: string; // ^[A-Za-z][A-Za-z0-9_.:-]{0,127}$
      readonly marker: string; // ^[A-Za-z][A-Za-z0-9_.-]{0,63}$
    }, // strict: no other key
    call?: CallArg,
  ): Promise<'migrated' | 'none' | 'skipped' | 'failed'>;
}

// doric.notifications/v1 (desktopMain)
interface DoricNotifications {
  show(
    request: { readonly title: string; readonly body: string }, // strict
    call?: CallArg,
  ): Promise<void>;
}

// doric.tokens/v1 (desktopMain, client)
interface DoricTokens {
  get(call?: CallArg): Promise<Readonly<Record<string, string>>>;
}

// doric.about/v1 (client)
interface DoricAbout {
  get(call?: CallArg): Promise<{ readonly version: string }>;
}

// doric.elements/v1 (client): only the window's active ui/v1 provider may call it
interface DoricElements {
  define(
    input: {
      readonly tag: string;
      readonly element: ElementConstructor;
      readonly owner: Caller;
    },
    call?: CallArg,
  ): Disposable;
  owner(tag: string, call?: CallArg): Caller | undefined;
  attach(element: object, call?: CallArg): void;
  release(element: object, call?: CallArg): void;
}

// doric.connection/v1 (client)
interface DoricConnection {
  status(call?: CallArg): 'connected' | 'disconnected';
  subscribe(
    listener: (status: 'connected' | 'disconnected') => void,
    call?: CallArg,
  ): Disposable;
}

// doric.browser/v1 (client)
interface DoricBrowser {
  open(url: string, call?: CallArg): Promise<void>; // absolute https: URL, at most 8192 characters
}

// doric.appearance/v1 (client)
interface DoricAppearance {
  get(call?: CallArg): Promise<{ readonly theme: 'dark' | 'light' | 'system' }>;
  set(
    input: { readonly theme: 'dark' | 'light' | 'system' },
    call?: CallArg,
  ): Promise<void>;
}
```

The desktop app implements the `desktopMain` contracts `doric.cache/v1`, `doric.migrations/v1`, `doric.notifications/v1` and `doric.tokens/v1`, and the desktop side of `doric.browser/v1` and `doric.appearance/v1`; its [README](../../../app/desktop/doric/README.md#platform-contracts-main-provides-to-a-generation) describes the files and state they use. The window runtime of the `desktop` package implements the `client` contracts `doric.tokens/v1`, `doric.about/v1`, `doric.elements/v1`, `doric.connection/v1`, `doric.browser/v1` and `doric.appearance/v1`; its [README](../../../packages/desktop/README.md#the-windows-platform-providers) describes how a window registers them.

What each one does:

- **`doric.bundle/v1`** answers with the calling bundle's identity, taken from `call.caller`, and the environment of the process ([`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)).
- **`doric.log/v1`** is the sink the provider of `log/v1` writes its records to ([`core/src/shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts)). In the host and the desktop process the record reaches the platform log with its identity: bundle, version, generation, environment, scope and trace ID; the desktop process writes a `debug` record at `info` ([`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)). In a window, `write` sends the record fire-and-forget to the desktop process, which reads only its `level` (`info`, `warn` or `error`), `message` and `fields` and writes them to its log with the window's key: the line carries no `bundleId`, `version`, `generation`, `environment`, `scope` or `traceId`, and a `debug` record is refused without the window hearing of it ([`packages/desktop/src/client/platform.ts`](../../../packages/desktop/src/client/platform.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [Observability](observability.md#where-records-go)).
- **`doric.network/v1`** lets a host part register handlers on the host's shared listeners. A bundle never calls `listen`: the platform owns the address, the bind and the close, and runs the cleanup the listener returns when the bundle deactivates ([`network.ts`](../../../packages/bundle/src/contracts/network.ts)). The resources it passes and the refusal from a generation process are described in [Services and channels](services-and-channels.md#native-handles-doricnetworkv1).
- **`doric.generation/v1`** describes the generation of the caller's operation. A work hold keeps that generation alive, draining, until it is disposed; its owner is the calling bundle. A peer signal reaches the same bundle in the other live generations through `onPeerSignalHook` of `doric.app.hooks/v1` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [Process isolation](process-isolation.md)).
- **`doric.cache/v1`** answers with the absolute cache directory of the calling bundle, one per bundle id: `<userData>/bundle-cache/<bundleId>`, under the desktop app's user-data directory, except for `papercraft`, which gets `<userData>/papercraft` so that the protocol serves it under `/papercraft-modules/`. The directory is created when missing, and a caller id outside `^[a-z][a-z0-9-]*$` gets `invalid_input` ([`cache.ts`](../../../app/desktop/doric/src/platform/native/cache.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)).
- **`doric.migrations/v1`** copies one `localStorage` key from the packaged app's `file://` origin to the `doric://app` origin of the windows, once per `marker`, and only when `doric://app` has no value for the key; the origins and pages belong to the platform. The marker is recorded in the `migrations` record of the desktop state, `state.json`. It answers `skipped` when the marker is already recorded, or, recording the marker, when the app is not packaged; `none` when the `file://` origin holds no string value for the key; `migrated` once the copy step has run, also when `doric://app` already held a value and nothing was written; and `failed` after an error, which is logged. A request outside the schema of the shape above rejects with `invalid_input` before the copy runs, and no marker is recorded; a valid request never rejects, and it records the marker unless recording it fails. The hidden windows and pages of the copy are described in the [desktop app README](../../../app/desktop/doric/README.md#the-storage-copy) ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`state.ts`](../../../app/desktop/doric/src/platform/state.ts), [`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts), [`storage-origin.ts`](../../../app/desktop/doric/src/platform/migration/storage-origin.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)).
- **`doric.notifications/v1`** shows one native notification. The title and the body are each trimmed, then cut to their first 200 code points; a longer line is truncated, not refused. A title that is empty after trimming, or a platform without native notifications, does nothing, and a refusal of the operating system is only logged ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`notifications.ts`](../../../app/desktop/doric/src/platform/native/notifications.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts), [desktop app README](../../../app/desktop/doric/README.md#notifications)).
- **`doric.tokens/v1`** answers with the app's CSS variables, a record of variable name to value: the shared design tokens, those of the default (light) variant, then `--doric-titlebar-height` (the title bar height in `px`), `--doric-window-background` (`var(--background)`), and `--doric-safe-top`, `--doric-safe-left` and `--doric-safe-right` (`0px`). The desktop process reads the tokens from `desktop@<v>/tokens.json` of its platform assets. In a window, the answer is the `tokens` record of the window's description, which the desktop process fills with the same variables when it describes the window ([`tokens.ts`](../../../app/desktop/doric/src/platform/tokens.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`packages/desktop/src/client/platform.ts`](../../../packages/desktop/src/client/platform.ts), [`activate.ts`](../../../packages/desktop/src/client/activate.ts)).
- **`doric.about/v1`** answers with the app's version, the same for every call in a window ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).
- **`doric.elements/v1`** defines custom element tags with their owner and gives each element its `services` ([Lifetimes](#lifetimes)). Every method throws `not_owner` for a caller other than the active provider of `ui/v1`. `define` throws `registration_conflict` when the tag is already defined, through this contract or otherwise, and `unavailable` in a window without a custom element registry; disposing its `Disposable` cannot undefine the tag, which stays taken and has no owner from then on. `owner` answers `undefined` when the tag has no owner, or when its owning bundle is quarantined or no longer active. `attach` throws `unavailable` when the element's tag has no active owner. `attach` of an element already attached and `release` of an element not attached do nothing ([`elements.ts`](../../../packages/desktop/src/client/elements.ts)).
- **`doric.connection/v1`** answers with the status of the host connection, `disconnected` until the desktop process reports the first one; a listener is called on every change and not with the current value ([`connection.ts`](../../../packages/desktop/src/client/connection.ts)).
- **`doric.browser/v1`** opens an `https:` URL in the system browser, the one way out of a window. A value that is not an absolute `https:` URL of at most 8192 characters is refused with `invalid_input` in the window, and the desktop process checks the URL again before it opens it ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`browser.ts`](../../../packages/desktop/src/client/browser.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).
- **`doric.appearance/v1`** reads and saves the theme preference of every window, `dark` when none is saved or it is unreadable. The desktop process keeps it in `userData/doric/appearance.json` as `{ "theme": … }`, reads the file once when the app prepares, holds the value in memory, and writes the file atomically on each `set` ([`appearance-store.ts`](../../../app/desktop/doric/src/platform/appearance-store.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [desktop app README](../../../app/desktop/doric/README.md#theme)). `set` saves and then repaints every window; it rejects `invalid_input` for a value outside the three themes and `unavailable` when the preference cannot be written, and the saved preference is then unchanged ([`appearance.ts`](../../../app/desktop/doric/src/platform/appearance.ts), [`appearance-store.ts`](../../../app/desktop/doric/src/platform/appearance-store.ts), [`packages/desktop/src/client/appearance.ts`](../../../packages/desktop/src/client/appearance.ts)).

## The platform as a consumer

In each environment, once the provider of `hooks/v1` has activated, the platform obtains it, defines `doric.app.hooks/v1` in it and fires its hooks at the points of the lifecycle; `onActivateHook` is fired after each later bundle activates, and a failure of one of its handlers is only reported ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). In a window, the bootstrap defines `doric.window.hooks/v1` in the same way ([`packages/desktop/src/client/activate.ts`](../../../packages/desktop/src/client/activate.ts)). In a bundle process, where the provider of `hooks/v1` runs in another process, the platform defines `doric.app.hooks/v1` before the first bundle activates, so every bundle is observed ([`manager.ts`](../../../packages/bundle/src/process/manager.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [Process isolation](process-isolation.md)). The platform is one more consumer of `hooks/v1`: when another bundle provides it, the platform uses that one.

## Activation order and the foundation

In each environment the activation loop runs three groups in order ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)):

1. **The foundation:** each bundle the composition chooses in `providers` for a contract that the core provides or requires in that environment. Providers of `storage.backend/v1` and `secrets.backend/v1` activate first. A foundation bundle may list nothing under `requires`, with one exception: a foundation bundle that replaces `events/v1`, `settings/v1` or `models/v1` may require the two backends. Any other line quarantines it with `foundation_requires`.
2. **The core:** its `requires` may name only contracts an active foundation bundle provides; the shipped core requires `storage.backend/v1` and `secrets.backend/v1`. When a contract the core requires has no active foundation provider in the environment, or the active one's version is outside the range, the environment enters [recovery mode](core.md#recovery-mode); a required contract that no enabled bundle provides in this environment, but one provides in another, is passed over here.
3. **The other bundles**, in dependency order.

A contract without the `doric.` prefix may be provided by any bundle. For a contract of cardinality `one`, one provider is active per environment: the bundle chosen in `providers`; without a choice, the core when it provides the contract, or else the provider whose id sorts first. Any other provider except the core is quarantined with `unchosen_provider`; a chosen provider that is quarantined leaves the contract without a provider, with no fallback to another. When the core's contract is replaced, its `provide` registers nothing, so the core's own `services.use` reaches the chosen provider. A contract of cardinality `many` has every live provider active at once ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). The choice is a field of the composition, for example:

```json
{
  "providers": {
    "hooks/v1": "myhooks",
    "storage.backend/v1": "postgres",
    "secrets.backend/v1": "postgres"
  }
}
```

The composition and its other fields are described in [Composition and distribution](composition-and-distribution.md) ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)); the core, its quarantine and recovery mode in [Core](core.md).

## Related documents

- [Bundle architecture](../bundles.md): the overview of bundles.
- [Boundaries](boundaries.md): the rules M1–M11, among them M3, and their checks.
- [The bundle manifest](manifest.md): `provides`, `requires`, `optional` and `desktopScope`.
- [Contracts](contracts.md): contract ids, refs, the `define*` family, the call and the import rules.
- [Hooks](hooks.md): `hooks/v1`, `doric.app.hooks/v1` and `doric.window.hooks/v1`.
- [Services and channels](services-and-channels.md): stubs, exposure and the bridges.
- [Process isolation](process-isolation.md): generations and how calls cross processes.
- [Core](core.md): what the core provides, the foundation and quarantine.
- [Desktop app README](../../../app/desktop/doric/README.md) and [`desktop` package README](../../../packages/desktop/README.md): the units that implement the desktop and window `doric.*` contracts.
- [Composition and distribution](composition-and-distribution.md): `providers` and the rest of the composition.
- [Storage](storage.md), [Events and nodes](events-and-nodes.md), [Windows](windows.md), [Menus and keybindings](menus-and-keybindings.md), [UI composition](ui-composition.md), [Navigation](navigation.md), [Observability](observability.md): the basic contracts in detail.
