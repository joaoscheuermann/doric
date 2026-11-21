# Feature: Local history

- Status: `implemented`

## Problem

A conversation's history is the Thread's durable event log on the host, and the window reads it through a live watch. Without a local copy, a Thread the reader opens draws nothing until the host answers and replays the whole log, which is slow for a long Thread and empty while the host is unreachable. The desktop needs a local snapshot of each recently used Thread that the window can draw at once, that the live watch then brings up to date, and that never shows the history of another database or of storage that was rewritten.

## Decisions

- The snapshot is a cache, never a source of truth. The host's durable Thread events are the only conversation history; the window's live watch brings the Thread up to date from where the snapshot ends, and a missing or broken snapshot only means the Thread opens from the host.
- The cache is its own bundle, `history`, with a `desktop` part only. It provides `history.snapshots/v1` in `desktopMain`, and the window reaches it over the desktop bridge.
- `history.snapshots/v1` has two methods: `read(threadId)` and `write({ threadId, updates })`. The chat feeds the cache with the updates it applied; the cache never subscribes to the host itself.
- Every update of a `write` applies to the call's `threadId`, except `deleted`, which names its own Thread. A stream failure (`error`) is not part of the contract and is never cached.
- The contract's record schemas are loose: they check only the fields the cache reads and keep every other field, so the bundle imports no runtime contract.
- A cached file whose `thread` has no string `id` reads as no snapshot.
- Snapshots are namespaced by the host's storage identity, `<hostId>/<storageGeneration>`, read from `doric.catalog/v1` once at activation. Without an identity the store is disabled for the rest of the activation: `read` answers `null` and `write` keeps nothing.
- `history.snapshots/v1` is optional for the chat, which reaches it through `whenAvailable` and imports only its types, so a composition without the `history` bundle loads nothing of it.
- Writes are debounced by 250 ms and flushed in an `onBeforeQuitHook` handler, which never vetoes the quit, and on deactivation.

## Current behavior and contracts

### The bundles

- [`history`](../../bundles/desktop/history/README.md) keeps the snapshots. It has a `desktop` part only, provides `history.snapshots/v1` and requires `hooks/v1` ([manifest.json](../../bundles/desktop/history/manifest.json), [src/desktop/index.ts](../../bundles/desktop/history/src/desktop/index.ts)).
- [`chat`](../../bundles/desktop/chat/README.md) lists `history.snapshots/v1` under `optional`. It reads a snapshot when it opens a Thread and writes every batch it applied ([manifest.json](../../bundles/desktop/chat/manifest.json), [src/client/index.ts](../../bundles/desktop/chat/src/client/index.ts)).
- The host's composition enables `history`. A desktop-only bundle runs because the desktop loads the `desktopMain` and `client` parts of the bundles the host's distribution lists, which it reads through `doric.catalog/v1` ([app/backend/doric-host/composition.json](../../app/backend/doric-host/composition.json), [app/desktop/doric/src/platform/app.ts](../../app/desktop/doric/src/platform/app.ts), [Composition and distribution](../architecture/bundles/composition-and-distribution.md)). The full contract, the store's rules and the file format are in the README of [`history`](../../bundles/desktop/history/README.md).

### The contract `history.snapshots/v1`

- It runs in `desktopMain`, and both methods have the exposure `'desktop'`. A window may send the scope keys `projectId`, `threadId` and `promptId` with a call; the methods ignore them ([src/contracts/index.ts](../../bundles/desktop/history/src/contracts/index.ts), [manifest.json](../../bundles/desktop/history/manifest.json)).
- `read(threadId)` answers `{ thread, lastSequence, events }` or `null`. `events` are the events the cache absorbed since it last held the Thread, ascending by `sequence` with one event per sequence; `lastSequence` is the sequence of the last event, 0 without events ([src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).
- `write({ threadId, updates })` takes the updates in the order the window applied them: `snapshot` (a Thread record or `null`, and events), `event`, `updated` (a Thread record) and `deleted`. It absorbs them, schedules a write and resolves at once ([src/desktop/index.ts](../../bundles/desktop/history/src/desktop/index.ts), [src/contracts/index.ts](../../bundles/desktop/history/src/contracts/index.ts)).
- Neither method's handler throws. The platform refuses a call whose input or output does not match the method's schema with `invalid_input` or `invalid_output`, and the desktop bridge refuses a call that carries a scope key other than the three with `invalid_input` ([packages/bundle/src/runtime/dispatch.ts](../../packages/bundle/src/runtime/dispatch.ts), [app/desktop/doric/src/platform/bridge/dispatcher.ts](../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).

### Opening a Thread

1. When the chat opens a Thread it does not hold, it reads the Thread's snapshot through `history.snapshots/v1.read`. With no provider, or when the read fails, it has no snapshot ([src/client/stores/thread-chats.ts](../../bundles/desktop/chat/src/client/stores/thread-chats.ts), [src/client/api/threads-api.ts](../../bundles/desktop/chat/src/client/api/threads-api.ts)).
2. The Thread starts from the snapshot: its record, and its events folded into the conversation's projection, so the conversation draws before the host answers ([src/client/domain/thread-chats.ts](../../bundles/desktop/chat/src/client/domain/thread-chats.ts)).
3. The chat then watches the Thread through `runtime.threads/v1.watchThread` from the snapshot's `lastSequence`, or from 0 without a snapshot. The host's events after that sequence, rewind markers included, bring the projection up to date ([src/client/domain/thread-chats.ts](../../bundles/desktop/chat/src/client/domain/thread-chats.ts), [src/client/stores/thread-chats.ts](../../bundles/desktop/chat/src/client/stores/thread-chats.ts), [src/client/api/thread-watch.ts](../../bundles/desktop/chat/src/client/api/thread-watch.ts)).
4. A watch of a Thread's fences for a surface outside the conversation starts from the same snapshot, without writing to the cache ([src/client/services/fence-watches.ts](../../bundles/desktop/chat/src/client/services/fence-watches.ts)).

The conversation's own watch, projection and bound are described in [Conversation](conversation.md).

### Feeding the cache

- Each live `event` reaches the cache with the flush that applies it to the conversation, at most one per Thread every 100 ms, as one batch per Thread. Events held for a Thread whose watch is released reach the cache at the release, and the events held for every Thread reach it when the chat's Thread store closes all its watches (`closeAll`). Every other update the watch delivers reaches the cache as soon as the chat applies it; the Thread record that `resume` applies from the host's reply is not written to the cache ([src/client/stores/thread-chats.ts](../../bundles/desktop/chat/src/client/stores/thread-chats.ts)).
- The chat converts each update to the contract's shape: a `snapshot` carries only its Thread record and events. An `error` is dropped. A missing provider or a failed write changes nothing in the conversation ([src/client/api/history-contract.ts](../../bundles/desktop/chat/src/client/api/history-contract.ts), [src/client/api/history.ts](../../bundles/desktop/chat/src/client/api/history.ts)).

### Keeping the snapshots

- At activation the `history` bundle reads its cache directory from `doric.cache/v1` and the storage identity `{ hostId, storageGeneration }` from `doric.catalog/v1.get().storage`, and opens the store over `<cache directory>/<encodeURIComponent(hostId)>/<storageGeneration>`. One file, `<encodeURIComponent(threadId)>.json`, holds one Thread ([src/desktop/index.ts](../../bundles/desktop/history/src/desktop/index.ts), [src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).
- The storage creates its identity with a random `hostId` and `storageGeneration` 1; rewriting the stored Thread logs increments `storageGeneration`. A different database or a new generation therefore reads none of the snapshots another one left, and each conversation replays its log from the host ([bundles/foundation/postgres/src/host/storage/identity.ts](../../bundles/foundation/postgres/src/host/storage/identity.ts), [packages/storage/src/memory/storage-backend.ts](../../packages/storage/src/memory/storage-backend.ts), [migration.sql](../../bundles/foundation/postgres/prisma/migrations/20261021000000_coalesce_thread_deltas/migration.sql), [src/desktop/index.ts](../../bundles/desktop/history/src/desktop/index.ts)).
- The store merges incoming events into the held log by sequence, keeping the event it already held for a sequence, and drops every event a rewind marker (an event whose payload has `type: 'history.truncated'` and an `afterSequence`) discards ([src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts), [bundles/desktop/chat/src/client/domain/projector.ts](../../bundles/desktop/chat/src/client/domain/projector.ts)).
- `deleted` forgets the Thread and deletes its file at once ([src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).
- The store holds at most 20 Threads. An update that brings a 21st forgets the least recently updated one and deletes its file; files a previous run left count, in modification order. The store counts Threads by their last update and the chat by its reader's views, so a Thread can be forgotten while its watch stays open: it is cached again from its next update, so once it absorbs an event its log holds only the events from then on (and no record, when that first update is an `event`); the chat later reopens it from that partial log and watches it from its last sequence, so the earlier events are not drawn ([src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts), [src/client/domain/thread-chats.ts](../../bundles/desktop/chat/src/client/domain/thread-chats.ts)).
- A write runs 250 ms after the first update that scheduled it, and an `onBeforeQuitHook` handler and deactivation flush every pending write; the handler answers `{ allow: true }`. Each file is written to `<file>.tmp`, which then replaces the file with a rename. A write that fails stays pending for the next flush ([src/desktop/index.ts](../../bundles/desktop/history/src/desktop/index.ts), [src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).
- A missing, unreadable or malformed file reads as `null`, and no failure of the store reaches the caller. The bundle logs nothing ([src/desktop/store.ts](../../bundles/desktop/history/src/desktop/store.ts)).
