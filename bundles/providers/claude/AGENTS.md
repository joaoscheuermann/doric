# claude

Apply these rules to `bundles/providers/claude/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to registering the `claude` provider kind as one
`models.provider/v1` record, and add to it no UI, no credential storage, no
sign-in flow and no other provider kind: drawing the sign-in and storing the
login belong to the bundle that owns the Claude login, and another kind belongs
to its own provider bundle.

## Rules

- Read [`README.md`](README.md) for what the record answers before changing
  it or adding to it.
- Keep the bundle host-only: put all its code in `src/host/`, keep the kind's
  descriptor, traits, `build`, `catalog` and `icons` in `src/host/kind.ts`,
  and keep `src/host/provider.ts` generic over a `KindDefinition`, with
  nothing specific to Claude in it.
- Add a feature to the kind through `models.provider/v1` only: add a member
  of the `KindDefinition` in `src/host/provider.ts` only for a method or
  output that `models.provider/v1` declares, and never add a contract,
  contracts module or slot to this bundle.
- Never write the Anthropic request, its headers, its auth handling or its
  catalog parsing here: put them in `packages/llms` and call them from
  `src/host/kind.ts` through `createClaudeProvider` and `claudeCatalogModel`,
  and add their tests, and their text in the
  [`llms` README](../../../packages/llms/README.md#claude), in
  `packages/llms` in the same change.
- Keep the descriptor deeply equal to `providerKind('claude')` of `llms`: read
  `lists` and `modelsFromCatalog` from it, and change a field or text of the
  descriptor in `packages/llms/src/lib/providers/kinds.ts` in the same change
  as in `src/host/kind.ts`.
- Never let `catalog` reject, request anything without a secret, or name the
  endpoint, the credential or the response in its answer: answer `absent`
  without a secret and `failed` on any error.
- Keep `kind`, `advertised`, `catalogCapacity` and `icons` free of I/O, and
  never read a secret in `icons`.
- Keep the `token` field the kind's only `secret` field: `create` puts the
  `secret` callback in the place of the first `secret` field, and the `llms`
  provider awaits it before each request.
- Reach the logger only through `log/v1`, created on first use, and never let
  a log record throw into the caller.
- When the descriptor's fields or text change, update
  [`tests/fixtures/provider-kind.json`](tests/fixtures/provider-kind.json) in
  the same change.
- Add a test of a record method to `tests/provider.test.ts` through
  `providerWorld` and a recording or failing transport from
  `tests/support/world.ts`, and never let a test reach the network.
- When the manifest's `version` or `provides` changes, update
  `tests/manifest.test.ts` in the same change.
- Declare every contract the bundle uses in [`manifest.json`](manifest.json),
  and raise the `models.provider/v1` entry of `provides` to the version of
  `bundle/contracts` whose members the record implements.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "claude"`.
- Update [`README.md`](README.md) in every change to the record, its
  descriptor or its errors, and update the feature docs
  [settings](../../../docs/features/settings.md) and
  [credentials](../../../docs/features/credentials.md) when the change alters
  what the provider page shows or which credential the kind reads,
  [models and providers](../../../docs/features/models-and-providers.md) when
  it alters the kind, its catalog or `create`,
  [provider sign-in](../../../docs/features/provider-sign-in.md) when it alters
  the `token` field or how the catalog reads the login, and
  [usage](../../../docs/features/usage.md) when it alters the context window
  the catalog reports.

## Verify

- `npx nx run bundle-claude:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-claude:test`: run it after any change under `src/` or
  `tests/`, or to `manifest.json`, and run the tests only through this target.
- `npx nx run bundle-claude:build`: run it after any change under `src/`, or
  to `manifest.json`, `package.json` or `tsconfig.json`, since only the build
  dry-activates the host part and checks what it provides against the
  manifest.

## Generated files

None.
