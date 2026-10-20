# Core bundle

`core` supplies the basic services every other Doric bundle builds on: the
tool and skill registries the agent sees, model provider resolution, settings,
stored credentials, storage, events, logging and hooks, plus the desktop
app's windows, menus, commands, navigation and UI regions. Most of what a
bundle can do in Doric, it does through a contract the core provides.

The composition names this bundle as its core: it activates right after the
foundation on the host. It requires `storage.backend/v1` and
`secrets.backend/v1`, so the composition must choose a provider for each in
`providers` (`postgres` in the shipped host, the `storage/memory` foundation in
tests). See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Host:** `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`, `storage/v1`,
  `secrets/v1`, `events/v1`, `settings/v1` and `models/v1`, plus the
  `core.settings/v1` and `core.settings-generation/v1` storage types; it
  defines `core.event-hooks/v1` (`onEventAppendedHook`).
- **Desktop main process:** hooks, log, local settings, `commands/v1`, the
  client commands bridge (`core.commands/v1`), `windows/v1` and `menus/v1`; it
  defines `core.hooks/v1`, registers `core.open-settings/v1` and opens the
  workspace window once the app is ready.
- **Window client:** hooks, log, `ui/v1`, `navigation/v1`, `regions/v1` and
  `commands/v1`; the structural elements `core-outlet`, `core-region`,
  `core-not-found` and `core-unavailable`; same-origin link interception and
  the menu context of the window path.

Each part's `provide` is inert when the composition chose another provider for
that contract; the core then uses the chosen one through its contract.
Activation does no I/O: storage types are declared to the backend on first use
and credentials are read on the first secrets call.

## Host services

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
  registered them, sorted by the global `order` key, then activation order;
  names are unique across bundles.
- `skills/v1` — canonical skill records sorted by the global `order` key, then
  bundle order; names are unique and `allowed-tools` resolve against every tool
  in the caller's `tools/v1` list.
- `models/v1` — the model layer over the `models.provider/v1` records that
  provider bundles register: `kinds` lists the advertised kinds, `kind`
  resolves any kind by id, `catalog` reads a kind's live model catalog with its
  stored credential, `prepare` builds the configured providers, `resolve`
  answers a provider's language model, and `contextWindow` reads a model's
  context capacity from a cached provider's catalog.
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
- `events/v1` — the owner of a registered event appends it to the stream of
  the event sink its provider registered (`sink`: scope keys in row order, and
  a stream template whose `{key}` placeholders take the call's scope values).
  The sink's owner must own the stream's family, and the call scope must carry
  every key of the sink; the body carries `type` and is redacted and made
  storable first. The core names no Thread log: the runtime registers its sink
  for `runtime.thread.events/{threadId}`. No shipped bundle other than the
  runtime registers an event (a test pins it).

## Guarantees

- `settings.set` and the secrets writes share one queue, which keeps a
  configuration from naming a credential that a concurrent delete removes.
- `log/v1` replaces every secret of `secrets/v1.view().redactions()` with
  `[REDACTED]` in the message and in the string leaves of the fields.

## Public contracts

The public `core/contracts` entrypoint exports `CoreHooksV1`,
`CoreEventHooksV1` and `OpenSettingsCommandV1`, typed references whose
providers arrive with the core's parts; `CoreCommandsV1`; the storage types
`settingsType` and `settingsGenerationType` (with `settingsGenerationId`), so
data migrations use the same definitions; and the model catalog fill helpers
that the host configuration runs over `models/v1.catalog`.

## Development

```console
npx nx build bundle-core
npx nx typecheck bundle-core
npx nx test bundle-core
```

The build writes `bundles/foundation/core/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/core`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
