# Claude provider bundle

`claude` registers the `claude` provider kind: Anthropic's Messages API
reached through a Claude Code subscription login. It is a host-only bundle that
provides one `models.provider/v1` record, which the core's `models/v1` lists,
reads catalogs from and builds providers with
([core README](../../foundation/core/README.md#modelsv1)). The requests
themselves are made by the `llms` package's Claude provider
([llms README](../../../packages/llms/README.md#claude)). See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles are
built and loaded. The feature doc
[Models and providers](../../../docs/features/models-and-providers.md)
describes how provider kinds, configured providers and model catalogs work
across bundles, and [Provider sign-in](../../../docs/features/provider-sign-in.md)
how a Claude provider is signed in.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `manifestVersion` | `1`                                                              |
| `id`              | `claude` (equal to the `name` of [`package.json`](package.json)) |
| `version`         | `1.2.0`                                                          |
| `engines`         | `{ "doric": "^1.0.0" }`                                          |
| `description`     | `Claude provider kind (Claude Code subscription login).`         |
| `provides`        | `models.provider/v1@1.3.0`                                       |
| `requires`        | `log/v1@^1.0.0`                                                  |
| `optional`        | none                                                             |
| `desktopScope`    | none                                                             |

The bundle declares no slot and fills none.

The bundle has one part, the host part, exported as `claude/host` from
[`src/host/index.ts`](src/host/index.ts). It has no desktop part, no client
part and no contracts module: it declares no contract of its own, since
`models.provider/v1` and `log/v1` are declared in `bundle/contracts`
([`models.ts`](../../../packages/bundle/src/contracts/basic/models.ts),
[`log.ts`](../../../packages/bundle/src/contracts/basic/log.ts)). Its package
exports `./package.json` and `./host`; `./host` resolves to
`./src/host/index.ts` under the `@org/source` condition and to
`./dist/host/index.js` (types `./dist/host/index.d.ts`) otherwise. It depends
on `bundle`, `llms`, `pino`, `runtime` and `tslib`.

The host process entry [`src/host/main.ts`](src/host/main.ts) (built to
`dist/host/main.mjs`) serves `doric.models.provider.v1.ProviderService` through
`runBundle` with `serveProviderKind` of `llms/rpc`, from the kind source that
`kindSource()` of [`src/host/provider.ts`](src/host/provider.ts) returns; it
reads images through `runtime.attachments/v1`, so the package depends on
`runtime`. The kernel entry stays `src/host/index.ts` until the host switch
(phase 3, slice S43 of
[`grpc-processes.md`](../../../docs/designs/grpc-processes.md)).

## Provided contract: `models.provider/v1` (1.3.0)

`activate` provides one record of `models.provider/v1` with cardinality
`many`, so it sits beside the records of the other provider bundles
([`src/host/index.ts`](src/host/index.ts),
[`src/host/provider.ts`](src/host/provider.ts)). The record is built from
the kind definition in [`src/host/kind.ts`](src/host/kind.ts). All methods
run in the host. The full shape of the contract is in the
[`packages/bundle` README](../../../packages/bundle/README.md#the-modelsproviderv1-contract).
This bundle implements all six methods and emits no events.

| Method              | `claude` answer                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `kind()`            | the descriptor of [Kind descriptor](#kind-descriptor)                                                                       |
| `advertised()`      | `true`: `models/v1.kinds()`, and so `GET /providers/kinds`, lists the kind                                                  |
| `catalog(input)`    | `read`, `absent` or `failed`, as in [`catalog`](#catalog)                                                                   |
| `create(input)`     | the built `llms` Claude provider, as in [`create`](#create) and [The built provider](#the-built-provider)                   |
| `catalogCapacity()` | `true`: the built provider's `models()` reports a model's context window and input modalities when the listing carries them |
| `icons(input)`      | `{ provider: 'claude', models }`, with `'claude'` for each requested model, in the input's order                            |

### Kind descriptor

`kind()` answers this object
([`src/host/kind.ts`](src/host/kind.ts),
[`tests/fixtures/provider-kind.json`](tests/fixtures/provider-kind.json)):

- `id`: `claude`; `label`: `Claude`; `description`: `Anthropic Messages
through a Claude Code subscription login, authenticated with a Claude
authorization value.`
- `fields`, in this order:
  - `endpoint`: `kind: 'url'`, `required: false`, `advanced: true`, label
    `Endpoint`, description `Overrides the base URL requests are sent to.`,
    placeholder `https://api.anthropic.com` (the `llms` Claude default).
  - `token`: `kind: 'secret'`, `required: true`, label `Token`, description
    "Names the stored API_TOKEN credential that carries the Claude
    authorization value: a Claude sign-in, a `claude setup-token` value, or a
    Console API key." Its value is the id of a stored `API_TOKEN` credential,
    which the core resolves.
- `lists`: the `lists` of the `llms` `claude` kind (`providerKind('claude')`),
  which are `models` and `reasonings`, so a list the `llms` kind gains reaches
  the settings tables with no change here.
- No `site` key: no provider page links a site for this kind.
- `modelsFromCatalog`: `true` (taken from the `llms` `claude` kind). The
  configuration fill writes every model `catalog()` lists into the provider's
  models on each save, and the settings page shows that list read-only instead
  of a model editor ([settings feature](../../../docs/features/settings.md)).

The descriptor equals the one `llms` exports as `providerKind('claude')`; it
is a separate copy, and the tests assert the two are deeply equal
([`tests/provider.test.ts`](tests/provider.test.ts); the fixture freezes the
fields and text; its `lists` is not compared).

### `catalog`

[`readClaudeCatalog`](src/host/kind.ts) answers:

- `{ status: 'absent' }` when `secret` is missing or blank after trimming; it
  sends no request.
- Otherwise it builds an `llms` Claude provider with `secret` as its
  authorization and the base URL below, and calls its `models()`, which reads
  `GET <baseUrl>/v1/models?beta=true&limit=1000` page by page with the same
  headers a request carries: while a page has `has_more: true`, the next page
  passes `after_id`, the page's `last_id`, else the id of its last listed
  model; listed entries with an empty id are dropped. It answers
  `{ status: 'read', models }`, one entry per listed model through `llms`' `claudeCatalogModel`: `{ id, name?, reasonings,
parameters: [], defaultEffort?, mandatory: false }`, where `name` is the
  model's display name, `reasonings` are the effort levels (`low`, `medium`,
  `high`, `xhigh`, `max`, in that order) its `capabilities.effort` marks
  supported (or those its id implies when the listing carries no
  capabilities), and `defaultEffort` is `medium` for Opus and Haiku 5.5 and
  later, `high` otherwise, falling back to the strongest listed effort.
- `{ status: 'failed' }` when the read throws for any reason (a refused login,
  a network error, a malformed answer). The result names nothing of the
  endpoint, the credential or the response.

The `secret` the core passes is the credential the `token` field names, read
through `secrets/v1`
([core README](../../foundation/core/README.md#modelsv1)).

### `create`

[`createKindProvider`](src/host/provider.ts) and
[`buildConfigured`](src/host/provider.ts):

1. The values become the provider's sources; when `secret` is given, it
   replaces the `token` value (the kind's one `secret` field).
2. Every required field must have a value: a function, or a string that is not
   blank after trimming. A missing or blank `token` throws
   `Provider kind claude requires a token value.`
3. The `endpoint` value must be a string; a function there throws
   `Provider value endpoint is a literal, not a source.`
4. It builds the `llms` Claude provider (`createClaudeProvider`) with the
   transport, the logger, `token` as its authorization and the base URL below
   ([`src/host/kind.ts`](src/host/kind.ts)), adds
   `kind: 'claude'` and `configuration` (the kind's `fields`) to it, and
   returns it as a language model handle (`toLanguageModel`).

Base URL, for `catalog` and `create` alike (`baseUrl` in
[`src/host/provider.ts`](src/host/provider.ts)): when `values` (for `catalog`,
`configuration`) has an `endpoint` key, its value is the base URL as written, even when blank, with no
trimming and no trailing-slash handling; without the key the base URL is
`https://api.anthropic.com`.

Because `token` is the `secret` callback, the `llms` provider awaits it before
every request, so a rotated credential reaches the next request of a provider
built before the rotation.

### The built provider

The `llms` Claude provider
([`claude.ts`](../../../packages/llms/src/lib/providers/claude.ts)):

- uses the base URL above, and sends `POST <baseUrl>/v1/messages?beta=true`
  with `anthropic-version: 2023-06-01`, `anthropic-beta` holding `oauth-2025-04-20` and
  `claude-code-20250219` (plus any beta the request body needs), `x-app: cli`
  and the Claude Code CLI user agent;
- reads the authorization value (awaiting it when it is a callback) and trims
  it before each request; an empty value throws `auth_missing` with the
  message `Claude provider received an empty auth value.`; otherwise, checked
  in this order, a value starting with `bearer` and a whitespace (any case) is
  sent as `authorization` as it is, a value starting with `sk-ant-api` (a
  Console API key) as `x-api-key`, and any other value as
  `authorization: Bearer <value>`;
- reports each listed model's `max_input_tokens` as its context window and
  `capabilities.image_input` as its input modalities, which is why
  `catalogCapacity()` is `true`: `models/v1.contextWindow` and
  `models/v1.inputModalities` read them.

## Used contract: `log/v1`

The `llms` provider logs through a pino logger. By default the bundle creates
it on first use with `services.use(LogV1)` and keeps it for the life of the
activation ([`src/host/index.ts`](src/host/index.ts),
[`src/host/logger.ts`](src/host/logger.ts)):

- The pino logger is at level `debug`.
- Each record is parsed from its JSON line; `level` maps to the `log/v1`
  method (50 and above `error`, 40 `warn`, 30 `info`, below 30 `debug`, a
  missing level `info`), `msg` becomes the message (`''` when it is not a
  string), `time`, `pid` and `hostname` are dropped, and every other field,
  child bindings included, is passed as the fields.
- A record that cannot be parsed or written is dropped; logging never fails
  the caller.

## Activation options

[`src/host/index.ts`](src/host/index.ts) exports `activate`, and
`createActivate(options)` for tests, where `options` is
`ProviderBundleOptions`:

- `transport?: () => HttpTransport`: the transport of every request; by
  default a new `llms` fetch transport (`createFetchTransport`) for each
  `catalog` and `create` call.
- `logger?: Logger`: the `llms` logger; by default the `log/v1` logger above.

## Data, side effects and configuration

- The bundle stores nothing and reads no setting or environment variable.
  A provider's values (`endpoint`, the `token` credential id) are stored by
  the core's configuration, and the credential by `secrets/v1`
  ([credentials feature](../../../docs/features/credentials.md)).
- Network: `catalog` with a secret, and every call of a built provider, reach
  the endpoint (`https://api.anthropic.com` by default). `kind`, `advertised`,
  `catalogCapacity` and `icons` do no I/O.
- Logs: the `llms` provider's records reach `log/v1`.
- A login is obtained outside the bundle: the
  [`claude-login`](../../features/claude-login/README.md) bundle draws "Sign
  in with Claude" in place of the `token` field on the provider page and
  stores the result as an `API_TOKEN` credential, and
  `npm run claude:oauth` ([`scripts/claude-oauth.mjs`](../../../scripts/claude-oauth.mjs))
  runs a Claude Code OAuth flow in the browser and writes the authorization to
  the root `.env` under `CLAUDE_AUTHORIZATION`, whose value can be stored as
  that credential.

## Errors and failure behavior

- `create` rejects with `Provider kind claude requires a token value.` when
  `secret` is absent and `values.token` is missing or blank; through the core,
  that is a provider whose configuration names no `token`, since the core
  removes `secret` fields from `values` and passes the named credential as
  `secret`
  ([`providers.ts`](../../foundation/core/src/host/models/providers.ts)).
- `catalog` never rejects: it answers `absent` or `failed` as above.
- `icons` never reads the configuration and never fails.
- Errors of a built provider are `llms` provider errors
  ([llms README](../../../packages/llms/README.md#errors)): an empty
  authorization value is `auth_missing`; an HTTP 401 or 403 is `auth_failed`
  (the message of a 401 asks the user to sign in with Claude again); any other
  status of 400 or more is `http_error`, retryable for 429 and 5xx unless
  Anthropic names a spend limit. Each message is
  `claude request failed with HTTP <status>` followed by Anthropic's own
  message when the body carries one
  ([`parse.ts`](../../../packages/llms/src/lib/providers/claude/parse.ts)).
  A login expires: when requests fail with `auth_failed`, sign in again and
  update the credential's secret.

## Build and test

The Nx project is `bundle-claude` ([`project.json`](project.json)); each
target first builds the packages it depends on (`^build`).

- `npx nx run bundle-claude:typecheck` checks `src/` with
  [`tsconfig.json`](tsconfig.json).
- `npx nx run bundle-claude:build` compiles `src/` to `dist/` and runs the
  bundle build (`packages/bundle/dist/build/cli.js build`), which validates
  `manifest.json`, dry-activates the host part and fails when `activate` is
  missing or a provided contract is not in `provides`, then writes
  `contracts.json`, the method schemas and `package.json` into `dist/`
  ([`cli.ts`](../../../packages/bundle/src/build/cli.ts),
  [`record.ts`](../../../packages/bundle/src/build/record.ts)).
- `npx nx run bundle-claude:test` compiles `src/` and `tests/` with
  [`tsconfig.spec.json`](tsconfig.spec.json) to `dist-tests/` and runs
  `node --test` on `dist-tests/tests/*.test.js`:
  [`tests/manifest.test.ts`](tests/manifest.test.ts) checks the manifest's
  version, `provides` and engine range, and
  [`tests/provider.test.ts`](tests/provider.test.ts) activates the host part
  with `createTestServices` and a recording or failing transport
  ([`tests/support/world.ts`](tests/support/world.ts)) and checks each method
  of the record.

The host loads the bundle because `claude` is listed in `enabled` of
[`composition.json`](../../../app/backend/doric-host/composition.json).
`npx nx run doric-host:build-bundles` builds and stages every bundle of the
host's composition, this one included.
