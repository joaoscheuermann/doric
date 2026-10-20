# History bundle

`history` makes a conversation appear the moment you open it. The desktop app
keeps a local copy of each recently used Thread's history, so the chat can draw
it right away while the live stream from the host catches up.

It is a desktop bundle with one desktop part (the cache in the desktop main
process) and no UI, loaded by the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contract:** `history.snapshots/v1` (desktopMain), with two methods exposed
  to windows over the desktop bridge:
  - `read(threadId)` returns the cached snapshot (`thread`, `lastSequence`,
    `events`) or `null` when there is no usable one;
  - `write({ threadId, updates })` absorbs the updates a window received
    (`snapshot`, `event`, `updated`, `deleted`) and saves them later.
- **Consumer:** the [`chat`](../chat/README.md) bundle, which lists the
  contract as `optional`. It seeds an opened conversation from `read` and feeds
  every applied batch back through `write`. Without this bundle the chat waits
  for the host instead.

The bundle requires only `hooks/v1` and has no client part, settings or tools.

## A cache, not a source of truth

The host's durable Thread events remain the only conversation history. The
cache only lets a conversation render before the host answers; the chat's
event stream reconciles it afterwards. Every part is best effort:

- reads never throw, and a missing or corrupt file reads as `null`;
- absorbing an update never blocks, and a failed write stays pending for the
  next flush;
- events are merged into one log, deduplicated by `sequence` and in ascending
  order, and events a rewind marker (`history.truncated`) discarded are
  dropped, the same rule the chat's projector applies;
- the contract schemas name only the fields the cache reads and keep the rest,
  so the bundle does not depend on the runtime's contracts.

## Storage

| Aspect   | Behavior                                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| Location | the bundle's `doric.cache/v1` directory, under `<hostId>/<storageGeneration>/<threadId>.json` |
| Identity | taken from `doric.catalog/v1`; without a host storage identity nothing is read or written     |
| Limit    | 20 Threads; updating a 21st deletes the least recently updated snapshot, also across restarts |
| Writes   | debounced by 250 ms, written to a temporary file and renamed into place                       |
| Flush    | on the app's `onBeforeQuitHook` (never vetoing the quit) and when the bundle deactivates      |
| Deletion | a `deleted` update removes that Thread's file                                                 |

Namespacing by host and storage generation means a different database or a
reset storage never shows another history.

## Development

```console
npx nx build bundle-history
npx nx typecheck bundle-history
npx nx test bundle-history
```

The tests cover the merge rules, eviction, corrupt files, the per-identity
directories and the before-quit flush. The build writes
`bundles/desktop/history/dist`, which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/history`. To rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
