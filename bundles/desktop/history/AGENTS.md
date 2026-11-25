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
- Never let the `onBeforeQuitHook` handler veto the quit, write every pending
  snapshot both there and in the cleanup `activate` returns, and finish those
  writes before the handler and the cleanup return: keep `flush` and the file
  calls of [`src/desktop/store.ts`](src/desktop/store.ts) synchronous, or await
  the flush in both places of [`src/desktop/index.ts`](src/desktop/index.ts).
- Read or write snapshots only under the namespace
  `<encodeURIComponent(hostId)>/<storageGeneration>` of the `doric.cache/v1`
  directory, and use `disabledHistoryStore`, which reads and writes nothing,
  when `doric.catalog/v1` gives no storage identity.
- Write into the namespace directory only Thread snapshots,
  `<encodeURIComponent(threadId)>.json`, each through its `.json.tmp` file and
  a rename: the store counts every `*.json` file there as a Thread's snapshot
  toward `snapshotLimit` and deletes the oldest.
- Declare the record schemas of [`src/contracts/`](src/contracts/index.ts) with
  `z.looseObject`, so that every field the host sends is kept in the snapshot,
  and never import the contracts of `runtime` or `chat`: `chat` imports this
  bundle's types, never the other way.
- Keep the checks that `isThreadEvent` and `historyFrom` of
  [`src/desktop/store.ts`](src/desktop/store.ts) apply to a saved file equal to
  `threadEventRecordSchema` and `threadRecordSchema`: an event's `projectId`,
  `threadId`, `promptId`, `sequence`, `type` and `createdAt`, and a Thread
  record's `id`. An event the schema accepts and the file check refuses makes
  the whole snapshot read back as `null`.
- Keep providing `history.snapshots/v1` while `chat` lists it under
  `optional`: `chat` imports only this bundle's types, with `import type`, and
  repeats the id in `ref('history.snapshots/v1')` of
  [`history-contract.ts`](../chat/src/client/api/history-contract.ts), so
  dropping `/v1` turns the cache off in `chat` with no failing check. When a
  change needs a new major, change that `ref` in the same change.
- Keep the rewind rule of `src/desktop/store.ts` (`truncation` and
  `survivors`) equal to the functions of the same names in the chat's
  projector ([`projector.ts`](../chat/src/client/domain/projector.ts)), and
  read the marker only in the shape `runtime` writes it,
  `{ type: 'history.truncated', afterSequence }` in an event's `event` field
  ([`threads.ts`](../../runtime/runtime/src/host/store/threads.ts)). When one
  changes how a marker discards events, change the other in the same change.
- Change the Thread limit or the write delay only through `snapshotLimit` and
  `writeDelayMs` of `src/desktop/store.ts`.
- Put a change to what the cache keeps, merges, evicts or writes in
  `src/desktop/store.ts`, and keep that file free of services: it works over
  one directory it is given.
- Put the wiring to services (cache directory, catalog, hooks, providing the
  contract) only in `src/desktop/index.ts`.
- Add a method of `history.snapshots/v1` to the `HistorySnapshots` interface
  and to `historySnapshotsMethods` of `src/contracts/index.ts`, put its logic
  in `src/desktop/store.ts`, and implement it in `historySnapshots` of
  `src/desktop/index.ts` over that store function.
- Test a change of the store in `tests/store.test.ts` against
  `createHistoryStore` over a temporary directory, and a change of the contract
  or of `activate` in `tests/service.test.ts` through `bootDesktop` of
  [`tests/support/desktop.ts`](tests/support/desktop.ts); when `activate`
  starts using a contract that neither `providePlatformServices` nor the test
  `core` provides, give `bootDesktop` a fake of it: register a platform
  contract on the directory as `doric.cache/v1` is, and a bundle contract
  through a test bundle beside `core`.
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
