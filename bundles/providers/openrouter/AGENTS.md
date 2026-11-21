# openrouter

Apply these rules to `bundles/providers/openrouter/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing the `openrouter` provider kind as one
`models.provider/v1` record built on the OpenRouter provider of `llms`, and add
to it no second kind, UI, setting, route, tool or contract of its own: listing,
resolving and caching configured providers belongs to the bundle that provides
`models/v1`, drawing a provider's form belongs to the bundle that draws the
provider settings, and storing a credential belongs to the bundle that
provides `secrets/v1`.

## Rules

- Read [`README.md`](README.md) for what the record answers, how `catalog`
  reads the model catalog, how `create` builds a provider and what each error
  means before changing the bundle.
- Keep `advertised` and `catalogCapacity` `true` in `src/host/kind.ts`: the
  kind must stay in the list of kinds a user can choose, and the built
  provider's `models()` must keep reporting each model's context window.
- Keep the descriptor of `openRouterKind` in `src/host/kind.ts` equal to
  `providerKind('openrouter')` of `packages/llms/src/lib/providers/kinds.ts`
  and to `tests/fixtures/provider-kind.json`, and change all three in one
  change: `tests/provider.test.ts` asserts that they match.
- Change the shape of `models.provider/v1` only in
  `packages/bundle/src/contracts/basic/models.ts`, never in this bundle.
- Put what is specific to the `openrouter` kind (its fields, its `build`, its
  `catalog` and its `icons`) in `src/host/kind.ts`, the catalog read in
  `src/host/catalog.ts`, and what turns any kind definition into the record
  (`createKindProvider`, `buildConfigured`) and the field and value helpers
  (`endpointField`, `tokenField`, `literalValue`, `baseUrl`) in
  `src/host/provider.ts`.
- When `models.provider/v1` gains a method or an output field in
  `packages/bundle/src/contracts/basic/models.ts`, add its member to
  `KindDefinition` and its method to `createKindProvider` in
  `src/host/provider.ts`, give it the `openrouter` answer in
  `src/host/kind.ts`, version [`manifest.json`](manifest.json) as
  [`bundles/AGENTS.md`](../../AGENTS.md) requires, and in the same change update
  `tests/manifest.test.ts` and add the answer's test to
  `tests/provider.test.ts`.
- Add a new provider value as a field of `openRouterKind` in
  `src/host/kind.ts`, mark it `advanced: true` unless every user must set it,
  read it in `build` through `literalValue`, and refuse a malformed value there
  with an `Error` whose message names the field, as `numericValue` does.
- Keep the catalog URL rule of `catalogUrl` in `src/host/catalog.ts` the same
  as the model-list URL of `packages/llms/src/lib/providers/openrouter/models.ts`
  (`modelsUrl`, else `<endpoint>/models`, else the default): the catalog a
  user picks models from must be the list the built provider validates them
  against.
- Never let `readCatalog` reject, log, or put the URL, the credential or the
  response in its answer: any failure must answer `{ status: 'failed' }`, and
  only `models/v1` logs it.
- Send the catalog's `authorization` header only when `secret` is not empty.
- Pass the `token` source to `createOpenRouterProvider` unresolved: never call
  the `secret` callback of `create` and never use `secrets/v1` in this bundle,
  so that `llms` reads the credential before each request and a rotated
  credential reaches the next request.
- Add a request rule, a model-family policy, a capability or a repair rule of
  the built provider in `packages/llms/src/lib/providers/openrouter.ts` or
  `packages/llms/src/lib/providers/openrouter/`, and add here only the field
  that carries its value and the line of `build` that passes it.
- Keep `icons` pure: never do I/O or read a secret in it, and choose a model's
  icon only through `openRouterModelIcon` of `llms`.
- Make the default logger only inside the `logger` callback of
  `createActivate` in `src/host/index.ts`, so that `log/v1` is used on the
  first `create` and never during `activate`, and keep one logger per
  activation.
- Never let the `log/v1` sink of `src/host/logger.ts` throw: a log record must
  never fail the caller.
- Test a behavior of the record in `tests/provider.test.ts`, and a behavior of
  `catalog` in `tests/catalog.test.ts`, activating the host part with
  `providerWorld` of `tests/support/world.ts` and injecting a transport with
  `recordingTransport` or `failingTransport`; never let a test reach the
  network.
- Test a request rule, a model-family policy or the repair loop of the built
  provider in `packages/llms/tests/`, since the `stream` of both test
  transports here throws.
- When you change the manifest's `version` or a `provides` entry, change the
  expected values in `tests/manifest.test.ts` in the same change.
- Declare every contract the bundle provides or uses in
  [`manifest.json`](manifest.json), and open it before adding a use of a
  contract.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "openrouter"`.
- Update [`README.md`](README.md) in the same change as any change to what it
  states: the manifest, the package's exports, the kind's fields, the record's
  answers, `catalog`, `create`, the logger, the errors or the Nx targets;
  update the feature doc [usage](../../../docs/features/usage.md) when
  the change alters the context capacity or the cost an `openrouter` provider
  reports, and the feature doc
  [credentials](../../../docs/features/credentials.md) when it alters how an
  `openrouter` provider names or reads its credential.

## Verify

- `npx nx run bundle-openrouter:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-openrouter:test`: run it after any change under `src/` or
  `tests/`, to `manifest.json`, or to
  `packages/llms/src/lib/providers/openrouter.ts`,
  `packages/llms/src/lib/providers/openrouter/`,
  `packages/llms/src/lib/providers/models.ts` or
  `packages/llms/src/lib/providers/kinds.ts`; run the tests only through this
  target, which builds `llms` and `bundle` first.
- `npx nx run bundle-openrouter:build`: run it after a change to
  `manifest.json`, `package.json` or a `tsconfig*.json` file.

## Generated files

None.
