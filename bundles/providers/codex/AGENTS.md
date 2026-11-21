# codex

Apply these rules to `bundles/providers/codex/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing the internal `codex` provider kind as one
`models.provider/v1` record built on the Codex provider of `llms`, and add to
it no second kind, UI, setting, route, tool or contract of its own: listing,
resolving and caching configured providers belongs to the bundle that provides
`models/v1`, drawing a provider's form belongs to the bundle that draws the
provider settings, and storing a credential belongs to the bundle that
provides `secrets/v1`.

## Rules

- Read [`README.md`](README.md) for what the record answers, how `create`
  builds a provider and what each error means before changing the bundle.
- Keep `advertised` `false` in `src/host/kind.ts`: the kind must stay out of
  the list of kinds a user can choose, while `models/v1.kind('codex')` must
  still resolve it.
- Keep `catalogCapacity` `false` in `src/host/kind.ts` while the built
  provider's `models()` reports no context capacity.
- Keep the descriptor of `codexKind` in `src/host/kind.ts` equal to
  `providerKind('codex')` of `packages/llms/src/lib/providers/kinds.ts` and to
  `tests/fixtures/provider-kind.json`, and change all three in one change:
  `tests/provider.test.ts` asserts that they match.
- Change the shape of `models.provider/v1` only in
  `packages/bundle/src/contracts/basic/models.ts`, never in this bundle.
- Put what is specific to the `codex` kind (its fields, its `build`, its
  `icons`) in `src/host/kind.ts`, and put what turns any kind definition into
  the record (`createKindProvider`, `buildConfigured`) and the field and value
  helpers (`endpointField`, `tokenField`, `literalValue`, `baseUrl`) in
  `src/host/provider.ts`.
- When `models.provider/v1` gains a method or an output field in
  `packages/bundle/src/contracts/basic/models.ts`, add its member to
  `KindDefinition` and its method to `createKindProvider` in
  `src/host/provider.ts`, give it the `codex` answer in `src/host/kind.ts`,
  raise the `provides` entry of [`manifest.json`](manifest.json) to the new
  minor and the manifest's `version` by one minor, and in the same change
  update `tests/manifest.test.ts` and add the answer's test to
  `tests/provider.test.ts`.
- Read every value of a field that is not of kind `secret` through
  `literalValue` in `build`, and refuse a malformed value there with an
  `Error` whose message names the field, as `fedrampValue` does.
- Pass the `token` source to `createCodexProvider` unresolved: never call the
  `secret` callback of `create` and never use `secrets/v1` in this bundle, so
  that `llms` reads the credential before each request and a rotated
  credential reaches the next request.
- Add a request header, a body rule or a capability of the built provider in
  `packages/llms/src/lib/providers/codex.ts`, and add here only the field that
  carries its value and the line of `build` that passes it.
- Keep `icons` pure: never do I/O or read a secret in it.
- Give `codexKind` a `catalog` only together with a models URL field, since
  `catalog` must answer `{ status: 'absent' }` without a request while the kind
  has none.
- Make the default logger only inside the `logger` callback of
  `createActivate` in `src/host/index.ts`, so that `log/v1` is used on the
  first `create` and never during `activate`, and keep one logger per
  activation.
- Never let the `log/v1` sink of `src/host/logger.ts` throw: a log record must
  never fail the caller.
- Test a behavior of the record in `tests/provider.test.ts`, activating the
  host part with `providerWorld` of `tests/support/world.ts` and injecting a
  transport with `recordingTransport` or `failingTransport`; never let a test
  reach the network.
- Assert a request the built provider sends only through its `models()`,
  since the `stream` of both test transports throws and Codex completion
  streams; test a header or body rule of
  `packages/llms/src/lib/providers/codex.ts` in
  `packages/llms/tests/codex.test.ts`.
- When you change the manifest's `version` or a `provides` entry, change the
  expected values in `tests/manifest.test.ts` in the same change.
- Declare every contract the bundle provides or uses in
  [`manifest.json`](manifest.json), and open it before adding a use of a
  contract.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "codex"`.
- Update [`README.md`](README.md) in the same change as any change to the
  kind's fields, the record's answers, `create`, the logger or the errors, and
  update the feature doc
  [models and providers](../../../docs/features/models-and-providers.md) when
  the change alters the kind, its catalog or `create`, the feature doc
  [provider sign-in](../../../docs/features/provider-sign-in.md) when it alters
  how the authorization value is obtained, and the feature doc
  [credentials](../../../docs/features/credentials.md) when it alters how a
  `codex` provider names or reads its credential.

## Verify

- `npx nx run bundle-codex:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-codex:test`: run it after any change under `src/` or
  `tests/`, to `manifest.json`, or to
  `packages/llms/src/lib/providers/codex.ts` or
  `packages/llms/src/lib/providers/kinds.ts`; run the tests only through this
  target, which builds `llms` and `bundle` first.
- `npx nx run bundle-codex:build`: run it after a change to `manifest.json`,
  `package.json` or a `tsconfig*.json` file.

## Generated files

None.
