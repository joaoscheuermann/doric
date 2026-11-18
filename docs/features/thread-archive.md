# Feature: thread archive

- Status: `implemented`
- Brief: none
- Specs: [docs/designs/thread-archive.md](../designs/thread-archive.md)
- Decisions: [Arquivamento de threads (2026-11-17)](../architecture/bundles/implementation-decisions.md#arquivamento-de-threads-2026-11-17)

## Problem

Every Thread of the selected Project stayed in the sidebar tree for as long as the Project existed. Agents spawn many agent threads, and the reader could not hide one: deleting an agent thread was refused, and deleting would break the spawn card that opens a child from its parent's conversation. Main threads stayed in the tree however long they went unused. The UI redesign deferred archiving for this reason (UR9 in [ui-redesign](ui-redesign.md)).

## Decisions

- Archived is a field on the Thread, not a state: archived Threads stay in the client's store, so the spawn card still opens an archived child. There is no finished state.
- The public record carries optional `archivedAt` (ISO 8601) and `pinned`; the stored document (`runtime.thread/v1` 1.3.0) keeps `archive: { at, batch }`, `pinned`, `restoredAt`, `viewedAt` and `result.reason`. Absent means not archived, not pinned, never restored, never viewed. No migration.
- Archive, restore, pin and view writes keep `updatedAt`, so a sweep never makes a Project look active.
- Agent-thread rule: an agent thread is archived 30 s to 40 s after the later of its turn's end and its last view's end, never with its descendants. A main thread is never archived by this rule.
- Main-thread rule: a main thread and its whole subtree are archived after the configured inactivity (1 day, 7 days by default, 30 days or never) when nothing in the subtree is pending. Activity is the latest `createdAt` or `result.at` in the subtree, or the main thread's restore time.
- Neither rule archives a Thread that is busy, failed, stopped by the reader (`result.reason: 'interrupted'`; other cancellations do not block), waiting for input (an open question form included, read from the result text with the shared `hasQuestionForm`), open on screen in any window, or pinned. For the main-thread rule a result that ended after the last view is unread and pending; a Thread never viewed has no unread result.
- A Thread restored by the reader is not auto-archived again until a turn ends after the restore. Until then it counts as pending for the main-thread rule, so its main thread's subtree is not archived by inactivity either.
- Any new activity (an accepted input, a resume, a resumed queue, a run start) un-archives the one Thread it reaches, never its ancestors; a delivered child result un-archives its parent.
- Manual archive refuses a busy target and archives the target with every non-archived descendant except busy and pinned ones, in one batch. Restore and Undo un-archive the Thread and every descendant of the same batch.
- The archiver is one sweep every 10 s over the live Projects. It reads storage outside the Project lock, decides again under the lock before writing, never waits for a held lock, and reads the configuration on every sweep, so a Settings change applies at the next sweep. On drain it stops and ends every view stream with `unavailable`; a Project's grace is counted from the first sweep that sees it live, and it is swept only 30 s after that, so 30 s to 40 s after it goes live.
- Presence is a desktop-exposed stream: a view lasts while its `viewThread` stream is open; the runtime counts views per Thread across windows, with no TTL.
- Archive and restore are one store commit each; a commit over the batch limit (about 5 000 Threads) is refused with `limit_exceeded` and nothing is written.
- No REST change: the four methods are desktop-exposed only; changed records go out as `thread:updated`.
- The first sweep after the upgrade archives every eligible agent thread and every main thread idle for 7 days or more, with no grace period (R1). Nothing is deleted; each is listed in the Archived tab.
- No rollback of `runtime` below 2.8.0 once it wrote a Thread (R2). `host-config` goes back to 0.1.0 only after `threads` is removed from the stored configuration (R16).

## Current behavior and contracts

- `runtime.threads/v1` 1.8.0 (desktop-exposed only):
  - `archiveThread({ id })` answers `{ status: 'archived', batch, threads }` (target first) or `missing`, `busy`, `already_archived`.
  - `restoreThread({ id, batch? })` answers `{ status: 'restored', threads }` or `missing`, `not_archived`; without `batch` it uses the Thread's own.
  - `setThreadPinned({ id, pinned })` answers the Thread, or `undefined` when missing.
  - `viewThread({ threadId }, listener)` emits one `{ kind: 'viewing', threadId }` and holds a view until disposed, the host link closes, the host drains (`unavailable`) or the Thread is missing (`not_found`); a failed record read logs `Thread view failed` and ends the stream with `internal`, and the layout does not reopen it.
  - `deleteThread` deletes an archived agent thread; a non-archived agent thread is still refused, and the subtree must be terminal.
- The fence and question-line rules are shared code in `runtime/contracts` (`src/contracts/fences.ts`), used by the host, `chat` and `openui`. `completedStatements` drops one trailing newline of an unclosed fence.
- Host configuration: optional, strict `threads: { autoArchive: { agentThreads, mainThreadsAfter } }`; absent keys mean `agentThreads: true` and `mainThreadsAfter: '7d'` (`'1d' | '7d' | '30d' | 'never'`).
- Sidebar (`layout`): two icon-only tabs above the Thread tree, Chat and Archived (`molecules/sidebar-tabs.tsx`), with tooltips and no counter; ⌘F search filters the open tab's tree.
  - Chat tab: non-archived Threads, with the archived ancestors of one drawn dimmed with an archive mark, still selectable, Restore in their menu. A row's hover actions are, right to left, the plus, Archive, and Unpin on a pinned row; a pinned row shows a pin mark at rest. The context menu of every Chat row, agent threads and busy rows included, has "Pin thread" / "Unpin thread"; "Archive thread" appears only when the row is archivable (not queued, running or cancelling).
  - Archive shows the toast "Thread archived" with Undo; there is no confirmation dialog.
  - Archived tab (`organisms/archived-threads.tsx`): the real tree grouped by archive date into Today, Last 7 days and Older (an unparsable archive time groups as Older). Only archived rows are interactive, with Restore and Delete on hover; every ancestor not archived in that section is an inert context row, including one archived in a different section. Delete removes the whole subtree; its dialog names how many non-archived descendants it removes too.
  - Refusals `busy`, `already_archived` and `not_archived` surface as `ClientError('conflict')`; other failures go through the store's failure path.
  - Open Threads report presence through `viewThread`.
  - Navigation is unchanged: an archived child opens in the viewer tab under its main thread, and an archived main thread resolves its own route.
- Settings: a "Threads" section (order 25, between Execution and Tools) with the "Auto-archive" group: the switch "Archive finished agent threads" and the choice "Archive inactive main threads after" (1 day, 7 days, 30 days, Never).
- Shipped in: `runtime` 2.8.0 (`runtime.threads/v1` 1.8.0, `runtime.thread/v1` 1.3.0), `host-config` 0.2.0 (`host-config/v1` and `host-config.configuration/v1` 1.2.0), `layout` 3.2.0, `settings` 1.8.0, `chat` 1.8.0, `openui` 2.3.0 (the last four require the new contract minors).

## Evolution

- 2026-11-17: implemented ([spec](../designs/thread-archive.md) version 5). Archive, restore, pin and presence in the runtime with the 10 s archiver; `threads.autoArchive` in the host configuration; the Chat and Archived sidebar tabs, archive, pin, restore and delete in the layout; the Threads section in Settings; fence rules shared through `runtime/contracts`.
