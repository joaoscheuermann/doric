# Core bundle

`core` is the bundle the composition names as its core: it activates right
after the foundation on the host and provides the basic services every other
bundle uses. It requires `storage.backend/v1` and `secrets.backend/v1`, so the
composition must choose a provider for each in `providers` (`postgres` in the
shipped host, the `storage/memory` foundation in tests). Its build writes
`bundles/core/dist`, which `doric:build-bundles` stages into
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

- `storage/v1` — a facade over the chosen `storage.backend/v1`. A storage
  type is defined by the bundle its namespace names, and only when it lists
  the type in `provides`. Only the owner reads or writes the type's documents,
  and only the bundle named by a stream's first segment reads or writes the
  stream; the active `events/v1` provider may also write streams, and the
  platform (`doric`) passes every check and may read data nobody defines.
  Written values are the output of the type's schema, and a batch over the
  backend's `capabilities()` is refused before anything is sent. Defining a
  type does no I/O: the backend learns it on the first operation.
- `settings/v1` — each registered space is a `core.settings/v1` document with
  its revision, the owner's contract version, the write time and the global
  `core.settings-generation/v1` counter. A space never written answers the
  schema's defaults at revision 0, or `settings_missing`. Subscribers run
  synchronously after each commit, before the next queued write.
- `secrets/v1` — a cache over the chosen `secrets.backend/v1`, loaded on the
  first call: backend order at load, `localeCompare` by name after each save.
  `delete` answers `referenced` while a registered reference source names the
  credential. `view()` is the in-process view (list, redactions,
  `addRedaction`), available once the credentials are loaded.
- `events/v1` — the owner of a registered event appends it, with a call scope
  naming the project, Thread and prompt, to `runtime.thread.events/<threadId>`;
  the body carries `type` and is redacted and made storable first. No shipped
  bundle registers an event before stage 5 (a test pins it).

`settings.set` and the secrets writes share one queue, which keeps a
configuration from naming a credential that a concurrent delete removes.
`log/v1` replaces every secret of `secrets/v1.view().redactions()` with
`[REDACTED]` in the message and in the string leaves of the fields.

A composition may choose another provider for any of them in `providers`; the
core's own `provide` is then inert, and the other facades reach it through
its contract.

The public `core/contracts` entrypoint exports `CoreHooksV1` and
`OpenSettingsCommandV1`, typed references whose providers arrive with the
core's desktop part, and the storage types `settingsType` and
`settingsGenerationType` (with `settingsGenerationId`), so data migrations use
the same definitions.

## Development

```console
npx nx build bundle-core
npx nx typecheck bundle-core
npx nx test bundle-core
```

To rebuild and stage every bundle used by the Direct host:

```console
npx nx run doric:build-bundles
```
