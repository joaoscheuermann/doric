# bundle

`bundle` is the platform package of Doric's bundles. Every feature of Doric —
agent tools, skills, model providers, sandboxes, storage, the agent runtime and
every part of the desktop UI — is a bundle that provides and consumes typed,
versioned service contracts. This package holds what makes that work:

- the contract API bundles are written against (`bundle/contracts`);
- the service runtime every environment shares: service directory, dispatcher,
  calls, catalog resolution, activation loop, the process envelope
  (`bundle/runtime`);
- the Node side of the host: discovery, the catalog, the kernel and its
  generation processes, the build CLI (`bundle`);
- in-process test harnesses for bundles (`bundle/testing`);
- the import-map specifiers a client part leaves to its window
  (`bundle/externals`) and the generated JSON Schemas (`bundle/schemas/*`).

Part of [Doric](../../README.md). The cross-unit mechanisms this package
implements are described in the architecture documents linked from each
section; this README is the home of the package's exports and of its build
tooling.

## Who uses it

| Kind     | Users                                                                                                                                                                                                                                                                                   | Entries                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Bundles  | Every bundle under [`/bundles`](../../bundles): its parts, its contracts module, its tests, and its `build` target                                                                                                                                                                      | `bundle/contracts`, `bundle/testing`, the build CLI |
| Bundles  | The embedded foundation host parts [`host-config`](../../bundles/foundation/host-config/README.md), [`postgres`](../../bundles/foundation/postgres/README.md) and [`transport`](../../bundles/foundation/transport/README.md) (`EmbeddedBundle`; `host-config` also `contractDocument`) | `bundle` (types), `bundle/runtime`                  |
| Apps     | [`doric-host`](../../app/backend/doric-host/README.md) boots the kernel with `startKernel` and serves the bridge (`PLATFORM_VERSION`, exposure)                                                                                                                                         | `bundle`, `bundle/runtime`, `bundle/contracts`      |
| Apps     | The desktop app [`doric`](../../app/desktop/doric/README.md) runs `desktopMain` generations and the window bridge                                                                                                                                                                       | `bundle/runtime`, `bundle/contracts`                |
| Packages | [`tool`](../tool/README.md) (`defineTool` over `tools/v1`), [`storage`](../storage/README.md) (in-memory foundation), `desktop` (window bootstrap, elements)                                                                                                                            | `bundle/contracts`, `bundle/runtime`, `bundle`      |
| Packages | The package's own build ([`parts.ts`](src/build/parts.ts))                                                                                                                                                                                                                              | `bundle/externals`                                  |

## Entry points

`package.json` `exports` ([`package.json`](package.json)); each entry resolves
to `src/` under the `@org/source` condition and to `dist/` otherwise.

| Entry              | Source                                             | Runs in          | Audience                                                                      |
| ------------------ | -------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `bundle/contracts` | [`src/contracts/index.ts`](src/contracts/index.ts) | Node and browser | Bundle authors                                                                |
| `bundle/runtime`   | [`src/runtime/index.ts`](src/runtime/index.ts)     | Node and browser | Apps, `desktop`, embedded foundation host parts, bundle tests                 |
| `bundle`           | [`src/index.ts`](src/index.ts)                     | Node             | The host, build tooling, embedded foundation host parts (types), bundle tests |
| `bundle/testing`   | [`src/testing/index.ts`](src/testing/index.ts)     | Node and browser | Bundle unit tests                                                             |
| `bundle/externals` | [`src/build/externals.ts`](src/build/externals.ts) | Node and browser | Build tooling                                                                 |
| `bundle/schemas/*` | `dist/schemas/*`, written by the build             | Data             | Anyone                                                                        |

`bundle/contracts` and `bundle/runtime` import only relative modules and
`zod`: `tsconfig.browser.json` typechecks them with the DOM library and no Node
types, and a test walks their import graph
([`tsconfig.browser.json`](tsconfig.browser.json),
[`browser-safe.test.ts`](tests/browser-safe.test.ts)). `bundle/externals`
imports nothing, so a consumer reads it without loading esbuild.

Dependencies: `zod` (schemas), `ajv` (JSON Schema validation in the host
processes), `yaml` (skill frontmatter); the build loads `esbuild` and Tailwind
only when it builds parts ([`package.json`](package.json),
[`cli.ts`](src/build/cli.ts)).

## Writing a bundle

```ts
import {
  defineMethod,
  defineService,
  type HostContext,
} from 'bundle/contracts';
import { z } from 'zod';

export const greeter = defineService('greeter.api/v1', {
  greet: defineMethod({
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ text: z.string() }).strict(),
    execute: ({ name }, call) => ({
      text: `${name} from ${call.caller.bundleId}`,
    }),
  }),
});

export const activate = ({ services }: HostContext) => {
  services.provide(greeter);
};
```

`manifest.json` declares the bundle's identity, the platform range and the
contracts it provides and requires:

```json
{
  "manifestVersion": 1,
  "id": "greeter",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "provides": ["greeter.api/v1@1.0.0"],
  "requires": []
}
```

The manifest's fields and rules are described in [The bundle
manifest](../../docs/architecture/bundles/manifest.md); what `activate`
receives in [Contexts and capabilities](../../docs/architecture/bundles/contexts.md);
the `define*` family as a whole in [Contracts and the `define*`
family](../../docs/architecture/bundles/contracts.md).

A bundle directory has these sources, each built only when it exists
([`cli.ts`](src/build/cli.ts), [`parts.ts`](src/build/parts.ts)):

| Source                         | Output (below `dist/`)               | Notes                                                                                             |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `src/host/index.ts`            | `host/index.js`                      | Compiled by `tsc`; the host imports it                                                            |
| `src/host/**/*.md`             | `host/**/*.md`                       | Templates the host part reads at import time                                                      |
| `src/desktop/index.ts`         | `desktop/index.js`                   | esbuild, Node 22, ESM                                                                             |
| `src/client/index.ts`          | `client/index.js`                    | esbuild, browser ES2022, ESM; window import-map specifiers stay external                          |
| `src/client/styles.css`        | `client/styles.css`                  | Tailwind over the platform theme, followed by the CSS esbuild extracted from the client's imports |
| `src/client/workers/<name>.ts` | `client/workers/<name>.js`           | Nothing external                                                                                  |
| `src/client/chunks/<name>.ts`  | `client/chunks/<name>.js` (+ `.css`) | Window modules the client entry imports on demand; built only with a client entry                 |
| `src/client/frames/<name>.ts`  | `client/frames/<name>.js`            | Modules for a document outside the window, with the frame import map                              |
| `src/contracts/index.ts`       | `contracts/index.js`                 | Compiled by `tsc`; other bundles import it as `<id>/contracts`                                    |
| `src/skills/<name>/SKILL.md`   | `skills/<name>/SKILL.md`             | Validated and copied                                                                              |

## `bundle/contracts`

The browser-safe API a bundle part, a contracts module or a test imports
([`src/contracts/index.ts`](src/contracts/index.ts)). Every export below is
listed with its signature.

### Ids and environments

From [`ids.ts`](src/contracts/ids.ts):

```ts
type ContractId = `${string}/v${number}`;
type Environment = 'host' | 'desktopMain' | 'client';
const environments: readonly Environment[]; // ['host', 'desktopMain', 'client']
const contractIdPattern: RegExp; // /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\/v[1-9][0-9]*$/
function isContractId(value: unknown): value is ContractId;
function isPlatformContract(id: string): boolean; // id starts with "doric."
function majorOf(id: string): number; // "git.commands/v2" → 2; TypeError when malformed
```

A contract whose id starts with `doric.` belongs to the platform: it always
exists, no manifest lists it, and only the platform defines it. A bundle id
matches `/^[a-z][a-z0-9-]*$/` and is never `doric`
([`ids.ts`](src/contracts/ids.ts), [`manifest.ts`](src/runtime/manifest.ts)).

### The `define*` functions

Each `define*` function validates its argument when it runs and returns a
frozen object branded with its kind (`Symbol.for('doric.definition')`), which
the runtime and the build recognize even across copies of the module. Every
check failure is a `TypeError` thrown at definition time
([`define.ts`](src/contracts/define.ts)). `defineHooks`, `defineService`,
`defineEvent`, `defineCommand`, `defineSettings` and `defineStorageType` refuse
an id that does not match `contractIdPattern` (`Invalid <what> contract ID
"<id>".`) and an id that starts with `doric.` (`The <what> contract ID "<id>"
is reserved for the platform.`).

#### `defineHook` and `defineHooks`

```ts
type HookKind = 'observe' | 'transform' | 'decide' | 'sequence';
type HookOrder = 'activation' | 'reverse';
type HookOwnerView<T> = (input: T, bundleId: string) => T | undefined;
type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };
const decisionSchema: z.ZodType<Decision>; // strict union of the two shapes

function defineHook<K extends HookKind, I extends z.ZodType>(definition: {
  readonly kind: K;
  readonly input: I;
  readonly order?: HookOrder; // sequence only; default 'activation'
  readonly forOwner?: HookOwnerView<z.output<I>>; // observe only
}): HookDefinition<K, I>;

interface HookDefinition<K, I> {
  readonly kind: K;
  readonly input: I;
  readonly order?: HookOrder;
  readonly forOwner?: HookOwnerView<z.output<I>>;
}

function defineHooks<
  const Id extends ContractId,
  H extends Record<string, HookDefinition>,
>(id: Id, hooks: H): HooksContract<Id, H>;

interface HooksContract<Id, H> {
  readonly type: 'hooks';
  readonly id: Id;
  readonly hooks: H; // frozen copy
}
function isHooksContract(value: unknown): value is HooksContract;
```

`defineHook` throws on an unknown kind, on `order` for a kind other than
`sequence` and on `forOwner` for a kind other than `observe`. `defineHooks`
throws when a member was not made with `defineHook` (`Hook "<name>" of "<id>"
must be created with defineHook.`). A hook has no output schema: the kind
fixes what a handler returns — nothing for `observe` and `sequence`, a value of
the input schema for `transform`, a `Decision` for `decide`. `forOwner` gives
each handler's bundle its own view of an `observe` input, or skips that
handler when it returns `undefined`. How hooks are owned, registered and fired
is described in [Hooks](../../docs/architecture/bundles/hooks.md).

#### `defineMethod` and `defineService`

```ts
type MethodExposure = 'desktop';
const methodExposures: readonly ['desktop'];
function isMethodExposure(value: unknown): value is MethodExposure;

function defineMethod<
  I extends z.ZodType,
  O extends z.ZodType,
  R extends DeepReadonly<z.input<O>> | Promise<DeepReadonly<z.input<O>>>,
>(method: {
  readonly input: I;
  readonly output: O;
  readonly expose?: MethodExposure; // absent: no window may call it
  readonly execute: (input: z.output<I>, call: Call, services: Services) => R;
}): MethodDefinition<I, O, R>;

interface MethodDefinition<I, O, R> {
  readonly input: I;
  readonly output: O;
  readonly expose?: MethodExposure;
  execute(input: z.output<I>, call: Call, services: Services): R;
}
type AnyMethodDefinition = MethodDefinition<z.ZodType, z.ZodType>;

type Cardinality = 'one' | 'many';
interface ServiceOptions {
  readonly cardinality: 'many';
}

function defineService<
  const Id extends ContractId,
  M extends Record<string, AnyMethodDefinition>,
>(id: Id, methods: M, options?: ServiceOptions): ServiceDefinition<Id, M>;
function defineService<
  R extends AnyServiceRef,
  M extends ImplementationOf<R> & Record<string, AnyMethodDefinition>,
>(
  contract: R,
  methods: M,
  options?: ServiceOptions,
): ServiceDefinition<RefId<R>, M>;

interface ServiceDefinition<Id, M> {
  readonly type: 'service';
  readonly id: Id;
  readonly cardinality: Cardinality; // 'one' unless options say 'many'
  readonly methods: M; // frozen copy
}
type AnyServiceDefinition = ServiceDefinition<
  ContractId,
  Record<string, AnyMethodDefinition>
>;
function isServiceDefinition(value: unknown): value is AnyServiceDefinition;
```

`defineMethod` throws when `execute` is not a function (`A method needs an
execute function.`) and when `expose` is not one of `methodExposures`.
`defineService` throws when a member was not made with `defineMethod` and when
`options` is anything but `{ cardinality: 'many' }`. Passing a `ref` in place
of the id makes the compiler check the methods against the interface the ref
carries ([`types.ts`](src/contracts/types.ts)). The `services` argument of
`execute` is the providing bundle's own `Services`, bound when it calls
`services.provide`. An output schema must be descriptive (no default,
transform or pipe): the runtime validates a result and returns the original
value, never the parsed copy ([`dispatch.ts`](src/runtime/dispatch.ts)).

#### `defineEvent`, `defineCommand`, `defineSettings`, `defineStorageType`

```ts
function defineEvent<
  const T extends ContractId,
  P extends z.ZodObject,
>(definition: { readonly type: T; readonly payload: P }): EventDefinition<T, P>;
interface EventDefinition<T, P> {
  readonly kind: 'event';
  readonly type: T;
  readonly payload: P;
}

function defineCommand<
  const Id extends ContractId,
  I extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly input: I;
  readonly execute: (
    input: z.output<I>,
    call: Call,
    services: Services,
  ) => void | Promise<void>;
}): CommandDefinition<Id, I>;
interface CommandDefinition<Id, I> extends Registrable<BoundCommand<Id, I>> {
  readonly kind: 'command';
  readonly id: Id;
  readonly input: I;
  execute(
    input: z.output<I>,
    call: Call,
    services: Services,
  ): void | Promise<void>;
}
interface BoundCommand<Id, I> {
  readonly id: Id;
  readonly input: I;
  execute(input: z.output<I>, call: Call): Promise<void>;
}

function defineSettings<
  const Id extends ContractId,
  S extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly schema: S;
}): SettingsDefinition<Id, S>;
interface SettingsDefinition<Id, S> {
  readonly kind: 'settings';
  readonly id: Id;
  readonly schema: S;
}

interface StorageIndex {
  readonly name: string;
  readonly fields: readonly string[]; // property paths of the schema
  readonly unique?: boolean;
}
function defineStorageType<
  const T extends ContractId,
  S extends z.ZodObject,
>(definition: {
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[];
}): StorageTypeDefinition<T, S>;
interface StorageTypeDefinition<T, S> {
  readonly kind: 'storage-type';
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[]; // frozen copies
}
```

A command is `Registrable`: when `commands/v1.register` receives it, the
runtime binds it to the registering bundle's services, so its `execute` later
receives `(input, call, services)` with that bundle's services
([`define.ts`](src/contracts/define.ts), [`registrable.ts`](src/contracts/registrable.ts)).
Events are registered with `events/v1`, settings with `settings/v1` and storage
types with `storage/v1.defineType`; see [Events and
nodes](../../docs/architecture/bundles/events-and-nodes.md) and
[Storage](../../docs/architecture/bundles/storage.md).

#### `ref`

```ts
function ref<T, Impl = ImplFrom<T>>(
  id: ContractId,
): ServiceRef<ApiFrom<T>, Impl>;
function isServiceRef(value: unknown): value is AnyServiceRef; // { kind: 'ref', id: string }

interface ServiceRef<
  Api = unknown,
  Impl = Api,
  Id extends ContractId = ContractId,
> {
  readonly kind: 'ref';
  readonly id: Id;
  // type-only: the API and the implementation the ref carries
}
```

A ref holds only the contract id at run time; its type parameters carry the
API. `ref` checks the id against `contractIdPattern` and accepts `doric.*`.
`T` is an interface (`ref<Git>('git.commands/v1')`) or a service definition,
whose methods become the stubs ([`define.ts`](src/contracts/define.ts),
[`types.ts`](src/contracts/types.ts)).

### Types of the stubs

From [`types.ts`](src/contracts/types.ts):

| Type                      | Meaning                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `AnyServiceRef`           | `ServiceRef<unknown, unknown, ContractId>`                                                                                               |
| `ApiOf<R>`                | The API a ref exposes: the type `services.use(R)` returns                                                                                |
| `ApiFrom<T>`              | The API derived from a definition (`StubsOf` its methods), a `CommandApi` for a command, or `T` itself for an interface                  |
| `ImplementationOf<R>`     | What `defineService(ref, methods)` must provide: one `MethodDefinition` per interface method, whose input drops the trailing `CallArg`   |
| `RefId<R>`                | The id of a ref                                                                                                                          |
| `StubOf<D>`, `StubsOf<M>` | A method's consumer stub: `(input, call?) => output` — `(...items, call?)` for a tuple input — returning a `Promise` when `execute` does |
| `CommandApi<Id, I>`       | The dispatch handle `commands/v1.execute` takes for a command ref: `{ id?, input? }`                                                     |
| `JsonValue`, `JsonObject` | Readonly JSON values                                                                                                                     |

### `Services` and the part contexts

From [`context.ts`](src/contracts/context.ts):

```ts
interface Disposable {
  dispose(): void;
} // idempotent
type Cleanup = () => void | Promise<void>;
interface ProviderInfo {
  readonly bundleId: string;
  readonly version: string;
}

interface Services {
  provide<D extends AnyServiceDefinition>(definition: D): Disposable;
  use<R extends AnyServiceRef>(contract: R, scope?: CallScope): ApiOf<R>;
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
```

A part's module exports `activate: Activate<…>`. The runtime implements
`Services` per bundle ([`services.ts`](src/runtime/services.ts)):

- `provide(definition)` registers a provider record in the environment's
  directory and tracks it in the current disposal scope. It throws
  `invalid_input` for a value not made with `defineService`,
  `undeclared_provide` when the bundle's descriptor does not list the contract
  in this environment, `cardinality_mismatch` when the definition's
  cardinality differs from the one the catalog publishes, `contract_mismatch`
  when a basic contract's provider does not implement exactly the platform's
  method table with the same JSON Schemas (only the table's `optional`
  methods may be omitted) or declares an exposure the platform does not give,
  and `provider_conflict` when a `one` contract already has a provider. When
  the composition chose another bundle as the provider of a `one` contract,
  `provide` registers nothing and returns an inert `Disposable`.
- `use(contract, scope?)` returns a late-binding stub: each method call
  resolves the active provider at call time. It throws `invalid_input` for a
  value that is not a ref, `many_contract_use` for a contract of cardinality
  `many`, and `undeclared_requirement` for a contract the manifest lists in
  neither `requires`, `optional` nor `provides` (a `doric.*` contract always
  passes; the composition's core may use every basic contract). `scope` binds
  scope keys to every call the stub makes. `use(HooksV1)` returns the hooks
  facade, whose `use(contract)` applies the same `requires` rule.
- `whenAvailable(contract, callback)` subscribes to the contract's providers:
  the callback runs for each provider now and for each one that registers
  later, with a stub pinned to it, inside a child disposal scope. The cleanup
  it returns (directly or as a promise's value) and everything it registered
  are disposed when that provider goes away or when the returned `Disposable`
  is disposed. A throw or a rejection is reported as `when_available_failed`.

A stub method takes its input and, last and optional, the parent `call` or
`CallOptions`. It validates the input with the provider's schema
(`invalid_input`), creates the hop's `Call`, invokes the provider, validates
the result (`invalid_output`), tracks a returned `Disposable` in the caller's
current scope, and returns the original value. A missing provider or method
is `unavailable`; a stub of a deactivated bundle refuses with `unavailable`
([`dispatch.ts`](src/runtime/dispatch.ts)). The rules are described with
examples in [Contexts and capabilities](../../docs/architecture/bundles/contexts.md).

### `Call`

From [`call.ts`](src/contracts/call.ts):

```ts
type CallScope = Readonly<Record<string, string>>;
interface Caller {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number;
}
interface TraceContext {
  readonly traceparent: string;
} // 00-<32 hex>-<16 hex>-01
interface Call {
  readonly caller: Caller;
  readonly scope?: CallScope;
  readonly signal: AbortSignal;
  readonly trace: TraceContext;
}
interface CallOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
} // epoch ms; 0 = none
type CallArg = Call | CallOptions;

const windowScopeKey = 'windowKey';
const scopeKeyPattern: RegExp; // /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SCOPE_MAX_KEYS = 16;
const SCOPE_MAX_VALUE = 512;
const callScopeSchema: z.ZodType<CallScope>;
const callGeneration: unique symbol; // Symbol.for('doric.call.generation')

function isCall(value: unknown): value is Call; // branded by the runtime
function isCallOptions(value: unknown): value is CallOptions;
function deadlineOf(call: Call): number; // 0 when none
function generationOf(call: Call): number; // 0 = kernel-originated, unpinned
```

Only the runtime creates a `Call`: it carries the non-enumerable brand
`Symbol.for('doric.call')`, its deadline and the generation it is pinned to.
`isCallOptions` accepts only a plain object whose own keys are a non-empty
subset of `signal` (an `AbortSignal`) and `deadline` (a finite number). How a
hop builds its call is in [`createHopCall`](#calls-traces-and-scopes); the
scope keys and their owners are in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#scope-keys).

### Errors

From [`error.ts`](src/contracts/error.ts):

```ts
class ContractError extends Error {
  readonly name: 'ContractError';
  readonly code: string;
  readonly details?: unknown;
  constructor(code: ContractErrorCode | (string & {}), message: string, details?: unknown);
}
const contractErrorCodes: readonly [...]; // listed below
type ContractErrorCode = (typeof contractErrorCodes)[number];
function isContractError(value: unknown): value is ContractError; // by name, code and message, never instanceof
function toContractError(value: unknown): ContractError;          // anything else becomes 'internal'
```

Every contract boundary throws a `ContractError`. The codes the platform
raises are an open set; callers match on `code`:

| Group                              | Codes                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                            | `internal`, `invalid_input`, `invalid_output`, `unavailable`, `undeclared_requirement`, `undeclared_provide`, `many_contract_use`, `cardinality_mismatch`, `provider_conflict`, `contract_mismatch`, `local_only`, `not_owner`, `registration_conflict`, `duplicate_tool`, `duplicate_skill`, `unavailable_tool` |
| Process envelope                   | `generation_lost`, `protocol_error`                                                                                                                                                                                                                                                                              |
| `storage/v1`, `storage.backend/v1` | `revision_conflict`, `sequence_conflict`, `unique_conflict`, `limit_exceeded`, `unknown_type`, `invalid_index_value`, `invalid_stream`                                                                                                                                                                           |
| `settings/v1`                      | `unknown_settings`, `settings_missing`, `settings_conflict`                                                                                                                                                                                                                                                      |
| `events/v1`                        | `unknown_event`, `invalid_scope`                                                                                                                                                                                                                                                                                 |
| `secrets/v1`, `secrets.backend/v1` | `credential_missing`, `credential_invalid`, `credential_name_taken`, `credential_kind_immutable`, `credential_ambiguous`, `credential_storage_unavailable`, `credential_key_required`, `credential_unreadable`, `unknown_kind`, `duplicate_credential_kind`                                                      |
| Desktop platform                   | `not_found`, `disconnected`, `unknown_command`, `route_conflict`                                                                                                                                                                                                                                                 |

### Registration and exposure helpers

```ts
const bindRegistrant: unique symbol; // Symbol.for('doric.bind-registrant')
interface Registrable<B> {
  [bindRegistrant](services: Services): B;
}
function isRegistrable(value: unknown): value is Registrable<unknown>;
```

A registration that needs its registrant's services (a command, a tool of the
`tool` package) implements `[bindRegistrant]`; the runtime calls it with the
caller's services before the provider receives the argument
([`registrable.ts`](src/contracts/registrable.ts)).

### Skills

From [`skill.ts`](src/contracts/skill.ts):

```ts
interface SkillSchemaInput {
  readonly name: string; readonly description: string; readonly body: string;
  readonly allowedTools: readonly string[]; readonly indexText?: string;
}
interface SkillRecord { /* the same, with indexText: string */ }
const skillRecordSchema: z.ZodType<SkillRecord>; // strict; non-empty trimmed strings
const SkillSchema: z.ZodCodec<…>;                 // SkillSchemaInput → SkillRecord
```

Decoding with `SkillSchema` removes duplicate `allowedTools` and sets
`indexText` to `` `${name} | ${description} | ${allowedTools.join(',')} | ${body}` ``,
whatever `indexText` the input had.

### Basic contracts

The platform declares each basic contract — id, cardinality, environments and
method table — and `bundle/contracts` exports its ref, its interface and its
method table (`<name>Methods`). A provider must implement exactly that table
([`basic/index.ts`](src/contracts/basic/index.ts),
[`services.ts`](src/runtime/services.ts)). The methods, data and errors of
each contract are described with its provider: the contracts `core` provides
in the [core README](../../bundles/foundation/core/README.md); the backends
with [`postgres`](../../bundles/foundation/postgres/README.md);
`models.provider/v1`, which `core` consumes, with each model provider (for
example [`claude`](../../bundles/providers/claude/README.md#provided-contract-modelsproviderv1-130))
and in [Models and providers](../../docs/features/models-and-providers.md).

```ts
interface BasicContractSpec {
  readonly cardinality: Cardinality;
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
  readonly optional: readonly string[]; // methods a provider may omit
}
const basicContracts: Readonly<Record<BasicContractId, BasicContractSpec>>;
type BasicContractId = keyof typeof basicContracts;
function isBasicContract(id: string): id is BasicContractId;
function basicContractSpec(id: string): BasicContractSpec | undefined;
```

| Contract             | Ref                | Environments            | Cardinality | Optional methods     | Source                                               |
| -------------------- | ------------------ | ----------------------- | ----------- | -------------------- | ---------------------------------------------------- |
| `hooks/v1`           | `HooksV1`          | all                     | one         |                      | [`hooks.ts`](src/contracts/basic/hooks.ts)           |
| `log/v1`             | `LogV1`            | all                     | one         |                      | [`log.ts`](src/contracts/basic/log.ts)               |
| `tools/v1`           | `ToolsV1`          | `host`                  | one         |                      | [`tools.ts`](src/contracts/basic/tools.ts)           |
| `skills/v1`          | `SkillsV1`         | `host`                  | one         |                      | [`skills.ts`](src/contracts/basic/skills.ts)         |
| `settings/v1`        | `SettingsV1`       | `host`, `desktopMain`   | one         |                      | [`settings.ts`](src/contracts/basic/settings.ts)     |
| `secrets/v1`         | `SecretsV1`        | `host`                  | one         |                      | [`secrets.ts`](src/contracts/basic/secrets.ts)       |
| `secrets.backend/v1` | `SecretsBackendV1` | `host`                  | one         |                      | [`secrets.ts`](src/contracts/basic/secrets.ts)       |
| `storage/v1`         | `StorageV1`        | `host`                  | one         |                      | [`storage.ts`](src/contracts/basic/storage.ts)       |
| `storage.backend/v1` | `StorageBackendV1` | `host`                  | one         |                      | [`storage.ts`](src/contracts/basic/storage.ts)       |
| `events/v1`          | `EventsV1`         | `host`                  | one         |                      | [`events.ts`](src/contracts/basic/events.ts)         |
| `models/v1`          | `ModelsV1`         | `host`                  | one         |                      | [`models.ts`](src/contracts/basic/models.ts)         |
| `models.provider/v1` | `ModelsProviderV1` | `host`                  | many        |                      | [`models.ts`](src/contracts/basic/models.ts)         |
| `commands/v1`        | `CommandsV1`       | `desktopMain`, `client` | one         |                      | [`commands.ts`](src/contracts/basic/commands.ts)     |
| `ui/v1`              | `UiV1`             | `client`                | one         |                      | [`ui.ts`](src/contracts/basic/ui.ts)                 |
| `navigation/v1`      | `NavigationV1`     | `client`                | one         | `forward`, `history` | [`navigation.ts`](src/contracts/basic/navigation.ts) |
| `regions/v1`         | `RegionsV1`        | `client`                | one         |                      | [`regions.ts`](src/contracts/basic/regions.ts)       |
| `windows/v1`         | `WindowsV1`        | `desktopMain`           | one         |                      | [`windows.ts`](src/contracts/basic/windows.ts)       |
| `menus/v1`           | `MenusV1`          | `desktopMain`           | one         |                      | [`menus.ts`](src/contracts/basic/menus.ts)           |

Each source file also exports the contract's types and zod schemas, listed in
[Exports per source file](#exports-per-source-file). The exported helpers
with behavior of their own are:

```ts
// common.ts — shared schemas of the method tables
interface MethodSpec {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly expose?: MethodExposure;
}
type MethodSpecs = Readonly<Record<string, MethodSpec>>;
const disposableSchema: z.ZodType<Disposable>; // meta { 'x-doric-local': 'disposable' }
function isDisposable(value: unknown): value is Disposable;
function isDisposableSchema(schema: z.ZodType): boolean; // also true for another copy of zod's registry entry
function functionSchema<T>(): z.ZodType<T>; // any function; process-local
const callSchema: z.ZodType; // a runtime Call inside a payload
const hooksContractSchema,
  eventDefinitionSchema,
  settingsDefinitionSchema,
  storageTypeDefinitionSchema,
  commandDefinitionSchema; // accept only values made by the matching define*
const noInput: z.ZodTuple<[]>; // a method without input
interface StreamObserver<T> {
  next(item: T): void;
  end?(error?: ContractError): void;
}
type StreamListener<T> = ((item: T) => void) | StreamObserver<T>;
function streamListener<T extends z.ZodType>(
  item: T,
): z.ZodType<StreamListener<z.output<T>>>;
function streamItemOf(schema: z.ZodType): z.ZodType | undefined;
function toStreamObserver<T>(listener: StreamListener<T>): StreamObserver<T>; // a function becomes { next }

// commands.ts
function isBoundCommand(value: unknown): value is BoundCommand; // { id: string, execute: function }

// tools.ts
const orderKeySchema: z.ZodNumber; // integer 1 … Number.MAX_SAFE_INTEGER, the global order of tools and skills
function isContractTool(value: unknown): value is ContractTool;

// secrets.ts
const credentialFieldNames: readonly ['username', 'email', 'secret'];
const builtinCredentialKinds: readonly CredentialKindDefinition[];
//   API_TOKEN: required ['secret']; USERNAME_PASSWORD: required ['username', 'secret']
function credentialFieldsSatisfied(
  kind: CredentialFieldSet,
  values: CredentialValues,
): boolean;
//   every required field present, and no field outside required ∪ optional
function credentialFieldsMessage(kind: CredentialKindDefinition): string;
//   "A <id> credential requires <required> and carries no other field." / "… and may also carry <optional>."
function isSecretsView(value: unknown): value is SecretsView; // has list, redactions, addRedaction

// models.ts
function toLanguageModel<T extends object>(value: T): T & LanguageModel;
//   a plain object gets a prototype of its own with the same own properties, so it crosses
//   the process envelope as a handle; an object with another prototype is returned as is
const MODEL_ICON_MAX_LENGTH = 16_384; // characters of one SVG icon
const MODEL_ICON_MAX_MODELS = 1000; // model names per icon request
const MODEL_ICON_MAX_NAME = 512; // characters of one model name
const MODEL_ICON_MAX_REQUESTS = 64; // requests per models/v1.icons call
```

A stream method's input has a `streamListener(item)` among its tuple items;
its JSON Schema records the item schema under `x-doric-stream`, so a boundary
recognizes the method and validates each item
([`common.ts`](src/contracts/basic/common.ts),
[`json-schema.ts`](src/runtime/json-schema.ts)). A schema marked with
`x-doric-local` holds a value local to its process; it crosses the envelope
only as a handle ([Process isolation](../../docs/architecture/bundles/process-isolation.md#the-envelope)).

#### Exports per source file

Every file exports the contract's interface, its ref (see the table above)
and its method table `<name>Methods` (`MethodSpecs`: one `{ input, output,
expose? }` per method). A `<name>Schema` is a zod schema and the type of the
same name without `Schema` is its `z.output` (`z.input` where noted). Method
semantics are in the provider's README (see above).

[`commands.ts`](src/contracts/basic/commands.ts):

| Export           | Meaning                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Commands`       | `register(command: Registrable<BoundCommand>): Disposable`; `execute(command: AnyServiceRef \| ContractId, input?, call?): Promise<void>` |
| `isBoundCommand` | See the helpers above                                                                                                                     |
| `CommandExecute` | `(input: unknown, call: Call) => Promise<void>`                                                                                           |

[`events.ts`](src/contracts/basic/events.ts):

| Export                | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Events`              | `register(definition)`, `sink(spec)`, `append(definition, payload, call?)`                                                                              |
| `EventSinkSpec`       | `{ scopeKeys: readonly string[]; stream: string; scopeDescription?: string }`: where the rows of appended events go; `{key}` in `stream` is a scope key |
| `eventSinkSpecSchema` | 1–`SCOPE_MAX_KEYS` unique keys matching `scopeKeyPattern`, `stream` 1–256 characters, every `{placeholder}` among the keys                              |

[`hooks.ts`](src/contracts/basic/hooks.ts):

| Export             | Meaning                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `Hooks`            | What `services.use(HooksV1)` returns: `define(C)`, `use(C)`, `whenAvailable(C, callback)`                                       |
| `HooksProvider`    | What a `hooks/v1` provider implements: `define`, `register`, `whenDefined`, `execute`; `HooksV1` is `ref<Hooks, HooksProvider>` |
| `HookOutput<H>`    | What a handler returns: nothing for `observe`/`sequence`, the input's output type for `transform`, `Decision` for `decide`      |
| `HookHandler<H>`   | `(input, call: Call) => HookOutput<H> \| Promise<HookOutput<H>>`                                                                |
| `AnyHookHandler`   | `(input: unknown, call: Call) => unknown`: a handler as the provider stores it                                                  |
| `HookHandle<C>`    | What `define(C)` returns to the owner: per hook, `execute(input, call?): Promise<HookOutput>`                                   |
| `HookRegistrar<C>` | What `use(C)` returns to a consumer: per hook, `(handler) => Disposable`                                                        |

[`log.ts`](src/contracts/basic/log.ts):

| Export      | Meaning                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `Log`       | `debug`, `info`, `warn`, `error(message, fields?, call?): void`; a level never throws and is never awaited |
| `LogFields` | `Readonly<Record<string, unknown>>`                                                                        |

[`menus.ts`](src/contracts/basic/menus.ts):

| Export                           | Meaning                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `Menus`                          | `addItem(item)`, `addKeybinding(binding)`, `setContext({ key: 'path' \| 'focus', value })`   |
| `MenuWhen`, `menuWhenSchema`     | `{ path?: string; focus?: string }`: the active route pattern and focus that enable an entry |
| `MenuItem`, `menuItemSchema`     | `{ id, location ('app/<menu>' or 'dock'), command, label, when?, order? }`                   |
| `Keybinding`, `keybindingSchema` | `{ command, key, when? }`                                                                    |
| `menuContextSchema`              | The input of `setContext`                                                                    |

[`models.ts`](src/contracts/basic/models.ts):

| Export                                             | Meaning                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Models`, `ModelsProvider`                         | The `models/v1` and `models.provider/v1` interfaces                                                                                                                           |
| `ModelField`, `modelFieldSchema`                   | One configuration field of a model kind: `{ key, label, kind: 'text' \| 'url' \| 'number' \| 'enum' \| 'secret', required, description?, placeholder?, options?, advanced? }` |
| `ModelKindDescriptor`, `modelKindDescriptorSchema` | `{ id, label, description, fields: ModelField[], lists: ('models' \| 'reasonings')[], modelsFromCatalog?, site?: { url (https:), label } }`                                   |
| `CatalogModel`, `catalogModelSchema`               | One model of a kind's catalog (loose object)                                                                                                                                  |
| `CatalogResult`, `catalogResultSchema`             | `{ status: 'read'; models: CatalogModel[] } \| { status: 'absent' \| 'failed' }`                                                                                              |
| `LanguageModel`, `languageModelSchema`             | An opaque, process-local model handle (`x-doric-local: 'object'`)                                                                                                             |
| `toLanguageModel`                                  | See the helpers above                                                                                                                                                         |
| `ResolvedModel`                                    | `{ providerId, model, effort?, languageModel }`                                                                                                                               |
| `ModelRequest`                                     | `{ providerId, model, effort? }`                                                                                                                                              |
| `ModelsConfiguration`                              | `Readonly<Record<string, unknown>>`                                                                                                                                           |
| `ModelsProviderCreateInput`                        | `{ providerId: string; values: Readonly<Record<string, string>>; secret?: () => Promise<string> }`: what `models.provider/v1.create` receives                                 |
| `MODEL_ICON_*`                                     | See the helpers above                                                                                                                                                         |
| `modelIconSvgSchema`                               | One icon: a string of at most `MODEL_ICON_MAX_LENGTH` characters starting with `<svg`                                                                                         |
| `ModelIconChoice`, `modelIconChoiceSchema`         | `{ provider?: name; models: (name \| null)[] }`: the icons a provider chooses, per requested model in order                                                                   |
| `ModelIconRequest`, `modelIconRequestSchema`       | `{ providerId, models }` or `{ kind, configuration, models }`                                                                                                                 |
| `ModelIconAnswers`, `modelIconAnswersSchema`       | `{ svgs: Record<name, svg>; answers: ModelIconChoice[] }`, in request order                                                                                                   |

[`navigation.ts`](src/contracts/basic/navigation.ts):

| Export                           | Meaning                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Navigation`                     | `register`, `navigate(path, { replace? })`, `back`, `forward`, `history` (both optional in the table), `current`, `chain`, `subscribe` |
| `RouteMatch`, `routeMatchSchema` | `{ path, pattern, params: Record<string, string> }`                                                                                    |
| `RouteRegistration`              | `{ path; create(match: RouteMatch): object; parent?: string }`                                                                         |
| `RouteEntry`                     | `{ match; route }`: one route of the active chain                                                                                      |
| `NavigationHistory`              | `{ canGoBack: boolean; canGoForward: boolean }`                                                                                        |

[`regions.ts`](src/contracts/basic/regions.ts):

| Export                           | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `Regions`                        | `add(region, item): Disposable`, `items(region)`, `subscribe(region, listener)` |
| `RegionItem`, `regionItemSchema` | `{ id, tag, props?: Record<string, unknown>, order? }`                          |
| `RegionEntry`                    | A `RegionItem` with `owner`: the `bundleId` that added it                       |

[`secrets.ts`](src/contracts/basic/secrets.ts):

| Export                                                                                            | Meaning                                                                                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Secrets`, `SecretsBackend`                                                                       | The `secrets/v1` and `secrets.backend/v1` interfaces; the backend stores plaintext across the contract         |
| `CredentialKind`, `credentialKindSchema`                                                          | A registered kind name: `/^[A-Z][A-Z0-9_]{1,31}$/`                                                             |
| `credentialFieldNames`, `CredentialField`                                                         | `'username' \| 'email' \| 'secret'`                                                                            |
| `CredentialValues`                                                                                | `{ username?, email?, secret? }`                                                                               |
| `CredentialFieldSet`                                                                              | `{ required: CredentialField[]; optional: CredentialField[] }`                                                 |
| `CredentialKindDefinition`, `credentialKindDefinitionSchema`                                      | `{ id: CredentialKind; required; optional; label?: string }`; no field both required and optional              |
| `builtinCredentialKinds`, `credentialFieldsSatisfied`, `credentialFieldsMessage`, `isSecretsView` | See the helpers above                                                                                          |
| `CredentialRef`, `credentialRefSchema`                                                            | `{ id: string }`                                                                                               |
| `Secret`, `secretSchema`                                                                          | `{ id, kind, name, username?, email?, secret? }`                                                               |
| `CredentialDescription`, `credentialDescriptionSchema`                                            | The public view: `{ id, kind, name, username?, email?, hasSecret }`; never the secret                          |
| `CredentialCreate`, `credentialCreateSchema`                                                      | `{ kind, name, username?, email?, secret? }`                                                                   |
| `CredentialUpdate`, `credentialUpdateSchema`                                                      | Every field optional; `username`, `email`, `secret` absent or `null` keep the stored value, any string sets it |
| `CredentialWrite`, `credentialWriteSchema`                                                        | The same as `CredentialDescription`                                                                            |
| `credentialDeleteResultSchema`                                                                    | `'deleted' \| 'missing' \| 'referenced'`                                                                       |
| `ResolveByKindOptions` (`z.input`), `resolveByKindOptionsSchema`                                  | `{ exclude?: string[] }`: ids removed before the one-match rule                                                |
| `SecretsView`                                                                                     | An in-process, synchronous view of the provider's cache; never crosses a boundary                              |
| `ReferenceSource`                                                                                 | `() => Iterable<string>`: the credential ids a holder references now                                           |
| `StoredSecret`, `storedSecretSchema`                                                              | `Secret` plus `createdAt?`, `updatedAt?`: what the backend stores                                              |

[`settings.ts`](src/contracts/basic/settings.ts):

| Export                                    | Meaning                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Settings`                                | `register`, `get`, `entry`, `set(definition, value, options?, call?)`, `subscribe`       |
| `SettingsEntry<T>`, `settingsEntrySchema` | `{ value: T; revision: number; version: string; updatedAt: string; generation: number }` |
| `SettingsSetOptions`                      | `{ expectedRevision?: number }`                                                          |

[`skills.ts`](src/contracts/basic/skills.ts):

| Export                                     | Meaning                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `Skills`                                   | `register(skill: SkillSchemaInput, options?): Disposable`, `list(call?)` |
| `RegisteredSkill`, `registeredSkillSchema` | `{ bundleId, alwaysAvailable, order?: orderKey, skill: SkillRecord }`    |
| `SkillRegistrationOptions`                 | `{ alwaysAvailable?: boolean; order?: number }`                          |

[`storage.ts`](src/contracts/basic/storage.ts):

| Export                                                       | Meaning                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `Storage`, `StorageBackend`                                  | The `storage/v1` and `storage.backend/v1` interfaces                                                                       |
| `StoredDocument`, `storedDocumentSchema`                     | `{ type, id, revision: int, value }`                                                                                       |
| `StorageQuery`, `storageQuerySchema`                         | `{ type, index, equals: IndexValue[], range?: { gt?, gte?, lt?, lte? }, order?: 'asc' \| 'desc', limit: 1–1000, cursor? }` |
| `StoragePage`, `storagePageSchema`                           | `{ items: StoredDocument[]; cursor? }`                                                                                     |
| `StreamRead`, `streamReadSchema`                             | `{ stream, afterSequence: int ≥ 0, limit: int > 0 }`                                                                       |
| `StreamEntry`, `streamEntrySchema`                           | `{ sequence: int > 0, value, createdAt }` (`createdAt` set by the backend at commit)                                       |
| `TruncationMark`, `truncationMarkSchema`                     | `{ afterSequence, atSequence }`: entries above `afterSequence` were removed when the stream stood at `atSequence`          |
| `StreamPage`, `streamPageSchema`                             | `{ entries, lastSequence, truncations }`; `truncations` are the marks that removed entries the reader may hold             |
| `expectedRevisionSchema`                                     | `{ type, id, revision: int ≥ 0 }`; revision 0 means "must not exist"                                                       |
| `CommitBatch`, `commitBatchSchema`                           | One atomic batch, applied in the order expect → delete → put → dropStreams → truncate → append, or not at all              |
| `commitResultSchema`                                         | `{ position: int }`                                                                                                        |
| `StorageHealth`, `storageHealthSchema`                       | `{ status: 'ok' \| 'unavailable', writable, reason?, disk?: { blocks, availableBlocks } }`                                 |
| `StorageIdentity`, `storageIdentitySchema`                   | `{ hostId: uuid, storageGeneration: int > 0 }`                                                                             |
| `StorageCapabilities`, `storageCapabilitiesSchema`           | `{ maxBatch, maxDocumentBytes, maxAppendBytes }`, positive integers                                                        |
| `feedRequestSchema`                                          | `{ after: int, limit: int > 0 }`                                                                                           |
| `FeedPage`, `feedPageSchema`                                 | `{ commits: { position, documents: { type, id }[], streams, truncated, dropped }[] }`                                      |
| `StorageDeclaration` (`z.input`), `storageDeclarationSchema` | `{ type, indexes: { name, fields, unique? }[] }`                                                                           |

[`tools.ts`](src/contracts/basic/tools.ts):

| Export                                       | Meaning                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tools`                                      | `register(tool: Registrable<ContractTool>, options): Disposable`, `list(call?)`, `catalog(call?)`                                              |
| `ContractToolDefinition`                     | `{ name, description?, inputSchema: JsonObject, outputSchema: JsonObject, strict? }`: what a model sees                                        |
| `ToolIssueView`                              | `{ path: string; message: string }`                                                                                                            |
| `ToolPayloadCheck`                           | `{ success: true; data } \| { success: false; issues: ToolIssueView[] }`                                                                       |
| `ContractTool`                               | `{ name, description?, input: ZodObject, output, definition, settings: object[], resultModalities?, check?(payload), execute(payload, call) }` |
| `RegisteredTool`                             | `{ bundleId, alwaysAvailable, order?, projectId?, tool: ContractTool }`                                                                        |
| `ToolCatalogEntry`, `toolCatalogEntrySchema` | `{ name, description?, settings: object[] }`: plain data, as `GET /tools` lists it                                                             |
| `ToolRegistrationOptions`                    | `{ alwaysAvailable: boolean; order?: number; projectId?: string }`                                                                             |
| `orderKeySchema`, `isContractTool`           | See the helpers above                                                                                                                          |

[`ui.ts`](src/contracts/basic/ui.ts):

| Export               | Meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `Ui`                 | `define(tag, element): Disposable`, `create(tag, props?): object`, `dispose(element)` |
| `ElementConstructor` | `abstract new (...args: never[]) => object`: a custom element class                   |

[`windows.ts`](src/contracts/basic/windows.ts) (types are `z.input`):

| Export                                         | Meaning                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Windows`                                      | `open(request: OpenWindowRequest, call?): Promise<void>`                                                                                                              |
| `WindowAppearance`, `windowAppearanceSchema`   | `{ size?: { width, height, minWidth?, minHeight? }, titleBar: 'native' \| 'integrated' \| 'none' (default 'integrated'), background: token name (default 'window') }` |
| `PathWindowRequest`, `pathWindowRequestSchema` | `{ key, path, appearance?, primary? }`: a window showing an app route                                                                                                 |
| `WindowView`, `windowViewSchema`               | `{ path: string` (host-relative, starts with `/`)`; partition: string` (the Electron session partition)`; title?: string }`                                           |
| `ViewWindowRequest`, `viewWindowRequestSchema` | `{ key, view: WindowView, appearance?, primary? }`: a window showing a page on the host                                                                               |
| `OpenWindowRequest`, `openWindowRequestSchema` | One of the two; each shape is strict, so a request names exactly one                                                                                                  |
| `openWindowResultSchema`                       | `z.void()`                                                                                                                                                            |

### Platform contracts

`bundle/contracts` exports the ref and the interface of each `doric.*`
contract, its types and its schemas
([`platform.ts`](src/contracts/platform.ts),
[`network.ts`](src/contracts/network.ts)). The platform provides them; a
bundle uses them without listing them. Their full shapes are in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts).

| Contract                 | Ref                    | Environments            |
| ------------------------ | ---------------------- | ----------------------- |
| `doric.catalog/v1`       | `DoricCatalogV1`       | all                     |
| `doric.diagnostics/v1`   | `DoricDiagnosticsV1`   | all                     |
| `doric.bundle/v1`        | `DoricBundleV1`        | all                     |
| `doric.log/v1`           | `DoricLogV1`           | all                     |
| `doric.network/v1`       | `DoricNetworkV1`       | `host`                  |
| `doric.generation/v1`    | `DoricGenerationV1`    | `host`                  |
| `doric.startup/v1`       | `DoricStartupV1`       | `host`                  |
| `doric.windows/v1`       | `DoricWindowsV1`       | `desktopMain`           |
| `doric.menus/v1`         | `DoricMenusV1`         | `desktopMain`           |
| `doric.cache/v1`         | `DoricCacheV1`         | `desktopMain`           |
| `doric.migrations/v1`    | `DoricMigrationsV1`    | `desktopMain`           |
| `doric.notifications/v1` | `DoricNotificationsV1` | `desktopMain`           |
| `doric.tokens/v1`        | `DoricTokensV1`        | `client`, `desktopMain` |
| `doric.about/v1`         | `DoricAboutV1`         | `client`                |
| `doric.elements/v1`      | `DoricElementsV1`      | `client`                |
| `doric.connection/v1`    | `DoricConnectionV1`    | `client`                |
| `doric.browser/v1`       | `DoricBrowserV1`       | `client`                |
| `doric.appearance/v1`    | `DoricAppearanceV1`    | `client`                |

It also exports two platform hooks contracts, which the platform defines
with `definePlatformHooks` ([`platform.ts`](src/contracts/platform.ts)):

| Contract                                  | Hook                      | Kind                    | Input                                                                |
| ----------------------------------------- | ------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `AppHooksV1` (`doric.app.hooks/v1`)       | `onActivateHook`          | observe                 | `{ bundleId, version, generation, environment }`                     |
|                                           | `onDeactivateHook`        | observe                 | the same                                                             |
|                                           | `onHostStartHook`         | sequence                | `{}`                                                                 |
|                                           | `onHostStopHook`          | sequence, reverse order | `{}`                                                                 |
|                                           | `onHostReadyHook`         | observe                 | `{}`                                                                 |
|                                           | `onGenerationReadyHook`   | observe                 | `{ generation }`                                                     |
|                                           | `onGenerationChangedHook` | observe, per owner      | a generation change; each handler sees only its own bundle's `holds` |
|                                           | `onPeerSignalHook`        | observe, per owner      | a peer signal; only handlers of the sending bundle receive it        |
|                                           | `onAppReadyHook`          | observe                 | `{}`                                                                 |
|                                           | `onAppActivateHook`       | observe                 | `{}`                                                                 |
|                                           | `onBeforeQuitHook`        | decide                  | `{}`                                                                 |
|                                           | `onConnectionChangedHook` | observe                 | `{ connected }`                                                      |
| `WindowHooksV1` (`doric.window.hooks/v1`) | `onCloseHook`             | decide                  | `{}`                                                                 |
|                                           | `onFlushHook`             | observe                 | `{}`                                                                 |

When each fires is in [Hooks](../../docs/architecture/bundles/hooks.md).

The catalog's quarantine codes are exported as `quarantineCodes`:
`invalid_manifest`, `invalid_descriptor`, `invalid_part`, `duplicate_id`,
`engines_unsatisfied`, `missing_dependency`, `incompatible_version`,
`dependency_quarantined`, `unchosen_provider`, `cardinality_mismatch`,
`foundation_requires`, `dependency_cycle`, `activate_failed`,
`registration_failed`, `skill_invalid`, `generation_failed` and
`kernel_requires_generation`. When each is set is described in [The core
bundle and quarantine](../../docs/architecture/bundles/core.md#quarantine).

The other exports of [`platform.ts`](src/contracts/platform.ts) and
[`network.ts`](src/contracts/network.ts) are the data of those contracts:

| Export                                                 | Type or value                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Phase`                                                | `'foundation' \| 'core' \| 'others'`                                                                                                                                                                                                               |
| `BundleState`                                          | `'active' \| 'quarantined' \| 'disabled' \| 'inactive'`                                                                                                                                                                                            |
| `QuarantineCode`, `QuarantineReason`                   | `(typeof quarantineCodes)[number]`; `{ code: QuarantineCode; message: string; contract?: string }`                                                                                                                                                 |
| `CatalogManifest`                                      | The validated v1 manifest the catalog publishes: `{ manifestVersion: 1; id; version; engines: { doric }; provides; requires; optional?; desktopScope?: Record<string, string[]>; description? }`                                                   |
| `CatalogComposition`                                   | `{ core: string; enabled: readonly string[]; providers: Readonly<Record<string, string>> }`                                                                                                                                                        |
| `ContractProvider`                                     | `{ bundleId: string; version: string` (the contract version in `provides`)`; bundleVersion: string }`                                                                                                                                              |
| `CatalogBundle`                                        | `{ id: string; version: string; description?: string; state: BundleState; phase?: Phase; manifest?: CatalogManifest; reasons: readonly QuarantineReason[] }`                                                                                       |
| `CatalogContract`                                      | `{ id: string; environment: Environment; cardinality: 'one' \| 'many'; providers: readonly ContractProvider[] }`                                                                                                                                   |
| `CatalogSnapshot`                                      | `{ generation: number; composition; bundles: readonly CatalogBundle[]; order: readonly string[]` (activation order)`; contracts: readonly CatalogContract[]; storage?: StorageIdentity }`                                                          |
| `CatalogChange`, `catalogChangeSchema`                 | `{ generation: int }`: an item of `doric.catalog/v1.watch()`                                                                                                                                                                                       |
| `DistributionFile`, `distributionFileSchema`           | `{ path: string` (non-empty, `/` separators)`; sha256: string` (64 lowercase hex)`; size: int ≥ 0 }`                                                                                                                                               |
| `DistributionParts`                                    | `{ desktopMain?: string; client?: string; clientStyles?: string; contracts?: string }`: paths of the built parts                                                                                                                                   |
| `DistributionBundle`                                   | `{ id; version; state: BundleState; reasons; manifest?: CatalogManifest; descriptor?: JsonObject; files: readonly DistributionFile[]; parts: DistributionParts }`                                                                                  |
| `DistributionCatalog`, `distributionCatalogSchema`     | `{ generation: int; hostBoot: string` (non-empty, random per host process)`; platformVersion: string; composition; storage?; host: CatalogSnapshot; bundles: readonly DistributionBundle[] }`                                                      |
| `DistributionArtifact`, `distributionArtifactSchema`   | `{ sha256: string; base64: string }`: one distributed file by hash                                                                                                                                                                                 |
| `DiagnosticError`                                      | `{ at: string; bundleId: string; kind: string; message: string; details?: unknown }`                                                                                                                                                               |
| `DiagnosticBundle`                                     | `{ id; version; state: BundleState; phase?: Phase; reasons: readonly QuarantineReason[]; activationMs?: number }`                                                                                                                                  |
| `Diagnostics`                                          | `{ generation: number; mode: 'normal' \| 'recovery'; recovery?: { reason: string }; issues: readonly string[]; bundles: readonly DiagnosticBundle[]; errors: readonly DiagnosticError[]; consumers: Readonly<Record<string, readonly string[]>> }` |
| `DiagnosticReport`                                     | `{ bundleId: string; kind: string; message: string; details?: unknown }`                                                                                                                                                                           |
| `BundleDescription`                                    | `{ bundleId: string; version: string; generation: number; environment: Environment }`                                                                                                                                                              |
| `LogRecord`                                            | `{ level: 'debug' \| 'info' \| 'warn' \| 'error'; message; fields?; bundleId; version; generation; environment; scope?: CallScope; traceId?: string }`                                                                                             |
| `MenuSkeleton`                                         | `readonly { id: string; label: string; role?: string; submenu?: MenuSkeleton }[]`                                                                                                                                                                  |
| `WINDOW_CAPTURE_MAX_SIDE`                              | `4096`                                                                                                                                                                                                                                             |
| `WindowCaptureRequest`, `windowCaptureRequestSchema`   | `{ key: string` (non-empty)`; rect: { x ≥ 0; y ≥ 0; width; height }` (sides positive, at most `WINDOW_CAPTURE_MAX_SIDE`)` }`                                                                                                                       |
| `WindowCapture`, `windowCaptureSchema`                 | `{ png: string` (base64)`; width: int > 0; height: int > 0` (device pixels)`; scale: number > 0 }`                                                                                                                                                 |
| `MigrationRequest`                                     | `{ key: string; marker: string }`                                                                                                                                                                                                                  |
| `MigrationResult`                                      | `'migrated' \| 'none' \| 'skipped' \| 'failed'`                                                                                                                                                                                                    |
| `migrationKeyPattern`                                  | `/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/`: a localStorage key a migration may copy                                                                                                                                                                      |
| `migrationMarkerPattern`                               | `/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`: the name of the marker record                                                                                                                                                                                  |
| `NotificationRequest`, `notificationRequestSchema`     | `{ title: string; body: string }`                                                                                                                                                                                                                  |
| `ConnectionStatus`, `connectionStatusSchema`           | `'connected' \| 'disconnected'`                                                                                                                                                                                                                    |
| `browserUrlSchema`                                     | A string of at most 8192 characters that parses as an absolute `https:` URL                                                                                                                                                                        |
| `DoricTheme`, `doricThemeSchema`                       | `'dark' \| 'light' \| 'system'`                                                                                                                                                                                                                    |
| `WorkHold`, `workHoldSchema`                           | `{ key: string` (1–256)`; label?: string` (≤ 256)` }`                                                                                                                                                                                              |
| `GenerationState`                                      | `'starting' \| 'active' \| 'draining' \| 'stopped' \| 'failed'`                                                                                                                                                                                    |
| `GenerationDescription`, `generationDescriptionSchema` | `{ generation: int; incarnation: int; state: GenerationState }`                                                                                                                                                                                    |
| `PeerSignal`                                           | `{ topic: string` (1–128)`; payload?: unknown }`                                                                                                                                                                                                   |
| `startupLevelSchema`                                   | `'debug' \| 'info' \| 'warn' \| 'error'`                                                                                                                                                                                                           |
| `NetworkResources`                                     | `{ http: object; server: object` (the host's shared `http.Server`)`; sockets: object }`                                                                                                                                                            |

`DoricNetwork.register` takes a `(resources: NetworkResources) => (() =>
void) | undefined`; the listener type is not exported.

## `bundle/runtime`

The service runtime shared by the host kernel, the host's generation
processes, the desktop main process and every window
([`src/runtime/index.ts`](src/runtime/index.ts)). Apps, the `desktop`
package, embedded foundation host parts (`host-config` imports
`contractDocument`) and bundle tests import it; desktop parts may, client,
chunk, worker and frame parts may not ([Build tooling](#build-tooling)).
It re-exports from the contracts what only the platform uses
([`define.ts`](src/contracts/define.ts),
[`platform.ts`](src/contracts/platform.ts)):

```ts
function definePlatformService<M extends Record<string, AnyMethodDefinition>>(
  idOrRef: ContractId | AnyServiceRef,
  methods: M,
): ServiceDefinition<ContractId, M>; // always cardinality 'one'
interface PlatformContractSpec {
  readonly environments: readonly Environment[];
  readonly methods: MethodSpecs;
}
const platformContracts: Readonly<
  Record<PlatformContractId, PlatformContractSpec>
>; // frozen
type PlatformContractId = keyof typeof platformContracts; // the doric.* service ids
```

`definePlatformService` checks the id like `defineService`
(`Invalid service contract ID "<id>".`) and throws a `TypeError`
`"<id>" is not a platform contract ID.` for an id that does not start with
`doric.`. The rest of the entry is the modules below.

### Directory and principals

```ts
interface ProviderRecord {
  readonly contractId: string;
  readonly bundleId: string;
  readonly version: string; // the providing bundle's version
  readonly contractVersion: string; // as declared in provides
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly methods: Readonly<Record<string, MethodSpec>>;
  readonly origin?: 'local' | 'remote';
  invoke(method: string, input: unknown, call: Call): unknown;
}
interface ProviderListener {
  added(record: ProviderRecord): void;
  removed(record: ProviderRecord): void;
}
interface Directory {
  register(record: ProviderRecord): () => void;
  providers(contractId: string): readonly ProviderRecord[];
  active(contractId: string): ProviderRecord | undefined;
  isActive(record: ProviderRecord): boolean;
  subscribe(contractId: string, listener: ProviderListener): () => void;
}
class ServiceDirectory implements Directory {
  observe(listener: ProviderListener): () => void;
}
class LayeredDirectory implements Directory {
  constructor(base: Directory, overlay?: Directory);
  readonly base: Directory;
  get overlay(): Directory | undefined;
  setOverlay(
    next: Directory | undefined,
    options?: { readonly retain?: boolean },
  ): void;
  release(overlay: Directory): void;
}
```

`ServiceDirectory` keeps the providers of each contract in registration
order; `active` is the first. Registering a second provider of a `one`
contract throws `provider_conflict`. `subscribe` calls `added` at once for
every current provider, then for each change; `observe` hears every contract
([`directory.ts`](src/runtime/directory.ts)). `LayeredDirectory` registers in
its base and reads the base before the overlay. `setOverlay` tells subscribers
the old overlay's records were removed and the new ones added; with
`retain: true` the old overlay's records stay active for the subscribers that
hold them until `release(overlay)` — the kernel uses this for a draining
generation ([`layered-directory.ts`](src/runtime/layered-directory.ts)).

```ts
interface ContractCatalogView {
  cardinality(contractId: string): Cardinality | undefined;
  activeProvider(contractId: string): string | undefined; // the chosen bundle of a 'one' contract
}
const emptyCatalogView: ContractCatalogView;
interface ServiceRuntime {
  readonly directory: Directory;
  readonly catalog: ContractCatalogView;
  readonly environment: Environment;
  readonly generation: number;
  readonly operationGeneration?: number; // pin of a call without parent: 0 in the kernel, N in generation N
  readonly generationSignal: AbortSignal; // the default call.signal
  readonly report: (entry: DiagnosticReport) => void;
  readonly now?: () => number;
  readonly awaitProvider?: (
    contractId: string,
    signal: AbortSignal | undefined,
  ) => Promise<void> | undefined;
}
interface DeclaredProvide {
  readonly version: string;
  readonly cardinality: Cardinality;
}
interface PrincipalOptions {
  readonly bundleId: string;
  readonly version: string;
  readonly provides: ReadonlyMap<string, DeclaredProvide> | 'any';
  readonly ownContracts?: ReadonlySet<string>;
  readonly requires: ReadonlySet<string> | 'any';
  readonly isCore?: boolean;
}
class Principal {
  readonly runtime: ServiceRuntime;
  readonly options: PrincipalOptions;
  readonly caller: Caller;
  readonly scope: DisposalScope;
  services: Services; // checked
  unchecked: Services; // without the requires check
  get bundleId(): string;
  get current(): DisposalScope;
  get closed(): boolean;
  runInScope<T>(scope: DisposalScope, fn: () => T): T;
  noteRegistrationError(error: unknown): void;
  isRegistrationError(error: unknown): boolean;
  close(): void; // every stub of this principal then refuses calls
}
function createPrincipal(
  runtime: ServiceRuntime,
  options: PrincipalOptions,
): Principal;
interface ElementScope {
  readonly services: Services;
  dispose(): Promise<void>;
}
function createElementScope(principal: Principal): ElementScope;
```

A principal is one bundle in one environment of one generation
([`principal.ts`](src/runtime/principal.ts),
[`services.ts`](src/runtime/services.ts)). When `awaitProvider` is given and a
call finds no active provider, the call waits for the promise it returns and
then dispatches again; its call signal aborts the wait
([`dispatch.ts`](src/runtime/dispatch.ts)). `createElementScope` gives one
custom element services in a child of its owner's activation scope; every
registration made through them, also later from a stub the element kept, ends
with `dispose` ([`services.ts`](src/runtime/services.ts)).

```ts
function createStub<Api>(principal: Principal, target: DispatchTarget): Api;
interface DispatchTarget {
  readonly contractId: string;
  readonly useScope?: CallScope;
  readonly pinned?: ProviderRecord;
}
function dispatch(
  principal: Principal,
  target: DispatchTarget,
  method: string,
  args: readonly unknown[],
): unknown;
function normalizeArguments(
  schema: z.ZodType,
  args: readonly unknown[],
): { input: unknown; callArg: CallArg | undefined; tuple: boolean };
function isTupleSchema(schema: z.ZodType): boolean;
function isRegistrationConflict(error: unknown): boolean;
function createHooksFacade(
  principal: Principal,
  provider: HooksProvider,
  assertUse?: (contractId: string) => void,
): Hooks;
```

`normalizeArguments` splits stub arguments: for a tuple input the items are
the arguments, and a trailing `Call` is always the call argument while
trailing call options are one only past the tuple's length or where the
item at that position rejects them. `isRegistrationConflict` is true for the
codes a registration refusal raises: `duplicate_tool`, `duplicate_skill`,
`registration_conflict`, `not_owner`, `unavailable_tool`,
`provider_conflict`, `undeclared_provide`, `cardinality_mismatch` and
`contract_mismatch` ([`dispatch.ts`](src/runtime/dispatch.ts)).
`createHooksFacade` turns the flat `hooks/v1` provider methods into the
consumer API, each call a real hop ([`facades.ts`](src/runtime/facades.ts)).

### Calls, traces and scopes

```ts
interface CallFactoryInput {
  readonly caller: Caller;
  readonly useScope?: CallScope; // wins over the parent's keys
  readonly arg?: CallArg; // parent call or { signal, deadline }
  readonly generationSignal: AbortSignal;
  readonly windowKey?: string; // client dispatcher only
  readonly generation?: number; // pin without parent
  readonly defaultGeneration?: number;
  readonly now?: () => number;
}
function createHopCall(input: CallFactoryInput): Call;
function anySignal(signals: readonly AbortSignal[]): AbortSignal;
function newTrace(): TraceContext;
function childTrace(parent: TraceContext): TraceContext; // same trace id, new span; new trace when malformed
function traceIdOf(trace: TraceContext): string | undefined;
```

`createHopCall` ([`call.ts`](src/runtime/call.ts)) sets `caller` to the
principal making the hop. With a parent call it keeps the parent's signal,
deadline and generation and makes a child span; without one it starts a new
trace, takes the given signal or `generationSignal`, aborts it at the deadline
with a `TimeoutError` when the deadline is positive, and pins the call to
`generation`, else `defaultGeneration`, else 0. The scope is the parent's,
then `useScope`, then `windowKey`; an empty scope is omitted
([`trace.ts`](src/runtime/trace.ts)).

```ts
type DisposalErrorHandler = (error: unknown) => void;
class DisposalScope {
  constructor(onError?: DisposalErrorHandler);
  get disposed(): boolean;
  track(disposable: Disposable): void;
  onDispose(cleanup: Cleanup): void;
  child(): DisposalScope;
  dispose(): Promise<void>; // reverse order, awaited one by one; idempotent; never throws
}
function toDisposable(dispose: () => void): Disposable; // idempotent
const inertDisposable: Disposable;
```

A scope disposed already disposes anything tracked afterwards at once;
every failure goes to `onError` ([`scope.ts`](src/runtime/scope.ts)).

### Manifest, composition and descriptor

```ts
// The interfaces below spell out the z.output type aliases of the schemas.
const semverString: z.ZodType<string>; // checked by isVersion
const semverRange: z.ZodType<string>; // checked by isRange
const manifestV1Schema: z.ZodType<ManifestV1, ManifestV1Input>; // strict
interface ManifestV1 {
  readonly manifestVersion: 1;
  readonly id: string; // /^[a-z][a-z0-9-]*$/, not "doric"
  readonly version: string; // semverString
  readonly engines: { readonly doric: string }; // semverRange
  readonly provides: readonly string[]; // "<id>/v<major>@<version>"; input default []
  readonly requires: readonly string[]; // "<id>/v<major>@<range>"; input default []
  readonly optional?: readonly string[]; // contract ids
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>; // contract id → ≤ SCOPE_MAX_KEYS keys
  readonly description?: string; // trimmed, non-empty
} // ManifestV1Input: the same with provides and requires optional
const manifestV0Schema: z.ZodType<ManifestV0>; // strict
interface ManifestV0 {
  readonly name: string; // trimmed, non-empty
  readonly description: string; // trimmed, non-empty
  readonly tools: readonly { path: string; alwaysAvailable: boolean }[]; // path tools/<file>.js
  readonly skills: readonly { path: string; alwaysAvailable: boolean }[]; // path skills/<dir>/SKILL.md
}
interface ContractEntry {
  readonly id: string;
  readonly major: number;
  readonly spec: string;
}
function parseContractEntry(entry: string): ContractEntry | undefined; // "<id>/v<major>@<version-or-range>"
interface LegacyResource {
  readonly path: string;
  readonly alwaysAvailable: boolean;
}
interface ReadManifest {
  readonly manifest: ManifestV1;
  readonly legacy?: {
    tools: readonly LegacyResource[];
    skills: readonly LegacyResource[];
  };
}
function parseManifest(document: unknown): ReadManifest;
function convertV0(v0: ManifestV0): ReadManifest;
function v0BundleId(name: string): string; // the name itself
```

`parseManifest` reads a document with `manifestVersion` as version 1 and any
other as the format the code calls v0 (`name`, `description`, `tools` at
`tools/<file>.js`, `skills` at `skills/<dir>/SKILL.md`, each with
`alwaysAvailable`), which `convertV0` turns into a version 1 manifest in
memory: id from the name, version `0.0.0`, `engines.doric` `*`, no
`provides`, and `requires` `tools/v1@^1.0.0` when it lists tools; its tools
and skills are kept as `legacy` ([`manifest.ts`](src/runtime/manifest.ts)).
The fields and rules of version 1 are in [The bundle
manifest](../../docs/architecture/bundles/manifest.md).

```ts
const compositionSchema: z.ZodType<Composition>; // strict
const requiredSchema: z.ZodType<Composition['required']>; // strict
const alternativeSchema: z.ZodType<Alternative>; // strict; options contains default
interface Composition {
  core: string; // non-empty
  enabled: string[]; // ≥ 1 non-empty ids
  resident?: string[]; // bundle ids of installed host parts sharing the host process
  providers: Record<string, string>; // contract id → bundle id; input default {}
  required?: { contracts: string[]; bundles: string[] }; // each input default []
  alternatives?: Record<string, Alternative>; // names /^[a-z][a-z0-9-]*$/
}
interface Alternative {
  env: string; // non-empty
  default: string; // non-empty, one of options
  options: string[]; // ≥ 1 non-empty
}
type AlternativeChoices = Readonly<Record<string, string>>;
type Variables = Readonly<Record<string, string | undefined>>;
function parseComposition(document: unknown): Composition;
function selectAlternatives(
  composition: Composition,
  variables: Variables,
): AlternativeChoices;
function enableAlternatives(
  composition: Composition,
  choices: AlternativeChoices,
): Composition;
function enabledAlternatives(composition: Composition): AlternativeChoices;
```

`selectAlternatives` takes for each alternative the value of its `env`
variable when it is one of `options`, else `default`. `enableAlternatives`
replaces each alternative's default bundle in `enabled` by the chosen option,
without duplicates. `enabledAlternatives` answers, for each alternative, its
single enabled option, or the default when none or several are enabled
([`composition.ts`](src/runtime/composition.ts)). The composition file is
described in [Composition and
distribution](../../docs/architecture/bundles/composition-and-distribution.md).

```ts
const descriptorKinds: readonly [
  'service',
  'hooks',
  'event',
  'command',
  'settings',
  'storage-type',
];
type DescriptorKind = (typeof descriptorKinds)[number];
const descriptorEntrySchema: z.ZodType<DescriptorEntry>; // strict
interface DescriptorEntry {
  id: string; // contractIdPattern
  version: string; // semverString
  kind: DescriptorKind;
  environment: Environment;
  cardinality: Cardinality;
  local: boolean;
  schema: string; // path relative to the bundle's dist, e.g. "schemas/hooks/v1.json"
}
const descriptorSchema: z.ZodType<Descriptor>; // strict
interface Descriptor {
  descriptorVersion: 1;
  bundle: { id: string; version: string };
  contracts: DescriptorEntry[];
}
function parseDescriptor(document: unknown): Descriptor;
function emptyDescriptor(id: string, version: string): Descriptor;
```

The descriptor is `dist/contracts.json`, which the build writes
([`descriptor.ts`](src/runtime/descriptor.ts)); its format is in [Contracts
and the `define*` family](../../docs/architecture/bundles/contracts.md).

### Catalog resolution and activation

```ts
type CatalogSource = { kind: 'installed'; dir: string } | { kind: 'embedded' };
interface CatalogCandidate {
  id;
  source;
  manifest?;
  descriptor?;
  errors: readonly QuarantineReason[];
}
type EntryState = 'scheduled' | 'quarantined' | 'disabled';
interface CatalogEntry {
  id;
  version;
  description?;
  source;
  manifest?;
  descriptor?;
  phase?: Phase;
  state: EntryState;
  reasons;
  dependencies: readonly string[];
}
interface ResolvedProvider {
  bundleId;
  version;
  bundleVersion;
}
interface ResolvedContract {
  id;
  environment;
  cardinality;
  providers: readonly ResolvedProvider[];
}
interface ResolvedEnvironment {
  environment;
  generation;
  composition;
  issues;
  entries;
  order;
  contracts;
  recovery?: { reason };
}
interface ResolveInput {
  candidates;
  composition;
  platformVersion;
  generation;
  issues?;
  recovery?;
}
function resolveEnvironment(
  input: ResolveInput,
  environment: Environment,
): ResolvedEnvironment;
```

`resolveEnvironment` resolves one environment without running bundle code:
it checks each candidate's manifest, descriptor and platform range, chooses
the provider of each contract, reads `requires` per environment (a `client`
part is served by `client`, `desktopMain` and `host` providers), quarantines
bundles with reasons and cascades the quarantine through `requires` until
nothing changes, orders activation as foundation, core, others, and sets
`recovery` when the core or a chosen foundation provider cannot run
([`catalog.ts`](src/runtime/catalog.ts)). The rules are in [The core bundle
and quarantine](../../docs/architecture/bundles/core.md) and [The bundle
manifest](../../docs/architecture/bundles/manifest.md).

```ts
interface PlatformLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
class ActivationFailure extends Error {
  readonly code: QuarantineCode;
  constructor(code, message, options?);
}
function catalogView(resolved: ResolvedEnvironment): ContractCatalogView;
function principalOptionsFor(
  entry: CatalogEntry,
  resolved: ResolvedEnvironment,
): PrincipalOptions;
interface ActivationOptions {
  readonly resolved: ResolvedEnvironment;
  readonly runtime: ServiceRuntime;
  readonly platform: Principal; // 'doric': defines AppHooksV1, fires lifecycle hooks
  readonly diagnostics: DiagnosticsStore;
  readonly loadPart: (entry: CatalogEntry) => Promise<Activate | undefined>;
  readonly afterActivate?: (entry, principal) => Promise<void>;
  readonly afterPhase?: (entry, principal) => Promise<void>; // once the phase is active
  readonly onHooksProviderReady?: (platform: Principal) => void | Promise<void>;
  readonly preActive?: readonly string[]; // active in another process; default []
  readonly hooksProvider?: 'local' | 'remote'; // default 'local'
  readonly settle?: (entry, principal) => Promise<void>;
  readonly onPrincipal?: (entry, principal) => void;
  readonly log?: PlatformLog;
  readonly now?: () => number;
}
interface ActivationResult {
  readonly mode: 'normal' | 'recovery';
  readonly active: readonly string[];
  readonly principals: ReadonlyMap<string, Principal>;
  readonly appHooks: () => HookHandle<typeof AppHooksV1> | undefined;
  stop(): Promise<void>; // reverse deactivation; idempotent
}
function activateEnvironment(
  options: ActivationOptions,
): Promise<ActivationResult>;
```

`activateEnvironment` activates the scheduled entries in order, each with its
own principal and disposal scope ([`activation.ts`](src/runtime/activation.ts)).
Once the `hooks/v1` provider is active (or before the first bundle when
`hooksProvider` is `remote`) the platform defines `AppHooksV1` and fires
`onActivateHook` and, on deactivation, `onDeactivateHook`. A bundle whose
dependency is not active is quarantined with `dependency_quarantined`; a
throwing `activate` disposes its registrations, runs its cleanup and
quarantines it with `activate_failed` (or `registration_failed` when a
registration was refused); a rejection of `afterActivate`, `afterPhase` or
`settle` quarantines it the same way and cascades to the bundles that depend
on it. A failure of the core or of a chosen foundation provider enters
recovery: no further bundle activates and each remaining one is recorded
`inactive`. Lifetimes and quarantine are described in [Contexts and
capabilities](../../docs/architecture/bundles/contexts.md#lifetimes) and [The
core bundle and quarantine](../../docs/architecture/bundles/core.md).

### Diagnostics and the platform providers

```ts
const DIAGNOSTIC_ERRORS_PER_BUNDLE = 50;
class DiagnosticsStore {
  constructor(options: {
    readonly generation: number;
    readonly now?: () => number;
  });
  load(resolved: ResolvedEnvironment): void; // scheduled bundles start 'inactive'
  get mode(): 'normal' | 'recovery';
  enterRecovery(reason: string): void; // the first reason is kept
  state(id: string): BundleState | undefined;
  setState(id: string, state: BundleState, activationMs?: number): void;
  quarantine(id: string, reason: QuarantineReason): void;
  reasons(id: string): readonly QuarantineReason[];
  report(entry: DiagnosticReport): void;
  snapshot(): Diagnostics;
}
```

`report` stamps an error with the current time and keeps the 50 newest of
each bundle ([`diagnostics.ts`](src/runtime/diagnostics.ts)).

```ts
interface LogSink {
  write(record: LogRecord): void;
}
interface BundleStates {
  snapshot(): Diagnostics;
  state(id: string): BundleState | undefined;
}
interface CatalogDistributionProvider {
  distribution(call: Call): Promise<DistributionCatalog>;
  artifact(
    request: { readonly sha256: string },
    call: Call,
  ): Promise<DistributionArtifact>;
  watch(listener: StreamListener<CatalogChange>, call: Call): Disposable;
}
interface CatalogCompositionProvider {
  disable(request: { readonly bundleId: string }, call: Call): Promise<void>;
  resetComposition(call: Call): Promise<void>;
}
function statesOf(diagnostics: Diagnostics): BundleStates;
function catalogSnapshot(
  resolved: ResolvedEnvironment,
  diagnostics: BundleStates,
  storage?: StorageIdentity,
): CatalogSnapshot;
function providePlatformServices(
  platform: Principal,
  options: {
    readonly snapshot: (call: Call) => CatalogSnapshot;
    readonly diagnostics: DiagnosticsStore;
    readonly diagnosticsFor?: (call: Call) => Diagnostics;
    readonly sink: LogSink;
    readonly distribution?: CatalogDistributionProvider;
    readonly composition?: CatalogCompositionProvider;
    readonly generation?: {
      describe(call): GenerationDescription;
      hold(work: WorkHold, call): Disposable;
      signal(signal: PeerSignal, call): void | Promise<void>;
    };
    readonly startup?: { stage(name: string): void; log(record): void };
  },
): void;
```

`providePlatformServices` provides, as the principal `doric`,
`doric.catalog/v1` (`get`, plus `distribution`, `artifact` and `watch` when
`distribution` is given, and `disable` and `resetComposition` when
`composition` is given), `doric.diagnostics/v1` (`get`, `report`),
`doric.bundle/v1` (`describe`: the caller's `bundleId`, `version`,
`generation` and the runtime's environment), `doric.log/v1` (`write` to the
sink), and `doric.generation/v1` and `doric.startup/v1` when those options are
given ([`platform-providers.ts`](src/runtime/platform-providers.ts)). Their
contracts are described in [The core bundle and
quarantine](../../docs/architecture/bundles/core.md#doriccatalogv1-and-doricdiagnosticsv1),
[Observability](../../docs/architecture/bundles/observability.md) and
[Process isolation](../../docs/architecture/bundles/process-isolation.md).

### Distribution

```ts
function distributedSource(bundle: {
  id: string;
  version: string;
}): CatalogSource;
function candidatesFromDistribution(
  catalog: DistributionCatalog,
): CatalogCandidate[];
function compositionFromDistribution(catalog: DistributionCatalog): Composition;
const distributionArtifactSchema,
  distributionCatalogSchema,
  distributionFileSchema;
```

The desktop resolves its `desktopMain` and `client` environments from the
host's distribution catalog: each distributed bundle becomes a candidate in
the host's order, the host's quarantine reasons become its errors, and a
bundle the host disabled leaves `enabled`
([`distribution.ts`](src/runtime/distribution.ts),
[Composition and distribution](../../docs/architecture/bundles/composition-and-distribution.md)).

### Contract documents and exposure

```ts
type SchemaDirection = 'input' | 'output';
interface MemberSchema { readonly schema: JsonObject; readonly local: boolean }
function memberSchema(schema: z.ZodType, io: SchemaDirection): MemberSchema;
const LOCAL_KEY = 'x-doric-local';
const localCodecKinds: readonly ['callback', 'disposable', 'object'];
const localMarker: JsonObject;          // { 'x-doric-local': true }
const STREAM_KEY = 'x-doric-stream';
function streamItemSchema(input: unknown): JsonObject | undefined;
type RecordedContract;                  // { id, environment, cardinality } & one of the six kinds' members
interface ContractDocument { readonly document: JsonObject; readonly local: boolean }
function contractDocument(contract: RecordedContract): ContractDocument;
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
function schemaPath(contractId: string): string;   // `schemas/${contractId}.json`
function canonicalJson(value: unknown): string;    // JSON with sorted keys
function jsonEqual(left: unknown, right: unknown): boolean;
function compilableSchema(schema: JsonValue): JsonValue; // drops an empty prefixItems so ajv compiles it

const documentExposureKey = 'x-doric-expose';
function exposureOf(contractId: string, method: string, declared?: { expose?: MethodExposure }): MethodExposure | undefined;
function isDesktopExposed(contractId: string, method: string, spec: { expose?: MethodExposure } | undefined): boolean;
function misdeclaredExposure(contractId: string, methods: Record<string, { expose?: MethodExposure }>): string | undefined;
function documentExposure(document: JsonObject): Readonly<Record<string, MethodExposure>>;
```

`memberSchema` writes the JSON Schema 2020-12 of one member (zod's `input` or
`output` view): a process-local value with a codec becomes
`{ "x-doric-local": "<kind>" }` in place, and a member with a local value
without a codec is `{ "x-doric-local": true }`; tuples carry `minItems` and,
without a rest, `maxItems`. `contractDocument` builds a contract's document,
`$id` `doric:contract/<id>`, with each member under `$defs`
([`json-schema.ts`](src/runtime/json-schema.ts)); the document format is in
[Contracts and the `define*`
family](../../docs/architecture/bundles/contracts.md). For a contract the
platform publishes (a basic or `doric.*` contract), the exposure of a method
comes from the platform's table, otherwise from the provider's
`defineMethod`; `misdeclaredExposure` names the first method that declares an
exposure the table does not give ([`exposure.ts`](src/runtime/exposure.ts)).

### Semantic versions

```ts
interface SemVer {
  major;
  minor;
  patch;
  prerelease: readonly (string | number)[];
}
function parseVersion(value: string): SemVer | undefined;
function isVersion(value: string): boolean;
function compareVersions(left: SemVer, right: SemVer): number;
function compare(left: string, right: string): number; // throws on an invalid version
function isRange(range: string): boolean;
function satisfies(candidate: string, range: string): boolean;
function rangeMajor(range: string): number | undefined; // the single major a range admits
function formatVersion(value: SemVer): string;
type ChangeLevel = 'none' | 'patch' | 'minor' | 'major';
function bump(base: string, level: ChangeLevel): string; // throws TypeError on an invalid base
```

Versions are `MAJOR.MINOR.PATCH` with an optional prerelease (no build
metadata); ranges are `*`, exact versions, `^`, `~` and `=`, `>`, `>=`, `<`,
`<=` comparators, joined by spaces (and) and `||` (or). A prerelease satisfies
a range only when a comparator of the same set names a prerelease of the same
release, as npm does ([`semver.ts`](src/runtime/semver.ts)).

### Platform version

```ts
const PLATFORM_VERSION = '1.11.0'; // what engines.doric ranges are checked against; every doric.* provider's version
const PLATFORM_ASSETS_VERSION = '1.0.0'; // the version segment of the platform folders and URLs
```

From [`version.ts`](src/runtime/version.ts).

### Generation processes and the envelope

```ts
type SerializedCatalogEntry = CatalogEntry;
interface GenerationInit {
  readonly environment: 'host' | 'desktopMain';
  readonly generation: number;
  readonly incarnation: number;
  readonly platformVersion: string;
  readonly composition: Composition;
  readonly entries: readonly SerializedCatalogEntry[];
  readonly order: readonly string[];
  readonly contracts: readonly ResolvedContract[];
  readonly preActive: readonly string[];
  readonly kernelProviders: readonly RemoteProviderDescriptor[];
  readonly hooksProvider: 'remote' | 'local';
  readonly catalog: CatalogSnapshot;
}
const generationInitSchema;
interface RunnerOptions {
  readonly transport: Transport;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  readonly loadPart: (
    entry: SerializedCatalogEntry,
  ) => Promise<Activate | undefined>;
  readonly afterActivate?: (entry, principal) => Promise<void>;
  readonly afterPhase?: (entry, principal) => Promise<void>;
  readonly now?: () => number;
}
function runGeneration(options: RunnerOptions): Promise<void>;
class AnnouncingDirectory implements Directory {
  constructor(inner: Directory, announce: (message: ControlMessage) => void);
}
```

`runGeneration` waits for `init`, activates the process's bundles against the
kernel's providers, announces `ready`, serves until `stop`, deactivates in
reverse order and answers `stopped`. Its `AnnouncingDirectory` announces every
local, non-`doric.*` provider a bundle registers to the kernel (`provide`,
then `unprovide`) ([`runner.ts`](src/runtime/runner.ts)).

The envelope between processes is exported from
[`envelope/index.ts`](src/runtime/envelope/index.ts):

| Module                                                | Exports                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`link.ts`](src/runtime/envelope/link.ts)             | `ProcessLink`, `ProcessLinkOptions`, `ResolveTarget`, `Transport` (`send`, `onMessage`, `onClose`, `close`), `LinkCloseReason`: request correlation, cancellation, deadlines, exported handles and the close of the channel                                         |
| [`messages.ts`](src/runtime/envelope/messages.ts)     | The wire message types (`CallMessage`, `InvokeMessage`, `ResultMessage`, `CancelMessage`, `ReleaseMessage`, `ControlMessage`, …), `wireMessageSchema`, `wireErrorSchema`, `remoteProviderDescriptorSchema`, `controlKinds`, `isControlMessage`, `appLifecycleHooks` |
| [`call-meta.ts`](src/runtime/envelope/call-meta.ts)   | `toWireCall`, `restoreCall`, `RestoreOptions`: a `Call` as wire metadata and back                                                                                                                                                                                   |
| [`errors.ts`](src/runtime/envelope/errors.ts)         | `createErrorClassRegistry`, `ErrorClassRegistry`, `encodeError`, `decodeError`: errors cross with their class rebuilt from the registry                                                                                                                             |
| [`values.ts`](src/runtime/envelope/values.ts)         | `encodeValue`, `decodeValue`, `planFor`, `documentPlan`, `fixedPlan`, `MethodPlan`, `RemoteTool`, `WIRE_KEY`, codec types: process-local values cross as handles, a local value the schema does not allow is `local_only`                                           |
| [`remote.ts`](src/runtime/envelope/remote.ts)         | `describeRecord`, `remoteRecord`, `registerRemote`, `recordKey`, `announcedKey`, `matchesTarget`: a provider record as a descriptor and back                                                                                                                        |
| [`validators.ts`](src/runtime/envelope/validators.ts) | `SchemaValidators`, `SchemaCheck`, `SchemaIssue`, `documentMethodSpecs`, `memberSpec`, `validatorSchema`: checks of JSON Schema members at a boundary                                                                                                               |
| [`memory.ts`](src/runtime/envelope/memory.ts)         | `createTransportPair`, `TransportPair`: two connected in-memory transports                                                                                                                                                                                          |

Why the envelope works as it does is described in [Process
isolation](../../docs/architecture/bundles/process-isolation.md#the-envelope);
its exports follow.

#### Wire messages

From [`messages.ts`](src/runtime/envelope/messages.ts). Every message is
validated with `wireMessageSchema` on receipt.

```ts
interface WireCall {
  readonly caller: Caller; // filled by the sending dispatcher
  readonly scope?: CallScope; // on receipt, entries with a bad key or a non-string value are dropped
  readonly trace: TraceContext; // the hop span the sender created
  readonly deadline: number; // epoch ms; 0 = none
  readonly generation: number; // the pinned operation generation; 0 = unpinned
}

// Envelope messages
interface CallMessage extends WireCall {
  readonly kind: 'call';
  readonly id: string; // `${side}:${counter}`, unique per sending side
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // encoded
  readonly provider?: string; // the bundle of the record the sender resolved
  readonly record?: string; // that record's key, for a bundle with several records
  readonly oneway?: true; // no result is sent back
}
interface InvokeMessage extends WireCall {
  readonly kind: 'invoke';
  readonly id: string;
  readonly handle: string; // a handle the receiver exported
  readonly method?: string; // 'execute' or 'check' for a tool, 'run' for a scoped callback
  readonly args: readonly unknown[]; // encoded
}
type ResultMessage =
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    };
interface CancelMessage {
  readonly kind: 'cancel';
  readonly id: string;
}
interface ReleaseMessage {
  readonly kind: 'release';
  readonly handle: string;
}
// Streams across the desktop bridge and the main <-> window IPC; the process
// link between the kernel and a generation does not serve them.
interface SubscribeMessage extends WireCall {
  readonly kind: 'subscribe';
  readonly id: string;
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // without the listener
}
interface EventMessage {
  readonly kind: 'event';
  readonly id: string;
  readonly values: readonly unknown[];
} // [item]
interface UnsubscribeMessage {
  readonly kind: 'unsubscribe';
  readonly id: string;
}
interface EndMessage {
  readonly kind: 'end';
  readonly id: string;
  readonly error?: WireError;
}
type EnvelopeMessage =
  | CallMessage
  | InvokeMessage
  | ResultMessage
  | CancelMessage
  | ReleaseMessage
  | SubscribeMessage
  | EventMessage
  | UnsubscribeMessage
  | EndMessage;

// Errors
interface WireError {
  readonly code: string; // ContractError.code, else 'internal'
  readonly message: string;
  readonly details?: unknown;
  readonly thrown?: WireThrown;
}
type WireThrown =
  | { readonly kind: 'value'; readonly value: unknown }
  | WireThrownError;
interface WireThrownError {
  readonly kind: 'error';
  readonly name: string; // Reflect.get(error, 'name')
  readonly prototype: string; // constructor name, looked up in the receiver's registry
  readonly own: readonly WireOwnProperty[]; // getOwnPropertyNames order
}
type WireOwnProperty =
  | {
      readonly key: string;
      readonly enumerable: boolean;
      readonly value: unknown;
    }
  | {
      readonly key: string;
      readonly enumerable: boolean;
      readonly error: WireThrownError;
    };

// Control plane (kernel <-> runner); never routed to bundles
interface RemoteProviderDescriptor {
  readonly contractId: string;
  readonly bundleId: string;
  readonly key?: string; // the record's identity, for several records of a many contract
  readonly version: string; // the providing bundle's version
  readonly contractVersion: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly schema:
    | { readonly kind: 'basic' }
    | { readonly kind: 'platform' }
    | { readonly kind: 'document'; readonly document: JsonObject };
}
type ControlMessage =
  | { readonly kind: 'init'; readonly init: unknown } // a GenerationInit, validated by the runner
  | { readonly kind: 'ready'; readonly order: readonly string[] }
  | { readonly kind: 'provide'; readonly descriptor: RemoteProviderDescriptor }
  | {
      readonly kind: 'unprovide';
      readonly contractId: string;
      readonly bundleId: string;
      readonly key?: string;
    }
  | { readonly kind: 'diagnostics'; readonly snapshot: Diagnostics }
  | { readonly kind: 'catalog'; readonly snapshot: CatalogSnapshot }
  | {
      readonly kind: 'platform-log';
      readonly level: 'info' | 'warn' | 'error';
      readonly fields: Readonly<Record<string, unknown>>;
      readonly message: string;
    }
  | {
      readonly kind: 'lifecycle';
      readonly id: string;
      readonly hook: AppLifecycleHook;
      readonly input: unknown;
    }
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: true;
      readonly output: unknown;
    }
  | {
      readonly kind: 'lifecycle-result';
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    }
  | { readonly kind: 'stop' }
  | { readonly kind: 'stopped' };
type AppLifecycleHook =
  | 'onAppReadyHook'
  | 'onAppActivateHook'
  | 'onBeforeQuitHook'
  | 'onGenerationReadyHook'
  | 'onConnectionChangedHook';
const appLifecycleHooks: readonly AppLifecycleHook[]; // frozen, in that order

type WireMessage = EnvelopeMessage | ControlMessage;
const wireMessageSchema: z.ZodType<WireMessage>;
const wireErrorSchema: z.ZodType<WireError>;
const remoteProviderDescriptorSchema: z.ZodType<RemoteProviderDescriptor>;
const controlKinds: ReadonlySet<string>; // the eleven ControlMessage kinds
function isControlMessage(message: WireMessage): message is ControlMessage;
```

`lifecycle` and `lifecycle-result` are declared and accepted by
`wireMessageSchema`, but no code sends them; `appLifecycleHooks` is read by
no code outside the module.

#### `ProcessLink` and `Transport`

From [`link.ts`](src/runtime/envelope/link.ts) and
[`memory.ts`](src/runtime/envelope/memory.ts):

```ts
interface Transport {
  send(message: WireMessage): void; // throws once the channel is closed
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: LinkCloseReason) => void): () => void;
  close(): void;
}
type LinkCloseReason =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'exited';
      readonly code: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: 'disconnected' };
interface ResolveTarget {
  readonly contract: string;
  readonly method: string;
  readonly provider?: string;
  readonly record?: string;
}
interface ProcessLinkOptions {
  readonly transport: Transport;
  readonly side: 'kernel' | 'generation'; // the kernel overwrites caller.generation
  readonly generation: number; // of the process on the generation side
  readonly incarnation?: number;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  resolve(target: ResolveTarget): ProviderRecord | undefined; // a local provider only
  principalOf?(bundleId: string): Principal | undefined; // for scoped callbacks
  report?(entry: DiagnosticReport): void;
  readonly generationSignal?: AbortSignal; // aborts the calls this side serves
  readonly now?: () => number;
}
interface CallTarget {
  readonly contract: string;
  readonly method: string;
  readonly input: unknown; // encoded
  readonly provider?: string;
  readonly record?: string;
} // the inline type of the three methods below; not exported

class ProcessLink implements CodecHost {
  constructor(options: ProcessLinkOptions);
  readonly side: 'kernel' | 'generation';
  readonly generation: number;
  readonly incarnation: number;
  readonly validators: SchemaValidators;
  readonly mirrors: Map<string, unknown>;
  get closeReason(): LinkCloseReason | undefined;
  get closeSignal(): AbortSignal; // aborted when the channel closes
  get inFlight(): number; // outbound calls awaiting a result + inbound calls not answered
  get openStreams(): number;
  onClose(listener: (reason: LinkCloseReason) => void): () => void; // called at once when already closed
  onIdle(listener: () => void): () => void; // each time inFlight drops to 0
  onControl(listener: (message: ControlMessage) => void): () => void;
  sendControl(message: ControlMessage): void;
  close(): void; // closes the transport; reason { kind: 'stopped' }
  forgetStream(end: (error: ContractError) => void): void;
  request(target: CallTarget, call: Call): Promise<unknown>; // resolves with the encoded output
  oneway(target: CallTarget, call: Call): void; // never throws
  optimistic(
    bundleId: string,
    target: CallTarget,
    call: Call,
    exported: readonly string[],
    end?: (error: ContractError) => void,
  ): Disposable; // a local Disposable now; the acknowledgement later
  activating(bundleId: string): () => void; // keep refusals for settle; returns the end mark
  settle(bundleId: string): Promise<void>; // rejects with the first refusal
  // CodecHost
  exportHandle(target: ExportTarget): string;
  exported(handle: string): ExportTarget | undefined;
  invoke(
    handle: string,
    method: string | undefined,
    args: readonly unknown[],
    call: Call,
  ): Promise<unknown>;
  run(handle: string, call: Call): string; // one run of a scoped callback; returns the run handle
  release(handle: string): void;
  detachedCall(): Call; // caller doric, a new trace
  principalOf(bundleId: string): Principal | undefined;
  report(bundleId: string, kind: string, error: unknown): void;
}

interface TransportPair {
  readonly left: Transport;
  readonly right: Transport;
  sever(reason?: LinkCloseReason): void; // ends both sides; default an exit by SIGKILL
}
function createTransportPair(): TransportPair; // structured-clones on send, delivers on a microtask, in order
```

When the call's signal aborts, `request` sends `cancel`; the serving side
aborts the provider's call, with a `TimeoutError` when the deadline has
elapsed. Once the channel closes, every pending and later request rejects with
`generation_lost` (`Generation <n> exited.`, details `{ generation,
incarnation }`), and each open stream registration ends with it. A message that
fails `wireMessageSchema` is reported to `report` as `protocol_error`; when it
is a `call`, `invoke` or `subscribe` with an `id`, the sender receives a
`protocol_error` result.

#### Values, errors and calls

From [`values.ts`](src/runtime/envelope/values.ts),
[`errors.ts`](src/runtime/envelope/errors.ts) and
[`call-meta.ts`](src/runtime/envelope/call-meta.ts):

```ts
const WIRE_KEY = '$doric';
type CallbackMode = 'async' | 'listener' | 'scoped';
type LocalKind =
  | 'callback'
  | 'disposable'
  | 'object'
  | 'call'
  | 'hooks'
  | 'definition'
  | 'tool';
type WireValue = // the wire form of a local value, keyed by WIRE_KEY
  | { readonly $doric: 'call' }
  | {
      readonly $doric: 'callback';
      readonly handle: string;
      readonly mode: CallbackMode;
    }
  | { readonly $doric: 'disposable'; readonly handle: string }
  | { readonly $doric: 'object'; readonly handle: string }
  | {
      readonly $doric: 'hooks';
      readonly id: string;
      readonly hooks: Readonly<
        Record<string, { kind: HookKind; input: JsonObject; order?: HookOrder }>
      >;
    }
  | {
      readonly $doric: 'definition';
      readonly kind: 'event' | 'settings' | 'storage-type';
      readonly id: string;
      readonly schema: JsonObject;
      readonly indexes?: readonly StorageIndex[];
    }
  | {
      readonly $doric: 'tool';
      readonly handle: string;
      readonly name: string;
      readonly description?: string;
      readonly definition: ContractToolDefinition;
      readonly settings: readonly object[];
      readonly resultModalities?: readonly string[];
    };
type ExportTarget =
  | {
      readonly kind: 'callback';
      readonly fn: (...args: unknown[]) => unknown;
      readonly mode: CallbackMode;
      readonly principal?: Principal;
      readonly parentScope?: DisposalScope;
    }
  | { readonly kind: 'disposable'; readonly value: Disposable }
  | { readonly kind: 'object'; readonly value: object }
  | { readonly kind: 'tool'; readonly tool: ContractTool };
interface CodecHost {
  /* the CodecHost members of ProcessLink above */
}
interface CodecContext {
  readonly host: CodecHost;
  readonly call: Call; // the call the value travels with
  readonly exports?: string[]; // handles exported while encoding
}
function encodeValue(
  value: unknown,
  kinds: ReadonlySet<LocalKind>,
  context: CodecContext,
): unknown;
function decodeValue(value: unknown, context: CodecContext): unknown;

interface MethodPlan {
  readonly refused?: string; // why the method cannot cross (local_only)
  readonly oneway?: boolean;
  readonly optimistic?: boolean;
  readonly listener?: number; // index of a stream method's listener among the input's items
  readonly input?: ReadonlySet<LocalKind>; // undefined = plain data
  readonly output?: ReadonlySet<LocalKind>;
  prepare?(input: unknown): unknown;
  finish?(output: unknown, input: unknown): unknown;
}
function fixedPlan(contractId: string, method: string): MethodPlan | undefined; // basic and doric.* methods
function documentPlan(
  label: string,
  input: unknown,
  output: unknown,
): MethodPlan; // from member JSON Schemas
function planFor(
  contractId: string,
  method: string,
  members: { readonly input: z.ZodType; readonly output: z.ZodType },
): MethodPlan; // fixedPlan, else documentPlan of the members

interface RemoteToolCallView {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly definition: ContractToolDefinition;
  execute(payload: unknown): Promise<unknown>;
  check(payload: unknown): Promise<ToolPayloadCheck>;
}
class RemoteTool implements ContractTool {
  constructor(wire: Extract<WireValue, { $doric: 'tool' }>, host: CodecHost);
} // check and execute run in the registering process

interface ErrorClassRegistry {
  register(errorClass: abstract new (...args: never[]) => Error): void;
  lookup(name: string): (abstract new (...args: never[]) => Error) | undefined;
}
function createErrorClassRegistry(): ErrorClassRegistry; // always knows ContractError
function encodeError(value: unknown): WireError;
function decodeError(wire: WireError, classes: ErrorClassRegistry): unknown;

function toWireCall(call: Call): WireCall;
interface RestoreOptions {
  readonly signals: readonly AbortSignal[]; // cancel, link close, receiving runtime
  readonly callerGeneration?: number; // the kernel overwrites caller.generation
  readonly now?: () => number;
}
function restoreCall(meta: WireCall, options: RestoreOptions): Call;
```

`encodeValue` replaces each local value by its `WireValue` and exports a
handle for it; a local value of a kind outside `kinds` throws `local_only`
(`<what> is local to its process and cannot cross the envelope.`).
`decodeValue` rebuilds the local values and keeps plain data as sent; one wire
form always yields one mirror per link. `encodeError` keeps a
`ContractError`'s code (else `internal`) and the thrown value; `decodeError`
returns a `ContractError` when nothing was thrown along, the thrown value as
is, or an error rebuilt on the prototype of its constructor name: the
registered class, else the standard error class of that name, else `Error`
(a `DOMException` is constructed anew); own properties are restored with
their enumerability, nested errors such as `cause` included.
`restoreCall` rebuilds the branded `Call`; its signal aborts with the given
signals and, at the deadline, with a `TimeoutError`.

## `bundle` (Node)

The Node entry for the host, the build, embedded foundation host parts
(`EmbeddedBundle`, as a type) and bundle tests
([`src/index.ts`](src/index.ts)); desktop, client, chunk, worker and frame
parts may not import it ([Build tooling](#build-tooling)). It re-exports, from `bundle/runtime`,
the manifest, composition and descriptor schemas and types, `convertV0`,
`resolveEnvironment`, the alternatives helpers, `PLATFORM_VERSION`,
`PLATFORM_ASSETS_VERSION`, `runGeneration` and its types; and, from
`bundle/testing`, `createTestServices`.

### `startKernel`

```ts
function startKernel(options: StartKernelOptions): Promise<KernelPlatform>;

interface StartHostOptions {
  readonly bundlesPath: string; // its immediate subdirectories are installed bundles
  readonly composition: Composition | { readonly path: string };
  readonly compositionOverrides?: string; // path of the overrides file
  readonly embedded?: readonly EmbeddedBundle[];
  readonly log: PlatformLog; // the platform's own log
  readonly sink: LogSink; // where doric.log/v1 records go
  readonly now?: () => number;
}
interface StartKernelOptions extends StartHostOptions {
  readonly network?: NetworkResources; // provides doric.network/v1 when given
  readonly runnerPath?: string; // default defaultRunnerPath()
  readonly errorClasses?: readonly (abstract new (...args: never[]) => Error)[];
  readonly startAttempts?: number; // default 3
  readonly stopTimeoutMs?: number; // default 10_000
  readonly spawn?: (init: GenerationInit) => SpawnedGeneration; // default forkGeneration(runnerPath)
  readonly startup?: StartupSink; // default: drops the lines
  readonly distribution?: (
    source: KernelDistributionSource,
  ) => CatalogDistributionProvider;
}
interface StartupSink {
  stage(name: string): void;
  log(record: {
    level: 'debug' | 'info' | 'warn' | 'error';
    fields: Readonly<Record<string, unknown>>;
    message: string;
  }): void;
}
interface KernelDistributionSource {
  generation(generation: number): {
    generation: number;
    resolved: ResolvedEnvironment;
    states: BundleStates;
  };
  retained(): readonly number[]; // generations whose process is not stopped
  storage(): StorageIdentity | undefined;
  onActive(listener: (generation: number) => void): () => void;
  embeddedDocuments?(bundleId: string): Readonly<Record<string, JsonObject>>;
}

interface HostPlatform {
  readonly mode: 'normal' | 'recovery';
  readonly generation: number;
  readonly services: Services; // principal 'doric': may use any contract
  call(options?: PlatformCallOptions): Call; // caller doric, new trace
  catalog(): CatalogSnapshot;
  storageIdentity(): Promise<StorageIdentity | undefined>;
  diagnostics(): Diagnostics;
  ready(): Promise<void>;
  stop(): Promise<void>;
}
interface PlatformCallOptions {
  scope?: CallScope;
  signal?: AbortSignal;
  deadline?: number;
  generation?: number;
}
interface KernelPlatform extends HostPlatform {
  readonly generations: GenerationManager;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  view(generation: number): Services;
  methodSpec(contractId: string, method: string): MethodSpec | undefined;
  awaitMethodSpec(
    contractId: string,
    method: string,
    signal?: AbortSignal,
  ): Promise<MethodSpec | undefined>;
}
```

`startKernel` boots the host ([`kernel.ts`](src/process/kernel.ts)):

1. It discovers the installed bundles, reads the composition (a file or a
   value) and applies the overrides file, then resolves generation 1's
   catalog. A discovery problem or an unreadable overrides file becomes a
   catalog issue; an unreadable composition forces recovery
   ([`activate.ts`](src/loader/activate.ts)).
2. It splits the catalog: foundation, core, every embedded bundle and every
   installed bundle listed under the composition's `resident` run in the
   kernel (this process); the other installed bundles run in a generation
   process ([`partition.ts`](src/process/partition.ts)).
3. It provides the platform services (`doric.catalog/v1` with distribution
   members when `distribution` is given and recovery members when
   `compositionOverrides` is given, `doric.diagnostics/v1`, `doric.bundle/v1`,
   `doric.log/v1`, `doric.generation/v1`, `doric.startup/v1`, and
   `doric.network/v1` when `network` is given), and logs `Bundle quarantined`
   with the reasons of each quarantined bundle.
4. It activates the kernel partition. An installed bundle's host part is
   `<dir>/host/index.js`, which must export `activate` (`invalid_part`
   otherwise). After each installed bundle activates, the tools a v0 manifest
   lists are registered on its behalf; once the phase is active, its skills
   (`skills/*/SKILL.md`, or the v0 manifest's list) are registered through
   `skills/v1`, which fails with `missing_dependency` when no `skills/v1`
   provider is active and with `skill_invalid` for an unreadable skill.
5. In recovery it logs `Bundle recovery mode` with the reason and every
   bundle's state and starts no generation; otherwise it starts generation 1
   and resolves once that generation is active or has failed and been replaced
   by an empty view.

The returned platform:

- `call(options)` makes a platform call (caller `doric`, new trace), pinned to
  `options.generation` (default 0, the active one).
- `catalog()` and `diagnostics()` answer for the active generation.
- `storageIdentity()` asks the active `storage.backend/v1` provider for
  `identity()`, or answers `undefined` without one; a resolved identity is
  kept and published in the catalog, a failure is not kept.
- `start()` runs `AppHooksV1.onHostStartHook` (a failing handler rejects),
  then reads the storage identity; once per host, and skipped in recovery.
- `ready()` fires `onHostReadyHook` once; a failure is reported as
  `hook_execute_failed`; skipped in recovery.
- `shutdown()` runs `onHostStopHook` once; a failure is reported and the stop
  goes on.
- `stop()` stops every generation, deactivates the kernel in reverse order,
  disposes the platform and aborts its signal; idempotent.
- `view(generation)` returns the platform's services pinned to that
  generation's view, or throws `unavailable` (`Generation N is not live.`).
- `methodSpec` answers the method specification of the active provider of a
  contract; `awaitMethodSpec` first waits, during a respawn, for the next
  active generation.

How the kernel and its generations work is described in [Process
isolation](../../docs/architecture/bundles/process-isolation.md).

### The generation manager

```ts
interface GenerationManager {
  acquire(work: WorkHoldRef, signal: AbortSignal): Promise<GenerationLease>;
  publish(): Promise<PublishResult>;
  onLost(listener: (lost: LostGeneration) => void): () => void;
  onActive(listener: (generation: number) => void): () => void;
  describe(): readonly GenerationSummary[];
  stop(): Promise<void>;
}
interface WorkHoldRef {
  readonly bundleId: string;
  readonly key: string;
  readonly label?: string;
}
interface GenerationLease {
  readonly generation: number;
  call(options: { scope?: CallScope; signal?: AbortSignal }): Call;
  release(): void; // idempotent
}
interface LostGeneration {
  generation;
  incarnation;
  holds: readonly WorkHoldRef[];
}
interface GenerationChange {
  event: 'activated' | 'draining' | 'lost' | 'stopped';
  generation;
  incarnation;
  holds?;
}
type PublishResult =
  | { status: 'published'; generation: number }
  | { status: 'kernel_restart_required'; reason: string }
  | { status: 'failed'; reason: string };
interface GenerationSummary {
  generation;
  incarnation;
  state: GenerationState;
  pid?: number;
  work: number;
}
interface SpawnedGeneration {
  readonly transport: Transport;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): void;
}
```

From [`manager.ts`](src/process/manager.ts):

- `acquire` waits (abortably) for an active generation and takes a work hold
  on it; it throws `unavailable` (`The host is stopping.`) while the host
  stops.
- `publish` reads the installed bundles and the composition again. It answers
  `kernel_restart_required` when the kernel partition changed, `failed` when
  every start attempt of the new generation fails (reported as
  `generation_failed`; the active generation stays) or the host is stopping,
  and `published` once the new generation is active and the previous one
  drains. Concurrent calls share one run.
- A generation starts with up to `startAttempts` processes. When the active
  generation's process exits unexpectedly, `onLost` listeners run with the
  work holds it kept, `generation_lost` is reported, and the generation
  respawns with the next incarnation; when every attempt fails and no other
  generation is active, an empty view takes its place and its bundles are
  logged as quarantined with `generation_failed`.
- A draining generation stops once it holds no work and no call is in flight;
  `stop` sends `stop`, then kills with `SIGKILL` after `stopTimeoutMs`.
- Each change is announced to every live generation as
  `onGenerationChangedHook`; after a publish or a respawn,
  `onGenerationReadyHook` fires in the new generation. A listener's or a
  hook's failure is reported, never thrown.

### Processes

```ts
function forkGeneration(
  runnerPath: string,
): (init: GenerationInit) => SpawnedGeneration;
function defaultRunnerPath(): string; // dist/process/runner-main.js
function childTransport(child: ChildProcess): Transport;
function parentTransport(): Transport; // throws without an IPC channel
function ajvValidators(): SchemaValidators;
interface HostPartition {
  published;
  kernelOrder;
  generationOrder;
  generationEntries;
}
function partitionCatalog(resolved: ResolvedEnvironment): HostPartition;
function isKernelResident(
  entry: CatalogEntry,
  resident?: readonly string[],
): boolean;
function kernelSignature(resolved: ResolvedEnvironment): string;
```

`forkGeneration` forks the runner with `serialization: 'advanced'`, stdin
ignored, stdout and stderr inherited, an IPC channel and the host's
environment ([`kernel.ts`](src/process/kernel.ts)). The runner,
[`runner-main.ts`](src/process/runner-main.ts), ignores `SIGINT` and `SIGTERM`
(only the kernel ends a generation) and exits when its IPC channel
disconnects. `childTransport` closes when the child exits;
`parentTransport` closes when the channel disconnects; sending on a closed
transport throws `unavailable` ([`node-transport.ts`](src/process/node-transport.ts)).
`ajvValidators` validates JSON Schema 2020-12 with ajv (formats not checked),
compiling each canonical schema once ([`ajv.ts`](src/process/ajv.ts)).
`partitionCatalog` publishes the order kernel first, then generation;
`kernelSignature` is the JSON of the kernel entries (id, version, phase,
state, source), the providers they publish and the recovery reason
([`partition.ts`](src/process/partition.ts)).

### `startHost`

```ts
function startHost(options: StartHostOptions): Promise<HostPlatform>;
```

`startHost` boots the host in one process: it resolves the catalog as
`startKernel` does and activates every scheduled bundle in this process, with
the same platform services but no `doric.generation/v1`, `doric.startup/v1`
or `doric.network/v1`, and the same `HostPlatform` members. Each call starts
a new generation number, counted per process. Foundation and runtime tests
use it ([`activate.ts`](src/loader/activate.ts)).

### Loader

```ts
interface InstalledBundle {
  readonly dir: string;
  readonly read?: ReadManifest;
  readonly descriptor?: Descriptor;
  readonly errors: readonly QuarantineReason[];
}
function discoverBundles(root: string): Promise<readonly InstalledBundle[]>;
function readInstalledBundle(dir: string): Promise<InstalledBundle>;
function readManifest(bundleDir: string): Promise<ReadManifest>;
function readDescriptor(bundleDir: string): Promise<Descriptor | undefined>;
class CompositionError extends Error {
  readonly path: string;
}
function readComposition(path: string): Promise<Composition>;

interface EmbeddedBundle {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  readonly documents?: Readonly<Record<string, JsonObject>>; // contract documents by schema path
  readonly host?: { readonly activate: Activate<HostContext> };
}
interface BuildCatalogInput {
  installed;
  embedded;
  composition;
  platformVersion;
  generation;
  issues?;
  recovery?;
}
function buildCatalog(input: BuildCatalogInput): ResolvedEnvironment; // the host environment
```

`discoverBundles` reads every immediate subdirectory of `root`, sorted by
path, without running bundle code, and throws (`Unable to discover bundles in
root "<root>".`) when `root` cannot be read ([`discover.ts`](src/loader/discover.ts)).
`readInstalledBundle` records an unreadable or invalid manifest as
`invalid_manifest` and an invalid `contracts.json` as `invalid_descriptor`; a
v0 bundle gets an empty descriptor; a missing `contracts.json` leaves the
descriptor absent. `readManifest`, `readDescriptor` and `readComposition` wrap
JSON and schema failures with the file in the message; `readComposition`
throws `CompositionError` ([`read.ts`](src/loader/read.ts)). An embedded
bundle is passed in code; an invalid manifest or descriptor quarantines it
([`catalog.ts`](src/loader/catalog.ts)).

```ts
const compositionOverridesSchema;      // { disabled: string[] }, strict
type CompositionOverrides;
function compositionOverridesPath(compositionPath: string): string; // composition.overrides.json beside it
function readCompositionOverrides(path: string): Promise<CompositionOverrides | undefined>; // undefined when missing
function writeCompositionOverrides(path: string, overrides: CompositionOverrides): Promise<void>;
function clearCompositionOverrides(path: string): Promise<void>;
function applyCompositionOverrides(composition: Composition, overrides: CompositionOverrides | undefined): Composition;
```

The overrides file persists the recovery actions: `applyCompositionOverrides`
leaves each disabled bundle out of `enabled`; the composition file itself is
never rewritten. `writeCompositionOverrides` writes a temporary file and
renames it over the target; `clearCompositionOverrides` deletes the file
([`overrides.ts`](src/loader/overrides.ts)). When `startKernel` has an
overrides path, `doric.catalog/v1.disable({ bundleId })` adds the bundle to
`disabled` (`not_found` when it is not in the composition, `invalid_input` for
the core; an unreadable file is replaced) and `resetComposition()` clears the
file; each then publishes, and a result other than `published` logs
`Composition change applies at the next host start` and throws `unavailable`.
The changes run one at a time ([`composition-actions.ts`](src/process/composition-actions.ts)).

```ts
interface ParsedSkill {
  readonly skill: SkillSchemaInput;
  readonly alwaysAvailable?: boolean;
  readonly order?: number;
}
function parseSkillDocument(
  source: string,
  context: string,
  options?: { frontmatterAvailability: boolean },
): ParsedSkill;
function readSkill(
  bundlePath: string,
  relativePath: string,
  options?: { frontmatterAvailability: boolean },
): Promise<ParsedSkill>;
function discoverSkills(bundlePath: string): Promise<readonly string[]>;
```

A `SKILL.md` is YAML frontmatter between `---` lines, then the Markdown body.
The frontmatter holds `name`, `description`, `allowed-tools` (a
space-separated string or a list), optional `indexText`, and, for a version 1
manifest (`frontmatterAvailability: true`), optional `alwaysAvailable` and
`order` (an `orderKeySchema` integer); any other key is refused.
`discoverSkills` lists `skills/<dir>/SKILL.md` in lexical directory order and
skips a directory without `SKILL.md`. A resource path that is absolute,
contains `\` or escapes the bundle directory is refused
([`skills.ts`](src/loader/skills.ts)).

```ts
interface DistributionInput {
  resolved: ResolvedEnvironment;
  states: BundleStates;
  hostBoot: string;
  platformVersion: string;
  storage?: StorageIdentity;
}
function distributionFor(
  input: DistributionInput,
): Promise<DistributionCatalog>;
function distributionFiles(bundleDir: string): Promise<DistributionFile[]>;
function distributionParts(
  files: readonly DistributionFile[],
): DistributionParts;
```

`distributionFiles` lists, with SHA-256 and size and sorted by path, the files
of a staged bundle the desktop may need: `manifest.json`, `contracts.json`,
`desktop/**`, `client/**`, `schemas/**`, `contracts/**/*.js`, and the modules
outside `contracts/` that those import relatively. `distributionFor` builds
one generation's distribution catalog from the host's catalog snapshot; an
embedded bundle has no files ([`distribution.ts`](src/loader/distribution.ts)).

## `bundle/testing`

```ts
interface TestServicesOptions {
  readonly bundle: { readonly id: string; readonly version?: string }; // version default '0.0.0'
  readonly provide?: readonly AnyServiceDefinition[]; // provided by a fake 'test-provider'
  readonly providers?: readonly {
    readonly bundleId: string;
    readonly provide: readonly AnyServiceDefinition[];
  }[];
}
interface TestServices {
  readonly services: Services; // the bundle under test; requires not enforced
  call(scope?: CallScope, signal?: AbortSignal): Call; // caller 'test', version 0.0.0, generation 1
  readonly reports: readonly DiagnosticReport[]; // failures the runtime reported
  dispose(): Promise<void>;
}
function createTestServices(options: TestServicesOptions): TestServices;
```

`createTestServices` runs a bundle's services in process, with no catalog and
no loader, in the `host` environment of generation 1. Each `providers` entry
is a fake bundle of its own, so several providers of a `many` contract reach
`whenAvailable` with their own ids, in the order given. `dispose` disposes the
bundle under test, then the providers, and aborts the generation signal
([`testing/index.ts`](src/testing/index.ts)).

```ts
import { createTestServices } from 'bundle/testing';

const harness = createTestServices({
  bundle: { id: 'greeter' },
  provide: [fakeDependency],
});

try {
  harness.services.provide(greeter);
  // exercise the services, passing harness.call() as the parent call
} finally {
  await harness.dispose();
}
```

```ts
interface MinimalHooksOptions {
  readonly hookDeadlineMs?: number;   // default 10_000
  readonly calls?: { method: string; caller: string; contract: string }[]; // records every call
}
function createMinimalHooks(options?: MinimalHooksOptions): ServiceDefinition<'hooks/v1', …>;

interface MinimalUiCore {
  readonly manifest: ManifestV1Input;
  readonly descriptor: Descriptor;
  readonly client: { readonly activate: Activate<ClientContext> };
}
const MINIMAL_CORE_TEXT = 'Minimal core';
function minimalUiCore(options?: { readonly id?: string }): MinimalUiCore; // id default 'mincore'
```

`createMinimalHooks` is a complete `hooks/v1` provider written only against
`bundle/contracts` and `doric.*` ([`minimal-hooks.ts`](src/testing/minimal-hooks.ts)):
`define` accepts a `doric.*` contract only from `doric` and any other only
from a bundle whose catalog manifest provides it (`not_owner`), and refuses a
second owner (`registration_conflict`); `execute` runs the handlers of the
kernel and of the call's generation in catalog order (`doric` first), then
registration order. A `sequence` hook awaits each handler with no deadline and
rejects on a failure (`order: 'reverse'` reverses the order); every other
kind gives each handler `hookDeadlineMs`, reports a timeout as
`hook_handler_timeout` and a failure, an invalid transform output or an
invalid decision as `hook_handler_failed` through `doric.diagnostics/v1`,
returns the last valid value for `transform`, and stops at the first refusal
for `decide`.

`minimalUiCore` is a core for window tests ([`minimal-ui-core.ts`](src/testing/minimal-ui-core.ts)):
its client part provides `hooks/v1`, `ui/v1`, `navigation/v1` and
`regions/v1` (navigation matches static paths and `:param` segments only),
and defines `<id>-outlet`, which renders `<p>Minimal core</p>`. Its `ui/v1`
refuses a tag that does not start with the caller's bundle id
(`invalid_input`).

## `bundle/externals`

```ts
const clientExternals: readonly string[];
//   react, react/*, react-dom, react-dom/*, @base-ui/react, @base-ui/react/*, lexical, @lexical/*,
//   desktop/ui, desktop/ui/*, zod, zod/*, bundle/contracts, */contracts
const frameExternals: readonly string[];
//   react, react/jsx-runtime, react/jsx-dev-runtime, react-dom, react-dom/client, @base-ui/react, @base-ui/react/*
function matchesExternal(
  external: readonly string[],
  specifier: string,
): boolean;
```

`clientExternals` are the window import-map specifiers a client part leaves
external, so one instance of each exists per window; `frameExternals` are
those of a frame's import map. A pattern with `*` matches any specifier with
its prefix and suffix ([`externals.ts`](src/build/externals.ts)). The import
map is described in [Platform
packages](../../docs/architecture/bundles/platform-packages.md#the-import-map-of-a-window).

## `bundle/schemas/*`

The package build writes the platform's JSON Schema 2020-12 documents below
`dist/schemas/` ([`platform-schemas.ts`](src/build/platform-schemas.ts)):

| Path                           | `$id` / contents                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `bundle-manifest/v1.json`      | `doric://app/schemas/bundle-manifest/v1.json`, from `manifestV1Schema`                                              |
| `composition/v1.json`          | `doric://app/schemas/composition/v1.json`, from `compositionSchema`                                                 |
| `contracts-descriptor/v1.json` | `doric://app/schemas/contracts-descriptor/v1.json`, from `descriptorSchema`                                         |
| `contracts/<id>.json`          | The contract document of every basic and `doric.*` service, and of `doric.app.hooks/v1` and `doric.window.hooks/v1` |

```ts
function platformSchemaDocuments(): ReadonlyMap<string, JsonObject>; // by path below schemas/
function writePlatformSchemas(outDir: string): Promise<void>;
```

## Build tooling

The build CLI runs from the package's build output:

```console
node packages/bundle/dist/build/cli.js build [--development] <bundleDir>
node packages/bundle/dist/build/cli.js stage <dest> <bundleDir...>
node packages/bundle/dist/build/cli.js stage <dest> --all <root>
node packages/bundle/dist/build/cli.js copy-md <from> <to>
```

```ts
class BuildError extends Error {}
interface BuildOptions {
  readonly mode?: 'production' | 'development';
} // default production
interface BuildResult {
  readonly manifest: ManifestV1;
  readonly descriptor: Descriptor;
  readonly documents: ReadonlyMap<string, JsonObject>;
}
function buildBundle(
  bundleDir: string,
  options?: BuildOptions,
): Promise<BuildResult>;
function bundleDirectories(root: string): Promise<readonly string[]>;
function stageBundles(
  destination: string,
  bundleDirs: readonly string[],
): Promise<void>;
function runCli(args: readonly string[]): Promise<void>;
```

Any other arguments reject with a `BuildError` carrying the usage line; run
from the command line, a failure prints its message and sets exit code 1
([`cli.ts`](src/build/cli.ts)).

**`build`** runs after `tsc` has compiled the bundle ([`cli.ts`](src/build/cli.ts)):

1. It validates `manifest.json` with `manifestV1Schema` (`Invalid manifest
"<path>": …`), removes `dist/skills`, `dist/schemas`,
   `dist/contracts.json` and `dist/manifest.json`, and copies the manifest.
2. It validates each `src/skills/<dir>/SKILL.md` with `SkillSchema`
   (`Invalid skill "<path>": …`) and copies it to `dist/skills/`.
3. It mirrors the Markdown below `src/host` into `dist/host`, as `copy-md`
   does, because the host part reads those templates when it is imported.
4. It builds the desktop and client parts (below).
5. It imports each built part (`host/index.js`, `desktop/index.js`,
   `client/index.js`; never a frame, worker or chunk) and dry-activates it
   against recording services. A client part is imported with a DOM shim
   ([`dom-shim.ts`](src/build/dom-shim.ts)): it may touch the DOM at import
   time only through `class … extends HTMLElement`. A part that fails to load
   or exports no `activate` fails the build.
6. It checks the recording against the manifest (below), then writes each
   contract's document to `dist/schemas/<id>.json`, `dist/contracts.json` and
   `dist/package.json` (`{ "type": "module" }`). A contract recorded in two
   environments with different schemas fails the build.

```ts
class RecordingError extends Error {}
function recordActivation(options: {
  manifest: ManifestV1;
  environment: Environment;
  activate: Activate;
}): Promise<readonly RecordedContract[]>;
function checkRecording(
  manifest: ManifestV1,
  recorded: readonly RecordedContract[],
): readonly string[];
function contractDocument(contract: RecordedContract): ContractDocument;
function schemaPath(contractId: string): string;
```

`recordActivation` records each `provide` (a `many` contract once), each
`hooks/v1.define` of a non-`doric.*` contract, and each `events/v1.register`,
`settings/v1.register`, `storage/v1.defineType` and `commands/v1.register` of
a `defineCommand` value; every other call is an inert no-op and
`whenAvailable` never fires. `use` of a contract outside `requires`,
`optional` and `provides` (and not `doric.*`) throws a `RecordingError`
([`record.ts`](src/build/record.ts)). `checkRecording` lists every problem: a
contract recorded twice in one environment, a contract not declared in
`provides`, a basic contract with another cardinality than the platform's, a
method exposed against the platform's table, and a `provides` entry nothing
recorded.

**Parts** ([`parts.ts`](src/build/parts.ts)). Each part with a source entry is
rebuilt into a cleared output folder with esbuild, bundled as ESM; inline
source maps in development mode, none in production.

| Part           | Platform       | External                                                      | Refused imports                                                                                                  |
| -------------- | -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| desktop        | Node 22        | `bundle/contracts`, `zod`, `zod/*`, `*/contracts`, `electron` | `bundle`, `react`, `react-dom`, `@base-ui/react`, `lexical`, `@lexical/*`, `desktop`                             |
| client, chunks | browser ES2022 | `clientExternals`                                             | `bundle`, `bundle/runtime`, `desktop`, `desktop/client`, `desktop/client/*`                                      |
| workers        | browser ES2022 | none                                                          | as the client                                                                                                    |
| frames         | browser ES2022 | `frameExternals`                                              | as the client, plus `bundle/*`, `desktop/*` and every client external that is not a frame external, except `zod` |

- A relative import that resolves into the bundle's own `src/contracts/`
  becomes the external `<id>/contracts`, except in a frame, which bundles the
  contracts' sources it imports.
- A bundled CommonJS module that `require`s an external gets a module that
  re-exports the external's ESM namespace, so the external stays one instance
  from the import map.
- Every browser build defines `process.env.NODE_ENV` as `"production"` and
  minifies syntax, in either mode, so libraries' development branches neither
  run nor ship in a window; fonts (`.woff2`, `.woff`, `.ttf`) are emitted as
  files under `assets/`.
- `src/client/styles.css` is compiled with Tailwind; a stylesheet that
  extends `@theme` fails the build. The CSS esbuild extracts from the client's
  imports is appended, and `client/styles.css` is written when either exists.
  A chunk's extracted CSS stays beside it as `client/chunks/<name>.css`.
- A failure is reported as `Building the <part> part failed:` with each
  esbuild error and its location.

**`stage`** replaces `<dest>/<id>` with each bundle's `dist`, leaving out
`*.tsbuildinfo` files; it fails naming the bundle directory when
`dist/manifest.json` is missing. With `--all <root>` it stages every
`<root>/<group>/<id>` that holds a `manifest.json`, in code-unit path order
(`bundleDirectories`). It replaces only the directories of the bundles it
stages: any other directory below `<dest>` stays
([`cli.ts`](src/build/cli.ts)). `doric-host` stages every bundle into
`app/backend/doric-host/dist/bundles`.

**`copy-md`** removes every `.md` below `<to>`, then copies each `.md` below
`<from>` to the same relative path; other files are kept, a missing `<from>`
copies nothing. A bundle's `test` target runs it after `tsc` so the compiled
tests find the templates ([`cli.ts`](src/build/cli.ts)).

Each bundle's Nx `build` target runs `tsc --build` of its `tsconfig.json`,
then `build`; how a bundle's project is set up is described in [The bundle
manifest](../../docs/architecture/bundles/manifest.md) and
[Boundaries](../../docs/architecture/bundles/boundaries.md).

## Build and test this package

| Target             | Runs                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle:build`     | `tsc --build packages/bundle/tsconfig.lib.json` into `dist/`, then `node packages/bundle/dist/build/platform-schemas.js`, which writes `dist/schemas/`           |
| `bundle:typecheck` | After `build`: `tsc --build packages/bundle/tsconfig.json --emitDeclarationOnly`, then `tsc -p packages/bundle/tsconfig.browser.json` (the browser-safe entries) |
| `bundle:test`      | `tsc -p` of `tsconfig.browser.json` and `tsconfig.spec.json` into `dist-tests/`, then `node --test packages/bundle/dist-tests/tests/*.test.js`                   |

```console
npx nx run bundle:build
npx nx run bundle:typecheck
npx nx run bundle:test
```

The targets are declared in [`project.json`](project.json); the tests are in
[`tests/`](tests), with fixtures under `tests/support/`.

## Related documents

- [Contracts and the `define*` family](../../docs/architecture/bundles/contracts.md)
- [The bundle manifest](../../docs/architecture/bundles/manifest.md)
- [Contexts and capabilities](../../docs/architecture/bundles/contexts.md)
- [Hooks](../../docs/architecture/bundles/hooks.md)
- [The core bundle and quarantine](../../docs/architecture/bundles/core.md)
- [Composition and distribution](../../docs/architecture/bundles/composition-and-distribution.md)
- [Process isolation](../../docs/architecture/bundles/process-isolation.md)
- [Observability](../../docs/architecture/bundles/observability.md)
- [Platform packages](../../docs/architecture/bundles/platform-packages.md)
- [Boundaries](../../docs/architecture/bundles/boundaries.md)
- [core README](../../bundles/foundation/core/README.md): the basic contracts' methods, data and errors
