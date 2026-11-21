# Contracts and the `define*` family

- Status: living document. It describes contracts, their ids, the import rules, the contract descriptor and structural copies as implemented on 2026-11-20.

## Summary

A contract is the public, versioned part of a bundle that another bundle may use without importing its code: a hooks contract, a service, an event, a command, a settings definition or a storage type. A contract is written in zod with one of the `define*` functions, `defineHook`, `defineHooks`, `defineService`, `defineMethod`, `defineEvent`, `defineCommand`, `defineSettings` and `defineStorageType`, and is named by a contract id that carries its major version, such as `git.commands/v1` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). One zod definition gives the TypeScript type, the validation at run time and, generated at build time, the JSON Schema 2020-12 document that describes the contract where a call crosses processes ([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts), [`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`remote.ts`](../../../packages/bundle/src/runtime/envelope/remote.ts)). No bundle writes JSON Schema by hand.

The rule is: **a bundle reaches another bundle only through a contract that bundle publishes, and the only module of another bundle it imports is `<id>/contracts`.** At run time a contract is resolved by its id, never by a module: a consumer holds a `ref`, which carries only the id, and the runtime dispatches each call to the provider the catalog chose ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). The functions, the `ref` helper, the `Call` and `ContractError` types and the contracts of the platform and the basic services come from the browser-safe entry point `bundle/contracts` of `packages/bundle` ([`index.ts`](../../../packages/bundle/src/contracts/index.ts)).

## Contract ids

A contract id is lowercase segments separated by `.`, then `/v` and a positive major: it matches `contractIdPattern`, `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\/v[1-9][0-9]*$` ([`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). The id carries only the major; the full version of a contract is the one its provider lists under `provides` in its manifest, such as `git.commands/v1@1.1.0`, and a consumer lists a range under `requires` or `optional` ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). How a contract takes a minor or a major is in [Versioning](versioning.md).

| Category                       | Form of the id                                                        | Examples                                                                                                                                                                                                                                                                                                                                                                                                                         | Who provides it                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform                       | `doric.<name>/vN`                                                     | `doric.catalog/v1`, `doric.diagnostics/v1`, `doric.bundle/v1`, `doric.log/v1`, `doric.windows/v1`, `doric.menus/v1`, `doric.cache/v1`, `doric.migrations/v1`, `doric.tokens/v1`, `doric.about/v1`, `doric.notifications/v1`, `doric.generation/v1`, `doric.startup/v1`, `doric.elements/v1`, `doric.connection/v1`, `doric.browser/v1`, `doric.appearance/v1`, `doric.network/v1`, `doric.app.hooks/v1`, `doric.window.hooks/v1` | The platform only                                                                                                                                                                                           |
| Basic services                 | The domain alone: `<domain>/vN`                                       | `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`, `settings/v1`, `secrets/v1`, `secrets.backend/v1`, `storage/v1`, `storage.backend/v1`, `events/v1`, `models/v1`, `models.provider/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1`                                                                                                                                                            | The core by default, except `storage.backend/v1` and `secrets.backend/v1`, which `postgres` provides, and `models.provider/v1`, which provider bundles such as `openai` provide; any bundle may replace one |
| Declared for others to provide | The declaring bundle's form, or the domain alone                      | `executor/v1` and `sandbox/v1`, declared by `runtime`; `default.skill-sources/v1`, declared by `default`; `files.decorations/v1`, declared by `files`                                                                                                                                                                                                                                                                            | Other bundles: `default` provides `executor/v1`, `docker` and `firecracker` provide `sandbox/v1`, `mcp` provides `default.skill-sources/v1`, `git` provides `files.decorations/v1`                          |
| A bundle's own                 | `<bundle>.<name>/vN`, or `<bundle>/vN` for the bundle's main contract | `git.commands/v1`, `chat.hooks/v2`, `runtime.records/v1`, `layout.tabs/v2`, `files/v1`, `runtime/v2`                                                                                                                                                                                                                                                                                                                             | The bundle whose id prefixes the contract id                                                                                                                                                                |

- **`doric.` is reserved.** `defineHooks`, `defineService`, `defineEvent`, `defineCommand`, `defineSettings` and `defineStorageType` throw on an id that starts with `doric.`; the platform declares its own contracts with internal variants, `definePlatformHooks` and `definePlatformService`, which `bundle/contracts` does not export ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`index.ts`](../../../packages/bundle/src/contracts/index.ts)). A bundle id may not be `doric`, the name of the platform's principal ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). A `doric.*` contract always exists, is listed in no manifest, accepts no other provider, and `use` of it is always allowed ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).
- **The prefix names the owner.** The catalog takes the first segment of an id as the bundle that owns the contract, and reads the contract's cardinality from that bundle's descriptor before any other provider's ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). The basic services carry no bundle name, because the core is only their default provider; their cardinality and environments come from a fixed table in the platform ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)).
- **Declared contracts.** A bundle may declare a contract for other bundles to provide: it writes the interface and the method schemas in its `contracts` entry point and lists the id under `requires` or `optional`, and each provider lists it under `provides` and depends on the declarer's package. The four ids of the third row are the ones the boundary checks treat this way ([`boundaries.mjs`](../../../tests/support/boundaries.mjs), [Boundaries](boundaries.md)).
- **Other names follow the same form.** Events, commands, settings and storage types are contracts with ids of their own, such as `comments.resolved/v1` or `runtime.thread/v1`. A custom element's tag starts with the id of the bundle that defines it, such as `chat-view`: `ui/v1` refuses a tag that does not start with `<calling bundle>-` ([`ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)).

## The `define*` family

Every `define*` function checks what the third column names when it runs, and returns a frozen object branded with its kind, which the runtime and the build recognize ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)). The full signature of each function, its options and its error messages are in [The `define*` functions](../../../packages/bundle/README.md#the-define-functions) of the package README.

| Function            | What it declares                                                                            | What it checks when it runs                                                                                        | Where it goes                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `defineHook`        | One hook: `kind`, the zod `input`, and `order` or `forOwner`                                | `kind` is `observe`, `transform`, `decide` or `sequence`; `order` only on `sequence`; `forOwner` only on `observe` | A member of `defineHooks`                                                                           |
| `defineHooks`       | A hooks contract: an id and its hooks, each named by its key                                | The id matches the pattern and is not `doric.*`; every member comes from `defineHook`                              | `services.use(HooksV1).define(contract)` by the owner                                               |
| `defineMethod`      | One method: `input`, `output`, `execute(input, call, services)` and an optional `expose`    | `execute` is a function; `expose` is `desktop` or absent                                                           | A member of `defineService`                                                                         |
| `defineService`     | A service: an id or a `ref`, its methods, and `{ cardinality: 'many' }` as the only option  | The id matches the pattern and is not `doric.*`; every member comes from `defineMethod`; the option is that one    | `services.provide(definition)`                                                                      |
| `defineEvent`       | A durable event: `type` and the zod object `payload`                                        | `type` matches the pattern and is not `doric.*`                                                                    | `services.use(EventsV1).register(definition)`, in a `host` part                                     |
| `defineCommand`     | A command: `id`, `input` and `execute(input, call, services)`                               | `id` matches the pattern and is not `doric.*`                                                                      | `services.use(CommandsV1).register(definition)`, in a `desktopMain` or `client` part                |
| `defineSettings`    | A bundle's settings: `id` and the zod `schema` of the value                                 | `id` matches the pattern and is not `doric.*`                                                                      | `services.use(SettingsV1).register(definition)`, in a `host` or `desktopMain` part                  |
| `defineStorageType` | A storage type: `type`, the zod object `schema` and `indexes` (`name`, `fields`, `unique?`) | `type` matches the pattern and is not `doric.*`                                                                    | `services.use(StorageV1).defineType(definition)`, in a `host` part                                  |
| `ref`               | A typed reference to a contract; its value holds only the id                                | The id matches the pattern; `doric.*` is accepted                                                                  | `services.use`, `services.whenAvailable`, `defineService(ref, …)` and `commands/v1.execute(ref, …)` |

The environments in the last column are those in which the platform publishes `commands/v1`, `settings/v1`, `events/v1` and `storage/v1` ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)).

### Hooks

`defineHook` takes no `output`: the kind fixes what a handler returns, nothing for `observe` and `sequence`, a value of the input schema for `transform`, and `{ allow: true }` or `{ allow: false, reason }` for `decide`. The owner fires a hook with `execute(input, call?)` on the handle `services.use(HooksV1).define(Contract)` returns, and an observer registers a handler with `use` or `whenAvailable` on the same contract ([`basic/hooks.ts`](../../../packages/bundle/src/contracts/basic/hooks.ts), [`facades.ts`](../../../packages/bundle/src/runtime/facades.ts)). How the provider of `hooks/v1` runs the handlers, their deadlines and the failure rule, and the hooks that ship, are in [Hooks and the app's lifecycle](hooks.md).

### Services and methods

A service carries its logic in its definition, as a tool does: each method has its `execute(input, call, services)`, where `services` are the services of the bundle that provided it, bound when it calls `services.provide(definition)` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`context.ts`](../../../packages/bundle/src/contracts/context.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). A method's `input` may be any zod type, not only an object.

```ts
// git, src/host/service.ts
export const createGitService = (terminals: TerminalList) =>
  defineService(GitCommandsV1, {
    status: defineMethod({
      expose: 'desktop',
      ...gitMethods.status,
      execute: (threadId: string, call: Call, services) =>
        workspace(services, call).withThread(/* … */),
    }),
    // …
  });
```

Passing the `ref` in place of the id makes the compiler check the methods against the interface the ref carries ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`types.ts`](../../../packages/bundle/src/contracts/types.ts)). In this example `gitMethods.status` holds the method's `input` and `output` schemas, which `git` exports from its `contracts` entry point together with the interface and the ref ([`git/src/contracts/index.ts`](../../../bundles/features/git/src/contracts/index.ts), [`git/src/host/service.ts`](../../../bundles/features/git/src/host/service.ts)).

When a consumer calls a method, the runtime validates the input with the provider's `input` schema and hands the parsed value to `execute`, or rejects with `invalid_input`; it validates the result with the `output` schema, rejects with `invalid_output` when it fails, and returns the original value, never the parsed copy. An `output` schema is therefore descriptive: no default, transform or pipe ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts), [`define.ts`](../../../packages/bundle/src/contracts/define.ts)). Every error that crosses a contract is a `ContractError`, with a stable `code`, a `message` and optional `details`; it is recognized by its name and code, not by `instanceof`, and any other thrown value becomes code `internal` ([`error.ts`](../../../packages/bundle/src/contracts/error.ts)).

`provide` is refused with `undeclared_provide` when the manifest does not list the id under `provides`, and with `cardinality_mismatch` when the definition's cardinality differs from the one the catalog publishes. A provider of a basic contract must implement every method of the platform's table, may omit only the methods the table marks optional, may implement no method the table lacks, and must use the platform's schemas; otherwise it is refused with `contract_mismatch` ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).

- **Cardinality.** `one`, the default, is one active provider per environment, chosen by the composition under `providers` when two bundles provide the same contract; `many` is several providers at once. `use` of a `many` contract throws `many_contract_use`; a consumer aggregates its providers with `whenAvailable`, which runs once per provider ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)). Every provider of a `many` contract declares `{ cardinality: 'many' }` in its definition; the catalog quarantines a provider whose descriptor disagrees with the contract's published cardinality ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). How a composition chooses a provider is in [Composition and distribution](composition-and-distribution.md).
- **Exposure.** A method is reachable from a desktop window only when its definition says `expose: 'desktop'`. For a basic or platform contract the platform's table decides, and a provider that declares an exposure the table does not give is refused with `contract_mismatch` ([`expose.ts`](../../../packages/bundle/src/contracts/expose.ts), [`exposure.ts`](../../../packages/bundle/src/runtime/exposure.ts)).
- **Process-local values.** A schema that uses a zod type JSON cannot carry (a function, `z.custom`, a symbol, a bigint, a date, a map, a set, a promise or NaN) is local. A local value marked with a codec, `callback`, `disposable` or `object`, crosses a process boundary as a handle; a value with none is refused with `local_only` where a call would cross ([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts), [`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)). How calls cross processes is in [Services and channels](services-and-channels.md).

### Events, commands, settings and storage types

These definitions carry no logic except the command's `execute`, so a bundle exports them from its `contracts` entry point as they are.

```ts
// comments, src/contracts/index.ts
export const commentsResolvedEvent = defineEvent({
  type: 'comments.resolved/v1',
  payload: z.looseObject({
    commentId: z.string(),
    resolved: z.boolean(),
  }),
});

// comments, src/host/index.ts, in activate
const events = services.use(EventsV1);
events.register(commentsResolvedEvent);

// comments, src/host/comments.ts, in an operation
await services
  .use(EventsV1)
  .append(
    commentsResolvedEvent,
    { commentId: current.commentId, resolved: input.resolved },
    call,
  );
```

- **Events.** `events/v1` has `register(definition)`, `append(definition, payload, call?)` and `sink(spec)` ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)). The role of durable events is in [Events and nodes](events-and-nodes.md).
- **Commands.** `register` binds the registering bundle's services to the command, so its `execute` receives `(input, call, services)`. Another bundle dispatches it with `services.use(CommandsV1).execute(command, input?, call?)`, where `command` is a ref or the id ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`registrable.ts`](../../../packages/bundle/src/contracts/registrable.ts), [`basic/commands.ts`](../../../packages/bundle/src/contracts/basic/commands.ts)). The ref of a command names the definition's type without importing it, such as `ref<CommandDefinition<'core.open-settings/v1', typeof openSettingsInput>>('core.open-settings/v1')` ([`core/src/contracts/commands.ts`](../../../bundles/foundation/core/src/contracts/commands.ts)). Menus and keybindings dispatch by id, as [Menus and keybindings](menus-and-keybindings.md) describes.
- **Settings.** `settings/v1` has `register`, an asynchronous `get` and `entry`, `set` and `subscribe`, each typed by the definition passed ([`basic/settings.ts`](../../../packages/bundle/src/contracts/basic/settings.ts)).
- **Storage types.** `storage/v1` has `defineType` and the operations on records; the index fields are property paths of the schema ([`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)). The storage contract is in [Storage](storage.md).

### Tools

A tool is defined with `defineTool` of the `tool` package, in the same form: `input`, `output` and `execute(payload, call, services)`. It is registered with `services.use(ToolsV1).register(tool, …)`, which binds the registering bundle's services ([`tools.ts`](../../../packages/tool/src/lib/tools.ts), [`basic/tools.ts`](../../../packages/bundle/src/contracts/basic/tools.ts)).

## The call

Every `execute` of a method, a command or a tool receives `(input, call, services)`, and every hook handler receives `(input, call)` ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)):

- `call.caller` is the bundle that made this hop, `{ bundleId, version, generation }`. The dispatcher fills it and never inherits it from a parent call.
- `call.scope` is an optional record of strings whose keys belong to the bundles that read them; the platform reserves one key, `windowKey`, which it fills for a call that leaves a window. A scope holds at most 16 keys, each a letter followed by up to 63 letters, digits, `_`, `.` or `-`, with values of at most 512 characters.
- `call.signal` aborts with the operation, and `call.trace` is its W3C trace context.

Every method of a stub takes, as its last optional argument, the parent `call` the handler received, from which the new hop inherits the scope, the signal and the trace, or `{ signal, deadline }`, with the deadline in epoch milliseconds. `services.use(contract, scope)` binds a scope to the stub it returns ([`call.ts`](../../../packages/bundle/src/contracts/call.ts), [`context.ts`](../../../packages/bundle/src/contracts/context.ts)).

## The `contracts` entry points and the import rules

### `bundle/contracts`

`bundle/contracts` imports only relative modules and zod, so every part may import it, in the host, in `desktopMain` and in a window ([`index.ts`](../../../packages/bundle/src/contracts/index.ts)). It exports the `define*` functions and `ref`; the types `Call`, `Services`, `HostContext`, `DesktopContext` and `ClientContext`, which a part's `activate` receives; `ContractError`; the refs of the basic services (`HooksV1`, `LogV1`, `ToolsV1`, `SkillsV1`, `SettingsV1`, `SecretsV1`, `SecretsBackendV1`, `StorageV1`, `StorageBackendV1`, `EventsV1`, `ModelsV1`, `ModelsProviderV1`, `CommandsV1`, `UiV1`, `NavigationV1`, `RegionsV1`, `WindowsV1`, `MenusV1`) with their interfaces; and the refs of the platform's contracts, such as `DoricCatalogV1` and `DoricWindowsV1`, with `AppHooksV1` and `WindowHooksV1` ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts), [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`network.ts`](../../../packages/bundle/src/contracts/network.ts)). The refs and interfaces of the basic services live in the platform because any bundle may provide them: the core writes its definitions against the same refs, as does `postgres`, the provider of `storage.backend/v1` and `secrets.backend/v1`.

`packages/bundle`, the package `bundle`, holds the bundle platform under these entry points: `bundle/contracts`, described here; `bundle/runtime`, the service runtime every process shares; `bundle`, the Node API: the loader that starts the host with `startHost`, and the build; `bundle/externals`, the import-map specifiers a window resolves; `bundle/testing`, for tests; and `bundle/schemas/*`, the platform's generated JSON Schema documents. It also holds the build CLI, `build <bundleDir>` ([`package.json`](../../../packages/bundle/package.json), [`index.ts`](../../../packages/bundle/src/index.ts), [`cli.ts`](../../../packages/bundle/src/build/cli.ts)).

### A bundle's `contracts` entry point

A bundle that publishes contracts exports them from `src/contracts/index.ts`, mapped in its `package.json` as `<id>/contracts` ([`chat/package.json`](../../../bundles/desktop/chat/package.json)). It holds what a consumer needs and no implementation:

- hooks contracts, events, settings and storage types, as definitions;
- for a service, its interface, its ref, `ref<Interface>(id)`, and the `input` and `output` schemas of its methods, which the provider spreads into its `defineMethod` calls ([`git/src/contracts/index.ts`](../../../bundles/features/git/src/contracts/index.ts));
- for a command, a ref typed by the definition, and the input schema.

The definitions with `execute` stay in the part that provides them. A consumer lists the contract's id in its manifest, under `requires` when it cannot run without it and under `optional` when it can. `use` of an id that the manifest lists under neither and that the bundle does not provide throws `undeclared_requirement`, except `doric.*` ids and, for the core, the basic contracts; `whenAvailable` checks no manifest line, and the line an optional consumer lists is required by the boundary checks instead ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [Boundaries](boundaries.md)). The manifest fields are in [Manifest](manifest.md).

### What a bundle may import

- **Another bundle: only `<id>/contracts`.** A file of a bundle's `src` names another bundle's package only as exactly `<id>/contracts`, never a subpath of it or of the package. A test or story file may also name `<id>/testing`, and a test file `<id>/package.json`. No file anywhere imports `<package>/src/…` of a workspace package. A boundary check enforces both, with no standing exception ([`boundaries.mjs`](../../../tests/support/boundaries.mjs), [`boundary-exceptions.json`](../../../tests/boundary-exceptions.json)); the checks are in [Boundaries](boundaries.md).
- **Its own contracts: by relative path.** A bundle's code imports its own contracts as `../contracts/index.js`, never as `<id>/contracts`. When the build compiles a `desktopMain` part, a `client` part, or a client's worker or chunk, it turns an import that resolves into the bundle's own `src/contracts/` into the external `<id>/contracts`, so that one instance of each contracts module, of `bundle/contracts` and of `zod` exists per process or window; a frame bundles its contracts instead ([`parts.ts`](../../../packages/bundle/src/build/parts.ts), [`externals.ts`](../../../packages/bundle/src/build/externals.ts)).
- **The platform's packages, by part.** The build of a part fails on a forbidden import ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)):

  | Part          | May import                                                                                                                                                                                                                                      | The build refuses                                                                                     |
  | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | `client`      | `bundle/contracts`, `<id>/contracts`, `zod`, React, React DOM, Base UI, Lexical, and `desktop/ui` and its subpaths, which the window's import map serves; `desktop/reads`, compiled into the part                                               | `bundle`, `bundle/runtime`, `desktop`, `desktop/client` and its subpaths                              |
  | `desktopMain` | `bundle/contracts`, `<id>/contracts`, `zod`, `electron` and Node built-ins                                                                                                                                                                      | `bundle`, React, React DOM, Base UI, Lexical and every `desktop` entry point                          |
  | Frame         | The frame's import map (React, React DOM, Base UI); everything else is bundled into it                                                                                                                                                          | What `client` refuses, every `bundle/*` and `desktop/*` entry point, and the window's other externals |
  | `host`        | The build sets no rule; host parts import `bundle/contracts` and `<id>/contracts`, and the kernel-resident `transport`, `postgres` and `host-config` import the type `EmbeddedBundle` from `bundle`, and `host-config` imports `bundle/runtime` | Nothing                                                                                               |

  `desktop/ui` holds the shared components, tokens and styles; `desktop/reads` holds the helpers every read surface shares: workspace paths, the refresh queue, the retry policy of a pending read and the error messages of a failed one ([`reads/index.ts`](../../../packages/desktop/src/reads/index.ts)). Tests import `bundle/testing`.

### Two rules for the content of a contract

- **Data has one owner.** A record is read through a contract of the bundle that owns it. A bundle does not hand out another bundle's record types through its own contract, imported or retyped. It may publish a view of another bundle's data: a type it declares itself, holding what its own function produces from that data, read-only, with no field it does not use. No check decides this rule; it is applied in review ([Boundaries](boundaries.md)).
- **Plain data in an added contract method.** A contract method that a change adds takes and returns plain data. A contribution to another bundle's surface names an element tag and gives props, and the element answers with DOM events; it passes no function, component or live object, except a subscription listener. A change that moves a contract to another bundle does not reshape it for this rule. It is applied in review ([Boundaries](boundaries.md)).

## Structural copies

Because a contract is resolved by its id, a bundle may write its own copy of another bundle's contract in place of importing `<owner>/contracts`:

- **A service:** `ref<LocalInterface>(id)`, with an interface that lists the methods the bundle calls, such as `chat`'s copy of `workspace.selection/v1` ([`chat/src/client/api/workspace-selection.ts`](../../../bundles/desktop/chat/src/client/api/workspace-selection.ts)) or `papercraft`'s view of `doric.windows/v1` through its `capture` method only ([`papercraft/src/desktop/snapshot.ts`](../../../bundles/features/papercraft/src/desktop/snapshot.ts)).
- **A hooks contract:** `defineHooks(id, …)` with the same id, hook names, kinds and inputs. The provider of `hooks/v1` matches a registration to the owner's definition by id and hook name, and a handler receives the input the owner's definition validated ([`core/src/shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts), [Hooks and the app's lifecycle](hooks.md#declaring-hooks)).

A copy carries no code of the owner, so the runtime validates every call against the provider's definition, not against the copy, and nothing checks the copy's types against the owner's ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)). The copies in this repository exist for four reasons:

- **The bundle runs without the owner.** `<owner>/contracts` is resolved only in a composition that contains the owner: a window's import map and a desktop generation's module resolution map `<id>/contracts` only for the bundles of their generation ([`import-map.ts`](../../../app/desktop/doric/src/platform/protocol/import-map.ts), [`module-hooks.ts`](../../../app/desktop/doric/src/platform/generation/module-hooks.ts)). So a bundle that reaches the owner through `whenAvailable` and must load without it keeps a copy and lists the id under `optional`: `chat` for `workspace.selection/v1` and `workspace.hooks/v1`, and `files`, `git`, `notifications` and `openui` for `chat.hooks/v2` ([`chat/manifest.json`](../../../bundles/desktop/chat/manifest.json), [`git/src/client/api/peers.ts`](../../../bundles/features/git/src/client/api/peers.ts)).
- **The package takes no dependency on the owner's.** `runtime` keeps a copy of `core.event-hooks/v1`, so that its package does not depend on the core's, and lists the id under `requires` ([`runtime/src/host/peers.ts`](../../../bundles/runtime/runtime/src/host/peers.ts)).
- **A copy narrowed to what the bundle calls.** `terminal`'s host part keeps copies of `runtime.hooks/v1`, `runtime.threads/v1` and `runtime.workspace/v1`, each narrowed to the members it calls, although its package depends on `runtime` and its client part imports `runtime/contracts`; it lists the three ids under `requires` ([`terminal/src/host/peers.ts`](../../../bundles/features/terminal/src/host/peers.ts), [`terminal/src/client/peers.ts`](../../../bundles/features/terminal/src/client/peers.ts), [`terminal/manifest.json`](../../../bundles/features/terminal/manifest.json)).
- **The app is older than the contract.** `bundle/contracts` is served by the app at run time, so a bundle that may load on an app whose `bundle/contracts` lacks a platform ref builds the ref from its id: `account` does so for `doric.about/v1`, which it detects with `whenAvailable` ([`account/src/client/domain/about.ts`](../../../bundles/desktop/account/src/client/domain/about.ts), [`import-map.ts`](../../../app/desktop/doric/src/platform/protocol/import-map.ts), [`module-hooks.ts`](../../../app/desktop/doric/src/platform/generation/module-hooks.ts)).

A copy does not remove the manifest line: the boundary check that reads each id a bundle's sources name, as a literal or through an import, requires it under `requires` or `optional`, `doric.*` ids aside, and counts the line in the graph of bundles that must have no cycle ([Boundaries](boundaries.md)).

## The contract descriptor and schemas

The build of a bundle, `build <bundleDir>` of the `packages/bundle` CLI, runs after `tsc` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)):

1. It validates the manifest and copies it to `dist/manifest.json`, validates and copies the skills, and copies the Markdown files below `src/host` to `dist/host`.
2. It builds the `desktopMain` and `client` parts, with the import rules above; a client's workers, `src/client/workers/*.ts`, to `dist/client/workers/<name>.js`, with every import bundled except an import of the bundle's own `src/contracts/`, which becomes the external `<id>/contracts`; its chunks, `src/client/chunks/*.ts`, to `dist/client/chunks/<name>.js`, with the client's externals; and its frames, `src/client/frames/*.ts`, to `dist/client/frames/<name>.js` ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)).
3. It imports each built part, `host/index.js`, `desktop/index.js` and `client/index.js`, and dry-activates it: `activate` runs against recording services ([`record.ts`](../../../packages/bundle/src/build/record.ts)). The recording keeps each `provide`, each `define` of a hooks contract that is not `doric.*`, and each `register` of an event, a settings definition or a command created with `defineCommand`, and each `defineType` of a storage type; a `many` service is kept once. Every other call is a no-op that returns an inert `Disposable`, and `whenAvailable` never calls back. `use` of an id the manifest lists under none of `requires`, `optional` and `provides`, `doric.*` aside, fails the build, on `hooks/v1` as on any service. A client part is imported under a DOM shim ([`dom-shim.ts`](../../../packages/bundle/src/build/dom-shim.ts)).
4. It checks the recording against the manifest ([`record.ts`](../../../packages/bundle/src/build/record.ts)): a contract recorded twice in one environment, a recorded contract the manifest does not list under `provides`, a basic contract with the wrong cardinality, a method exposure the platform's table does not give, and an id of `provides` that no part records each fail the build. A contract recorded in two environments must generate the same document in both ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)).
5. It writes one JSON Schema document per contract to `dist/schemas/<contract id>.json`, the descriptor to `dist/contracts.json`, and `dist/package.json`, which marks `dist` as ES modules.

The descriptor lists every contract the bundle provides, once per environment ([`descriptor.ts`](../../../packages/bundle/src/runtime/descriptor.ts)):

```json
{
  "descriptorVersion": 1,
  "bundle": { "id": "git", "version": "1.3.0" },
  "contracts": [
    {
      "id": "git.commands/v1",
      "version": "1.1.0",
      "kind": "service",
      "environment": "host",
      "cardinality": "one",
      "local": false,
      "schema": "schemas/git.commands/v1.json"
    }
  ]
}
```

`kind` is `service`, `hooks`, `event`, `command`, `settings` or `storage-type`; `version` is the one `provides` lists; `local` says that a member uses a process-local type.

A schema document is JSON Schema 2020-12 with `$id` `doric:contract/<id>` and `x-doric-kind`, and holds each member under `$defs` ([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts)):

| Kind           | Members under `$defs`                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `service`      | `<method>.input` and `<method>.output`; `x-doric-expose` maps each exposed method to `desktop` |
| `hooks`        | `<hook>.input`, each with `x-doric-hook-kind`                                                  |
| `event`        | `payload`                                                                                      |
| `command`      | `input`                                                                                        |
| `settings`     | `value`                                                                                        |
| `storage-type` | `value`, with `x-doric-indexes`                                                                |

An input schema describes what a caller sends and an output schema what it receives. A process-local value appears as `{ "x-doric-local": "<codec>" }`, or `true` when it has no codec, and a stream listener records its item schema under `x-doric-stream`. The generator is the runtime's own, so the documents the build writes are the ones a live definition produces: a provider in a generation process announces a service to the kernel with the document generated from its definition, and a basic or platform contract with no document, by its id ([`schemas.ts`](../../../packages/bundle/src/build/schemas.ts), [`remote.ts`](../../../packages/bundle/src/runtime/envelope/remote.ts)). The documents ship with the bundle's other distributed files, `schemas/**` beside `manifest.json` and `contracts.json`, so that a desktop part can call the bundle's host contracts; a kernel-resident bundle, passed to the loader in code as an `EmbeddedBundle`, carries its manifest, its descriptor and its documents in that object ([`distribution.ts`](../../../packages/bundle/src/loader/distribution.ts), [`loader/catalog.ts`](../../../packages/bundle/src/loader/catalog.ts)).

The catalog reads `contracts.json` with the manifest, and quarantines a bundle with `invalid_descriptor` when the file is missing, names another bundle or version, lists an id twice in one environment, lists an id `provides` lacks or with another version, or omits an id `provides` lists ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). The platform's own documents, for the manifest, the composition, the descriptor and each basic and platform contract, are generated from the same zod schemas by [`platform-schemas.ts`](../../../packages/bundle/src/build/platform-schemas.ts), with `$id`s such as `doric://app/schemas/bundle-manifest/v1.json`.

## Related documents

- [`packages/bundle` README, The `define*` functions](../../../packages/bundle/README.md#the-define-functions): the full signatures of the `define*` functions and `ref`.
- [Hooks and the app's lifecycle](hooks.md): `defineHook`, `defineHooks`, `execute` and the hooks that ship.
- [Boundaries](boundaries.md): the boundary checks and the rules they enforce.
- [Manifest](manifest.md): `provides`, `requires` and `optional`.
- [Versioning](versioning.md): how a contract takes a minor or a major.
- [Services and channels](services-and-channels.md): the stubs, the dispatcher and the calls between processes.
- [Contexts](contexts.md): what a part's `activate` receives.
- [Composition and distribution](composition-and-distribution.md): choosing the provider of a contract under `providers`.
- [Core](core.md): the default provider of the basic services, and quarantine.
- [Events and nodes](events-and-nodes.md), [Storage](storage.md), [Menus and keybindings](menus-and-keybindings.md): what the events, storage types and commands are used for.
- [Observability](observability.md): where `call.caller` is reported.
