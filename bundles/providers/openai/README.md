# OpenAI provider bundle

`openai` lets Doric run its agents on any endpoint that answers the OpenAI
Responses API: OpenAI itself or a compatible server you point it at. You
choose the endpoint, the stored API token and the model when you connect a
model provider in the desktop app.

It is a provider bundle with one host part, which provides the `openai` kind
as one `models.provider/v1` record that the `models/v1` of the
[`core`](../../foundation/core/README.md) bundle registers, lists and builds.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.
The feature doc [Models and providers](../../../docs/features/models-and-providers.md)
describes how provider kinds, configured providers and model catalogs work
across bundles.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                             |
| ----------------- | --------------------------------- |
| `manifestVersion` | `1`                               |
| `id`              | `openai`                          |
| `version`         | `1.2.0`                           |
| `engines.doric`   | `^1.0.0`                          |
| `description`     | `OpenAI Responses provider kind.` |
| `provides`        | `models.provider/v1@1.4.0`        |
| `requires`        | `log/v1@^1.0.0`                   |

The manifest lists `runtime.attachments/v1` and `secrets/v1` under `optional`
and has no slots. The bundle has no
settings, routes, tools, client part or desktop part.

[`package.json`](package.json) names the package `openai` and exports
`./host`, whose kernel entry `src/host/index.ts` was deleted in slice S68a
(the export is removed in S70), and `./package.json`. It depends on `bundle` (for
`bundle/contracts`), `llms` (the OpenAI Responses provider and the model
icons), `pino` (the logger the `llms` providers take) and `tslib`.

## Host part

The host process entry [`src/host/main.ts`](src/host/main.ts) (built to
`dist/host/main.mjs`) serves `doric.models.provider.v1.ProviderService` through
`runBundle` with `serveProviderKind` of `llms/rpc`, from the kind source that
`kindSource()` of [`src/host/provider.ts`](src/host/provider.ts) returns; it
reads images through `runtime.attachments/v1`, so the package depends on
`runtime`. `kindSource` takes the kind definition
([`src/host/kind.ts`](src/host/kind.ts)) and `KindProviderOptions`: `transport`
(default `createFetchTransport()` of `llms`, called once per `create` call) and
`logger`, which `main.ts` makes on first use over the instance's `context.log`,
whose records go to `log/v1` (phase 3, slices S43 and S68a of
[`grpc-processes.md`](../../../docs/designs/grpc-processes.md)).

## Provided contract: `models.provider/v1@1.4.0`

The contract is declared in
[`packages/bundle/src/contracts/basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)
and imported from `bundle/contracts`. It runs in the `host` environment and
has cardinality `many`; this bundle registers exactly one record, with
`{ cardinality: 'many' }` ([`src/host/provider.ts`](src/host/provider.ts)).
The full shape of the contract — the inputs and outputs of its six methods,
`ModelKindDescriptor`, `ModelField`, `CatalogResult`, `ModelIconChoice`, the
`icons` limits and the `LanguageModel` handle that `create` answers — is in
the [`packages/bundle` README](../../../packages/bundle/README.md#the-modelsproviderv1-contract).
This bundle implements all six methods and emits no events.

| Method              | `openai` answer                                                                        |
| ------------------- | -------------------------------------------------------------------------------------- |
| `kind()`            | the descriptor of [The `openai` kind](#the-openai-kind)                                |
| `advertised()`      | `true`: `models/v1.kinds()`, and so `GET /providers/kinds`, lists the kind             |
| `catalog(input)`    | always `{ status: 'absent' }`, with no request: the kind has no models URL field       |
| `create(input)`     | the built OpenAI Responses provider, as in [Building a provider](#building-a-provider) |
| `catalogCapacity()` | `false`: the built provider's `models()` reports no context capacity                   |
| `icons(input)`      | as in [Icons](#icons)                                                                  |

Each answer is defined in [`src/host/kind.ts`](src/host/kind.ts) and turned
into a method by [`src/host/provider.ts`](src/host/provider.ts).
`models/v1.kind('openai')` resolves the kind whether or not it is advertised
([`bundles/foundation/core/src/host/models/service.ts`](../../foundation/core/src/host/models/service.ts)),
and `models/v1.contextWindow` reads context capacity only from a kind whose
`catalogCapacity()` is `true`
([`bundles/foundation/core/src/host/models/capacity.ts`](../../foundation/core/src/host/models/capacity.ts)).

## The `openai` kind

[`src/host/kind.ts`](src/host/kind.ts) defines the kind:

| Key           | Value                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `id`          | `openai`                                                                        |
| `label`       | `OpenAI`                                                                        |
| `description` | `Any endpoint that answers the OpenAI Responses API, under its own identity.`   |
| `lists`       | `['models', 'reasonings']`: a provider keeps a model list and reasoning efforts |

It has no `site` and no `modelsFromCatalog`. Its fields, in order:

| `key`      | `label`    | `kind`   | Required | Other                                                                                                                                                |
| ---------- | ---------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint` | `Endpoint` | `url`    | no       | `advanced: true`; description `Overrides the base URL requests are sent to.`; `placeholder` is the default base URL `https://api.openai.com/v1`      |
| `token`    | `Token`    | `secret` | no       | description `Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a compatible endpoint may accept.` |

The two fields come from the builders `endpointField` and `tokenField` of
[`src/host/provider.ts`](src/host/provider.ts); the default base URL is
`openAiMetadata.baseUrl` of
[`packages/llms/src/lib/providers/openai.ts`](../../../packages/llms/src/lib/providers/openai.ts).
A `token` value is the id of a stored `API_TOKEN` credential, which the host
resolves; it never holds the secret itself. The descriptor equals the `openai`
entry of the `llms` kind catalog (`providerKind('openai')` in
[`packages/llms/src/lib/providers/kinds.ts`](../../../packages/llms/src/lib/providers/kinds.ts))
and the fixture
[`tests/fixtures/provider-kind.json`](tests/fixtures/provider-kind.json),
which the tests compare it with.

## Building a provider

`create({ providerId, values, secret })`
([`src/host/provider.ts`](src/host/provider.ts),
[`src/host/kind.ts`](src/host/kind.ts)):

1. Copies `values` into the provider's sources. When `secret` is given, it
   becomes the source of `token`, the kind's `secret` field, and replaces any
   literal `token` value. `models/v1` passes the provider's values without the
   credential id, and passes `secret` only when the provider names a
   credential, as a callback that reads it through `secrets/v1` each time it
   is called
   ([`bundles/foundation/core/src/host/models/providers.ts`](../../foundation/core/src/host/models/providers.ts)).
2. Checks every required field; the `openai` kind has none, so this check
   never refuses.
3. Reads `endpoint` as a literal: a callback in its place rejects with
   `Provider value endpoint is a literal, not a source.` (the contract's
   `values` are strings, so only a direct caller of the kind definition can
   pass one). An absent `endpoint` keeps the default base URL
   `https://api.openai.com/v1`; a present one, blank included, replaces it.
4. Calls `createOpenAiProvider` of `llms` with the transport (one per
   `create`), the logger, `apiKey` set to the `token` source (`''` when there
   is none), the base URL when `endpoint` is present, and `identity`
   `{ id: providerId, name: providerId }`, so the provider reports the
   configured provider's id, not `openai`, as its id and name in its metadata,
   events, errors and logs. Without `secret`, a literal `token` value is sent
   verbatim as the bearer key; `models/v1` never passes one, since it strips
   every `secret` field from `values`.
5. Answers the built provider with two more keys, `kind: 'openai'` and
   `configuration` (the kind's `fields`), made a `LanguageModel` handle with
   `toLanguageModel`.

The `token` callback is not called during `create`: the `llms` provider awaits
it before every request, so a rotated credential reaches the next request of a
provider built before the rotation.

### The built provider

The provider is the OpenAI Responses provider of `llms`
([`packages/llms/src/lib/providers/openai.ts`](../../../packages/llms/src/lib/providers/openai.ts));
its request body, streaming and structured-output rules are described in the
[`llms` README](../../../packages/llms/README.md#openai-responses-compatible-endpoints).
What a provider of this kind sends:

- **Requests.** Responses go to `POST <base URL>/responses` (with
  `accept: text/event-stream` when streaming), embeddings to
  `POST <base URL>/embeddings`, reranking to `POST <base URL>/rerank`, and the
  model list to `GET <base URL>/models`, whose `data[].id` entries become the
  models.
- **Authorization.** Each request reads the `token` source and sends
  `authorization: Bearer <value>`; a missing or blank value sends no
  authorization header
  ([`packages/llms/src/lib/providers/auth.ts`](../../../packages/llms/src/lib/providers/auth.ts)).
- **Capabilities.** Streaming, embeddings, reranking, tools, reasoning, model
  listing, service tier and structured outputs are reported; OAuth is not.
- **Logging.** The logger gets the child bindings `component: 'llms'` and
  `provider: <providerId>`; building the provider, and so each `create`, logs
  `llm provider initialized` at `debug`, and each operation is logged at
  `debug` as `llm <operation> <status>` with its fields
  ([`packages/llms/src/lib/providers/logging.ts`](../../../packages/llms/src/lib/providers/logging.ts)).
- **Limits.** The base URL is joined verbatim (a trailing `/` yields
  `//responses`); the provider sets no timeout and retries nothing: a request
  ends with the transport or the caller's `signal`, and `retryable` only marks
  the error for the caller
  ([`packages/llms/src/lib/providers/openai.ts`](../../../packages/llms/src/lib/providers/openai.ts)).

## Icons

`icons({ configuration, models })` ([`src/host/kind.ts`](src/host/kind.ts))
first decides whether `configuration.endpoint` is OpenAI's own endpoint: it is
when the value is absent or blank, or when it parses as a URL whose origin
equals the origin of `https://api.openai.com/v1` (so
`https://api.openai.com:443/v1` counts and `https://api.openai.com.example.test`
does not). A value that is not a URL is a compatible endpoint.

- On OpenAI's own endpoint it answers `{ provider: 'openai', models }` with
  `'openai'` for every model.
- On a compatible endpoint it answers no `provider` icon, and for each model
  the icon of the first family whose word the lowercased model name contains,
  else `null` (`modelNameIcon` of
  [`packages/llms/src/lib/icons/index.ts`](../../../packages/llms/src/lib/icons/index.ts)).
  The families, in matching order: `claude` → `claude`, `gemini` → `gemini`,
  `gemma` → `gemma`, `gpt` → `openai`, `deepseek` → `deepseek`, `qwen` →
  `qwen`, `llama` → `meta`.

The choice is pure: it does no I/O and reads no secret.

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
as the `secret` callback of `create`.

## Data and side effects

The bundle stores nothing and reads no file or environment variable. Its only
side effects are the HTTP requests of a built provider, to the configured
endpoint, and its `log/v1` records. The provider's endpoint and credential id
are stored in the host configuration by the
[`host-config`](../../foundation/host-config/README.md) bundle, which refuses
an empty `endpoint` or one that does not start with `http://` or `https://`
([`schema.ts`](../../foundation/host-config/src/host/config/schema.ts)) and
builds providers through `models/v1`
([`service.ts`](../../foundation/host-config/src/host/config/service.ts)); the
secret is stored by the bundle that provides `secrets/v1`. This bundle
validates no value: a direct caller that passes a blank `endpoint` gets
requests to the relative URL `/responses`, which the fetch transport rejects.

## Errors

| Where                                                    | Error                                                 | When                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| any method                                               | `ContractError` `invalid_input`                       | the input fails the method's schema: an unknown key, a non-string value, more than 1000 `models` or a model name over 512 characters ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts))                                                                                                                       |
| any method                                               | `ContractError` `invalid_output`                      | an answer fails the method's output schema ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts))                                                                                                                                                                                                                 |
| `openAiKind.build` or `buildConfigured`, called directly | `Provider value endpoint is a literal, not a source.` | a callback given for `endpoint`; through `create` the strict `values` schema refuses it first with `invalid_input` ([`src/host/provider.ts`](src/host/provider.ts))                                                                                                                                                            |
| built provider                                           | the `secrets/v1` error, unchanged                     | the `token` callback rejects: every request fails before it is sent ([`auth.ts`](../../../packages/llms/src/lib/providers/auth.ts))                                                                                                                                                                                            |
| built provider                                           | provider error `missing_model`                        | a request whose `model` is blank, before any request is sent ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts)), or `validateModel` finds no such model in `models()` ([`openai.ts`](../../../packages/llms/src/lib/providers/openai.ts))                                                                     |
| built provider                                           | provider error `missing_input`                        | a completion or stream without messages, an embedding with blank input, or a rerank without a query or documents ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                           |
| built provider                                           | provider error `invalid_dimensions` / `invalid_top_n` | an embedding `dimensions` or a rerank `topN` that is not a positive integer ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                                                                |
| built provider                                           | provider error `invalid_json`                         | a response body that is not JSON or not a JSON object ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                                                                                      |
| built provider                                           | provider error `invalid_embedding` / `invalid_rerank` | an embedding or rerank response of the wrong shape ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                                                                                         |
| built provider                                           | provider error `auth_failed`                          | HTTP 401 or 403 ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                                                                                                                            |
| built provider                                           | provider error `http_error`                           | any other status of 400 or above, retryable for 429 and 500 and above ([`common.ts`](../../../packages/llms/src/lib/providers/common.ts))                                                                                                                                                                                      |
| built provider                                           | provider error `network_error` (retryable)            | the transport failure, or a cause up to eight levels deep, carries `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET` or `EAI_AGAIN`; an unresolvable host (`ENOTFOUND`), an abort and any other transport error pass through unchanged ([`http.ts`](../../../packages/llms/src/lib/providers/http.ts)) |
| built provider, `stream`                                 | `error` event `provider_error`                        | the stream reports `response.failed`; yielded as an `error` event that ends the stream, not thrown ([`openai.ts`](../../../packages/llms/src/lib/providers/openai.ts))                                                                                                                                                         |
| built provider, `stream`                                 | `error` event `malformed_stream_event`                | a stream event whose data is not a JSON object; yielded as an `error` event that ends the stream, not thrown ([`openai.ts`](../../../packages/llms/src/lib/providers/openai.ts))                                                                                                                                               |

`catalog` never fails: it answers `absent`. `create` never refuses a missing
token: a provider without one sends requests with no authorization header.

## Development

| Target                               | What it does                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run bundle-openai:typecheck` | `tsc --build` of [`tsconfig.json`](tsconfig.json), declarations only                                                                                     |
| `npx nx run bundle-openai:test`      | compiles `src/` and `tests/` with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/` and runs `dist-tests/tests/*.test.js` with `node --test` |
| `npx nx run bundle-openai:build`     | `tsc --build` into `dist/`, then the bundle build of `packages/bundle` (`node packages/bundle/dist/build/cli.js build bundles/providers/openai`)         |

Every target first builds its dependencies (`^build`), among them `llms` and
`bundle` ([`project.json`](project.json)).

The tests serve `kindSource` through `serveProviderKind` on a test router,
with a transport that records requests or one that fails, and never the
network ([`tests/support/world.ts`](tests/support/world.ts) holds the frozen
kind):

- [`tests/router.test.ts`](tests/router.test.ts): the record's descriptor
  equals the fixture and `providerKind('openai')` of `llms` and has no `site`;
  `advertised` is `true` and `catalogCapacity` is `false`; `catalog` is
  `absent` without a request; `create` uses the provider id as identity, logs
  through `log/v1`, sends no authorization header without a secret and uses
  the default base URL without an endpoint; the secret source is read before
  every request, so a rotation reaches the next one; `icons` chooses `openai`
  on OpenAI's own endpoint and each model's family on a compatible one,
  including a look-alike host and a value that is not a URL.
- [`tests/manifest.test.ts`](tests/manifest.test.ts): the manifest's
  `version`, `provides` and `engines.doric`.
- [`tests/host-build.test.ts`](tests/host-build.test.ts): the host part builds
  to `dist/host/main.mjs`, and no `dist/host/index.js` exists.

The Doric host stages this bundle with every other bundle of its composition:

```console
npx nx run doric-host:build-bundles
```
