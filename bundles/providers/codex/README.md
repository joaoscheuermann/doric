# Codex provider bundle

`codex` registers the internal `codex` provider kind with Doric's model layer.
The kind sends a model's requests to the ChatGPT Codex Responses backend,
authenticated with a Codex authorization value. It is not a user-facing option:
the kind is not advertised, so it does not appear in the list of provider kinds
you can choose when you connect a model, while a configuration that names a
`codex` provider still builds it. To connect a model, use the
[`openai`](../openai/README.md) or [`openrouter`](../openrouter/README.md) kinds.

It is a provider bundle with one host part, which provides the kind as one
`models.provider/v1` record that the `models/v1` of the
[`core`](../../foundation/core/README.md) bundle registers, lists and builds.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.
The feature doc [Models and providers](../../../docs/features/models-and-providers.md)
describes how provider kinds, configured providers and model catalogs work
across bundles, and [Provider sign-in](../../../docs/features/provider-sign-in.md)
how the Codex authorization value is obtained.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                             |
| ----------------- | ------------------------------------------------- |
| `manifestVersion` | `1`                                               |
| `id`              | `codex`                                           |
| `version`         | `1.2.0`                                           |
| `engines.doric`   | `^1.0.0`                                          |
| `description`     | `Codex provider kind (internal, not advertised).` |
| `provides`        | `models.provider/v1@1.3.0`                        |
| `requires`        | `log/v1@^1.0.0`                                   |

The manifest has no `optional` contracts and no slots. The bundle has no
settings, routes, tools, client part or desktop part.

[`package.json`](package.json) names the package `codex` and exports one
entry, `./host` ([`src/host/index.ts`](src/host/index.ts), built to
`dist/host/index.js`). It depends on `bundle` (for `bundle/contracts`), `llms`
(the Codex provider), `pino` (the logger the `llms` providers take) and
`tslib`.

## Host part

[`src/host/index.ts`](src/host/index.ts) exports `activate`, which provides
one `models.provider/v1` record built from the `codex` kind definition
([`src/host/kind.ts`](src/host/kind.ts)) by `createKindProvider`
([`src/host/provider.ts`](src/host/provider.ts)). `activate` does no I/O and
uses no contract.

It also exports `createActivate(options)`, the same host part with injected
dependencies, for tests:

| Option      | Type                  | Default                                                                                |
| ----------- | --------------------- | -------------------------------------------------------------------------------------- |
| `transport` | `() => HttpTransport` | `createFetchTransport()` of `llms`, called once per `create` call                      |
| `logger`    | pino `Logger`         | a pino logger whose records go to `log/v1`, made on the first `create` and then reused |

The default logger is made lazily: the host part calls `services.use(LogV1)`
only on the first `create`, and every later `create` of the same activation
reuses that logger ([`src/host/index.ts`](src/host/index.ts)).

## Provided contract: `models.provider/v1@1.3.0`

The contract is declared in
[`packages/bundle/src/contracts/basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)
and imported from `bundle/contracts`. It runs in the `host` environment only
and has cardinality `many`: every provider bundle registers its own record
([`packages/bundle/src/contracts/basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)).
The full shape of the contract — the inputs and outputs of its six methods,
`ModelKindDescriptor`, `ModelField`, `CatalogResult`, `ModelIconChoice`, the
`icons` limits and the `LanguageModel` handle that `create` answers — is in
the [`packages/bundle` README](../../../packages/bundle/README.md#the-modelsproviderv1-contract).
This bundle registers exactly one record, with `{ cardinality: 'many' }`
([`src/host/provider.ts`](src/host/provider.ts)). The contract has no
optional methods, so a record implements all six methods below, and it
defines no events.

### Methods and what `codex` answers

| Method                            | Input                                                                                             | Output                                   | `codex` answer                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `kind()`                          | none                                                                                              | `ModelKindDescriptor`                    | the descriptor of [The `codex` kind](#the-codex-kind)                            |
| `advertised()`                    | none                                                                                              | `boolean`                                | `false`                                                                          |
| `catalog(input)`                  | `{ configuration: Record<string, string>, secret?: string }` (strict)                             | `CatalogResult`                          | always `{ status: 'absent' }`, with no request                                   |
| `create(input)`                   | `{ providerId: string, values: Record<string, string>, secret?: () => Promise<string> }` (strict) | `LanguageModel` (a process-local handle) | the built Codex provider, as in [Building a provider](#building-a-provider)      |
| `catalogCapacity()` (minor 1.1.0) | none                                                                                              | `boolean`                                | `false`                                                                          |
| `icons(input)` (minor 1.2.0)      | `{ configuration: Record<string, string>, models: string[] }` (strict)                            | `ModelIconChoice`                        | `{ provider: 'openai', models: ['openai', …] }`, one `'openai'` per listed model |

`advertised()` decides whether `models/v1.kinds()` (and so
`GET /providers/kinds`) lists the kind; `models/v1.kind('codex')` resolves it
either way
([`bundles/foundation/core/src/host/models/registry.ts`](../../foundation/core/src/host/models/registry.ts),
[`bundles/foundation/core/src/host/models/index.ts`](../../foundation/core/src/host/models/index.ts)).
`catalogCapacity()` decides whether the built provider's `models()` reports
context capacity to `models/v1.contextWindow`; `false` means it does not
([`bundles/foundation/core/src/host/models/capacity.ts`](../../foundation/core/src/host/models/capacity.ts)).

`create` receives `secret` as a callback that crosses no process: the
contract marks it a local callback
([`packages/bundle/src/contracts/basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)),
and `models/v1` passes it when the provider's configuration names a
credential in its first `secret` field
([`bundles/foundation/core/src/host/models/providers.ts`](../../foundation/core/src/host/models/providers.ts)).
The output is a handle made with `toLanguageModel`, a copy of the answered
object's own properties on a prototype of its own: back in the host process
that built it, it is the object `create` answered; anywhere else any use of it
is refused as `local_only`.

`icons` limits: `models` holds at most 1000 names (`MODEL_ICON_MAX_MODELS`),
each at most 512 characters (`MODEL_ICON_MAX_NAME`); every icon name in the
answer is 1 to 64 characters, `provider` may be absent, and `models` has the
input's length and order, with `null` for a model without an icon of its own.
The choice is pure: it does no I/O and reads no secret, and a throw makes
`icons` reject.

### Data shapes

`ModelKindDescriptor` (strict):

| Key                 | Type                                       | Meaning                                                                                  |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `id`                | `string`                                   | the kind id                                                                              |
| `label`             | `string`                                   | the kind's display name                                                                  |
| `description`       | `string`                                   | one sentence on what the kind connects to                                                |
| `fields`            | `ModelField[]`                             | the values a provider of the kind carries                                                |
| `lists`             | `('models' \| 'reasonings')[]`             | the lists a provider of the kind keeps                                                   |
| `modelsFromCatalog` | `boolean`, optional                        | whether the model list is the live catalog                                               |
| `site`              | `{ url: string, label: string }`, optional | the `https:` site a provider page links to, with a non-empty control label (minor 1.3.0) |

`ModelField` (strict): `key`, `label` (strings), `kind` (`text`, `url`,
`number`, `enum` or `secret`), `required` (boolean), and optional
`description`, `placeholder`, `options` (strings) and `advanced` (boolean). A
`secret` field's value is the id of a stored `API_TOKEN` credential, which the
host resolves; it never holds the secret itself.

`CatalogResult`: `{ status: 'read', models: CatalogModel[] }` or
`{ status: 'absent' | 'failed' }`. `CatalogModel` has `id`, `reasonings` and
`parameters` (string arrays) and `mandatory` (boolean), optional `name` and
`defaultEffort`, and may carry more keys.

`ModelIconChoice` (strict): optional `provider` (icon name) and `models`
(icon name or `null` per requested model).

## The `codex` kind

[`src/host/kind.ts`](src/host/kind.ts) defines the kind. It has no `site`,
no `modelsFromCatalog`, and `lists` is empty, so a `codex` provider keeps no
model list. Its fields, in order:

| `key`              | `label`              | `kind`   | Required | Other                                                                                           |
| ------------------ | -------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `endpoint`         | `Endpoint`           | `url`    | no       | `advanced: true`; `placeholder` is the default base URL `https://chatgpt.com/backend-api/codex` |
| `token`            | `Token`              | `secret` | yes      | names the stored `API_TOKEN` credential that carries the Codex authorization value              |
| `chatGptAccountId` | `ChatGPT account ID` | `text`   | no       | sent as the `ChatGPT-Account-ID` header beside the authorization value                          |
| `fedramp`          | `FedRAMP`            | `enum`   | no       | `options: ['true', 'false']`, `placeholder: 'false'`; `true` sends `X-OpenAI-Fedramp`           |

The label is `Codex` and the description is `The ChatGPT Codex Responses
backend, authenticated with a Codex authorization value.` The `endpoint` and
`token` fields come from the builders `endpointField` and `tokenField`
of [`src/host/provider.ts`](src/host/provider.ts). The descriptor equals the
`codex` entry of the `llms` kind catalog (`providerKind('codex')` in
[`packages/llms/src/lib/providers/kinds.ts`](../../../packages/llms/src/lib/providers/kinds.ts))
and the fixture [`tests/fixtures/provider-kind.json`](tests/fixtures/provider-kind.json),
which the tests compare it with.

## Building a provider

`create({ providerId, values, secret })`
([`src/host/provider.ts`](src/host/provider.ts),
[`src/host/kind.ts`](src/host/kind.ts)):

1. Copies `values` into the provider's sources. When `secret` is given, it
   becomes the source of `token`, the kind's `secret` field, and replaces any
   literal `token` value. `models/v1` passes the provider's values without the
   credential id and passes `secret` as a callback that reads the stored
   credential through `secrets/v1` each time it is called
   ([`bundles/foundation/core/src/host/models/providers.ts`](../../foundation/core/src/host/models/providers.ts)).
2. Checks every required field: `token` must be a callback or a literal that
   is not blank, else `create` rejects with
   `Provider kind codex requires a token value.`
3. Reads `chatGptAccountId`, `fedramp` and `endpoint` as literals; a callback
   in their place rejects with
   `Provider value <key> is a literal, not a source.` (the contract's `values`
   are strings, so only a direct caller of the kind definition can pass one).
   `fedramp` absent sends no flag, `'true'` or `'false'` sets it, and any
   other value rejects with `Provider value fedramp is not a flag: <value>`.
   `endpoint` absent keeps the default base URL; present, it replaces it.
4. Calls `createCodexProvider` of `llms` with the transport (one per `create`),
   the logger, `authorization` set to the `token` source, and the optional
   account id, flag and base URL. `providerId` reaches the kind's `build` as
   `deps.identity` (`{ id: providerId, name: providerId }`); the `codex`
   `build` does not pass it on.
5. Answers the built provider with two more keys, `kind: 'codex'` and
   `configuration` (the kind's `fields`), made a `LanguageModel` handle with
   `toLanguageModel`.

The `token` callback is not called during `create`: the `llms` provider awaits
it before every request, so a rotated credential reaches the next request of a
provider built before the rotation.

### The built provider

The provider is the Codex provider of `llms`
([`packages/llms/src/lib/providers/codex.ts`](../../../packages/llms/src/lib/providers/codex.ts)),
built on the OpenAI Responses core
([`packages/llms/src/lib/providers/openai.ts`](../../../packages/llms/src/lib/providers/openai.ts)):

- **Requests.** Responses go to `POST <base URL>/responses` and the model list
  to `GET <base URL>/models`. Each request carries the authorization value, as
  read from the `token` source, unchanged in the `authorization` header (no
  `Bearer` prefix is added; a blank value sends no header,
  [`packages/llms/src/lib/providers/auth.ts`](../../../packages/llms/src/lib/providers/auth.ts)),
  plus `ChatGPT-Account-ID` when an account id is set and
  `X-OpenAI-Fedramp: true` when `fedramp` is `'true'`.
- **Body.** The request body drops `temperature`, sets `store: false`, and
  sets `instructions` to the request's instructions, or to
  `You are Codex, a coding agent.` when they are absent or blank.
- **Completion.** A non-streaming completion reads the stream and answers its
  final response; a stream that ends without one fails with the provider error
  code `missing_stream_finish`, and a stream error is raised as a provider
  error.
- **Capabilities.** Streaming, tools, reasoning, model listing, OAuth, service
  tier and structured outputs are reported; embeddings and reranking are not,
  and calling them rejects with `unsupported_embeddings` or
  `unsupported_reranking`.
- **Account id.** An account id that reads blank at request time fails with
  `auth_missing` (`Codex provider received an empty auth value.`).
- **Logging.** The logger gets the child bindings `component: 'llms'` and
  `provider: 'codex'`; building the provider, and so each `create`, logs
  `llm provider initialized` at `debug`, and each operation is logged at
  `debug` as `llm <operation> <status>` with its fields
  ([`packages/llms/src/lib/providers/logging.ts`](../../../packages/llms/src/lib/providers/logging.ts)).
- **Other failures.** A built provider also fails with the errors of the
  `llms` OpenAI Responses core: `provider_error` when the stream reports
  `response.failed`, `missing_model` when `validateModel` finds no such model
  in `models()` ([`openai.ts`](../../../packages/llms/src/lib/providers/openai.ts)),
  `auth_failed` for HTTP 401 or 403 and `http_error` for any other status of
  400 or above, retryable for 429 and 500 and above
  ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts)), and a
  retryable `network_error` when the connection cannot be made or drops
  ([`http.ts`](../../../packages/llms/src/lib/providers/http.ts)).

## Contracts used

- **`log/v1`** (required, `^1.0.0`): the sink of the default `llms` logger.
  [`src/host/logger.ts`](src/host/logger.ts) builds a pino logger at level
  `debug` whose every JSON record becomes one `log/v1` call. The pino level
  maps to the method: 50 and above to `error`, 40 to `warn`, 30 to `info`,
  anything lower to `debug`, and a record without a numeric level to `info`.
  `msg` becomes the message (`''` when it is not a string), pino's `level`,
  `time`, `pid` and `hostname` are dropped, and every other field, child
  bindings included, is passed as the record's fields. A record that cannot be
  parsed or delivered is dropped: logging never fails the caller.

`models.provider/v1` is the only contract the bundle provides; it uses no
other contract. It calls no `secrets/v1` itself: the credential arrives only
through the `secret` callback of `create`.

## Data, side effects and configuration

- **Persistence.** None: the bundle stores nothing and keeps no state beyond
  the lazily made logger of its activation
  ([`src/host/index.ts`](src/host/index.ts)).
- **Network.** Only a built provider sends requests, through the transport
  (`fetch` by default) to the endpoint; `kind`, `advertised`, `catalog`,
  `catalogCapacity` and `icons` send none
  ([`src/host/provider.ts`](src/host/provider.ts)).
- **Logs.** Records go to `log/v1` as described above; each `create` writes
  at least the `llm provider initialized` record
  ([`src/host/logger.ts`](src/host/logger.ts),
  [`packages/llms/src/lib/providers/logging.ts`](../../../packages/llms/src/lib/providers/logging.ts)).
- **Configuration.** None of its own: no settings and no environment
  variables ([`src/host/index.ts`](src/host/index.ts),
  [`src/host/kind.ts`](src/host/kind.ts)). A provider's values come from the
  host's provider configuration through `models/v1`, and the credential from
  `secrets/v1`.

## Errors

| Where          | Error                                                                                            | When                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any method     | `ContractError` `invalid_input`                                                                  | the input fails the method's schema: an unknown key, a non-string value, more than 1000 `models` or a model name over 512 characters ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)) |
| any method     | `ContractError` `invalid_output`                                                                 | an answer fails the method's output schema, such as an icon name outside 1 to 64 characters ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts))                                          |
| `create`       | `Provider kind codex requires a token value.`                                                    | no `secret` and no non-blank literal `token` ([`src/host/provider.ts`](src/host/provider.ts))                                                                                                            |
| `create`       | `Provider value fedramp is not a flag: <value>`                                                  | `fedramp` other than `'true'` or `'false'` ([`src/host/kind.ts`](src/host/kind.ts))                                                                                                                      |
| `create`       | `Provider value <key> is a literal, not a source.`                                               | a callback given for `endpoint`, `chatGptAccountId` or `fedramp` ([`src/host/provider.ts`](src/host/provider.ts))                                                                                        |
| `icons`        | the thrown error                                                                                 | the kind's icon choice throws ([`src/host/provider.ts`](src/host/provider.ts))                                                                                                                           |
| built provider | provider error `missing_stream_finish`                                                           | the stream ends before a final response ([`codex.ts`](../../../packages/llms/src/lib/providers/codex.ts))                                                                                                |
| built provider | provider error `unsupported_embeddings` / `unsupported_reranking`                                | `embedding` or `rerank` is called ([`codex.ts`](../../../packages/llms/src/lib/providers/codex.ts))                                                                                                      |
| built provider | provider error `auth_missing`                                                                    | the account id reads blank at request time ([`codex.ts`](../../../packages/llms/src/lib/providers/codex.ts))                                                                                             |
| built provider | provider error `provider_error`, `missing_model`, `auth_failed`, `http_error` or `network_error` | as in [The built provider](#the-built-provider)                                                                                                                                                          |

`catalog` never fails: it answers `absent`.

## Development

| Target                              | What it does                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run bundle-codex:typecheck` | `tsc --build` of [`tsconfig.json`](tsconfig.json), declarations only                                                                                     |
| `npx nx run bundle-codex:test`      | compiles `src/` and `tests/` with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/` and runs `dist-tests/tests/*.test.js` with `node --test` |
| `npx nx run bundle-codex:build`     | `tsc --build` into `dist/`, then the bundle build of `packages/bundle` (`node packages/bundle/dist/build/cli.js build bundles/providers/codex`)          |

Every target first builds its dependencies (`^build`), among them `llms` and
`bundle` ([`project.json`](project.json)).

The tests run the host part through `createTestServices` of `bundle/testing`
beside a recording `log/v1` ([`tests/support/world.ts`](tests/support/world.ts)):

- [`tests/provider.test.ts`](tests/provider.test.ts): the record's descriptor
  equals the fixture and `providerKind('codex')` of `llms` and has no `site`;
  `advertised` and `catalogCapacity` are `false`; `catalog` is `absent` without
  a request; `create` refuses a missing or blank token and a `fedramp` that is
  not a flag; a built provider answers `kind` and `configuration`; `icons`
  chooses `openai` for the provider and every model.
- [`tests/manifest.test.ts`](tests/manifest.test.ts): the manifest's
  `version`, `provides` and `engines.doric`.

The Doric host stages this bundle with every other bundle of its composition:

```console
npx nx run doric-host:build-bundles
```
