# core

`core` is the default provider of the basic Doric services: hooks, logging, the
tool and skill registries, storage, stored credentials, events, settings and
models on the host; commands, windows, menus and local settings in the
desktop's main process; and the UI, navigation, regions and commands of each
app window. Most of what a bundle does in Doric, it does through a contract the
core provides. See the [main README](../../../README.md) for Doric as a whole
and [`packages/bundle`](../../../packages/bundle/README.md) for how bundles,
parts and contracts work.

The features that run through the core's contracts are described in these
feature docs, which state each contract at the level the feature needs:
[credentials](../../../docs/features/credentials.md) (`secrets/v1`, and the
redaction of `log/v1` and `events/v1`),
[settings](../../../docs/features/settings.md) (`settings/v1` and
`core.open-settings/v1`), [default agent](../../../docs/features/default-agent.md)
(handlers of a `transform` hook through `hooks/v1`) and
[UI redesign](../../../docs/features/ui-redesign.md) (the Back and Forward of
`navigation/v1`).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| `manifestVersion` | `1`                                                        |
| `id`              | `core`                                                     |
| `version`         | `1.16.0`                                                   |
| `engines`         | `doric: ^1.0.0`                                            |
| `description`     | Default provider of the basic Doric services.              |
| `requires`        | `storage.backend/v1@^1.0.0`, `secrets.backend/v1@^1.0.0`   |
| `optional`        | none                                                       |
| Other fields      | none (`desktopScope`, slots and the like are not declared) |

`provides`, with the part that provides each entry:

| Contract                            | Kind    | Host | Desktop main | Window client |
| ----------------------------------- | ------- | :--: | :----------: | :-----------: |
| `hooks/v1@1.0.0`                    | service |  ✓   |      ✓       |       ✓       |
| `log/v1@1.0.0`                      | service |  ✓   |      ✓       |       ✓       |
| `tools/v1@1.4.0`                    | service |  ✓   |              |               |
| `skills/v1@1.1.0`                   | service |  ✓   |              |               |
| `settings/v1@1.0.0`                 | service |  ✓   |      ✓       |               |
| `secrets/v1@1.2.0`                  | service |  ✓   |              |               |
| `storage/v1@1.1.0`                  | service |  ✓   |              |               |
| `events/v1@1.0.0`                   | service |  ✓   |              |               |
| `models/v1@1.4.0`                   | service |  ✓   |              |               |
| `core.settings/v1@1.0.0`            | storage |  ✓   |              |               |
| `core.settings-generation/v1@1.0.0` | storage |  ✓   |              |               |
| `core.event-hooks/v1@1.0.0`         | hooks   |  ✓   |              |               |
| `commands/v1@1.0.0`                 | service |      |      ✓       |       ✓       |
| `core.commands/v1@1.0.0`            | service |      |      ✓       |               |
| `windows/v1@1.1.0`                  | service |      |      ✓       |               |
| `menus/v1@1.0.0`                    | service |      |      ✓       |               |
| `core.hooks/v1@1.0.0`               | hooks   |      |      ✓       |               |
| `core.open-settings/v1@1.1.0`       | command |      |      ✓       |               |
| `ui/v1@1.0.0`                       | service |      |              |       ✓       |
| `navigation/v1@1.1.0`               | service |      |              |       ✓       |
| `regions/v1@1.0.0`                  | service |      |              |       ✓       |

The parts are [`src/host/index.ts`](src/host/index.ts),
[`src/desktop/index.ts`](src/desktop/index.ts) and
[`src/client/index.ts`](src/client/index.ts). Code that two parts share is in
`src/shared/`, and the core's own contract declarations are in
[`src/contracts/`](src/contracts/index.ts). Every basic contract (every id
without a `core.` prefix above) has its specification, cardinality and
environments in [`bundle/contracts`](../../../packages/bundle/src/contracts/basic/index.ts);
the core implements that specification.

## Loading

- The composition names this bundle as its core (`"core": "core"` in
  [`composition.json`](../../../app/backend/doric-host/composition.json)). Each
  environment activates its bundles in three phases: the foundation, then the
  core, then every other bundle. The foundation is the set of providers the
  composition chooses under `providers` for a contract the core provides or
  requires in that environment (`postgres`, for `storage.backend/v1` and
  `secrets.backend/v1`, in the shipped host); the backends come first
  ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).
- The environment enters recovery mode, and activates no further bundle, when
  the core is not installed, not enabled or quarantined; when a contract of
  the core's `requires` has no enabled provider in any environment, or, in
  this environment, is not provided by an active foundation bundle or is
  provided at a version outside the range (a contract provided only in another
  environment does not trigger recovery); or when a chosen foundation provider
  is quarantined
  ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). It also
  enters recovery mode when the core's `activate`, or a chosen foundation
  provider's `activate`, fails: the bundle is quarantined and every later
  bundle is left `inactive`
  ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)); a
  throw from the core's host activation, such as from `storage.defineType`,
  therefore takes the environment down. The core's
  place in a composition, the replacement of its contracts, quarantine and
  recovery are described in
  [The core bundle and quarantine](../../../docs/architecture/bundles/core.md).
- Each part calls `services.provide` for each of its contracts. A `provide` is
  inert when the composition chose another provider for that contract, and the
  core then reaches the chosen one through `services.use`, as any bundle does
  ([`src/host/index.ts`](src/host/index.ts),
  [`src/desktop/index.ts`](src/desktop/index.ts),
  [`src/client/index.ts`](src/client/index.ts)).
- Activation does no I/O: a storage type is declared to the backend on the
  first operation on it, the catalog is read on the first call that needs it,
  and the credentials are read on the first `secrets/v1` call
  ([`src/shared/state.ts`](src/shared/state.ts),
  [`src/host/storage/facade.ts`](src/host/storage/facade.ts),
  [`src/host/secrets/facade.ts`](src/host/secrets/facade.ts)).
- The host part registers a start step on `doric.app.hooks/v1`
  `onHostStartHook`: it calls `storage.backend/v1.connect`, enters the startup
  stage `credential_activation` of `doric.startup/v1`, logs
  `Activating stored credentials`, and calls `secrets/v1.list`. A storage that
  cannot connect, or a credential key that is missing or unusable, fails the
  host's start there ([`src/host/secrets/activation.ts`](src/host/secrets/activation.ts)).
- On the host, the core defines `core.event-hooks/v1` during activation; a
  host with no catalog (a unit test) cannot define it, and appends then fire no
  hook ([`src/host/index.ts`](src/host/index.ts)).

## Contracts it uses

| Contract                                                                              | Where                | What for                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.backend/v1`                                                                  | host                 | Every `storage/v1` operation, the backend's limits (`capabilities`) and the connection at start                                                                                         |
| `secrets.backend/v1`                                                                  | host                 | Loading, writing and deleting stored credentials                                                                                                                                        |
| `models.provider/v1` (many)                                                           | host                 | The model kinds `models/v1` lists and builds, aggregated with `services.whenAvailable`                                                                                                  |
| `storage/v1`, `secrets/v1`, `hooks/v1`, `log/v1`, `tools/v1`                          | host                 | The active providers of these contracts, through `services.use`: settings are stored through `storage/v1`, events are redacted with `secrets/v1`, skills check tools through `tools/v1` |
| `commands/v1`, `core.commands/v1`, `menus/v1`, `ui/v1`, `navigation/v1`, `regions/v1` | desktop main, client | The active providers, as above: the client sends a command it does not hold to `core.commands/v1`, and the structural elements draw through `ui/v1`                                     |
| `doric.catalog/v1`                                                                    | every part           | The manifests (`provides`) for ownership checks, the activation order of hook handlers, the active generation and the active host providers                                             |
| `doric.diagnostics/v1`                                                                | every part           | Reporting a failing hook handler, log write or settings listener                                                                                                                        |
| `doric.log/v1`, `doric.bundle/v1`                                                     | every part           | Writing log records, and the environment a record names                                                                                                                                 |
| `doric.app.hooks/v1`                                                                  | host, desktop main   | The host start step; the desktop's app-ready and app-activate steps                                                                                                                     |
| `doric.startup/v1`                                                                    | host                 | The `credential_activation` stage and its log line                                                                                                                                      |
| `doric.windows/v1`, `doric.menus/v1`                                                  | desktop main         | Opening, focusing and remembering windows; the menu skeleton, items, keybindings and contexts                                                                                           |
| `doric.migrations/v1`, `doric.cache/v1`                                               | desktop main         | Copying the saved selection into the app origin; the directory of the local settings file                                                                                               |
| `doric.elements/v1`                                                                   | client               | Owning custom element tags and giving each created element its owner's services                                                                                                         |

The runtime lets the core use any basic contract without listing it under
`requires`, which is why `models.provider/v1` and the core's own contracts are
not listed ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)).
A `doric.*` contract is never listed by any bundle. The `doric.*` contracts are
declared in [`platform.ts`](../../../packages/bundle/src/contracts/platform.ts).

## Rules every provider of the core follows

- **Caller.** Every method acts for `call.caller.bundleId`, the bundle that
  called it. The platform principal `doric` passes every ownership check
  ([`src/shared/state.ts`](src/shared/state.ts)).
- **Generations.** On the host, registries of tools, skills, credential
  kinds, storage types, settings spaces, event types, event sinks and hook
  handlers are partitioned by generation. A registration made by a call of
  generation 0 (the kernel) is seen by every call; one made in generation `n`
  is seen only by calls of generation `n`, or by kernel calls while `n` is the
  active generation of `doric.catalog/v1`. A kernel registration collides with
  every live entry; a registration of generation `n` collides with a live
  entry of the kernel or of generation `n`. Two generations of the same bundle
  therefore never collide, and disposing one never removes the other's
  ([`src/shared/partition.ts`](src/shared/partition.ts)). Hook definitions
  follow their own rule, stated under `hooks/v1`.
- **Definition ownership.** `storage/v1.defineType`, `settings/v1.register`
  and `events/v1.register` accept an id only from the bundle named by its
  namespace (its first segment before `.` or `/`), else `not_owner`, and only
  when that bundle lists the id under `provides`, else `undeclared_provide`.
  The version written with a settings space is the version of that `provides`
  entry ([`src/shared/state.ts`](src/shared/state.ts)).
- **Errors.** A refusal is a `ContractError` with a code; an `invalid_input`
  that comes from a schema lists each issue as `path: message` (only `message`
  when the path is empty), joined with `; `
  ([`src/shared/issues.ts`](src/shared/issues.ts)). Two providers differ:
  `hooks/v1.execute` puts zod's own error message in its `invalid_input` and
  the issues in `details.issues` ([`src/shared/hooks.ts`](src/shared/hooks.ts)),
  and `models/v1` throws a plain `Error`, with no code, for a configuration
  that lists no providers, an invalid configured provider, an unknown provider
  kind and an unavailable provider
  ([`src/host/models/index.ts`](src/host/models/index.ts),
  [`src/host/models/providers.ts`](src/host/models/providers.ts)).
- **Diagnostics.** A failure that must not fail the caller (a hook handler, a
  log write, a settings listener) is reported to `doric.diagnostics/v1`; a
  failing report is ignored ([`src/shared/state.ts`](src/shared/state.ts),
  [`src/shared/hooks.ts`](src/shared/hooks.ts)).
- **Write queue.** In each process, `settings/v1.set` and the
  `secrets/v1` writes (`create`, `update`, `delete`) run one at a time in
  arrival order, and a failed task frees the queue. A configuration therefore
  never names a credential that a concurrent delete removes
  ([`src/shared/writes.ts`](src/shared/writes.ts)).

## Contracts provided in every part

### `hooks/v1`

The mechanism, the hook kinds and the hooks the platform and other bundles
declare are described in [Hooks and the app's lifecycle](../../../docs/architecture/bundles/hooks.md).
This section is the full shape of the contract and the core's behavior.

Shape ([`hooks.ts`](../../../packages/bundle/src/contracts/basic/hooks.ts)):
cardinality `one`, in `host`, `desktopMain` and `client`. A bundle calls
`services.use(HooksV1)` and gets `Hooks`, which the runtime builds over the
provider's `HooksProvider`:

| `Hooks` member                      | Result             | Meaning                                                                                                        |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `define(contract)`                  | `HookHandle<C>`    | For the owner: defines the contract and returns, per hook, `execute(input, call?) → Promise<HookOutput>`       |
| `use(contract)`                     | `HookRegistrar<C>` | For an observer: per hook, a function that takes a handler `(input, call) → output` and returns a `Disposable` |
| `whenAvailable(contract, callback)` | `Disposable`       | Runs `callback(registrar)` each time the owner defines the contract; the callback may return a cleanup         |

`HookOutput` is nothing for `observe` and `sequence`, a value of the input
schema for `transform`, and a `Decision` for `decide`.

A hooks contract and its hooks ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)):

- `HooksContract` is `{ type: 'hooks', id, hooks: Record<name, HookDefinition> }`,
  built with `defineHooks(id, hooks)`, which throws a `TypeError` for a
  malformed id, a `doric.*` id reserved for the platform, or a hook not made
  with `defineHook`. The name of a hook is its key, by convention
  `on<Point>Hook`.
- `HookDefinition` is `{ kind, input, order?, forOwner? }`, built with
  `defineHook`: `kind` is `'observe'`, `'transform'`, `'decide'` or
  `'sequence'`; `input` is a zod schema; `order` is `'activation'` (the
  default) or `'reverse'` and is accepted only on a `sequence` hook;
  `forOwner(input, bundleId) → input | undefined` is accepted only on an
  `observe` hook. Any other combination throws a `TypeError`.
- `Decision` is `{ allow: true }` or `{ allow: false, reason: string }`, each
  strict: any other key makes the decision invalid.

| `HooksProvider` method                     | Input                                          | Output             |
| ------------------------------------------ | ---------------------------------------------- | ------------------ |
| `define(contract, call?)`                  | a hooks contract                               | `Disposable`       |
| `register(contract, hook, handler, call?)` | contract, hook name, `(input, call) → unknown` | `Disposable`       |
| `whenDefined(contract, callback, call?)`   | contract, `() → void \| Cleanup`               | `Disposable`       |
| `execute(contract, hook, input, call?)`    | contract, hook name, input                     | `Promise<unknown>` |

Behavior of the core's provider ([`src/shared/hooks.ts`](src/shared/hooks.ts)):

- `define` refuses a `doric.*` contract to anyone but `doric`, and a bundle
  contract to a bundle whose manifest in `doric.catalog/v1` has no `provides`
  entry starting with `<id>@`, both with `not_owner`. A bundle contract has one
  definition per generation, and a definition made by a kernel call is apart
  from every generation's, so a kernel definition and a generation definition
  of the same id do not collide; a `doric.*` contract has one definition. A
  definition by another bundle in the same partition is
  `registration_conflict`, and a second `define` by the same owner returns a
  no-op `Disposable`. `define` runs every waiting `whenDefined` callback
  before it returns: a callback that throws makes `define` throw, with the
  contract already defined. Disposing the definition undefines the contract.
- `register` records the handler with its bundle, its generation and the
  call's `scope.windowKey`, and keeps it until disposed, whether or not the
  contract is defined.
- `whenDefined` runs the callback at once when the contract is defined, and
  again at each later definition. When the definition goes away, the handlers
  the callback registered while it ran synchronously are removed and its
  cleanup runs in a microtask; a throwing cleanup is ignored. Disposing the
  watcher does the same.
- `execute` refuses an unknown hook name and an input that fails the hook's
  schema, both with `invalid_input` (the second with `details.issues`). It
  runs the handlers the call's generation sees, ordered by the activation
  order of `doric.catalog/v1` (`doric` first), then by registration order. For
  `doric.window.hooks/v1`, only the handlers registered with the call's
  `windowKey` run.
- Each `observe`, `transform` and `decide` handler is awaited within a
  deadline: 10 000 ms (`DEFAULT_HOOK_DEADLINE_MS`) for a bundle's hooks; for
  `doric.window.hooks/v1`, the time left to the call's deadline, and none for
  `onCloseHook`. A deadline of 0, which a window hook gets when the call's
  deadline has already passed, means no deadline. A handler that throws, returns an invalid value or decision,
  or misses its deadline is reported to `doric.diagnostics/v1`
  (`hook_handler_failed` or `hook_handler_timeout`, with
  `{ contract, hook }`) and skipped. `transform` passes each valid result to
  the next handler and resolves to the last; `decide` resolves to the first
  refusal, else `{ allow: true }`. An `observe` hook with `forOwner` gives each
  handler the input that function returns for the handler's bundle, and skips
  the handler when it returns `undefined`.
- A `sequence` hook awaits each handler with no deadline, in order or, with
  `order: 'reverse'`, in reverse; the first failure rejects `execute`.
- `execute` rejects with the call's abort reason when `call.signal` aborts
  first.

### `log/v1`

Shape ([`log.ts`](../../../packages/bundle/src/contracts/basic/log.ts)):
`debug`, `info`, `warn` and `error`, each `(message: string, fields?:
Record<string, unknown>, call?) → void`; cardinality `one`, in every
environment.

Behavior ([`src/shared/log.ts`](src/shared/log.ts)): each level writes one
record through `doric.log/v1` with `level`, `message`, `fields`, the caller's
`bundleId`, `version` and `generation`, the `environment` that
`doric.bundle/v1` names, the call's `scope` and the trace id of its
`traceparent`. The host and main process parts first replace every secret of
`secrets/v1.view().redactions()` by `[REDACTED]` in the message and in every
string leaf of the fields, including the name, message, stack and cause of an
`Error` ([`src/shared/redact.ts`](src/shared/redact.ts)); when that view
cannot be read (the credentials are not loaded yet, or the `secrets/v1`
provider runs in another process, where `view` is `local_only`, as it always does for the main process part), the record is written as it is. The client part does not
redact. A level never throws: a failed
write is reported as `log_write_failed`.

## Host contracts

In the method tables, "(desktop)" marks a method whose specification has
`expose: 'desktop'`, so a desktop window may call it across the bridge; a
method without it is reachable only from bundle parts. "local" marks a method
that is usable only in the provider's own process. A process-local value with
a codec (its schema's `x-doric-local` is `callback`, `disposable` or
`object`) crosses the process boundary as a handle: a `Disposable`
(`disposableSchema`), a stream listener (`watchRedactions`), a handler,
definition or callback in a method the envelope has a codec for
(`tools.register`, `storage.defineType`, `settings.register` and `subscribe`,
`registerKind`, `events.register`), and a `languageModel`. A local value with
no codec, such as a plain `functionSchema` argument or a `z.custom` object,
never crosses: its method is refused with `local_only` when called from
another process
([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts),
[`envelope/values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts),
[`common.ts`](../../../packages/bundle/src/contracts/basic/common.ts)). Among
the core's host contracts, these are `secrets/v1.registerReferences` and
`view`; among its window contracts, `ui/v1.define`, `create` and `dispose`,
`navigation/v1.register`, `chain` and `subscribe`, `regions/v1.items` and
`subscribe`, and `commands/v1.register`.

### `tools/v1`

Shape ([`tools.ts`](../../../packages/bundle/src/contracts/basic/tools.ts)):

| Method                     | Input                                                                                                                                 | Output                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `register(tool, options)`  | a `ContractTool` bound by its registrant; `{ alwaysAvailable: boolean, order?: positive safe integer, projectId?: non-empty string }` | `Disposable`                         |
| `list(call?)`              | none                                                                                                                                  | `RegisteredTool[]`                   |
| `catalog(call?)` (desktop) | none                                                                                                                                  | `{ name, description?, settings }[]` |

A `ContractTool` has `name` (not blank), `description?`, `input` (a zod
object), `output`, `definition` (`{ name, description?, inputSchema,
outputSchema, strict? }`), `settings` (the configuration fields, an array),
`resultModalities?`, `check?(payload)` and `execute(payload, call)`. A
`RegisteredTool` is `{ bundleId, alwaysAvailable, order?, projectId?, tool }`.

Behavior ([`src/host/tools.ts`](src/host/tools.ts)):

- `register` is `duplicate_tool` when a tool of the same name is visible to
  the registration's generation and either one is unscoped or both belong to
  the same Project. Two Projects may each hold a tool of the same name.
- `list` answers a frozen array of the tools the call sees: the unscoped ones
  and those whose `projectId` equals `call.scope.projectId`, sorted by `order`
  ascending, unordered ones last, then by registration order.
- `catalog` answers the same list as plain data, `{ name, description?,
settings }`, and is reachable from a desktop window.

### `skills/v1`

Shape ([`skills.ts`](../../../packages/bundle/src/contracts/basic/skills.ts)):
`register(skill, options?) → Disposable`, where `skill` is the input of
`SkillSchema` ([`skill.ts`](../../../packages/bundle/src/contracts/skill.ts))
and `options` is `{ alwaysAvailable?: boolean, order?: positive safe integer }`;
`list(call?) → Promise<{ bundleId, alwaysAvailable, order?, skill }[]>`.

Behavior ([`src/host/skills.ts`](src/host/skills.ts)): `register` is
`duplicate_skill` when a visible skill has the name, and `unavailable_tool`
when an `allowed-tools` entry is not the name of a tool in the caller's
`tools/v1.list`. `alwaysAvailable` defaults to `false`. `list` answers the
visible skills sorted by `order`, unordered ones last, then by registration
order.

### `storage/v1`

Shape ([`storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts)):

| Method                                   | Input                                                                                                                                         | Output                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `defineType(definition)`                 | a storage type made with `defineStorageType` (`type`, zod `schema`, `indexes: { name, fields, unique? }[]`)                                   | `Disposable`                                                                                                |
| `get({ type, id })`                      | a document key                                                                                                                                | `{ type, id, revision, value } \| undefined`                                                                |
| `query(query)`                           | `{ type, index, equals: (string\|number\|boolean\|null)[], range?: { gt?, gte?, lt?, lte? }, order?: 'asc'\|'desc', limit: 1–1000, cursor? }` | `{ items: StoredDocument[], cursor? }`                                                                      |
| `read({ stream, afterSequence, limit })` | a stream id, a sequence ≥ 0, a positive limit                                                                                                 | `{ entries: { sequence, value, createdAt }[], lastSequence, truncations: { afterSequence, atSequence }[] }` |
| `commit(batch)`                          | `{ expect?, put?, delete?, truncate?, append?, dropStreams? }`                                                                                | `{ position }`                                                                                              |
| `health()`                               | none                                                                                                                                          | `{ status: 'ok'\|'unavailable', writable, reason?, disk?: { blocks, availableBlocks } }`                    |
| `putBlob(bytes)`                         | base64 text                                                                                                                                   | `{ hash }` (`sha256:<hex>`)                                                                                 |
| `getBlob(hash)`                          | a hash                                                                                                                                        | base64 text or `undefined`                                                                                  |
| `deleteBlob(hash)`                       | a hash                                                                                                                                        | nothing; an unknown hash is a no-op                                                                         |

A batch holds `expect: { type, id, revision }[]` (revision 0: must not
exist), `put: { type, id, value }[]`, `delete: { type, id }[]`,
`truncate: { stream, afterSequence }`, `append: { stream, expectedSequence?,
events: unknown[] (at least one) }[]` and `dropStreams: string[]`; it applies
in the order expect, delete, put, dropStreams, truncate, append, or not at
all. A stream id is `<owner>.<family>/<key>`
([`streams.ts`](../../../packages/storage/src/streams.ts)).

Behavior ([`src/host/storage/facade.ts`](src/host/storage/facade.ts)), over the
chosen `storage.backend/v1`:

- `defineType` applies the definition ownership rule, checks that index names
  are unique and that every dotted index field names a place the schema can
  hold (`invalid_input` otherwise), and registers the type
  ([`src/host/storage/validate.ts`](src/host/storage/validate.ts)). The same
  owner may define the same type again in the same generation with the same
  JSON Schema and indexes and gets another handle; the type leaves when every
  handle is disposed. Any other second definition is `registration_conflict`
  ([`src/host/storage/registry.ts`](src/host/storage/registry.ts)).
- A type is declared to the backend (`declareType` with its indexes) once, on
  the first `get`, `query` or `commit` that touches it; a failed declaration is
  retried by the next operation.
- `get` and `query` of an undefined type are `unknown_type`, and of another
  bundle's type `not_owner`; the platform reads any type, even an undefined one.
- `read` is allowed to the stream's owner (the first segment of its id) and
  the platform, else `not_owner`; a malformed id is `invalid_stream`.
- `commit` checks the owner of every type in `expect`, `delete` and `put`;
  parses every `put` value with the type's schema (`invalid_input`) and writes
  the parsed output; allows `dropStreams`, `truncate` and `append` only on the
  caller's own streams, or on any stream when the caller is the active
  `events/v1` provider or the platform; refuses an empty batch
  (`invalid_input`) and a batch over the backend's `capabilities()`
  (`limit_exceeded`: more items than `maxBatch`, counting each appended event;
  a `put` value over `maxDocumentBytes`; an event over `maxAppendBytes`) before
  anything is sent ([`batch.ts`](../../../packages/storage/src/batch.ts)); and
  then declares the touched types and sends the batch. The backend's
  capabilities are read once and kept; a failed read is retried.
- `health`, `putBlob`, `getBlob` and `deleteBlob` go to the backend unchanged.
  A blob is shared by every bundle: who may read one is the caller's own
  record of it.

The backend's own errors (`revision_conflict`, `sequence_conflict`,
`unique_conflict`, `invalid_index_value`) reach the caller unchanged; they are
listed in [`storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts).

### `settings/v1`

Shape ([`settings.ts`](../../../packages/bundle/src/contracts/basic/settings.ts)),
in `host` and `desktopMain`. A space is defined with `defineSettings({ id,
schema })` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)).

| Method                                                  | Output                          |
| ------------------------------------------------------- | ------------------------------- |
| `register(definition)`                                  | `Disposable`                    |
| `get(definition, call?)`                                | the space's value               |
| `entry(definition, call?)`                              | `SettingsEntry`                 |
| `set(definition, value, { expectedRevision? }?, call?)` | `SettingsEntry`                 |
| `subscribe(definition, listener)`                       | `Disposable`; `listener(entry)` |

`SettingsEntry` is `{ value, revision, version, updatedAt, generation }`:
`revision` grows by one on each write of the space, `version` is the owner's
`provides` version at the write, `updatedAt` is ISO-8601 in UTC with
milliseconds, and `generation` is the global settings counter after that
write.

Behavior on the host ([`src/host/settings/facade.ts`](src/host/settings/facade.ts)):

- `register` applies the definition ownership rule; a space visible to the
  registration's generation is `registration_conflict`
  ([`src/shared/settings-registry.ts`](src/shared/settings-registry.ts)).
- `get`, `entry`, `set` and `subscribe` take any registered space the call's
  generation sees, else `unknown_settings`; they check no owner.
- A read loads the space's `core.settings/v1` document through `storage/v1`
  once and keeps it; a failed load is retried. A space never written answers
  its schema's parse of `{}` at revision 0, generation 0 and `updatedAt`
  `1970-01-01T00:00:00.000Z`, or `settings_missing` when the schema refuses
  `{}`. A stored value that no longer parses is `invalid_output`.
- `set` runs in the write queue. It parses the value (`invalid_input`), reads
  the space's document and the counter, refuses an `expectedRevision` that is
  not the current revision (`settings_conflict`, with `expected` and
  `actual`), and commits both documents in one batch that expects their
  current revisions. It then calls every listener of the space, of every
  generation, synchronously and before the queue moves on; a throwing
  listener is reported as `settings_listener_failed`.

Behavior in the desktop's main process ([`src/desktop/settings.ts`](src/desktop/settings.ts)):
the same contract and rules, over one JSON file, `settings.json`, in the
directory `doric.cache/v1` gives the core. The file holds `{ generation,
spaces: { <id>: { value, revision, version, updatedAt, generation } } }`; it
is created by the first `set` and replaced on each write by writing
`settings.json.<pid>.tmp` and renaming it. A missing file reads as empty; a
file that cannot be read or parsed is `invalid_output`.

### `secrets/v1`

Shape ([`secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts)).
A credential is `{ id, kind, name, username?, email?, secret? }`; its public
description is `{ id, kind, name, username?, email?, hasSecret }`. A kind is a
name matching `^[A-Z][A-Z0-9_]{1,31}$` with a field set `{ required,
optional }` over `username`, `email` and `secret`, and an optional `label`;
the platform defines `API_TOKEN` (requires `secret`) and `USERNAME_PASSWORD`
(requires `username` and `secret`).

| Method                               | Input                                                                                                            | Output                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `resolve({ id })`                    | a credential id                                                                                                  | the credential with its secret                   |
| `list()` (desktop)                   | none                                                                                                             | descriptions                                     |
| `kinds()`                            | none                                                                                                             | kind definitions the call sees                   |
| `registerKind(definition)`           | `{ id, required, optional, label? }`                                                                             | `Disposable`                                     |
| `describe({ id })`                   | a credential id                                                                                                  | a description or `undefined`                     |
| `create(input)` (desktop)            | `{ kind, name, username?, email?, secret? }`                                                                     | the description                                  |
| `update({ id }, input)` (desktop)    | `{ kind?, name?, username?, email?, secret? }`; `null` or absent keeps a field, a string (`''` included) sets it | the description                                  |
| `delete({ id })` (desktop)           | a credential id                                                                                                  | `'deleted' \| 'missing' \| 'referenced'`         |
| `resolveByKind(kind, { exclude? }?)` | a kind and ids to leave out                                                                                      | the one credential, or `undefined`               |
| `redactions()`                       | none                                                                                                             | the redaction list                               |
| `watchRedactions(listener)`          | a stream listener of `string[]`                                                                                  | `Disposable`                                     |
| `registerReferences(source)`         | `() → Iterable<string>`, local                                                                                   | `Disposable`                                     |
| `view()`                             | none, local                                                                                                      | `{ list(), redactions(), addRedaction(secret) }` |

Behavior ([`src/host/secrets/facade.ts`](src/host/secrets/facade.ts),
[`src/host/secrets/cache.ts`](src/host/secrets/cache.ts)):

- The first call lists the backend and keeps the rows in a cache, which
  answers every later read; a failed load is retried by the next call. The
  cache starts in the backend's order and is sorted by `localeCompare` of the
  name after each save; a removal keeps the order.
- `resolve` of an id not stored is `credential_missing`; of a credential whose
  kind the call's generation does not see, `unknown_kind`.
- `create`, `update` and `delete` run in the write queue. `create` refuses an
  unknown kind (`unknown_kind`) and values that break the kind's field set
  (`credential_invalid`, with the message of `credentialFieldsMessage`),
  writes the row with a new UUID through `secrets.backend/v1.put`, and saves
  it in the cache. `update` refuses a missing id (`credential_missing`) and a
  change of kind (`credential_kind_immutable`), merges the input, checks the
  field set and writes the row. A name already used by a credential of the
  same kind is the backend's `credential_name_taken`; a secret written with no
  credential key is its `credential_storage_unavailable`.
- `delete` answers `referenced`, touching nothing, while a registered
  reference source names the id; otherwise it deletes through the backend
  and, on `deleted`, drops the credential from the cache at once.
- `resolveByKind` refuses an unknown kind, leaves out `exclude`, and is
  `credential_ambiguous` when more than one credential of the kind remains.
- `registerKind` is `duplicate_credential_kind` when a kind of that id is
  visible to the registration's generation, built-in kinds included.
- The redaction list is every non-empty stored secret, in cache order, then
  every secret added with `view().addRedaction` (an empty one is ignored).
  `watchRedactions` delivers the list once the credentials are loaded and
  again after every create, update, delete and added redaction; a write
  resolves only after every watcher received the list it produced, and a
  failing watcher does not fail the write.
- `view()` is `unavailable` until the credentials are loaded. No method logs,
  and no error carries a secret.

### `events/v1`

Shape ([`events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)):
`register(definition) → Disposable`, where the definition is made with
`defineEvent({ type, payload })`; `sink({ scopeKeys, stream,
scopeDescription? }) → Disposable`; `append(definition, payload, call?) →
Promise<void>`. A sink's `scopeKeys` are 1 to 16 unique scope keys, its
`stream` is at most 256 characters, and every `{key}` placeholder in it is
one of its keys.

Behavior ([`src/host/events/facade.ts`](src/host/events/facade.ts)):

- `register` applies the definition ownership rule and refuses a payload that
  declares `type` (`invalid_input`); a type visible to the registration's
  generation is `registration_conflict`
  ([`src/host/events/registry.ts`](src/host/events/registry.ts)).
- `sink` registers the one sink of a generation; a second visible sink is
  `registration_conflict` ([`src/host/events/sinks.ts`](src/host/events/sinks.ts)).
  A bundle registers a sink only for streams it owns (`not_owner`), checked
  with each placeholder filled with a sample value; the platform registers a
  sink for any stream ([`src/host/events/facade.ts`](src/host/events/facade.ts)).
- `append` refuses an unregistered type (`unknown_event`), a caller that is
  not the type's owner (`not_owner`), a generation with no sink and a call
  scope that lacks a key of the sink (`invalid_scope`, naming
  `scopeDescription` or the keys), a stream whose filled-in owner is not the
  sink's registrant (`not_owner`), and a payload that fails its schema
  (`invalid_input`). It appends one row to the stream made by filling each
  placeholder with the call's scope value: the sink's scope keys in order,
  then `type`, then `event`, which is `{ type, ...payload }` redacted with
  `secrets/v1.redactions()` and made storable
  ([`src/shared/redact.ts`](src/shared/redact.ts)). After the commit it fires
  `core.event-hooks/v1.onEventAppendedHook` with `{ stream, type }` without
  waiting for it.
- A value that JSON cannot hold is stored as a marker: `[NaN]`, `[Infinity]`,
  `[Undefined]`, `[BigInt: n]`, `[Symbol: …]`, `[Function: name]`,
  `[Circular: path]`, `[RegExp: …]`, `[Invalid Date]`, or `[<Class>: …]` for an
  object with no readable property; a `Date` becomes its ISO text, binary data
  an array of bytes, and U+0000 and unpaired surrogates become U+FFFD.

### `models/v1`

Shape ([`models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)):

| Method                                       | Input                                                        | Output                                                           |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `resolve({ providerId, model, effort? })`    | a configured provider and model                              | `{ providerId, model, effort?, languageModel }`                  |
| `kinds()` (desktop)                          | none                                                         | advertised kind descriptors                                      |
| `kind(id)` (desktop)                         | a kind id                                                    | its descriptor or `undefined`                                    |
| `catalog({ kind, configuration })` (desktop) | a kind and its string values                                 | `{ status: 'read', models } \| { status: 'absent' \| 'failed' }` |
| `prepare(configuration)`                     | a configuration, or `{ configuration, revision, updatedAt }` | nothing                                                          |
| `contextWindow({ providerId?, model })`      | a model                                                      | a number or `undefined`                                          |
| `inputModalities({ providerId?, model })`    | a model                                                      | strings or `undefined`                                           |
| `icons({ requests })` (desktop)              | up to 64 requests                                            | `{ svgs, answers }`                                              |

A kind descriptor is `{ id, label, description, fields, lists, modelsFromCatalog?, site? }`:
`fields` are `{ key, label, kind: 'text'|'url'|'number'|'enum'|'secret', required, description?, placeholder?, options?, advanced? }`,
`lists` is a subset of `models` and `reasonings`, and `site` is `{ url (https), label }`.
A catalog model is `{ id, name?, reasonings, parameters, defaultEffort?, mandatory, … }`.
An icon request is `{ providerId, models }` or `{ kind, configuration, models }`,
with at most 1000 model names of at most 512 characters; an answer is
`{ provider?, models: (name | null)[] }`, and `svgs` maps each name used to an
SVG of at most 16 384 characters. The `languageModel` is a process-local
handle: in the process that built it, it is the provider's object; any use of
it in another process fails with `local_only`.

Behavior ([`src/host/models/index.ts`](src/host/models/index.ts)):

- The core watches every `models.provider/v1` record. Each record's `kind()`,
  `advertised()` and `catalogCapacity()` are read once and kept in
  registration order; a record whose descriptor cannot be read is left out,
  and one whose `catalogCapacity()` fails counts as `false`. When a record
  goes away, the providers it built are dropped
  ([`src/host/models/registry.ts`](src/host/models/registry.ts)).
- `kinds` answers the advertised descriptors in registration order; `kind`
  answers the first registered kind with the id, advertised or not.
- `catalog` answers `absent` for an unregistered kind. Otherwise it takes the
  kind's first `secret` field, reads the credential whose id that field holds
  through `secrets/v1.resolve` (a missing one sends no secret), and calls the
  record's `catalog`. A failure answers `failed` and logs the warning
  `Model catalog could not be read` with `{ kind }` only.
- `prepare` takes the provider list of a configuration (each `{ id, kind,
configuration, models?: { name }[] }`) and builds every provider, one at a
  time in list order, through the record of its kind
  ([`src/host/models/providers.ts`](src/host/models/providers.ts)). A provider
  receives its values without the `secret` fields and, when it names a
  credential in one, a `secret()` function that reads that credential through
  `secrets/v1` at each call, so a rotated credential reaches built providers;
  when `secrets/v1.resolve` fails for any reason (no credential stored under
  that id, a failed credential load, …), `secret()` answers `''`.
  A configuration with a `revision` becomes the active set; one without is a
  candidate that the next stored configuration with the same provider list
  activates without building again. Preparing the active revision again with
  the same providers does nothing. A list that is not an array, an invalid
  provider or an unknown kind throws.
- `resolve` answers the active set's built provider. With no active set, or a
  provider the set does not hold, or a provider whose record was replaced and
  cannot be built again, it throws `Configured provider is unavailable.`; a
  replaced record's provider is otherwise built again on first use.
- `contextWindow` and `inputModalities` look for exactly one candidate among
  the configured providers whose kind reports `catalogCapacity()`: the one
  named by `providerId`, or, without it, the ones that list the model. The
  candidate's built provider's `models()` entry for the model gives a finite
  capacity above 0, or its input modalities. Any other case answers
  `undefined`; neither throws ([`src/host/models/capacity.ts`](src/host/models/capacity.ts)).
- `icons` answers each request in parallel: it finds the kind and values (from
  the request, or from the configured provider), asks the kind's record within
  1000 ms (`PROVIDER_ICONS_DEADLINE_MS`), keeps only names of the `llms` icon
  set, and gives each model its own icon, else the provider's, else `null`. An
  unknown provider or kind, a record that fails or is late, or an answer of
  another length answers no provider icon and `null` per model. It reads no
  secret and builds no provider ([`src/host/models/icons.ts`](src/host/models/icons.ts)).

### `core.event-hooks/v1`

A hooks contract the host part owns ([`src/contracts/hooks.ts`](src/contracts/hooks.ts)):

| Hook                  | Kind    | Input                              | When                                                |
| --------------------- | ------- | ---------------------------------- | --------------------------------------------------- |
| `onEventAppendedHook` | observe | `{ stream: string, type: string }` | After `events/v1.append` commits a row; not awaited |

The hook names only where the row went: an observer reads the row from the
stream itself.

### `core.settings/v1` and `core.settings-generation/v1`

Storage types the host part defines through the active `storage/v1`
([`src/contracts/storage.ts`](src/contracts/storage.ts)):

| Type                          | Document id     | Value                                       | Indexes |
| ----------------------------- | --------------- | ------------------------------------------- | ------- |
| `core.settings/v1`            | the settings id | `{ value, version, updatedAt, generation }` | none    |
| `core.settings-generation/v1` | `global`        | `{ generation }`, an integer ≥ 0            | none    |

The document's revision is the space's revision.

## Desktop main process contracts

### `commands/v1`

Shape ([`commands.ts`](../../../packages/bundle/src/contracts/basic/commands.ts)),
in `desktopMain` and `client`: `register(command) → Disposable`, where the
command is a bound command (`{ id, input, execute }`, made with
`defineCommand`); `execute(command, input?, call?) → Promise<void>`, where
`command` is an id or a command reference.

Behavior in the main process ([`src/desktop/commands.ts`](src/desktop/commands.ts)):
`register` refuses an id already registered (`registration_conflict`).
`execute` refuses an unregistered id (`unknown_command`), parses the input
(`{}` when absent) with the command's schema (`invalid_input`), and runs the
command with the parsed input and the call. Menus and keybindings execute
with `{}`.

### `core.commands/v1`

`execute({ id, input }) → Promise<void>`, reachable from a desktop window
([`src/contracts/commands.ts`](src/contracts/commands.ts)). It runs the main
process's `commands/v1.execute(id, input ?? {})`; a miss there is
`unknown_command`, unchanged ([`src/desktop/commands-bridge.ts`](src/desktop/commands-bridge.ts)).
The window client sends here every command its own window does not hold.

### `core.open-settings/v1`

A command with the input `{ path?: string, defaultPath?: string }`
([`src/contracts/commands.ts`](src/contracts/commands.ts)), registered at
activation ([`src/desktop/commands.ts`](src/desktop/commands.ts)):

- With `path`, it opens the window of key `settings` at `path` through
  `doric.windows/v1.open`, which focuses an open settings window and navigates
  it when the path differs.
- Without `path`, an open settings window is only focused and keeps its
  section; with none open, a new one opens at `defaultPath`.
- With neither and no settings window open, it is `invalid_input` and nothing
  opens.

The settings window is 960 × 720, at least 720 × 520, with an integrated title
bar ([`src/desktop/appearance.ts`](src/desktop/appearance.ts)). The core
knows no settings route of its own.

### `windows/v1`

Shape ([`windows.ts`](../../../packages/bundle/src/contracts/basic/windows.ts)):
`open(request, call?) → Promise<void>`, reachable from a desktop window. A
request is exactly one of:

- `{ key, path, appearance?, primary? }`: a window that shows an app route;
- `{ key, view: { path (starting with "/"), partition, title? }, appearance?, primary? }`:
  a window that shows a page on the host, in its own session partition.

`appearance` is `{ size?: { width, height, minWidth?, minHeight? },
titleBar: 'native' | 'integrated' | 'none' (default 'integrated'),
background: token name (default 'window') }`. `primary` marks the one primary
window.

Behavior ([`src/desktop/windows.ts`](src/desktop/windows.ts)): an empty key is
`invalid_input`, before any hook runs. The request then passes through
`core.hooks/v1.onBeforeOpenWindowHook`, and `doric.windows/v1.open` opens the
adjusted request under the key `<caller bundle id>:<key>`: a handler may
change everything but the key.

### `core.hooks/v1`

A hooks contract the main process part owns and defines at activation
([`src/contracts/hooks.ts`](src/contracts/hooks.ts),
[`src/desktop/index.ts`](src/desktop/index.ts)):

| Hook                     | Kind      | Input                       | When                             |
| ------------------------ | --------- | --------------------------- | -------------------------------- |
| `onBeforeOpenWindowHook` | transform | a `windows/v1.open` request | Before the core opens the window |

### `menus/v1`

Shape ([`menus.ts`](../../../packages/bundle/src/contracts/basic/menus.ts)),
every method reachable from a desktop window. `when` is `{ path?, focus? }`,
where `path` is an active route pattern.

| Method                                                          | Output          |
| --------------------------------------------------------------- | --------------- |
| `addItem({ id, location, command, label, when?, order? })`      | `Promise<void>` |
| `addKeybinding({ command, key, when? })`                        | `Promise<void>` |
| `setContext({ key: 'path' \| 'focus', value: string \| null })` | `Promise<void>` |

`location` is `app/<menu>` or `dock`; `command` is a command id.

Behavior ([`src/desktop/menus.ts`](src/desktop/menus.ts)): `addItem` and
`addKeybinding` pass the item or binding to `doric.menus/v1` with `owner`, the
caller's `{ bundleId, version, generation }`. `setContext` sets the context
of the calling window, whose key it takes from `call.scope.windowKey`; a call
from no window is `invalid_input`. How main builds the menu, matches `when`
and dispatches commands is described in
[Native menus and keybindings](../../../docs/architecture/bundles/menus-and-keybindings.md).

### App start and activation

On `doric.app.hooks/v1.onAppReadyHook`, the main process part
([`src/desktop/index.ts`](src/desktop/index.ts)):

1. sets the menu skeleton through `doric.menus/v1.setSkeleton`: the top-level
   menus App, File, Edit, View, Window and Help, each an Electron role
   (`appMenu`, `fileMenu`, `editMenu`, `viewMenu`, `windowMenu`, `help`)
   ([`src/desktop/menu.ts`](src/desktop/menu.ts));
2. asks `doric.migrations/v1.storage` to copy the `localStorage` entry
   `doric.selection` from the `file://` origin to `doric://app` once, recorded
   under the marker `selectionOrigin`; a failure logs the warning
   `Selection migration did not run` and does not stop the next step
   ([`src/desktop/migrations.ts`](src/desktop/migrations.ts));
3. opens the primary window of key `workspace` at the path
   `doric.windows/v1.lastPath('workspace')` remembers, else `/`, at 1280 × 800,
   at least 960 × 640, with an integrated title bar
   ([`src/desktop/appearance.ts`](src/desktop/appearance.ts)).

On `onAppActivateHook`, it focuses the `workspace` window, or opens it again.

## Window client contracts

The client part activates once per window ([`src/client/index.ts`](src/client/index.ts)).
It provides `hooks/v1`, `log/v1` (without redaction), `ui/v1`, `navigation/v1`,
`regions/v1` and `commands/v1`; defines the elements `core-outlet`,
`core-region`, `core-not-found` and `core-unavailable`; intercepts same-origin
links; and reports the window's route to the menus. Its cleanup undoes the
last two. `ui/v1.define`, `create` and `dispose`, `navigation/v1.register`,
`chain` and `subscribe`, `regions/v1.items` and `subscribe`, and
`commands/v1.register` are local: a call from another process is refused with
`local_only`.

### `ui/v1`

Shape ([`ui.ts`](../../../packages/bundle/src/contracts/basic/ui.ts)):
`define(tag, elementClass) → Disposable`, `create(tag, props?) → element`,
`dispose(element) → void`.

Behavior ([`src/client/ui.ts`](src/client/ui.ts)):

- `define` refuses a tag that does not start with `<caller bundle id>-`
  (`invalid_input`) and registers the tag for its bundle with
  `doric.elements/v1`.
- `create` of a tag no active bundle owns answers a `<core-unavailable>` whose
  `data-tag` names the tag. Otherwise it creates the element, attaches it to
  a child scope of its owner's services, and assigns `props` to it.
- `dispose` acts once per element: it calls the element's `remove()` and
  `dispose()` when it has them, then releases the element's scope.

### `navigation/v1`

Shape ([`navigation.ts`](../../../packages/bundle/src/contracts/basic/navigation.ts)),
one per window:

| Method                                       | Output                                   |
| -------------------------------------------- | ---------------------------------------- |
| `register({ path, create(match), parent? })` | `Disposable`                             |
| `navigate(path, { replace? }?)`              | nothing                                  |
| `back()`                                     | nothing                                  |
| `forward()`                                  | nothing                                  |
| `history()`                                  | `{ canGoBack, canGoForward }`            |
| `current()`                                  | `{ path, pattern, params } \| undefined` |
| `chain()`                                    | `{ match, route }[]`, root first         |
| `subscribe(listener(match \| undefined))`    | `Disposable`                             |

`forward` and `history` are the contract's optional methods: a provider may
omit them. The core provides them exactly when the app's `navigationMethods`
lists both, so it serves the method list of the app it runs on
([`src/client/navigation.ts`](src/client/navigation.ts)).

Behavior ([`src/client/navigation.ts`](src/client/navigation.ts),
[`src/client/route-match.ts`](src/client/route-match.ts)):

- A route path starts with `/` and has no empty segment; a trailing `/` is
  dropped; `:name` is a parameter (`[A-Za-z_][A-Za-z0-9_]*`, not repeated).
  Anything else is `invalid_input`. A route with the same length and the same
  static and parameter positions as a registered one is `route_conflict`.
- Routes match the pathname only. Among matches, a static segment beats a
  parameter at the first position where two routes differ; parameter values
  are URI-decoded, and a malformed escape does not match.
- `chain()` is the matched route and its ancestors through `parent`, root
  first; a parent that is not registered, or a cycle, ends it. Each ancestor's
  `params` are the matched params it names. `current()` is the last entry's
  match. Both keep their identity until the match changes.
- `navigate` resolves the path against the window's URL and refuses another
  origin (scheme and host) with `invalid_input`. A path equal to the current
  one is ignored unless `replace` is set. It pushes or replaces a history
  entry, resolves the routes and notifies. `back` and `forward` move the
  window's history, and the `popstate` that follows notifies.
- Subscribers run after every navigation, Back and Forward, and after a
  registration or disposal that changes the match; a throwing subscriber is
  logged to the console.
- Each history entry the core writes holds exactly `{ doric: { index, max } }`,
  and the core keeps the current `index` and `max`. The first use reads the
  current entry, writing `index 0, max 0` into an entry without that state; a
  push sets `index + 1` and `max = index`; a replace keeps both; a `popstate`
  takes the landed entry's `index`, raises `max` to the largest of the known
  `max`, the entry's `max` and `index`, and writes it back, while an entry
  without state counts as `index 0`. `history()` answers `canGoBack = index > 0`
  and `canGoForward = index < max`. Nothing is written to `sessionStorage`,
  `localStorage` or a file: a reload keeps the list, and closing the window
  ends it.

### `regions/v1`

Shape ([`regions.ts`](../../../packages/bundle/src/contracts/basic/regions.ts)):
`add(region, { id, tag, props?, order? }) → Disposable`;
`items(region) → { id, tag, props?, order?, owner }[]`;
`subscribe(region, listener()) → Disposable`.

Behavior ([`src/client/regions.ts`](src/client/regions.ts)): `add` refuses an
id already in the region (`registration_conflict`) and records the caller as
`owner`. `items` answers the region's items sorted by `order`, absent last,
then by add order, as one frozen array kept until the region changes (an
empty frozen array for an unknown region). Listeners run after every change;
a throwing listener is logged to the console.

### `commands/v1` in a window

The same contract as in the main process. A command registered in the window
runs there; any other id is sent to `core.commands/v1.execute({ id, input })`
in the main process, and its `unknown_command` reaches the caller unchanged
([`src/client/commands.ts`](src/client/commands.ts)).

### Structural elements

Each element is `display: contents` once connected, and tears down only when
it is still disconnected a microtask after a disconnection, so a move within
the document keeps what it shows ([`src/client/elements/lifecycle.ts`](src/client/elements/lifecycle.ts)).

- `<core-outlet>` shows the route of its depth in `navigation/v1.chain()`,
  where the depth is the number of `<core-outlet>` ancestors, across shadow
  roots. The same route and pattern keep their element and receive the new
  params as properties; another route disposes the element through `ui/v1`
  and creates the new one with the route's `create(match)`, and an element
  that cannot be created is logged to the console. The outermost outlet shows
  `<core-not-found path>` when no route matches; a deeper outlet with no entry
  shows nothing ([`src/client/elements/outlet.ts`](src/client/elements/outlet.ts)).
- `<core-region name>` shows the items of that region in order, creating each
  once with `ui/v1.create(tag, props)` and disposing it when it leaves
  ([`src/client/elements/region.ts`](src/client/elements/region.ts)).
- `<core-not-found>` shows a status line "Nothing is registered at `<path>`."
  and leaves the URL as it is ([`src/client/elements/not-found.ts`](src/client/elements/not-found.ts)).
- `<core-unavailable>` is hidden and empty; its `data-tag` names the tag that
  was asked for ([`src/client/elements/unavailable.ts`](src/client/elements/unavailable.ts)).

### Links and the menu context

- A plain primary click (no modifier key, not already handled) on an `<a
href>` without `target` or `download`, whose URL is in the window's origin,
  is cancelled and becomes `navigation/v1.navigate(pathname + search + hash)`;
  every other click keeps the browser's behavior
  ([`src/client/links.ts`](src/client/links.ts),
  [`src/client/origin.ts`](src/client/origin.ts)).
- At activation and after each navigation that changes it, the window sets its
  `path` menu context to the active route pattern, or `null` when none
  matches, through `menus/v1.setContext`; a failure logs the error
  `Could not set the menu context of the window path.`
  ([`src/client/menu-context.ts`](src/client/menu-context.ts)).

## Public entry point

The package export `core/contracts` ([`src/contracts/index.ts`](src/contracts/index.ts))
holds:

- the hooks contracts `CoreHooksV1` and `CoreEventHooksV1`, and their hooks
  as separate exports, `onBeforeOpenWindowHook` and `onEventAppendedHook`
  ([`src/contracts/hooks.ts`](src/contracts/hooks.ts));
- `OpenSettingsCommandV1` and `openSettingsInput`, `CoreCommandsV1`,
  `CoreCommands`, `coreCommandsExecuteInput` and `coreCommandsMethods`
  ([`src/contracts/commands.ts`](src/contracts/commands.ts));
- the storage types `settingsType` and `settingsGenerationType`, and
  `settingsGenerationId` (`global`) ([`src/contracts/storage.ts`](src/contracts/storage.ts));
- the model catalog fill that the host configuration runs over
  `models/v1.catalog` ([`src/host/models/catalog.ts`](src/host/models/catalog.ts)):
  - `readModelProperties(configuration, read, listed?)` reads, in parallel,
    the catalog of every provider that lists models or whose kind's list is
    its catalog (`listed`). For a listed provider, its models become every
    model the catalog names, trimmed and without duplicates, in catalog
    order; for another, each model it lists gets the catalog's `reasonings`,
    `defaultEffort` and `mandatory: true` when set, and a model the catalog
    does not name gets no efforts. A catalog that cannot be read leaves its
    provider unchanged. It then applies `executionProfile`.
  - `executionProfile(providers, configuration)` resolves
    `models.execution` against the model it names: an effort already named
    stays; a model with no efforts drops the effort; otherwise the effort is
    the model's `defaultEffort` when it is one of its efforts, else its first
    effort other than `none`. A model with no `reasonings` key leaves the
    profile unchanged.
  - the types `FillConfiguration`, `FillProvider`, `FillModel`,
    `CatalogReader` and `CatalogListed`.

## Data and side effects

- **Host storage:** the documents of `core.settings/v1` and
  `core.settings-generation/v1`; the rows `events/v1.append` writes to the
  sink's streams; credentials through `secrets.backend/v1`. Everything else
  the core keeps (registries, the credential cache, the settings cache, the
  provider sets) is in memory and starts empty in each process.
- **Desktop file:** `settings.json` in the core's `doric.cache/v1` directory,
  shape above.
- **Windows and menus:** the `workspace` and `settings` windows, the menu
  skeleton, and the copy of `doric.selection` into the `doric://app` origin.
- **Browser history:** one `{ doric: { index, max } }` state per history entry
  of each window.
- **Logs and diagnostics:** the log records written for callers; the warnings
  `Model catalog could not be read` (with `{ kind }`) and
  `Selection migration did not run` (with `{ marker: 'selectionOrigin' }`);
  the info line `Activating stored credentials`; in a window, the error
  `Could not set the menu context of the window path.` (with `{ error }`);
  the console errors of a failing navigation or region listener and of a
  route element that cannot be created; the diagnostics kinds
  `hook_handler_failed`, `hook_handler_timeout`, `log_write_failed` and
  `settings_listener_failed`.

## Configuration and limits

The core reads no environment variable and no setting of its own; a credential
key that the backend needs is the backend's configuration.

| Limit                              | Value                          | Where                                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| Hook handler deadline              | 10 000 ms                      | [`src/shared/hooks.ts`](src/shared/hooks.ts)                            |
| Provider `icons` deadline          | 1000 ms                        | [`src/host/models/icons.ts`](src/host/models/icons.ts)                  |
| `storage/v1.query` `limit`         | 1 to 1000                      | [`storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts) |
| Batch, document and event size     | the backend's `capabilities()` | [`batch.ts`](../../../packages/storage/src/batch.ts)                    |
| Event sink keys and stream         | 1–16 keys, 256 characters      | [`events.ts`](../../../packages/bundle/src/contracts/basic/events.ts)   |
| Icon requests, models, names, SVGs | 64, 1000, 512, 16 384          | [`models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)   |

The host part's `createActivate({ hooks: { deadlineMs }, now })` and the main
process part's `createActivate` take a hook deadline (0 or less: none) and a
clock for settings write times; the shipped parts use the defaults
([`src/host/index.ts`](src/host/index.ts), [`src/desktop/index.ts`](src/desktop/index.ts)).

## Build and test

```console
npx nx run bundle-core:build
npx nx run bundle-core:typecheck
npx nx run bundle-core:test
```

- `build` compiles `src/` (host, shared and contracts) with
  [`tsconfig.json`](tsconfig.json) and runs the bundle build, which writes the
  parts, the manifest and the contract descriptor with its JSON Schemas to
  `dist/` ([`project.json`](project.json)). `doric-host:build-bundles` stages
  it into the host.
- `typecheck` checks the host and shared code, the main process part
  ([`tsconfig.parts.json`](tsconfig.parts.json)) and the client part with the
  DOM library ([`tsconfig.client.json`](tsconfig.client.json)).
- `test` builds this bundle and the bundles its tests load, compiles
  `tests/`, and runs `tests/*.test.ts` (host), `tests/desktop/` (main process)
  and `tests/client/` (windows on `happy-dom`) with `node --test`.
