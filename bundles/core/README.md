# Core bundle

`core` is the bundle the composition names as its core: it activates first on
the host and provides the basic services every other bundle uses. Its build
writes `bundles/core/dist`, which `doric:build-bundles` stages into
`agents/doric/dist/bundles/core`.

## Services

The host part provides these basic contracts from `bundle/contracts`:

- `hooks/v1` — hooks contracts owned by the bundle that lists them in
  `provides` (or by the platform, for `doric.*`). Handlers run in catalog order,
  the platform first; each gets the owner's call and a 10-second deadline, and a
  failing or late handler is reported to `doric.diagnostics/v1` instead of
  failing the owner. `observe` waits for each handler, `transform` chains valid
  results, and `decide` stops at the first refusal.
- `log/v1` — records that name the calling bundle, its version, generation,
  call scope, trace ID and environment, written through `doric.log/v1` into the
  host's log destinations. A level never throws.
- `tools/v1` — one ordered registry of tools bound to the bundle that
  registered them; names are unique across bundles.
- `skills/v1` — canonical skill records in bundle order; names are unique and
  `allowed-tools` resolve only against tools the same bundle registered.

A composition may choose another provider for any of them in `providers`; the
core's own `provide` is then inert.

The public `core/contracts` entrypoint exports `CoreHooksV1` and
`OpenSettingsCommandV1`, typed references whose providers arrive with the
core's desktop part.

## Development

```console
npx nx build bundle-core
npx nx typecheck bundle-core
npx nx test bundle-core
npx nx run bundle-core:contracts-baseline   # after an intended contract change
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
