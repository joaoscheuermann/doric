# OpenRouter provider bundle

`openrouter` registers the `openrouter` provider kind with Doric's model layer.
The kind sends a model's requests to OpenRouter's Chat Completions API,
authenticated with an OpenRouter API key. It reads OpenRouter's live model
catalog, so Doric knows each model's context window and what each model
accepts, and it repairs a rejected structured response with corrected attempts.
The kind is advertised: `models/v1.kinds()` lists it among the provider kinds
you choose from when you connect a model
([`bundles/foundation/core/src/host/models/service.ts`](../../foundation/core/src/host/models/service.ts)).

It is a provider bundle with one host part, which provides the kind as one
`models.provider/v1` record that the `models/v1` of the
[`core`](../../foundation/core/README.md) bundle registers, lists and builds.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.
The feature doc [Models and providers](../../../docs/features/models-and-providers.md)
describes how provider kinds, configured providers and model catalogs work
across bundles.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                        |
| `id`              | `openrouter`                                                               |
| `version`         | `1.2.0`                                                                    |
| `engines.doric`   | `^1.0.0`                                                                   |
| `description`     | `OpenRouter provider kind with live catalog and structured-output repair.` |
| `provides`        | `models.provider/v1@1.4.0`                                                 |
| `requires`        | `log/v1@^1.0.0`                                                            |

The manifest lists `runtime.attachments/v1` and `secrets/v1` under `optional`
and has no slots. The bundle has no
settings, routes, tools, client part or desktop part.

[`package.json`](package.json) names the package `openrouter` and exports one
entry, `./host` ([`src/host/index.ts`](src/host/index.ts), built to
`dist/host/index.js`). It depends on `bundle` (for `bundle/contracts`), `llms`
(the OpenRouter provider, the catalog parser and the model icons), `pino` (the
logger the `llms` providers take) and `tslib`.

## Host part

[`src/host/index.ts`](src/host/index.ts) exports `activate`, which provides
one `models.provider/v1` record built from the `openrouter` kind definition
([`src/host/kind.ts`](src/host/kind.ts)) by `createKindProvider`
([`src/host/provider.ts`](src/host/provider.ts)). `activate` does no I/O and
uses no contract.

It also exports `createActivate(options)`, the same host part with injected
dependencies, for tests:

| Option      | Type                  | Default                                                                                       |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `transport` | `() => HttpTransport` | `createFetchTransport()` of `llms`, called once per `catalog` call and once per `create` call |
| `logger`    | pino `Logger`         | a pino logger whose records go to `log/v1`, made on the first `create` and then reused        |

The default logger is made lazily: the host part calls `services.use(LogV1)`
only on the first `create`, and every later `create` of the same activation
reuses that logger ([`src/host/index.ts`](src/host/index.ts)).

The host process entry [`src/host/main.ts`](src/host/main.ts) (built to
`dist/host/main.mjs`) serves `doric.models.provider.v1.ProviderService` through
`runBundle` with `serveProviderKind` of `llms/rpc`, from the kind source that
`kindSource()` of [`src/host/provider.ts`](src/host/provider.ts) returns; it
reads images through `runtime.attachments/v1`, so the package depends on
`runtime`. The kernel entry stays `src/host/index.ts` until the host switch
(phase 3, slice S43 of
[`grpc-processes.md`](../../../docs/designs/grpc-processes.md)).

## Provided contract: `models.provider/v1@1.4.0`

The contract is declared in
[`packages/bundle/src/contracts/basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)
and imported from `bundle/contracts`. It runs in the `host` environment only,
has cardinality `many`
([`packages/bundle/src/contracts/basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)),
has no optional methods and defines no events. Its
full shape — the input and output of each method, `ModelKindDescriptor`,
`ModelField`, `CatalogResult`, `CatalogModel`, `ModelIconChoice`, the limits
of `icons` and how `create`'s `secret` callback and `LanguageModel` handle
work — is stated in the
[`packages/bundle` README](../../../packages/bundle/README.md#the-modelsproviderv1-contract).
This bundle registers exactly one record, with `{ cardinality: 'many' }`
([`src/host/provider.ts`](src/host/provider.ts)), and answers:

| Method              | `openrouter` answer                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `kind()`            | the descriptor of [The `openrouter` kind](#the-openrouter-kind)                                                    |
| `advertised()`      | `true`: `models/v1.kinds()`, and so `GET /providers/kinds`, lists the kind                                         |
| `catalog(input)`    | a live read of the model catalog, as in [Reading the catalog](#reading-the-catalog)                                |
| `create(input)`     | the built OpenRouter provider, as in [Building a provider](#building-a-provider)                                   |
| `catalogCapacity()` | `true`: the built provider's `models()` reports each model's context window, which `models/v1.contextWindow` reads |
| `icons(input)`      | `{ provider: 'openrouter', models }`, with each model's icon chosen from its id, as in [Icons](#icons)             |

How `models/v1` uses `advertised` and `catalogCapacity` is stated in the
[`core` README](../../foundation/core/README.md#modelsv1)
([`bundles/foundation/core/src/host/models/service.ts`](../../foundation/core/src/host/models/service.ts),
[`bundles/foundation/core/src/host/models/capacity.ts`](../../foundation/core/src/host/models/capacity.ts)).

## The `openrouter` kind

[`src/host/kind.ts`](src/host/kind.ts) defines the kind:

- `id` `openrouter`, `label` `OpenRouter`, and `description`
  `OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair.`
- `lists` is `['models', 'reasonings']`: a provider of the kind keeps a list of
  models and a list of reasoning efforts. There is no `modelsFromCatalog`.
- `site` is `{ url: 'https://openrouter.ai', label: 'Open OpenRouter' }`, the
  page a provider page links to.

Its fields, in order:

| `key`                        | `label`                     | `kind`   | Required | Other                                                                                                 |
| ---------------------------- | --------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `endpoint`                   | `Endpoint`                  | `url`    | no       | `advanced: true`; `placeholder` is the default base URL `https://openrouter.ai/api/v1`                |
| `token`                      | `Token`                     | `secret` | yes      | names the stored `API_TOKEN` credential that carries the OpenRouter API key                           |
| `maxStructuredOutputRepairs` | `Structured output repairs` | `number` | no       | `advanced: true`; `placeholder: '2'`; how many corrected attempts a rejected structured response gets |
| `modelsUrl`                  | `Models URL`                | `url`    | no       | `advanced: true`; `placeholder` is `https://openrouter.ai/api/v1/models`                              |

The `endpoint` and `token` fields come from the builders `endpointField` and
`tokenField` of [`src/host/provider.ts`](src/host/provider.ts); the default
base URL is `openRouterMetadata.baseUrl` and the default repair count is
`defaultStructuredOutputRepairs` of `llms`
([`packages/llms/src/lib/providers/openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts),
[`packages/llms/src/lib/providers/openrouter/core.ts`](../../../packages/llms/src/lib/providers/openrouter/core.ts)).
The descriptor equals the `openrouter` entry of the `llms` kind catalog
(`providerKind('openrouter')` in
[`packages/llms/src/lib/providers/kinds.ts`](../../../packages/llms/src/lib/providers/kinds.ts))
and the fixture
[`tests/fixtures/provider-kind.json`](tests/fixtures/provider-kind.json), which
the tests compare it with.

## Reading the catalog

`catalog({ configuration, secret })`
([`src/host/catalog.ts`](src/host/catalog.ts)) sends one request through the
transport and keeps no cache:

1. The URL is `configuration.modelsUrl` when set, else
   `<configuration.endpoint>/models` when `endpoint` is set, else
   `https://openrouter.ai/api/v1/models`.
2. It sends `GET` with the header `accept: application/json`, plus
   `authorization: Bearer <secret>` when `secret` is given and not empty.
   `models/v1` passes as `secret` the stored credential that the
   configuration's `token` names
   ([`bundles/foundation/core/src/host/models/service.ts`](../../foundation/core/src/host/models/service.ts)).
3. It parses the answer with `modelCatalog` of `llms`
   ([`packages/llms/src/lib/providers/models.ts`](../../../packages/llms/src/lib/providers/models.ts)):
   each object of the answer's `data` array becomes one `CatalogModel` with
   `id` (`''` when absent), `name` when it is a string, `reasonings` from
   `reasoning.supported_efforts` (only known efforts), `parameters` from
   `supported_parameters` (strings, in order), `defaultEffort` from
   `reasoning.default_effort` when it is one of the listed efforts, and
   `mandatory` true only when `reasoning.mandatory` is `true`. Two entries with
   the same `id` keep the last one.
4. It answers `{ status: 'read', models }`, the models in the answer's order.

Any failure — a network error, an HTTP status of 400 or above, a body that is
not JSON — answers `{ status: 'failed' }`. Nothing in this bundle logs it or
names the URL, the credential or the response; `models/v1` logs
`Model catalog could not be read` at `warn` with the kind only. `catalog`
never answers `absent`.

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
   `Provider kind openrouter requires a token value.`
3. Reads `maxStructuredOutputRepairs`, `modelsUrl` and `endpoint` as literals;
   a callback in their place rejects with
   `Provider value <key> is a literal, not a source.` (the contract's `values`
   are strings, so only a direct caller of the kind definition can pass one).
   `maxStructuredOutputRepairs` is read with `Number`: a value that is not a
   finite number rejects with
   `Provider value maxStructuredOutputRepairs is not a number: <value>`.
4. Calls `createOpenRouterProvider` of `llms` with the transport (one per
   `create`), the logger, `apiKey` set to the `token` source, `modelsUrl`, the
   repair count when given and `baseUrl` when `endpoint` is given. The repair
   count must be a non-negative safe integer, else building throws
   `OpenRouter provider maxStructuredOutputRepairs must be a non-negative safe integer.`
   ([`packages/llms/src/lib/providers/openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts)).
   `providerId` reaches the kind's `build` as `deps.identity`
   (`{ id: providerId, name: providerId }`); the `openrouter` `build` does not
   pass it on.
5. Answers the built provider with two more keys, `kind: 'openrouter'` and
   `configuration` (the kind's `fields`), made a `LanguageModel` handle with
   `toLanguageModel`.

The `token` callback is not called during `create`: the `llms` provider awaits
it before every request, so a rotated credential reaches the next request of a
provider built before the rotation.

### The built provider

The provider is the OpenRouter provider of `llms`
([`packages/llms/src/lib/providers/openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts),
[`packages/llms/src/lib/providers/openrouter/core.ts`](../../../packages/llms/src/lib/providers/openrouter/core.ts));
the [`llms` README](../../../packages/llms/README.md#openrouter) and
[`MODEL_COMPATIBILITY.md`](../../../packages/llms/MODEL_COMPATIBILITY.md)
describe its request rules per model family in full. What a Doric provider of
this kind does:

- **Requests.** Completions go to `POST <base URL>/chat/completions` (with
  `accept: text/event-stream` when streaming), embeddings to
  `POST <base URL>/embeddings`, reranking to `POST <base URL>/rerank`, and the
  model list to `GET <modelsUrl>`, else `GET <base URL>/models`. The base URL
  is `endpoint`, else `https://openrouter.ai/api/v1`. Each request carries
  `authorization: Bearer <key>`, the key read from the `token` source at that
  moment; a key that reads blank fails with `auth_missing`
  ([`openrouter/core.ts`](../../../packages/llms/src/lib/providers/openrouter/core.ts),
  [`openrouter/auth.ts`](../../../packages/llms/src/lib/providers/openrouter/auth.ts),
  [`openrouter/models.ts`](../../../packages/llms/src/lib/providers/openrouter/models.ts)).
- **Model list.** `models()` reads the model list with a 5-second timeout and
  keeps it for 15 minutes; after a failed read it answers the last list it
  kept, or the error when it kept none, and retries no sooner than 30 seconds
  later. Each model has `id`, `name`, `contextWindow` (from `context_length`,
  else `top_provider.context_length`, else `architecture.context_length`),
  `inputModalities` from `architecture.input_modalities`, and the raw entry.
  `validateModel` fails with `missing_model` for a model the list does not hold
  ([`openrouter/catalog.ts`](../../../packages/llms/src/lib/providers/openrouter/catalog.ts),
  [`openrouter/models.ts`](../../../packages/llms/src/lib/providers/openrouter/models.ts)).
- **Context window.** A streamed response without a schema adds the model's
  `contextWindow` to its `response.started` event when the model list knows
  it ([`openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts)).
  Separately, `models()` reports each model's `contextWindow`, which
  `models/v1.contextWindow` reads because the record answers
  `catalogCapacity: true`
  ([`bundles/foundation/core/src/host/models/capacity.ts`](../../foundation/core/src/host/models/capacity.ts)).
- **Request preparation.** A request with tools or a schema reads the model's
  `supported_parameters` from the model list. Tools and a schema together fail
  with `unsupported_structured_tools`; tools for a model that does not
  advertise them, or a forced tool choice it does not support, fail with
  `unsupported_model_feature`; a forced tool choice the model family cannot
  combine with the requested reasoning fails with
  `incompatible_model_request`. When the model list shows the model does not
  accept `tool_choice`, `toolChoice: 'auto'` is dropped and
  `toolChoice: 'none'` drops the tools as well. A `parallelToolCalls` the
  model does not accept is dropped. A request that sets
  `parallelToolCalls: false` and still has tools always gets a system
  instruction to call at most one tool per response, placed after its own
  system messages
  ([`openrouter/prepare.ts`](../../../packages/llms/src/lib/providers/openrouter/prepare.ts)).
  When the model list cannot be read, the model's curated profile decides
  instead, and a model whose id names no known lab then refuses tools
  ([`openrouter/catalog.ts`](../../../packages/llms/src/lib/providers/openrouter/catalog.ts),
  [`openrouter/profiles.ts`](../../../packages/llms/src/lib/providers/openrouter/profiles.ts)).
- **Structured output.** A schema is sent as `json_schema` when the model
  lists `structured_outputs`, as `json_object` when it lists only
  `response_format`, and in the prompt otherwise. The answer is validated
  locally. When it does not match (`invalid_structured_output`), the provider
  repeats the request with the rejected answer and a user message
  `# Structured output correction` asking for exactly one corrected JSON
  object, up to `maxStructuredOutputRepairs` times (2 by default), adding up
  the usage of every attempt; the last failure is raised. A streamed request
  with a schema completes first and then yields `response.started`, one
  `text.delta` when the answer has text, and `response.finished`
  ([`openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts)).
- **Cost.** Usage carries the cost OpenRouter reports, in the unit `credits`
  ([`openrouter/parse.ts`](../../../packages/llms/src/lib/providers/openrouter/parse.ts)).
- **Capabilities.** Streaming, embeddings, reranking, tools, reasoning, model
  listing and structured outputs are reported; OAuth and service tier are not
  (`openRouterCapabilities` in
  [`openrouter/core.ts`](../../../packages/llms/src/lib/providers/openrouter/core.ts)).
- **Logging.** The logger gets the child bindings `component: 'llms'` and
  `provider: 'openrouter'`; building the provider, and so each `create`, logs
  `llm provider initialized` at `debug`, and each operation is logged at
  `debug` as `llm <operation> <status>` with its fields
  ([`packages/llms/src/lib/providers/logging.ts`](../../../packages/llms/src/lib/providers/logging.ts)).
- **Stream errors.** A stream event that is not JSON ends the stream with
  `malformed_stream_event`, and an event that carries an error ends it with
  `provider_error` ([`openrouter/core.ts`](../../../packages/llms/src/lib/providers/openrouter/core.ts)).
- **HTTP failures.** `auth_failed` for HTTP 401 or 403 and `http_error` for any
  other status of 400 or above, retryable for 429 and 500 and above
  ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts)), and a
  retryable `network_error` when the connection cannot be made or drops
  ([`http.ts`](../../../packages/llms/src/lib/providers/http.ts)).
  `network_error` applies only to completions, streams, embeddings and
  reranking, whose transport `openrouter/core.ts` wraps with
  `withProviderErrors`; the `models()` loader uses the unwrapped transport,
  and there, as for any other failure such as an unresolvable host, the
  transport's error passes through unchanged.
- **Invalid JSON.** A non-streamed answer of a completion, an embedding, a
  rerank or `models()` that is not a JSON object fails with `invalid_json`
  (`parseJsonBody` in
  [`common.ts`](../../../packages/llms/src/lib/providers/common.ts)).

## Icons

`icons({ configuration, models })` ([`src/host/kind.ts`](src/host/kind.ts))
answers `provider: 'openrouter'` and, for each model id in order,
`openRouterModelIcon` of `llms`, chosen by the id's prefix: `anthropic/` →
`claude`, `google/gemma` → `gemma`, other `google/` → `gemini`, `openai/` →
`openai`, `deepseek/` → `deepseek`, `qwen/` → `qwen`, `meta-llama/` → `meta`;
any other id → `null`
([`packages/llms/src/lib/icons/index.ts`](../../../packages/llms/src/lib/icons/index.ts),
[`openrouter/profiles.ts`](../../../packages/llms/src/lib/providers/openrouter/profiles.ts)).
For example `anthropic/claude-sonnet-4` gets `claude` and `acme/coder-7b`
gets `null`. The choice ignores `configuration`, does no I/O and reads no
secret.

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
as the `secret` of `catalog` and the `secret` callback of `create`.

## Data, side effects and configuration

- **Persistence.** None: the bundle stores nothing and keeps no state beyond
  the lazily made logger of its activation
  ([`src/host/index.ts`](src/host/index.ts)). A built provider keeps its model
  list in memory, as above.
- **Network.** `catalog` sends one request per call; a built provider sends
  its requests through the transport (`fetch` by default) to the endpoint or
  the models URL. `kind`, `advertised`, `catalogCapacity` and `icons` send none
  ([`src/host/provider.ts`](src/host/provider.ts),
  [`src/host/catalog.ts`](src/host/catalog.ts)).
- **Logs.** Records go to `log/v1` as described above; each `create` writes
  at least the `llm provider initialized` record. `catalog` writes none
  ([`src/host/logger.ts`](src/host/logger.ts),
  [`src/host/catalog.ts`](src/host/catalog.ts)).
- **Configuration.** None of its own: no settings and no environment
  variables ([`src/host/index.ts`](src/host/index.ts),
  [`src/host/kind.ts`](src/host/kind.ts)). A provider's values come from the
  host's provider configuration through `models/v1`, and the credential from
  `secrets/v1`.

## Errors

| Where          | Error                                                                                                    | When                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| any method     | `ContractError` `invalid_input` / `invalid_output`                                                       | the input or the answer fails the method's schema ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts))         |
| `catalog`      | none: `{ status: 'failed' }`                                                                             | the read fails for any reason ([`src/host/catalog.ts`](src/host/catalog.ts))                                                  |
| `create`       | `Provider kind openrouter requires a token value.`                                                       | no `secret` and no non-blank literal `token` ([`src/host/provider.ts`](src/host/provider.ts))                                 |
| `create`       | `Provider value maxStructuredOutputRepairs is not a number: <value>`                                     | `Number(value)` is not finite ([`src/host/kind.ts`](src/host/kind.ts))                                                        |
| `create`       | `OpenRouter provider maxStructuredOutputRepairs must be a non-negative safe integer.`                    | the repair count is negative or not an integer ([`openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts))    |
| `create`       | `Provider value <key> is a literal, not a source.`                                                       | a callback given for `endpoint`, `modelsUrl` or `maxStructuredOutputRepairs` ([`src/host/provider.ts`](src/host/provider.ts)) |
| `icons`        | the thrown error                                                                                         | the kind's icon choice throws ([`src/host/provider.ts`](src/host/provider.ts))                                                |
| built provider | provider error `auth_missing`                                                                            | the API key reads blank at request time ([`openrouter/auth.ts`](../../../packages/llms/src/lib/providers/openrouter/auth.ts)) |
| built provider | provider error `missing_model`                                                                           | `validateModel` finds no such model ([`openrouter.ts`](../../../packages/llms/src/lib/providers/openrouter.ts))               |
| built provider | `unsupported_structured_tools`, `unsupported_model_feature`, `incompatible_model_request`                | as in [The built provider](#the-built-provider)                                                                               |
| built provider | `invalid_structured_output`                                                                              | the answer still fails the schema after the last repair                                                                       |
| built provider | `malformed_stream_event`, `provider_error`, `auth_failed`, `http_error`, `network_error`, `invalid_json` | as in [The built provider](#the-built-provider)                                                                               |

## Development

| Target                                   | What it does                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run bundle-openrouter:typecheck` | `tsc --build` of [`tsconfig.json`](tsconfig.json), declarations only                                                                                     |
| `npx nx run bundle-openrouter:test`      | compiles `src/` and `tests/` with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/` and runs `dist-tests/tests/*.test.js` with `node --test` |
| `npx nx run bundle-openrouter:build`     | `tsc --build` into `dist/`, then the bundle build of `packages/bundle` (`node packages/bundle/dist/build/cli.js build bundles/providers/openrouter`)     |

Every target first builds its dependencies (`^build`), among them `llms` and
`bundle` ([`project.json`](project.json)).

The tests run the host part through `createTestServices` of `bundle/testing`
beside a recording `log/v1`, with a transport that records requests or one
that always fails ([`tests/support/world.ts`](tests/support/world.ts)):

- [`tests/provider.test.ts`](tests/provider.test.ts): the record's descriptor
  equals the fixture and `providerKind('openrouter')` of `llms`; `advertised`
  and `catalogCapacity` are `true`; `create` refuses a missing token and a
  repair count that is not a number; a built provider answers `kind` and
  `configuration`; `icons` chooses `openrouter` for the provider and each
  model's lab.
- [`tests/catalog.test.ts`](tests/catalog.test.ts): `catalog` reads the
  default URL with the bearer token, sends no `authorization` for an empty or
  missing secret, prefers `modelsUrl` over `<endpoint>/models`, and answers
  `failed` without logging the URL or the secret.
- [`tests/manifest.test.ts`](tests/manifest.test.ts): the manifest's
  `version`, `provides` and `engines.doric`.

The Doric host stages this bundle with every other bundle of its composition
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json),
[`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json)):

```console
npx nx run doric-host:build-bundles
```
