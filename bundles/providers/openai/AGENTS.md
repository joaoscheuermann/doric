# openai

Apply these rules to `bundles/providers/openai/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing the `openai` provider kind, for any endpoint
that answers the OpenAI Responses API, as one `models.provider/v1` record
built on the OpenAI Responses provider of `llms`, and add to it no second
kind, UI, setting, route, tool or contract of its own: listing, resolving and
caching configured providers belongs to the bundle that provides `models/v1`,
drawing a provider's form belongs to the bundle that draws the provider
settings, and storing a credential belongs to the bundle that provides
`secrets/v1`.

## Rules

- Read [`README.md`](README.md) for what the record answers, how `create`
  builds a provider, how `icons` chooses and what each error means before
  changing the bundle.
- Keep `advertised` `true` in `src/host/kind.ts`: the kind must stay in the
  list of kinds a user can choose when connecting a model.
- Keep `catalogCapacity` `false` in `src/host/kind.ts` while the built
  provider's `models()` reports no context capacity.
- Keep the `token` field optional: a provider without a credential must still
  build and must send no authorization header, since a compatible endpoint
  may accept that.
- In `build`, pass `deps.identity` to `createOpenAiProvider` as `identity`,
  never `openAiMetadata`; `create` in `src/host/provider.ts` sets it to
  `{ id: providerId, name: providerId }`, so that each configured provider
  reports its own id in events, errors and logs.
- Keep the descriptor of `openAiKind` in `src/host/kind.ts` equal to
  `providerKind('openai')` of `packages/llms/src/lib/providers/kinds.ts` and
  to `tests/fixtures/provider-kind.json`, and change all three in one change:
  `tests/provider.test.ts` asserts that they match.
- Change the shape of `models.provider/v1` only in
  `packages/bundle/src/contracts/basic/models.ts`, never in this bundle.
- Put what is specific to the `openai` kind (its fields, its `build`, its
  `icons`) in `src/host/kind.ts`, and put what turns any kind definition into
  the record (`createKindProvider`, `buildConfigured`) and the field and value
  helpers (`endpointField`, `tokenField`, `literalValue`, `baseUrl`) in
  `src/host/provider.ts`.
- When `models.provider/v1` gains a method or an output field in
  `packages/bundle/src/contracts/basic/models.ts`, add its member to
  `KindDefinition` and its method to `createKindProvider` in
  `src/host/provider.ts`, give it the `openai` answer in `src/host/kind.ts`,
  and add the answer's test to `tests/provider.test.ts`.
- When you change the manifest's `version` or a `provides` entry, change the
  expected values in `tests/manifest.test.ts` in the same change.
- Read every value of a field that is not of kind `secret` through
  `literalValue` in `build`, and refuse a malformed value there with an
  `Error` whose message names the field.
- Pass the `token` source to `createOpenAiProvider` unresolved: never call the
  `secret` callback of `create` and never use `secrets/v1` in this bundle, so
  that `llms` reads the credential before each request and a rotated
  credential reaches the next request.
- Add a request header, a body rule or a capability of the built provider in
  `packages/llms/src/lib/providers/openai.ts`, and add here only the field
  that carries its value and the line of `build` that passes it.
- Keep `icons` pure: never do I/O or read a secret in it. Decide OpenAI's own
  endpoint only by comparing the endpoint's URL origin with the origin of
  `openAiMetadata.baseUrl`, never by a substring of the host, and choose a
  model's icon on a compatible endpoint only through `modelNameIcon` of
  `llms`; add a model family in `packages/llms/src/lib/icons/index.ts`, not
  here.
- Give `openAiKind` a `catalog` only together with a models URL field, since
  `catalog` must answer `{ status: 'absent' }` without a request while the
  kind has none.
- Make the default logger only inside the `logger` callback of
  `createActivate` in `src/host/index.ts`, so that `log/v1` is used on the
  first `create` and never during `activate`, and keep one logger per
  activation.
- Never let the `log/v1` sink of `src/host/logger.ts` throw: a log record must
  never fail the caller.
- Test a behavior of the record in `tests/provider.test.ts`, activating the
  host part with `providerWorld` of `tests/support/world.ts` and injecting a
  transport with `recordingTransport`, or `failingTransport` for a transport
  failure; never let a test reach the network.
- Assert a request the built provider sends through a method that uses
  `request` (`models()`, `complete()`, `embedding()`, `rerank()`), giving
  `recordingTransport` a body that method parses; never through `stream()`,
  which both test transports refuse.
- Test a header, body or stream rule of
  `packages/llms/src/lib/providers/openai.ts` in the
  `packages/llms/tests/openai*.test.ts` file that covers it, and a model
  family in `packages/llms/tests/icons.test.ts`, and run
  `npx nx run llms:test` after it.
- Declare every contract the bundle provides or uses in
  [`manifest.json`](manifest.json), and open it before adding a use of a
  contract.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "openai"`.
- Update [`README.md`](README.md) in the same change as any change to the
  kind's fields, the record's answers, `create`, `icons`, the logger or the
  errors. In the same change, update the feature doc
  [credentials](../../../docs/features/credentials.md) when the change alters
  how an `openai` provider names or reads its credential,
  [settings](../../../docs/features/settings.md) when it alters the provider
  form or the icons a provider page shows, and
  [usage](../../../docs/features/usage.md) when it alters `catalogCapacity`.

## Verify

- `npx nx run bundle-openai:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-openai:test`: run it after any change under `src/` or
  `tests/`, to `manifest.json`, or to
  `packages/llms/src/lib/providers/openai.ts`,
  `packages/llms/src/lib/providers/kinds.ts` or
  `packages/llms/src/lib/icons/index.ts`; run the tests only through this
  target, which builds `llms` and `bundle` first.
- `npx nx run bundle-openai:build`: run it after a change to `manifest.json`,
  `package.json` or a `tsconfig*.json` file.

## Generated files

None.
