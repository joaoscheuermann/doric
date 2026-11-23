# Host config bundle

`host-config` owns the one Doric configuration: the model providers the host
can use, the model and reasoning effort prompts run with, the execution limits,
per-tool values, the user's profile, the Thread archive preferences, and the
references to the stored credentials all of these name. It checks a new
configuration end to end, down to building its providers, before it stores it,
so the host never stores a configuration whose providers failed to build
([`replace`](#replace), step 5).

See the [main README](../../../README.md) for Doric as a whole,
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work,
and the feature docs [settings](../../../docs/features/settings.md) and
[credentials](../../../docs/features/credentials.md) for how the configuration
and the credentials behave across bundles.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                 |
| `id`              | `host-config`                                                                                       |
| `version`         | `0.2.0`                                                                                             |
| `engines.doric`   | `^1.0.0`                                                                                            |
| `description`     | `Owner of the Doric configuration settings space.`                                                  |
| `provides`        | `host-config.configuration/v1@1.2.0`, `host-config/v1@1.2.0`                                        |
| `requires`        | `hooks/v1@^1.0.0`, `settings/v1@^1.0.0`, `secrets/v1@^1.0.0`, `models/v1@^1.0.0`, `tools/v1@^1.0.0` |
| `optional`        | none (the field is absent)                                                                          |
| `desktopScope`    | `{ "host-config/v1": ["projectId", "threadId", "promptId"] }`                                       |

`desktopScope` lets a desktop window send the scope keys `projectId`,
`threadId` and `promptId` with a call to `host-config/v1`
([manifest](../../../docs/architecture/bundles/manifest.md#desktopscope)); the
methods ignore them.

The bundle has one part, the host part ([`src/host/index.ts`](src/host/index.ts)),
and a contracts module ([`src/contracts/index.ts`](src/contracts/index.ts)). It
declares no slot. The build writes the descriptor `dist/contracts.json`, where
`host-config.configuration/v1` is a `settings` contract and `host-config/v1` a
`service` contract, both of the `host` environment, cardinality `one`, not
`local`, at version `1.2.0`, with their JSON schemas under `dist/schemas/`.

The shipped [`composition.json`](../../../app/backend/doric-host/composition.json)
lists `host-config` under `resident`, so its host part runs in the host's own
(kernel) process rather than in the generation process
([`resident`](../../../docs/architecture/bundles/composition-and-distribution.md#resident)):
the `secrets/v1` view and the credential reference source it uses are local to
that process. When a publish changes the kernel partition — the id, version,
phase, state or install directory of a resident bundle, or a contract one
provides, with its cardinality and versions — the publish fails with
`kernel_restart_required` and the host must be restarted; a new version of
`host-config` is such a change. A publish that leaves them unchanged starts the
new generation, and the kernel keeps running this bundle's loaded code until
the next host start ([`manager.ts`](../../../packages/bundle/src/process/manager.ts),
[`partition.ts`](../../../packages/bundle/src/process/partition.ts)). The same file
names `host-config/v1` under `required.contracts`, so the host does not start
without it.

### Package

[`package.json`](package.json) names the package `host-config` (version
`0.0.1`, private, ES module) and exports `./package.json`, `./contracts`,
`./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`), `./kernel` and `./testing` ([Entry points](#entry-points)). Its dependencies
are `bundle`, `core` (for `readModelProperties` of `core/contracts`), `llms`
(the provider kind catalog), `tool` (bound tool factories), `tslib` and `zod`
(`^4.4.3`).

## Contracts it uses

| Contract             | Used for                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings/v1`        | `register` the space `host-config.configuration/v1`, `subscribe` to its writes, `entry` to load it and `set` to replace it ([`configuration.ts`](src/host/configuration.ts), [`store.ts`](src/host/config/store.ts)); shape in the [core README](../core/README.md#settingsv1).                  |
| `secrets/v1`         | `view()` for the stored credential list the settings schema checks, `registerReferences` for the reference source, and `list`, `create`, `update`, `delete` in the credential service ([`credentials/service.ts`](src/host/credentials/service.ts)); [core README](../core/README.md#secretsv1). |
| `models/v1`          | `kind(id)` to learn whether a kind's model list is its catalog, `catalog({ kind, configuration })` to fill the listed models, and `prepare(configuration)` to build providers ([`service.ts`](src/host/config/service.ts)); [core README](../core/README.md#modelsv1).                           |
| `tools/v1`           | `list()`, whose tools must each be a `tool` package bound factory, to check their required fields ([`configuration.ts`](src/host/configuration.ts)); [core README](../core/README.md#toolsv1).                                                                                                   |
| `hooks/v1`           | `use(AppHooksV1).onHostStartHook(...)` to register the start step ([`configuration.ts`](src/host/configuration.ts)); [core README](../core/README.md#hooksv1).                                                                                                                                   |
| `doric.app.hooks/v1` | Its `onHostStartHook` runs the start step ([hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop)). A `doric.*` contract needs no declaration.                                                                                                                                 |
| `doric.startup/v1`   | `stage('configuration_activation')` and two `info` lines with `log(record)` in the start step ([hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop)).                                                                                                                        |

## `host-config/v1` (version 1.2.0)

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`ConfigurationV1 = ref<Configuration>('host-config/v1')`, and provided during
`activate` with `services.provide(defineService(...))`
([`configuration.ts`](src/host/configuration.ts)).

| Method                  | Input                           | Output                | Exposed   |
| ----------------------- | ------------------------------- | --------------------- | --------- |
| `current(call?)`        | none (`z.tuple([])`)            | `DoricConfiguration`  | `desktop` |
| `replace(input, call?)` | `unknown`: the body as received | `ConfigReplaceResult` | `desktop` |

`configurationMethods` holds both method specs, and the service document
`schemas/host-config/v1.json` is built from them with `contractDocument`.

### Shapes

```ts
interface DoricConfiguration {
  configuration: ConfigurationValue;
  revision: number; // the settings space's revision
  updatedAt: string; // ISO-8601, UTC, milliseconds
}

type ConfigReplaceResult =
  | { status: 'replaced'; config: DoricConfiguration }
  | { status: 'invalid'; message: string }
  | { status: 'rejected' };

/** The service `host-config/v1` provides; `CallArg` is the type of `bundle/contracts`. */
interface Configuration {
  current(call?: CallArg): Promise<DoricConfiguration>;
  replace(input: unknown, call?: CallArg): Promise<ConfigReplaceResult>;
}

interface ConfigurationValue {
  providers: ConfigurationProvider[];
  models: { execution: { providerId: string; model: string; effort?: string } };
  execution: {
    maxTurns: number;
    maxToolResultChars?: number;
    contextCompaction?: ContextCompactionConfig;
  };
  tools?: Record<string, Record<string, string>>;
  gitCredentialId?: string;
  githubCredentialId?: string;
  profile?: ConfigurationProfile;
  threads?: {
    autoArchive?: {
      agentThreads?: boolean;
      mainThreadsAfter?: '1d' | '7d' | '30d' | 'never';
    };
  };
}

interface ConfigurationProvider {
  id: string;
  kind: string;
  configuration: Record<string, string>; // a `secret` field holds a credential id
  models?: ConfigurationModel[];
}

interface ConfigurationModel {
  name: string;
  reasonings?: string[];
  defaultEffort?: string;
  mandatory?: boolean;
}

interface ConfigurationProfile {
  name?: string;
  timezone?: string; // absent: the host's own time zone
}

interface ContextCompactionConfig {
  enabled: boolean;
  pressurePercent: number;
  tailMinMessages: number;
  summaryMaxChars: number;
  charBudget: number;
}
```

The contract's Zod schemas (`configurationValueSchema`,
`doricConfigurationSchema`, `configReplaceResultSchema`) are loose objects that
check these types only and carry the value unchanged; the rules of
[The configuration](#the-configuration) are applied by the provider, because
they need the `llms` kind catalog.

The contracts module also exports the defaults a consumer applies when a key
is absent; this bundle never fills them in:

- `defaultContextCompaction`: `{ enabled: true, pressurePercent: 80, tailMinMessages: 6, summaryMaxChars: 6000, charBudget: 200000 }`, for an absent `execution.contextCompaction`.
- `defaultMaxToolResultChars`: `50000`, for an absent `execution.maxToolResultChars`.

### `current`

Answers the active snapshot. The first call loads it from the settings space
([Storage](#storage)) and caches it; concurrent first calls share one load,
and a failed load is retried by the next call
([`service.ts`](src/host/config/service.ts)). The cache changes only through
`replace`: a write to the space made by anything else is not seen by
`current` until the host starts again. A failed load rejects the call with the
load's error.

### `replace`

The input is parsed against the configuration schema first, outside the lane;
a body the schema refuses answers
`{ status: 'invalid', message: 'The Doric configuration is invalid.' }`.
Every accepted body then runs in one serialized lane, in request order; a
failed replacement does not block the next one
([`service.ts`](src/host/config/service.ts)):

1. The active snapshot is loaded if it is not yet.
2. Every credential reference must name a stored credential of the right kind
   ([Credential references](#credential-references)).
3. The listed models are filled from their kinds' catalogs with
   `readModelProperties` of `core/contracts`: for each kind,
   `models/v1.kind(kind)` says whether its model list is its catalog
   (`modelsFromCatalog`; a kind that cannot be described is not). A provider of
   such a kind gets every model its catalog lists, in the catalog's order, even
   when it lists none. Any other provider that lists models gets, for each
   model, the catalog's `reasonings` (empty for a model the catalog does not
   name), `defaultEffort` and `mandatory`. A catalog that answers anything
   other than `read` leaves its provider as it was, and a provider of another
   kind that lists no models is not read. The execution profile is then
   resolved against the model it names, in this order: when the provider does
   not list that model, or the model carries no `reasonings`, the profile is
   unchanged; when the model's effort list is empty, the profile loses its
   `effort`, even a named one; a named `effort` is kept; with none, it takes
   the model's `defaultEffort` when that is in the list, else the first effort
   other than `none`, else the first effort. The fill is `readModelProperties`
   and `executionProfile` of the
   [core's public entry point](../core/README.md#public-entry-point).
4. Every tool of `tools/v1.list()` must resolve each required field it
   declares from `tools[<tool name>][<field key>]` or else from the field's
   default; a missing or blank value of a required field fails with
   `Tool <name> requires a <key> value.`, and a listed tool that is not a
   `tool` bound factory fails with `Tool "<name>" was not defined with defineTool.`
   ([`tool-config.ts`](src/host/config/tool-config.ts)).
5. `models/v1.prepare(configuration)` builds the candidate providers from the
   bare filled configuration, so a configuration whose providers fail to build
   is never stored.
6. The filled configuration is written with one `settings/v1.set`
   ([Storage](#storage)).
7. `models/v1.prepare(snapshot)` activates the stored revision's providers,
   the snapshot becomes active, and the call answers
   `{ status: 'replaced', config: snapshot }`. The `models/v1` provider reuses
   the candidate set of step 5 only when the providers serialize identically,
   in the same order
   ([`providers.ts`](../core/src/host/models/providers.ts)); the store sorts
   providers by `id` and reorders their keys, so a body whose order differs
   from the stored order is built twice.

| Result     | When                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replaced` | Every step succeeded.                                                                                                                                                                                                                                     |
| `invalid`  | The schema refused the body (fixed message), or step 2 or 4 failed (that step's message).                                                                                                                                                                 |
| `rejected` | A failure before the write: the load, the credential list, a catalog step, the step 5 build or the write itself. Nothing is stored and the active configuration is kept.                                                                                  |
| `rejected` | A failure of step 7, after the write. The new revision is stored and the reference source already answers its credentials, but `current` keeps answering the previous snapshot until the next host start, whose start step activates the stored revision. |

`transport` serves the two methods as `GET /config` and `PUT /config`, and
answers `invalid` with 422 `invalid_config` and `rejected` with 503
`configuration_rejected`
([`routes/config.ts`](../transport/src/host/routes/config.ts)).

## The configuration

`ConfigInputSchema` ([`schema.ts`](src/host/config/schema.ts)) is the rule a
stored configuration obeys. Every object in it is strict: an unknown key is
refused.

| Field                          | Rule                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providers`                    | At least one provider; provider `id`s are unique.                                                                                                                              |
| `models.execution.providerId`  | Trimmed, 1–128 characters; must be the `id` of a listed provider.                                                                                                              |
| `models.execution.model`       | Trimmed, 1–512 characters. It is not checked against the provider's model list.                                                                                                |
| `models.execution.effort`      | Optional; one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. It is not checked against the model's efforts.                                                    |
| `execution.maxTurns`           | A positive safe integer: the turn limit of one prompt.                                                                                                                         |
| `execution.maxToolResultChars` | Optional positive safe integer: the cap on one tool result.                                                                                                                    |
| `execution.contextCompaction`  | Optional, all five keys: `enabled` boolean, `pressurePercent` integer 50–95, `tailMinMessages` positive integer, `summaryMaxChars` integer ≥ 200, `charBudget` integer ≥ 1000. |
| `tools`                        | Optional record of tool name → record of field key → string. Its values are checked only by step 4 of `replace`.                                                               |
| `gitCredentialId`              | Optional UUID of a `GIT` credential: the Git identity.                                                                                                                         |
| `githubCredentialId`           | Optional UUID of an `API_TOKEN` credential: the GitHub token.                                                                                                                  |
| `profile.name`                 | Optional; trimmed, then 1–100 UTF-16 code units with no `\r` or `\n`. The trimmed value is stored.                                                                             |
| `profile.timezone`             | Optional; a zone the host's `Intl.DateTimeFormat` accepts, stored as given. Absent means the host's own time zone.                                                             |
| `threads.autoArchive`          | Optional `{ agentThreads?: boolean, mainThreadsAfter?: '1d' \| '7d' \| '30d' \| 'never' }`; absent keys mean `true` and `'7d'`, applied by the runtime.                        |

A provider is `{ id, kind, configuration, models? }`, judged against the kind
it names in the `llms` catalog
([`kinds.ts`](../../../packages/llms/src/lib/providers/kinds.ts)):

- `id` is trimmed, 1–128 characters. `kind` is trimmed, 1–128 characters, and
  must equal the `id` of a catalog kind exactly (`providerKind`); any other
  value is refused with `Unknown provider kind: <kind>`.
- `configuration` holds exactly the kind's declared fields: a key the kind does
  not declare is refused, a required field must be present and not blank, and
  an optional field is either absent or not blank. Each value must suit its
  field's kind: `url` starts with `http://` or `https://`, `number` is a finite
  number, `enum` is one of the field's options, `secret` is a UUID, and `text`
  is any string.
- `models` is present exactly when the kind keeps the `models` list; it may be
  empty. Model names are trimmed, 1–512 characters, and unique.
- When the kind keeps `reasonings`, every model carries `reasonings` (unique
  efforts from the list above, possibly empty), an optional `defaultEffort`
  that must be one of them, and an optional `mandatory` boolean. When it does
  not, a model carries none of the three.

The configuration holds no secret: a provider's `secret` field,
`gitCredentialId` and `githubCredentialId` each carry the UUID of a stored
credential, so `current` answers the same shape `replace` accepts.

`providerCredentials(provider)` answers `{ field, id }` for every `secret`
field a provider sets ([`schema.ts`](src/host/config/schema.ts)).

## Storage

The configuration is the one value of the `settings/v1` space
`host-config.configuration/v1`, which the core keeps as a `core.settings/v1`
document through `storage/v1`. The space's schema is `ConfigInputSchema` plus
one check: every credential reference must be in `secrets/v1.view().list()`
(`The configuration references a credential that is not stored.`); while the
view cannot be read, any configuration with a reference is refused
([`configuration.ts`](src/host/configuration.ts)).

The store ([`store.ts`](src/host/config/store.ts)) writes and reads through two
normalizers, so `current` and `replace` answer the same bytes for the same
configuration:

- A write stores the configuration with `providers` sorted by `id`
  (`localeCompare`) and `tools` set to `{}` when absent.
- A read rebuilds the value and parses it again with `ConfigInputSchema`, which
  emits the top-level keys in the order `providers`, `models`, `execution`,
  `tools`, `gitCredentialId`, `githubCredentialId`, `profile`, `threads`, and
  each nested object in its schema's key order. Providers are sorted by `id`;
  a provider's `configuration` keys are in PostgreSQL jsonb order (shorter
  UTF-8 byte length first, then by bytes), with the first `secret` field of its
  kind last; the tool names and each tool's field keys are in jsonb order
  ([`order.ts`](src/host/config/order.ts)).
- The snapshot is `{ configuration, revision, updatedAt }`, with `revision` and
  `updatedAt` of the settings entry; each write gets the next revision.

A space never written fails the load with `settings_missing`, because the
schema refuses `{}`; the Doric host's migrations seed it
([postgres README](../postgres/README.md#rows-the-migrations-leave)).
`defaultConfig` ([`schema.ts`](src/host/config/schema.ts)) is the same
configuration: one provider `openrouter` of kind `openrouter` with
`endpoint: 'https://openrouter.ai/api/v1'`, `token:
'00000000-0000-4000-8000-000000000002'` and no models; execution model
`openrouter` / `deepseek/deepseek-v4-flash-0731` with effort `low`;
`maxTurns: 32`; and `tools: {}`.

## Credential references

The references of a configuration are each provider's `secret` field values,
`gitCredentialId` and `githubCredentialId` (`referencedCredentialIds`,
[`configuration.ts`](src/host/configuration.ts)).

- `replace` checks each against the credential list of `secrets/v1`
  ([`service.ts`](src/host/config/service.ts)): a provider's secret must name an
  `API_TOKEN` credential (label `Provider <id> <field key>`), `gitCredentialId`
  a `GIT` one (`The Git identity`) and `githubCredentialId` an `API_TOKEN` one
  (`The GitHub credential`). A reference to nothing answers
  `invalid` with `<label> references a credential that is not stored.`; one of
  the wrong kind with `<label> must reference a <KIND> credential, not a <kind> one.`
- The bundle registers a reference source with `secrets/v1.registerReferences`
  that answers the references of the latest configuration it has seen: the one
  the store loaded, then the value of every write to the space. While a
  credential is referenced, `secrets/v1.delete` answers `referenced`.
- A credential named only in `tools` is neither checked nor registered as a
  reference.

## Start step

The host part registers an `onHostStartHook` handler
([`configuration.ts`](src/host/configuration.ts)). It sets the startup stage
`configuration_activation`, logs `Activating Doric configuration`, loads the
snapshot through `current`, calls `models/v1.prepare(snapshot)`, and logs
`Doric configuration activated` with the fields `configRevision`,
`providerCount`, `executionModel` and `maxTurns`. The hook runs before the host
listens, so no prompt resolves a provider before the stored configuration is
active, and a failure of the step (a missing or unreadable space, a stored
value the schema refuses, a provider that cannot be built) stops the host
([hooks](../../../docs/architecture/bundles/hooks.md#host-start-and-stop)).
`activate` itself does no I/O: it registers the space, the subscription, the
reference source, the service and the hook, and its disposer removes the hook.

## Side effects

- One `settings/v1` write per `replace` that reaches step 6.
- Provider builds through `models/v1.prepare`, and catalog reads through
  `models/v1.catalog`, which may reach the providers' endpoints.
- Two `doric.startup/v1` log lines at start.
- No file, process or network access of its own.

The bundle reads no environment variable and has no configuration of its own;
`DORIC_CREDENTIAL_KEY` appears only in the message of `MissingKeyError`.

## Entry points

- `host-config/contracts` ([`src/contracts/index.ts`](src/contracts/index.ts)):
  `ConfigurationV1`, the types of [Shapes](#shapes) (`Configuration`,
  `DoricConfiguration`, `ConfigReplaceResult`, `ConfigurationValue`,
  `ConfigurationProvider`, `ConfigurationModel`, `ConfigurationProfile`,
  `ContextCompactionConfig`), the three Zod schemas,
  `configurationMethods`, `defaultContextCompaction` and
  `defaultMaxToolResultChars`.
- `host-config/kernel` ([`src/kernel.ts`](src/kernel.ts)), for kernel and test
  compositions that embed the bundle instead of installing it:
  - `createHostConfig()` returns `{ bundle, definition, track(configuration) }`:
    `bundle` is the embedded bundle (its manifest has the same `provides` and
    `requires` as `manifest.json`, version `0.0.0`, no `desktopScope`, and
    carries the service document of `host-config/v1`); `definition` is the
    settings space definition; `track` sets the configuration the reference
    source answers. The installed part's `activate`
    ([`src/host/index.ts`](src/host/index.ts)) activates this same bundle.
  - The types `HostConfig` (the return of `createHostConfig`) and
    `ConfigurationSettings` (the type of `definition`).
  - `configurationSettingsId` (`'host-config.configuration/v1'`),
    `referencedCredentialIds(configuration)`, and `boundTools(registered)`,
    which answers the bound factories of `tools/v1.list()` and throws a
    `TypeError` for a tool not defined with `defineTool`.
- `host-config/testing` ([`src/testing.ts`](src/testing.ts)), for tests only:
  - `ConfigInputSchema`, `defaultConfig`, `providerCredentials` and the types
    `ConfigInput` and `DoricConfig` ([`schema.ts`](src/host/config/schema.ts)).
  - `createConfigStore({ settings, definition, track })` → `{ load(), replace(config) }`.
  - `createConfigService({ store, credentials, tools, models })` →
    `{ current(), replace(input) }`, where `credentials` answers a promise of
    the credential service, `tools` the bound tools, and `models` has
    `catalog`, `kind` and `prepare`.
  - `createCredentialService({ secrets })`
    ([`credentials/service.ts`](src/host/credentials/service.ts)) awaits
    `secrets.list()`, so a missing or unusable key with a secret at rest fails
    there, and answers a service over the synchronous `secrets.view()`:
    `list()`, `find(id)`, `byId(id)` (throws `Credential <id> is not stored.`),
    `byKind(kind)` (none, or the only one; several throw
    `More than one <KIND> credential is stored; name the one to use.`),
    `byUnclaimedKind(kind, claimed)` (the same, ignoring the ids in `claimed`),
    `secrets()` (the redaction list), `register(secret)` (adds a non-empty
    redaction), `create(input)` and `update(id, input)` (answer
    `{ status: 'saved', credential }`; `{ status: 'missing' }` when the
    written credential is not in the list afterwards or for
    `credential_missing`; `{ status: 'invalid', message }` for
    `credential_invalid`; `{ status: 'conflict' }` for `credential_name_taken`;
    `{ status: 'immutable' }` for `credential_kind_immutable`; throw
    `MissingKeyError` for `credential_storage_unavailable`, with the message
    `DORIC_CREDENTIAL_KEY is required to store a credential secret.`; and
    rethrow any other
    error), and `remove(id)` (`secrets/v1.delete`, answering `'deleted'`,
    `'missing'` or `'referenced'`).
    In the host part, the service is created on the first `replace` and
    created again after a failure.
  - `credentialById`, `credentialByKind`
    ([`resolve.ts`](src/host/credentials/resolve.ts)), `publicCredential`
    (a credential with `secret` replaced by `hasSecret`,
    [`kind.ts`](src/host/credentials/kind.ts)), `MissingKeyError` and the
    types `Credential`, `CredentialService`, `ConfigService`, `ConfigStore`.

## Build and test

```console
npx nx run bundle-host-config:typecheck
npx nx run bundle-host-config:test
npx nx run bundle-host-config:build
```

[`project.json`](project.json) declares:

- `typecheck`: `tsc --build --emitDeclarationOnly`.
- `build`: `tsc --build` into `dist/`, then the bundle build of
  `packages/bundle`, which writes `dist/manifest.json`, `dist/package.json`,
  `dist/contracts.json` and `dist/schemas/`. `doric-host:build-bundles` stages
  `dist` into `app/backend/doric-host/dist/bundles/host-config`.
- `test`: compiles `src/` and `tests/` into `dist-tests/` with
  `tsconfig.spec.json` and runs `node --test` on `dist-tests/tests/*.test.js`:
  [`config.test.ts`](tests/config.test.ts) for the schema, the store and the
  `replace` pipeline, and [`credentials.test.ts`](tests/credentials.test.ts)
  for credential resolution.

Activation, the reference source and the start step of `createHostConfig` are
tested in `app/backend/doric-host/tests/` (`npx nx run doric-host:test`), whose
tests skip unless `DORIC_TEST_DATABASE_URL` names a test database.

Each target first builds the projects the bundle depends on.
