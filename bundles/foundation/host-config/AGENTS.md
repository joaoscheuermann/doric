# host-config

Apply these rules to `bundles/foundation/host-config/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to owning the one Doric configuration: its settings space,
the rules a configuration obeys, the `host-config/v1` service that answers and
replaces it, its start step, and the credential references it names. Do not
add to it a window, an HTTP route, a credential store, a provider build or a
use of a configuration value: drawing the configuration belongs to the bundle
that draws settings, serving it over HTTP to the bundle that serves the host's
routes, storing credentials to the provider of `secrets/v1`, building providers
to the provider of `models/v1`, and applying a value to the bundle that reads
it.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it,
  and the feature docs [settings](../../../docs/features/settings.md) and
  [credentials](../../../docs/features/credentials.md) for how the
  configuration and its credentials behave across bundles.
- Put new code only in `src/host/` and `src/contracts/`, and only re-exports in
  `src/testing.ts`.
- Never add a desktop or client part: drawing the configuration belongs to the
  bundle that draws settings, which reaches this bundle only through
  `host-config/v1`.
- Keep the rules a stored configuration obeys only in `ConfigInputSchema` of
  `src/host/config/schema.ts`, and keep every object of it strict.
- Keep the schemas of `src/contracts/index.ts` loose structural mirrors that
  carry the value unchanged: never move a validation rule into them, since the
  rules need the `llms` kind catalog.
- Never restate a provider kind's fields, lists or efforts: read them from
  `providerKind` and `reasoningEfforts` of `llms`.
- Add a configuration key in one change to `ConfigInputSchema`, to
  `ConfigurationValue` and `configurationValueSchema` in
  `src/contracts/index.ts`, and to `fromSettings` in
  `src/host/config/store.ts`, which rebuilds the value key by key and drops
  any key it does not name.
- Make every new key optional and put it after the last key of its object, so
  that a stored configuration without it and `defaultConfig` still parse and
  the keys `current` answers keep their order.
- Never fill in a default for an absent key in the schema or the store:
  export the value an absent key stands for from `src/contracts/index.ts`, as
  `defaultContextCompaction` and `defaultMaxToolResultChars` are, and let the
  consumer apply it.
- Keep the configuration free of secrets: a key that names a credential holds
  its UUID, and is added to `referencedCredentialIds` in
  `src/host/configuration.ts` and checked for its credential kind in
  `requireCredentials` of `src/host/config/service.ts`.
- Answer caller input as `invalid` and every other failure as `rejected`: throw
  a `ConfigCredentialError` or `ConfigToolError` only for a fault of the
  submitted body; give a new kind of such fault its own error class and add it
  to the `instanceof` check in the `catch` of `replace` in
  `src/host/config/service.ts`; and keep
  the fixed message `The Doric configuration is invalid.` for a body the
  schema refuses.
- Run every replacement inside the serialized lane of `createConfigService`,
  and build the candidate providers with `models/v1.prepare` before
  `store.replace`, so that a configuration whose providers fail to build is never
  stored.
- Read and write the settings space only through `createConfigStore`, so that
  every read and write passes through the same normalizers.
- Keep `defaultConfig` in `src/host/config/schema.ts` equal to the
  configuration the database migrations seed, and change both in one change:
  `app/backend/doric-host/tests/persistence.test.ts` asserts they are equal.
- When [`bundles/AGENTS.md`](../../AGENTS.md) requires raising the version of
  `host-config/v1` or `host-config.configuration/v1`, raise both to the same
  version, in both `provides` entries of [`manifest.json`](manifest.json) (the
  `contractVersion` constant that versioned the embedded manifest left with
  `createHostConfig` in slice S68a).
- Add a method to `host-config/v1` in `configurationMethods` of
  `src/contracts/index.ts` and in `HostConfigService` of
  `src/host/service.ts`; give it `expose: 'desktop'` only when a window
  calls it.
- Export from `src/testing.ts` only seams the host's tests and this bundle's
  tests drive; `src/kernel.ts` was deleted in slice S68a, so add no kernel
  entry.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "host-config"`.
- Test a schema rule in `tests/config.test.ts` through
  `ConfigInputSchema.safeParse`, a step of `replace` in the same file through
  `createConfigService` with a fake store, `models` and the
  `credentialResolver` of `tests/helpers/credentials.ts`, and credential
  resolution in `tests/credentials.test.ts`; import `src/` by relative path.
- Test each new configuration key in `tests/config.test.ts` through
  `storedService(memorySettings(...))`, which drives the real store: replace a
  body that carries the key, then read it back with `current()` from a new
  service, since a fake store never runs `fromSettings`, where a key is lost.
- Test a change to activation, the reference source or the start step in
  `app/backend/doric-host/tests/`, which boots the bundle in a host.
- After a change to `src/host/configuration.ts`, `src/host/service.ts`,
  `src/testing.ts` or a signature they export, run `npx nx run doric-host:test`
  with `DORIC_TEST_DATABASE_URL` set to a test database, since these tests skip
  without it, and `npx nx run doric-host-e2e:typecheck`; their tests import
  `host-config/testing`.
- Update [`README.md`](README.md) in every change to a contract, a
  configuration key or rule, the `replace` pipeline, storage or the start step,
  and update the feature doc [settings](../../../docs/features/settings.md) for
  a change to the configuration or its replacement and
  [credentials](../../../docs/features/credentials.md) for a change to the
  credential references, in the same change.

## Verify

- `npx nx run bundle-host-config:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-host-config:test`: run it after any change under `src/`
  or `tests/`.
- `npx nx run bundle-host-config:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or
  `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
