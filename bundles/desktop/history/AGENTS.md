# history

Apply these rules to `bundles/desktop/history/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to caching, in `desktopMain`, a local snapshot of each
recently used Thread's durable event log so that a window can draw the
conversation before the host answers, and add to it no UI, setting, tool, host
part or client part: watching, projecting and drawing a Thread belong to the
bundle that shows the Thread, and the host's durable events stay the only
conversation history.

## Rules

- Read [`README.md`](README.md) for what the bundle does before changing it.
- Keep the cache best effort: never let a method of `history.snapshots/v1` or
  of the store reject or throw because of the file system; a missing or
  malformed file must read as `null`, and an entry whose write fails must stay
  pending for the next flush.
- Never let the `onBeforeQuitHook` handler veto the quit, and write every
  pending snapshot both there and in the cleanup `activate` returns.
- Read or write a snapshot only under the namespace
  `<encodeURIComponent(hostId)>/<storageGeneration>` of the `doric.cache/v1`
  directory, and never touch the disk when `doric.catalog/v1` gives no storage
  identity.
- Declare the record schemas of `src/contracts/` with `z.looseObject`, checking
  only the fields the cache reads, and never import the contracts of `runtime`
  or `chat`: `chat` imports this bundle's types, never the other way.
- Change `src/contracts/` only compatibly within `/v1`: `chat` builds the
  updates it passes to `write` and reads `read`'s answer with these types.
- Keep the merge rule of `src/desktop/store.ts` equal to the rewind rule of the
  chat's projector (`bundles/desktop/chat/src/client/domain/projector.ts`):
  when one changes how a `history.truncated` marker discards events, the other
  must change in the same change.
- Change the Thread limit or the write delay only through the constants of
  `src/desktop/store.ts`.
- Put a change to what the cache keeps, merges, evicts or writes in
  `src/desktop/store.ts`, and keep that file free of services: it works over
  one directory it is given.
- Put the wiring to services (cache directory, catalog, hooks, providing the
  contract) only in `src/desktop/index.ts`.
- Add a method of `history.snapshots/v1` to the `HistorySnapshots` interface
  and to `historySnapshotsMethods` of `src/contracts/index.ts`, with
  `expose: 'desktop'` only when a window calls it, and implement it in
  `historySnapshots` of `src/desktop/index.ts`.
- Add a scope key to `desktopScope` in [`manifest.json`](manifest.json) only
  when a window sends it with a call to `history.snapshots/v1`, and never
  remove one a caller still sends: the bridge refuses a call with an
  undeclared key.
- Test a change of the store in `tests/store.test.ts` against
  `createHistoryStore` over a temporary directory, and a change of the contract
  or of `activate` in `tests/service.test.ts` through `bootDesktop` of
  `tests/support/desktop.ts`; when `activate` starts using another platform
  contract, give `bootDesktop` a fake of it.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "history"`.
- Update [`README.md`](README.md) and the feature doc
  [Local history](../../../docs/features/local-history.md) in the same change as
  any change to the contract, the merge rule, the file layout, the limits or
  the failure behavior.

## Verify

- `npx nx run bundle-history:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-history:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle first, because `tests/service.test.ts` loads the bundle from `dist/`.
- `npx nx run bundle-history:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None.
