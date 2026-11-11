# Spec: sidebar alignment

- Ticket: none given.
- Status: `accepted`, version 7 (2026-11-11), approved by the user on 2026-11-10. Phases 1–4 are implemented (2026-11-10, PR #57); the follow-up of [§9.5](#95-follow-up-pane-rows-and-headers), decided by the user on 2026-11-11, is implemented (2026-11-11, PR #57). Version 6 answers the Major findings of the stage 4 Readiness and Codebase review of version 5; its Nits are listed in [Deferred to the plan](#deferred-to-the-plan) ([Revisions](#revisions)).
- Builds on: commit `bb4c2453` (`main`). Every line reference names the file as it is at that commit, except the captures under `docs/designs/sidebar-alignment/`, added for this spec. Every path is written from the repository root.
- Requirements: U1–U12, set by the user (jao.scheuermann). They are not reopened here. U12 is the follow-up the user decided on 2026-11-11 from the papercraft preview in conversation.
- Visual target: the text of [Visual target](#visual-target) and the three committed captures it describes. Figma and the papercraft preview are informative.
- Feature docs: [docs/features/ui-redesign.md](../features/ui-redesign.md), whose sidebar column and Files column this change revises. No new feature doc.
- Identifiers: U1–U12 requirements; D1–D18 design decisions; T-1.1 … T-4.8 and T-F.1 … T-F.4 tests (with T-2.12 in phase 2); SR1–SR15 risks; SQ1–SQ2 questions, both closed.

## Contents

- [Terms](#terms)
- [Visual target](#visual-target)
- [Problem](#problem)
- [Goals](#goals)
- [Non-goals](#non-goals)
- [Requirements](#requirements)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Flows](#flows)
- [Contracts and versions](#contracts-and-versions)
- [Persisted data](#persisted-data)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Test plan](#test-plan)
- [1:1 verification](#11-verification)
- [Docs to update](#docs-to-update)
- [Deferred to the plan](#deferred-to-the-plan)
- [Open questions](#open-questions)
- [Revisions](#revisions)

## Terms

Thread, root Thread, subthread, Project, host, renderer, bundle, contract (`name/vN`, minor version) and pane mean what the Terms of `docs/features/ui-redesign.md:28-44` say. The terms below are this spec's.

| Term                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The user, the reader           | The user is jao.scheuermann, who set U1–U11. The reader is anyone using Doric, as in `docs/features/ui-redesign.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sidebar column                 | The sidebar's `SidebarContent` under its 40 px header (`bundles/desktop/layout/src/client/components/organisms/project-sidebar.tsx:492`): the search field, the Thread tree, the New Thread button and the stack panes. "Column" alone means this one.                                                                                                                                                                                                                                                                                                                     |
| Files column                   | The right workspace panel that shows the Files view or the Changes view (`bundles/desktop/layout/src/client/components/organisms/project-panel.tsx:125-140`).                                                                                                                                                                                                                                                                                                                                                                                                              |
| Files column trees             | The Files view's tree (`bundles/features/files/src/client/tree/files-tree.tsx:346-361`) and the Changes view's tree (`bundles/features/git/src/client/changes/git-changes.tsx:361-377`, one `ChangesTree` per repository). Both draw `FileTree` rows (`packages/desktop/src/panels/file-tree.tsx`) inside a `ScrollArea` (`packages/desktop/src/components/scroll-area.tsx`).                                                                                                                                                                                              |
| Thread kind, kind icon         | A Thread's kind is `main` (a root Thread), `sub-thread` (a subthread the reader opened) or `sub-agent` (a subthread an agent spawned) (`bundles/desktop/layout/src/client/domain/thread-kind.ts:3-16`, `:34-37`). Its kind icon is the lucide icon for the kind: `message-circle`, `message-circle-plus`, `bot-message-square` (`thread-kind.ts:28-32`).                                                                                                                                                                                                                   |
| Untitled Thread, Untitled icon | A Thread whose `name` is the empty string; every surface shows it as "Untitled" (`bundles/desktop/layout/src/client/components/molecules/thread-branches.tsx:109`, `:201`; `bundles/desktop/layout/src/client/domain/workspace-tabs.ts:79`; `bundles/desktop/layout/src/client/hooks/thread-navigation.ts:22`). The Untitled icon is lucide `message-circle-dashed`.                                                                                                                                                                                                       |
| Prompt, execution, idle        | A prompt is one request a Thread's agent runs. Its execution runs from its `prompt.started` event to its result; U9's "turn" is an execution. A Thread is running while one of its prompts executes: `state === 'running'` with an `activePromptId` (`thread-branches.tsx:98-99`), both set together by the runner (`bundles/runtime/runtime/src/host/domain/runner.ts:494`). Otherwise it is idle.                                                                                                                                                                        |
| Thread record                  | The runtime's public `Thread` (`bundles/runtime/runtime/src/contracts/model.ts:160-194`), which the layout reads through `runtime/contracts` (`bundles/desktop/layout/src/client/domain/workspace.ts:4`). The fields this spec reads: `executionStartedAt` (`model.ts:173`), `lastExecutionMs` (`:174`) and `result` (`:180`).                                                                                                                                                                                                                                             |
| `lastStarted`                  | The host's stored record of a Thread's latest `prompt.started`: `{ promptId, at } \| null` (`bundles/runtime/runtime/src/contracts/storage.ts:112-113`). The public record derives `executionStartedAt` and `lastExecutionMs` from it (`bundles/runtime/runtime/src/host/store/threads.ts:133-149`).                                                                                                                                                                                                                                                                       |
| Busy agent terminal            | A terminal whose `origin` is `'agent'` and whose `state` is `'starting'` or `'running'` (`bundles/features/terminal/src/client/domain/terminals.ts:6-19`). A user shell (`origin: 'user'`) is never busy.                                                                                                                                                                                                                                                                                                                                                                  |
| Active row                     | A Thread row that shimmers and shows the elapsed badge (U9): its Thread is running, or a descendant Thread at any depth is running, or a busy agent terminal sits under the Thread or a descendant.                                                                                                                                                                                                                                                                                                                                                                        |
| Shimmer                        | The `shimmer` class on the row's name: a highlight that sweeps across the name's letters while the row is active (`thread-branches.tsx:198`).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Elapsed badge                  | The active row's time at its right edge, a `role="status"` element named "Agent running" (`bundles/desktop/layout/src/client/components/molecules/row-add-action.tsx:61-64`).                                                                                                                                                                                                                                                                                                                                                                                              |
| Badge start                    | The time an elapsed badge counts from: the start of the Thread's own latest execution ([§1](#1-the-badge-start)).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The plus                       | The 20 px "New sub-thread in {name}" button a Thread row shows on hover or focus when the Thread can take a subthread; it opens a draft row under the Thread (`thread-branches.tsx:108-114`, `row-add-action.tsx:80-90`).                                                                                                                                                                                                                                                                                                                                                  |
| Draft row                      | The inline name field that New Thread or the plus opens in the tree (`bundles/desktop/layout/src/client/components/molecules/draft-name.tsx`).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Lead slot                      | The 16 px box that leads a tree row and holds its 14 px icon (`thread-branches.tsx:175-196`, `file-tree.tsx:164-185`, `bundles/features/git/src/client/changes/changes-tree.tsx:130-141`).                                                                                                                                                                                                                                                                                                                                                                                 |
| Hover swap                     | Today's behavior of an expandable tree row: while hovered or focused, its lead icon hides and a chevron shows, turned down while the row is open (`thread-branches.tsx:180-192`, `file-tree.tsx:171-182`, `changes-tree.tsx:134-140`). U11 removes it.                                                                                                                                                                                                                                                                                                                     |
| Level, depth                   | `ThreadLevel` is the list of Thread nodes under one parent with its pending draft row (`bundles/desktop/layout/src/client/domain/thread-tree.ts:10-21`); `threadLevel` builds the root level of a Project (`thread-tree.ts:58-69`). Depth is a row's nesting count from 0; tree guides are numbered by level 0, 1, … from the left.                                                                                                                                                                                                                                        |
| `ThreadRows` registration      | Rows a bundle adds under each Thread of the sidebar tree, registered with `layout.sidebar/v1.addThreadRows` (`bundles/desktop/layout/src/contracts/index.ts:291-305`). It names an element `tag`, mounted under each expanded Thread with a `thread-id` attribute; `count(threadId)` above 0 makes the Thread row expandable; the owner calls the `subscribe` listener after every change of an answer. The terminal bundle registers one, which draws the terminal rows (`bundles/features/terminal/src/client/index.ts:56-82`).                                          |
| Follow a Project               | The terminal client store's `follow(projectId)` starts the Project's terminal watch (`bundles/features/terminal/src/client/store.ts:150-156`). The store holds no terminals for a Project it does not follow.                                                                                                                                                                                                                                                                                                                                                              |
| Stack pane                     | A group a bundle registers through `layout.stack` (`bundles/desktop/layout/src/contracts/index.ts:331-385`): Screens (`bundles/features/screen/src/client/index.ts:35-46`) and MCP (`bundles/features/mcp/src/client/index.ts:32-42`) today.                                                                                                                                                                                                                                                                                                                               |
| Threads pane                   | The layout's own registration in that stack (`bundles/desktop/layout/src/client/domain/sidebar-stack.ts:21-29`, registered at `bundles/desktop/layout/src/client/index.ts:91`). Its special cases in the view: the "Threads" header and "Collapse Threads" toggle drawn when another pane exists (`project-sidebar.tsx:180-205`); the `headless` case, which draws no header and keeps the pane open when it is the stack's only pane (`project-sidebar.tsx:121-139`, `:512`); and `paneAction`'s exclusion of its id (`project-sidebar.tsx:482`). This change removes it. |
| Trailing marks                 | What a Files column row shows at its right end: a file's git letter (M, A, U, D, R), a directory's change count (`file-tree.tsx:215-223`), a repository row's line totals (`changes-tree.tsx:161-168`).                                                                                                                                                                                                                                                                                                                                                                    |
| Tools named                    | Base UI 1.8.0 is the component library under `ScrollArea`. happy-dom is the DOM the unit tests run in; it computes no layout. `get_metadata` is the Figma tool that reads a node's frames and positions. Papercraft is the repository's tool that previews components in a conversation ([docs/features/papercraft.md](../features/papercraft.md)); its story files live under `.doric/`, which git ignores (`.gitignore:9`).                                                                                                                                              |

## Visual target

The reference is this text and three captures of the Figma file `ITniMiH6BnZHhuX6NkJhqP`, taken on 2026-11-10 and committed with this spec:

- `docs/designs/sidebar-alignment/sidebar-column.png` (node `266:22228`, 280×1078 including the 40 px window header).
- `docs/designs/sidebar-alignment/files-view.png` (node `266:21740`, the Files view at 328 px).
- `docs/designs/sidebar-alignment/changes-view.png` (node `266:22012`, the Changes view at 328 px).

Sidebar column, top to bottom:

- The search field "Search Threads", 268×36, 6 px from each side.
- 12 px, then the Thread tree. Rows are 28 px tall with a 16 px lead slot holding a 14 px icon. Each level indents 20 px; a vertical guide marks each ancestor level. Root rows wear their kind icon; an Untitled Thread wears the Untitled icon. Terminal rows ("npm run dev") wear the terminal icon in the same lead slot. No row shows a repository mark.
- An active row's name shimmers and its elapsed badge ("05:12") sits at the row's right edge. Its active child shows its own badge ("02:00").
- 12 px under the last row, the New Thread button: 268×28, secondary background, a 14 px plus icon and no text.
- Empty space down to the stack panes, which sit at the bottom with no dividers. Each pane header holds a chevron, the title (Screens, MCP) and the pane's plus action, which shows only while the header is hovered or focused. The capture `sidebar-column.png` draws it always shown; this spec departs from it by the user's decision on the papercraft preview (2026-11-11, U12, [§9.5](#95-follow-up-pane-rows-and-headers)), as SQ1 does for the header height. Under the last header, 14 px.
- The captures draw the pane headers 20 px tall. This spec keeps them 28 px (`h-7`), as decided in SQ1.

Files column trees (both captures): rows 28 px tall, 20 px per level with guides, folder and open-folder icons for directories, a file icon for files, the git letter or change count 8 px from the right edge in its status color, and a selected row's background spanning the row. The captures draw that background under the mark; this spec ends it where the mark begins, a trade-off the user accepted ([§10.2](#102-rows)). The captures do not show horizontal scrolling; [§10](#10-files-column-horizontal-scrolling) specifies it.

Informative only: Figma `266:22228` with its frames `266:22224` (column), `266:22226` (New Thread at y 284), `429:97567` (spacer) and `429:97568` (panes at y 984), read with `get_metadata` on 2026-11-10; and the papercraft story file `.doric/papercraft/drafts/sidebar-tree.stories.tsx`, whose `Comparison` story (variant "C") and `HoverStatesGrid` story (column "Hover · proposta (sem chevron)") the user reviewed.

## Problem

The sidebar column differs from the visual target:

- The Thread tree sits in a resizable panel group with a "Threads" header and a collapse toggle whenever another pane is registered (`project-sidebar.tsx:506-519`, `:180-205`).
- The New Thread control is a text row above the tree (`project-sidebar.tsx:246-261`, `:502-504`).
- Screens and MCP are resizable panels with handles between them (`project-sidebar.tsx:509`, `:160-178`).
- Thread rows draw a repository mark at their trailing edge (`row-add-action.tsx:74-79`) and reserve 32 px for it at rest (`thread-branches.tsx:164-168`).
- Tree levels step 12 px (`packages/desktop/src/panels/tree-guides.tsx:5`); the user chose 20 px (U6).
- Terminal rows draw their icon as a direct 16 px child of the button (`bundles/features/terminal/src/client/rows/terminal-rows.tsx:97`, sized by `[&>svg]:size-4` in `packages/desktop/src/components/sidebar.tsx:701`), while Thread rows use a lead slot.
- An Untitled Thread wears its kind icon (`bundles/desktop/layout/src/client/components/molecules/thread-mark.tsx:37-56`).
- Expandable rows have the Hover swap; the user chose to keep the lead icon (U11).
- A parent Thread shows no elapsed badge and no shimmer while its children work. When a parent spawns subthreads, its own prompt often ends before theirs: a child's result is delivered into the parent's running prompt, or queued when the parent is idle (`runner.ts:244-274`, `:997-1018`). In the second case the parent sits idle while its children run. The row reads only `executionStartedAt` (`thread-branches.tsx:218`), which the host fills only while the Thread runs (`threads.ts:133-140`).

The Files column trees cannot scroll sideways: both hosts force `overflow-x-hidden!` on the scroll viewport (`files-tree.tsx:347`, `git-changes.tsx:362`), `ScrollArea` draws only a vertical scrollbar (`scroll-area.tsx:21`), each row clips (`file-tree.tsx:205`, `changes-tree.tsx:147`) and each name truncates (`file-tree.tsx:188`, `changes-tree.tsx:142`). With 20 px steps a deep path loses most of its name.

## Goals

- G1. The sidebar column matches U1–U8, U11 and the [Visual target](#visual-target).
- G2. A Thread row is active while its subtree works (U9), counting from the badge start.
- G3. These rules are pure functions with unit tests, and the components draw what they return: `threadActivity` and `isThreadRunning` ([§2](#2-the-activity-rule)), the badge start ([§1](#1-the-badge-start)), `elapsedBadge` and `threadRowPadding` ([§4](#4-thread-rows)), `threadRowsBusy` ([§3](#3-the-busy-answer-layoutsidebarv1-110)), `isAgentBusy` ([§3](#3-the-busy-answer-layoutsidebarv1-110)), `isUntitled` ([§5](#5-the-untitled-icon)) and `indentation` ([§7](#7-tree-indentation)).
- G4. Every name in the Files column trees, including a repository row's label, can be read whole by scrolling sideways, with the trailing marks in view (U10).

## Non-goals

- Any runtime change. The Thread record already carries what the elapsed badge needs ([§1](#1-the-badge-start)).
- A "name being generated" state. New Threads are created Untitled.
- Persisting a stack pane's open state; it stays in memory (`bundles/desktop/layout/src/client/stores/stack.ts:13-25`).
- Changing `cwdRepo` (U5). It stays in the record; no sidebar surface reads it after this change.
- Changing the rows' hover background (`rowInteraction`, `tree-guides.tsx:19-22`).
- Changing what a stack pane draws inside it.

## Requirements

- **U1** — Remove the Threads pane header (label, chevron, "Collapse Threads"); Threads is no longer a collapsible pane.
- **U2** — The New Thread button moves below the Thread tree: full width, icon-only (`PlusIcon` 14 px), secondary style, `h-7`; it keeps the accessible name "New Thread" and stays disabled without a Project.
- **U3** — The search field keeps "Search Threads".
- **U4** — Stack panes (Screens, MCP) keep their header and collapse toggle, lose the `ResizableHandle` dividers and resizing, and are pinned to the bottom of the column. An open pane takes its content height up to 40% of the column and scrolls beyond; the Thread tree takes the rest and scrolls.
- **U5** — Remove the repository marks from Thread rows; the name runs to the right edge, or up to the elapsed badge. `cwdRepo` stays in the data model.
- **U6** — Tree indentation steps 20 px per level for every tree sharing `packages/desktop/src/panels/tree-guides.tsx`; guides at 14 + 20·level px.
- **U7** — Terminal rows use the Thread rows' icon pattern: a 16 px lead slot holding a 14 px icon.
- **U8** — An Untitled Thread shows the Untitled icon instead of its kind icon in the sidebar row, the breadcrumb and the tabs.
- **U9** — A Thread row shows the elapsed badge and the shimmer while the Thread runs or any descendant, at any depth, works: a running descendant Thread, or a busy agent terminal under the Thread or a descendant. User shells do not count. Agent background terminals that never end (dev servers, watchers, `timeout_ms: 0`) keep counting while they run (decision D-A, 2026-11-10). The time counts from the start of the Thread's own last execution.
- **U10** — The Files column trees scroll horizontally. The trailing marks stay pinned to the visible right edge with `position: sticky` while the tree scrolls, and a decorated row's hover and selected background ends where its mark begins, while an undecorated row's spans the row (D16). It stays in this spec by the user's decision.
- **U11** — Remove the Hover swap: on hover or focus an expandable row keeps its lead icon. Rows open and close as today, by click and keyboard. No chevron in these trees. Thread rows with children gain `aria-expanded` (SQ2); the rest of accessibility stays as it is.
- **U12** — Follow-up (user decision on the papercraft preview, 2026-11-11): Screens and MCP rows align their icons with the pane header chevrons; row actions show only on row hover or focus, over the row's right edge, without reserved space; MCP "Sign in" stays visible as a link; an empty open pane says so; a pane header's action shows only on header hover or focus ([§9.5](#95-follow-up-pane-rows-and-headers)).

Which surfaces each requirement changes:

| Requirement    | Sidebar column           | Files view     | Changes view                  | Other                                |
| -------------- | ------------------------ | -------------- | ----------------------------- | ------------------------------------ |
| U1, U2, U3, U4 | yes                      | —              | —                             | `layout.stack` contract              |
| U5, U9         | Thread rows              | —              | —                             | `layout.sidebar/v1`, terminal bundle |
| U6             | Thread and terminal rows | rows           | rows                          | skeleton rows                        |
| U7             | terminal rows            | —              | —                             | —                                    |
| U8             | Thread rows              | —              | —                             | breadcrumb, conversation tabs        |
| U10            | —                        | yes            | yes                           | `ScrollArea`                         |
| U11            | Thread rows              | directory rows | repository and directory rows | —                                    |

## Design decisions

Each decision is detailed in the section it names; they are numbered in section order.

| Id  | Decision                                                                                                                                                                                    | Section                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1  | An idle Thread's badge start is `result.at − lastExecutionMs`, derived in the client; the runtime does not change.                                                                          | [§1](#1-the-badge-start)                       |
| D2  | An active Thread with no badge start shimmers, shows no time, and keeps a hidden "Agent running" status.                                                                                    | [§1](#1-the-badge-start), [§4](#4-thread-rows) |
| D3  | One pass, `threadActivity(level, busy)`, decides which rows are active and their badge start.                                                                                               | [§2](#2-the-activity-rule)                     |
| D4  | `layout.sidebar/v1` 1.1.0 adds an optional `busy(threadId)` to `ThreadRows`; the terminal bundle answers it within a stated per-render bound.                                               | [§3](#3-the-busy-answer-layoutsidebarv1-110)   |
| D5  | A Thread row's trailing slot keeps only the elapsed badge and the plus; the name's room follows what the slot shows.                                                                        | [§4](#4-thread-rows)                           |
| D6  | The elapsed badge writes at most 8 characters: `mm:ss`, `h:mm:ss` up to 99 h, then `{d}d {h}h` up to 99 days, then `99d+`.                                                                  | [§4](#4-thread-rows)                           |
| D7  | `isUntitled(thread)` states the Untitled rule; `ThreadKindIcon` takes an `untitled` input.                                                                                                  | [§5](#5-the-untitled-icon)                     |
| D8  | The lead icon never swaps on hover or focus; the tree rows draw no chevron; a Thread row with children carries `aria-expanded`.                                                             | [§6](#6-lead-icon-without-hover-swap)          |
| D9  | The tree step becomes 20 px.                                                                                                                                                                | [§7](#7-tree-indentation)                      |
| D10 | Terminal rows draw their icon in a lead slot.                                                                                                                                               | [§8](#8-terminal-lead-slot)                    |
| D11 | The Threads pane and its special cases are removed; the tree and New Thread form the layout's own region, which keeps the button's height.                                                  | [§9.1](#91-the-thread-region)                  |
| D12 | New Thread is a secondary `sm` `Button` under the tree.                                                                                                                                     | [§9.2](#92-new-thread)                         |
| D13 | Each stack pane is a group pinned to the bottom, capped at 40% of the column on the group, shrinking to its header when space runs out.                                                     | [§9.3](#93-stack-panes)                        |
| D14 | `layout.stack/v2` replaces `layout.stack/v1`, without the size fields; the layout no longer provides v1; Screens and MCP move to v2.                                                        | [§9.4](#94-layoutstackv2)                      |
| D15 | `ScrollArea` gains `scrollbars?: 'vertical' \| 'both'`; only the two Files column hosts pass `'both'`, and their trees are as wide as their widest row.                                     | [§10.1](#101-the-scroll-container)             |
| D16 | Files column rows stop clipping and span the tree's full width; a row's background ends where its mark begins.                                                                              | [§10.2](#102-rows)                             |
| D17 | A trailing mark is the row's last flex child after the button, `sticky` at the right edge, reserving its own width and taking the hover and selected colors as the button's `peer` sibling. | [§10.3](#103-pinned-trailing-marks)            |
| D18 | Pane rows align with the header chevrons and reveal their actions on hover or focus; empty panes say so; the layout reveals a pane's `headerTag` on header hover or focus (U12).            | [§9.5](#95-follow-up-pane-rows-and-headers)    |

## Design

### 1. The badge start

The Thread record carries:

- `executionStartedAt` while the Thread runs: `lastStarted.at` when `lastStarted` names the active prompt (`threads.ts:133-140`).
- `result` (`{ status, text, promptId, at }`), the latest finished prompt's outcome.
- `lastExecutionMs = max(0, result.at − lastStarted.at)`, present exactly when `result.promptId === lastStarted.promptId` (`threads.ts:141-149`).

The rule, in `bundles/desktop/layout/src/client/domain/thread-tree.ts`:

- A running Thread's badge start is its `executionStartedAt`.
- An idle Thread's badge start is `result.at − lastExecutionMs`, as an ISO string, when `lastExecutionMs` is present and `result.at` parses. That equals `lastStarted.at`, the start of its latest execution, to the millisecond, unless the clamp at 0 applied; then it is `result.at`, later than the start by the clamped difference.
- Otherwise the Thread has no badge start.

An idle Thread has no badge start exactly when its latest result does not belong to its latest started prompt. The causes:

- It never started a prompt. Example: the reader opens a subthread inside a root Thread and prompts only the subthread; the root Thread is active through it but has no `lastStarted`.
- Its latest started prompt was paused (`prompt.paused`): the reader's Stop with `reader_stopped`, the host stopping or restarting (`host_stopped`, `host_restarted`), or low storage (`storage_low`) (`bundles/runtime/runtime/src/contracts/storage.ts:61`). A pause writes no result (`runner.ts:570-579`, `:599`, `:641`), so `lastStarted` names the paused prompt and `result` an older one. A stopped parent whose children keep working is the common case.
- Its latest result belongs to a prompt that never started: removing a queued prompt writes a `cancelled` result for it (`runner.ts:871-896`).
- A rewind moved `lastStarted` back past the latest result (`threads.ts:877-883`); rewinds run only on an idle Thread with an empty queue (`runner.ts:1026-1030`).

In each case the row shows D2's state, not a wrong time. Resuming a paused prompt publishes `prompt.resumed` and queues it again (`runner.ts:790-812`); when it runs, the runner publishes a new `prompt.started` (`runner.ts:504`), so `lastStarted` and the badge start move to the resume time.

A badge start can be days old: a root Thread idle since Monday, with a dev server its subthread's agent started, counts from Monday's start (D-A). D6 keeps that legible.

### 2. The activity rule

`bundles/desktop/layout/src/client/domain/thread-tree.ts` exports:

```ts
/** Whether the Thread's own prompt runs (`running` with an active prompt). */
export const isThreadRunning: (thread: Thread) => boolean;

/** An active row: it shimmers, and shows its elapsed time from `startedAt`. */
export type ThreadActivity = {
  /** The badge start (§1); absent, the row shows no time (D2). */
  readonly startedAt?: string;
};

/**
 * The active Threads of `level` and its descendants, by id. A Thread is active
 * while it runs, while `busy(id)` answers true for it, or while any child is
 * active. Inactive Threads have no entry.
 */
export const threadActivity: (
  level: ThreadLevel,
  busy: (threadId: string) => boolean,
) => ReadonlyMap<string, ThreadActivity>;
```

The rule:

- One pass from the leaves up. Every node is visited, and `busy` is called exactly once per Thread of the level.
- The level `threadLevel` builds holds every Thread of the Project (`thread-tree.ts:58-69`), whatever is collapsed or hidden by the search. A collapsed or filtered-out descendant still makes its ancestors active.
- Each active Thread's `startedAt` is its own badge start ([§1](#1-the-badge-start)), never a descendant's.
- The pass is linear in the Threads plus the `busy` calls. A per-row walk of `threadSubtreeIds` (`bundles/desktop/layout/src/client/domain/workspace.ts:104-123`) would be quadratic.
- `isThreadRunning` requires both `state === 'running'` and `activePromptId`, as the row does today (`thread-branches.tsx:98-99`). The runner sets both together (`runner.ts:494`); a record with one and not the other counts as idle.

`ProjectSidebar` computes the map once per render from the level it already builds, with `busy = (id) => threadRowsBusy(rows, id)`. It reads the registrations through `useThreadRows`, so a change of any registration's answers re-renders it (`bundles/desktop/layout/src/client/stores/thread-rows.ts:22-26`, `:39`). `ThreadBranches` receives the map and passes it to every level.

### 3. The busy answer: `layout.sidebar/v1` 1.1.0

"Busy" in this spec means one thing: the answer of a registration's `busy(threadId)`. The terminal bundle answers true for a Thread with a busy agent terminal directly under it. A descendant Thread's own work reaches its ancestors through `threadActivity`, never through `busy`.

`ThreadRows` (`bundles/desktop/layout/src/contracts/index.ts:291-300`) gains one optional method:

```ts
  /**
   * 1.1.0: whether work this bundle tracks directly under the Thread, not under
   * its descendants, keeps the Thread active. The layout makes the Thread and
   * every ancestor active (shimmer and elapsed badge) while it answers true.
   * The layout calls it once per Thread of the selected Project on every render
   * of the tree, drawn or not (under a collapsed row, outside a search), so it
   * must answer from memory. A throw reads as false. The owner calls the
   * `subscribe` listener after every change of any answer. Absent: never busy.
   */
  busy?(threadId: string): boolean;
```

- The validator (`isThreadRows`, `bundles/desktop/layout/src/contracts/index.ts:307-318`) accepts `busy` absent or a function and refuses anything else; its message becomes `Expected { id, tag, count, subscribe, busy? }.`.
- `bundles/desktop/layout/src/client/stores/thread-rows.ts` adds `threadRowsBusy(rows, threadId): boolean` beside `hasThreadRows`: true when any registration's `busy` answers `true`. A registration without `busy`, or whose `busy` throws, counts as false, with nothing logged: the same handling `hasThreadRows` gives a throwing `count` today (`bundles/desktop/layout/src/client/stores/thread-rows.ts:51-62`).

The terminal bundle (`registerTerminalSurfaces`, `bundles/features/terminal/src/client/index.ts:56-82`):

- Its mirror of the contract (`bundles/features/terminal/src/client/peers.ts:70-83`) gains `busy?`.
- `bundles/features/terminal/src/client/domain/terminals.ts` exports `isAgentBusy(terminal): boolean`, true when `origin === 'agent'` and `state !== 'exited'`.
- The registration adds `busy(threadId)`: true when a terminal of the Thread is agent-busy. Before answering, `busy` follows the Thread's Project, as `count` does (`index.ts:69-71`). `count` is unchanged.

Cost requirement. Resolving a Thread's Project goes through `workspace().thread()`, a cross-contract call that validates its input and its whole `Thread` output (`packages/bundle/src/runtime/dispatch.ts:177`, `:197`) and that the layout answers by scanning every Project's Threads (`bundles/desktop/layout/src/client/domain/route-selection.ts:49-58`). `count` makes that call only for drawn rows; `busy` is called for every Thread on every render. So `busy` must meet this bound:

- "The same window" is the life of one registration: from `registerTerminalSurfaces` in a renderer window until that registration is disposed (`index.ts:76-81`).
- Within it, `busy` makes at most one `workspace().thread()` call per Thread whose Project it resolved, and none for that Thread afterwards; a render after the first one for a Project makes no such call from `busy`. A call that answers no Project (the Thread not loaded yet) resolves nothing, and the next `busy` for that Thread may call again.
- A resolution is kept for the registration's life and never dropped. A Thread's Project cannot change: `runtime.threads/v1` has no method that moves a Thread to another Project (`bundles/runtime/runtime/src/contracts/threads.ts:340-495`). A deleted Thread's kept resolution is never asked for again and costs one entry; switching the selected Project drops nothing, and the earlier Project's Threads resolve without a call if it is selected again. `busy` still calls `store.follow(projectId)` on each call, which is a constant-time no-op for a followed Project (`store.ts:150-156`), so a resolution never stands in for a follow. The client never unfollows a Project today (`store.unfollow`, `store.ts:157-161`, has no caller).
- All `busy` calls of one render together take time linear in the selected Project's Threads plus the terminals the store holds. `store.threadTerminals(threadId)` scans every terminal the store holds on each call (`store.ts:163-164`), so calling it once per Thread does not meet the bound.

How the registration meets the bound is left to the plan.

The never-followed Project: today the terminal bundle follows a Project only from `count`, which the layout calls only for drawn rows (`thread-branches.tsx:96`, `:100`, `:222`). `busy` is called for every Thread of the selected Project, so the first render of a Project with at least one Thread follows it. Until the first snapshot arrives, `busy` answers false; the snapshot calls the store's listeners (`store.ts:98-101`, `:110-115`), and the layout re-renders and recomputes the map. `store.follow` is idempotent (`store.ts:150-156`) and its subscription asynchronous (`bundles/features/terminal/src/client/output-watch.ts:60-63`), so a follow during render updates no store synchronously.

Agent background terminals: the terminal tool lets an agent start a command in the background with no timeout (`timeout_ms: 0`; `bundles/features/terminal/src/host/tool.ts:34`, `:152-155`); the host then sets no timer (`bundles/features/terminal/src/host/registry.ts:127`, `:141-146`). Such a terminal stays `running` until it exits or is closed, and keeps its Thread and every ancestor active for that time (U9, D-A).

A layout 1.0.0 never calls `busy`, and its validator ignores the extra field (`index.ts:307-318`). The terminal bundle therefore keeps requiring `layout.sidebar/v1@^1.0.0`; with an older layout, agent terminals do not make rows active.

### 4. Thread rows

- No repository mark. `RepoMark` (`thread-mark.tsx:58-85`), `ThreadIconKind` and `threadIconKind` (`bundles/desktop/layout/src/client/domain/sidebar.ts:4-22`), and the `repo` prop of `ThreadBranches` and `RowAddAction` are removed. Their only callers are the sidebar and the `ThreadBranches` story.
- The name's room follows one rule, `threadRowPadding(timed, addable): string` in `bundles/desktop/layout/src/client/domain/sidebar.ts`, which replaces `running ? 'pr-16' : 'pr-8'` (`thread-branches.tsx:165`). `timed` is true when the row is active with a badge start; `addable` when the row has the plus. The button's right padding:

  | Row                                                              | At rest         | Hovered or focused                                                                   |
  | ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
  | timed, with the plus                                             | 56 px (`pr-14`) | 56 px; the elapsed badge hides and the plus shows                                    |
  | timed, without the plus                                          | 56 px (`pr-14`) | 56 px; the elapsed badge stays                                                       |
  | not timed (idle, or active without a badge start), with the plus | 6 px (`pr-1.5`) | 32 px (`group-hover/tree-row:pr-8 group-focus-within/tree-row:pr-8`); the plus shows |
  | not timed, without the plus                                      | 6 px (`pr-1.5`) | 6 px                                                                                 |

  The function returns those classes: `'pr-14'`; `'pr-14'`; `'pr-1.5 group-hover/tree-row:pr-8 group-focus-within/tree-row:pr-8'`; `'pr-1.5'`. The 56 px already covers the 20 px plus at `right-1`, so a timed row does not re-truncate on hover.

- On a row with the plus, hover or focus hides the elapsed badge (`group-hover/tree-row:opacity-0`, `group-focus-within/tree-row:opacity-0`) and shows the plus, as today (`row-add-action.tsx:35-36`, `:49-51`). The hidden status of D2 has no visible box and is not faded.
- An active row's name shimmers. With a badge start, its elapsed badge counts from it and sits at the row's right edge (`right-1`). Without one (D2), the row keeps the `role="status"` element named "Agent running", visually hidden (`sr-only`) and with no text, so assistive technology still reads the row as active. `RowAddAction` takes `active: boolean` and `startedAt?: string` for this.
- The label "Agent running" stays for a row active through a descendant: an agent works in its subtree.
- The "Last execution" tooltip line keeps showing only while the Thread itself is not running (`thread-branches.tsx:121-128`), with `duration` unchanged.

The elapsed text (D6). `bundles/desktop/layout/src/client/utility/duration.ts` keeps `duration` (`duration.ts:2-7`) unchanged and adds `elapsedBadge(milliseconds): string`, composed on it: below 100 h it returns `duration(milliseconds)`; from 100 h it writes the day tiers. `useExecutionTime` (`bundles/desktop/layout/src/client/hooks/use-execution-time.ts:15`) uses `elapsedBadge` instead of `duration`; the "Last execution" tooltip keeps `duration`.

| Elapsed                 | Text                                                            | Example            |
| ----------------------- | --------------------------------------------------------------- | ------------------ |
| under 1 h               | `duration`: `mm:ss`                                             | `05:12`            |
| 1 h to under 100 h      | `duration`: `h:mm:ss`, hours unpadded                           | `99:59:59`         |
| 100 h to under 100 days | `{d}d {h}h`, whole days and the remaining whole hours, unpadded | `4d 4h`, `99d 23h` |
| 100 days and more       | `99d+`                                                          | `99d+`             |

A negative elapsed time (a clock behind the host's) reads as `00:00`, as `duration` does today (`duration.ts:3`). The widest text is 8 characters (`99:59:59`); `99d 23h` replaces two colons with a space and two letters among `tabular-nums` digits, so it is not wider in practice. The 1:1 verification checks both against the 56 px reserve.

### 5. The Untitled icon

- `bundles/desktop/layout/src/client/domain/thread-kind.ts` exports `isUntitled(thread): boolean`, true when `thread.name === ''`. `threadKindIcon` (`thread-kind.ts:28-32`) is unchanged.
- `ThreadKindIcon` (`thread-mark.tsx:37-56`) keeps its name and `kind` input and gains `untitled?: boolean` (default `false`). When true it draws lucide `MessageCircleDashedIcon` (lucide-react 0.544.0, installed) instead of the kind icon.
- The sidebar row, the breadcrumb (`bundles/desktop/layout/src/client/components/molecules/thread-breadcrumb.tsx:49-51`) and a conversation tab (`bundles/desktop/layout/src/client/components/organisms/workspace-tabs.tsx:183-188`) pass `untitled={isUntitled(thread)}`. A tab whose Thread is missing from the tree keeps the `main` kind icon.
- The row's tooltip stays the kind's hint (`threadKindHint`).

### 6. Lead icon without hover swap

U11, for the three trees that swap today:

- Thread rows: the lead slot holds only `ThreadKindIcon`, as on a non-expandable row (`thread-branches.tsx:193-195`).
- `FileTree`: a directory's lead slot holds only `FolderOpenIcon` while open and `FolderIcon` while closed; a file's holds `FileIcon` as today.
- The Changes view's repository row: its lead slot holds only `GitBranchIcon`.

`ChevronRightIcon` is no longer imported by `thread-branches.tsx`, `file-tree.tsx` or `changes-tree.tsx`. Opening and closing do not change: click on a selected Thread row, click on a directory or repository row, Enter and Space, and ArrowRight and ArrowLeft where the row handles them today (`file-tree.tsx:148-160`, `changes-tree.tsx:114-126`, `thread-branches.tsx:153-159`). `aria-expanded` stays on directory and repository rows (`file-tree.tsx:136`, `changes-tree.tsx:111`).

Thread rows carry no `aria-expanded` today (`thread-branches.tsx:148-160`). By the user's answer to SQ2, the `role="treeitem"` element of a Thread row with children gets it: `true` while open, `false` while closed. "With children" is the row's existing `expandable`: child Threads, or rows a `ThreadRows` registration counts under it (`thread-branches.tsx:100`). "Open" is the existing `expanded`, which also counts a search that opens the row (`thread-branches.tsx:101-104`). A row without children has no `aria-expanded` attribute.

The stack panes' collapse chevron is a header control, not a tree row, and stays.

### 7. Tree indentation

The step of `packages/desktop/src/panels/tree-guides.tsx` becomes 1.25 rem (`tree-guides.tsx:5`): `indentation(depth)` is 6 + 20·depth px and the guides sit at 14 + 20·level px. Every caller takes the step unchanged: the file tree, the tree skeleton, Thread rows, the draft row, terminal rows, the Changes repository row and the stories. No caller computes its own step; the other `0.75rem` values in the repository are a markdown quote style (`bundles/desktop/chat/src/client/components/organisms/conversation/plugins/markdown-prompt.tsx:47`) and the draft row's fallback for a depthless draft (`draft-name.tsx:37`), both unrelated to the step.

### 8. Terminal lead slot

A terminal row's `TerminalIcon`, and the one in its rename field, sits in a `<span aria-hidden data-slot="terminal-lead">` with the Thread lead slot's size (16 px box, 14 px icon) and the color the button gave its direct `svg` (`[&>svg]:text-sidebar-accent-foreground`, `sidebar.tsx:701`). The layout's story mirror (`bundles/desktop/layout/stories/support/terminal-rows.tsx`) does the same.

### 9. The sidebar column

#### 9.1 The Thread region

- `threadsPane`, `THREADS_PANE_ID`, `PANE_HEADER` and `paneExpanded` are deleted from `sidebar-stack.ts`, which keeps `orderedPanes`. The layout no longer registers a Threads pane, so `panes()` lists only the panes bundles register. No bundle reads `panes()` or the `threads` id.
- The column holds, top to bottom: the search field; the Thread region (`data-slot="thread-region"`); then each stack pane.
- The Thread region is a column of two items: the tree scroller (`data-slot="thread-tree"`) and the New Thread button, 12 px apart.
  - The scroller holds, top to bottom: the `model.error` alert when there is one (`project-sidebar.tsx:428-434`), the loading skeleton rows while loading (`:438-446`), the Thread rows, and the "No threads match" notice when a search matches nothing (`:467-474`). The alert scrolls with the rows, as today.
  - The scroller is as tall as its content, shrinks when the region is shorter, and scrolls vertically beyond.
  - The button follows the scroller, so it sits under whichever of those items is last.
  - The button never shrinks.
  - The region takes the free height of the column, which pins the panes to the bottom. Its minimum height is the button plus the gap (40 px, `min-h-10`), so the button never overlaps a pane header.
- Gaps follow the visual target: 12 px search → tree, 12 px tree → button, 14 px under the last pane. Rows keep their 6 px inset inside the scroller, so their 2 px focus ring is not clipped.
- `SidebarContent` stays `overflow-visible`, so the search field's 3 px focus ring can draw into the header (`project-sidebar.tsx:488-492`). `Sidebar` keeps `overflow-hidden` (`project-sidebar.tsx:487`), which clips the column at the window's bottom ([SR2](#risks)).
- The resizable panel group, its handles, `PanePanel` and its `headless` case go.

#### 9.2 New Thread

A `Button` from `desktop/ui/button`, `variant="secondary"`, `size="sm"` (`h-7`, 14 px icon, `packages/desktop/src/components/button.tsx:14-15`, `:28`), full width, holding only `PlusIcon`. Its accessible name is "New Thread" (`aria-label`); it is disabled while no Project is selected; pressing it opens the root draft row at the end of the tree, as today.

#### 9.3 Stack panes

Each registered pane is a `SidebarGroup` (`data-slot="sidebar-pane"`, `data-pane-id`) under the Thread region:

- Its header is today's: 28 px (`h-7`), the title, the toggle button with `aria-expanded` and the name "Collapse {title}" / "Expand {title}", and the pane's `headerTag` action, which the layout hides until the header is hovered or holds focus ([§9.5](#95-follow-up-pane-rows-and-headers)). A pane that cannot collapse draws no toggle and is always open.
- The group itself carries the cap: `max-h-[40%]`, `min-h-7`, a column of the header (never shrinking) and, while open, the content (the pane's `tag` element), which shrinks with the group and scrolls vertically (`min-h-0 overflow-y-auto`). A closed pane is its header.
- Height order when the column is short: the Thread region gives up its free height first (it has no basis, only its 40 px minimum); then the open panes shrink toward their headers.
- The 40% resolves against the column's height, which is definite all the way up:
  - the workspace root is `h-svh` (`bundles/desktop/layout/src/client/views/workspace-view.tsx:240`);
  - `SidebarProvider`, `Tabs` and the workspace layout are `flex-1` items of definite column flex containers (`workspace-view.tsx:244`, `:251`; `bundles/desktop/layout/src/client/components/templates/workspace-layout.tsx:85-91`);
  - the sidebar's `ResizablePanel` is stretched across a horizontal panel group (`workspace-layout.tsx:89-100`);
  - `Sidebar` is `flex h-full flex-col` of that panel (`sidebar.tsx:191`);
  - the column is its `flex-1 min-h-0` item (`sidebar.tsx:393`).

  A flex item stretched or flexed in a container of definite size has a definite size (CSS Flexbox §9.8), so the group's percentage resolves.

- The open state stays the stack store's (`bundles/desktop/layout/src/client/stores/stack.ts`), driven by the toggle and by the contract's `setOpen` and `toggle`.

#### 9.4 `layout.stack/v2`

Ignoring `defaultSize`, `minSize` and `maxSize` changes what `layout.stack/v1` does, so by `docs/architecture/bundles/versioning.md:49` ("outra semântica") it is a new major (decision D-B).

- `layout.stack/v2` (2.0.0), in `bundles/desktop/layout/src/contracts/index.ts`, keeps v1's exported names for the pane, the service and their schemas: `StackPane`, `LayoutStack`, `stackPaneSchema` and `layoutStackMethods` (`contracts/index.ts:331-410`) are edited in place. `StackPane` loses `defaultSize`, `minSize` and `maxSize`, and the strict `stackPaneSchema` then refuses them. The methods are unchanged (`register`, `panes`, `isOpen`, `setOpen`, `toggle`, `subscribe`). The comments state the drawing of [§9.3](#93-stack-panes): one group per pane under the Thread region, pinned to the bottom, no resizing, an open pane up to 40% of the column. The only renamed export is the reference: `LayoutStackV1` (`contracts/index.ts:420`) becomes `LayoutStackV2 = ref<LayoutStack>('layout.stack/v2')`. Files that import only the types (`bundles/desktop/layout/src/client/hooks/use-stack-panes.ts:3`, `bundles/desktop/layout/stories/support/layout-host.tsx:32`) do not change.
- The layout stops providing `layout.stack/v1` (user decision, 2026-11-10); no v1 alias remains. `versioning.md:60` lets a superseded major be provided until it is removed, and this change removes it in the same release, as the layout did with `layout.panel/v1` when it added `layout.panel/v2` (`bundles/desktop/layout/tests/tabs-menus.test.ts:214-222`).
- The layout bundle provides `layout.stack/v2@2.0.0` and no `layout.stack/v1`. A provided contract changes major and another disappears, so the bundle's version moves to the next major (`versioning.md:57`).
- Screens and MCP move to v2: their peer mirrors drop the size fields from `StackPane` (`bundles/features/screen/src/client/peers.ts:59-63`, `bundles/features/mcp/src/client/peers.ts:42-44`) and define `LayoutStackV2` in place of `LayoutStackV1` (`bundles/features/screen/src/client/peers.ts:66-71`, `bundles/features/mcp/src/client/peers.ts:47-52`), they register through `whenAvailable(LayoutStackV2, …)` (`bundles/features/screen/src/client/index.ts:59`, the same in MCP), their panes lose `minSize` and `maxSize` (`bundles/features/screen/src/client/index.ts:43-44`, `bundles/features/mcp/src/client/index.ts:40-41`), and their `requires` entry `layout.stack/v1@^1.0.0` becomes `layout.stack/v2@^2.0.0` (`bundles/features/screen/manifest.json:13`, `bundles/features/mcp/manifest.json:20`). Each bundle's version takes a patch: no contract it provides changes (`versioning.md:57`).
- Compatibility. A bundle's `requires` ranges are checked against the active providers, and a bundle whose range no provider meets is quarantined with the reason (`versioning.md:37-39`; example 2, `:65`; example 3's last sentence, `:66`: "quem só pede `v1` entra em quarentena com motivo").
  - A bundle outside this repository that still requires `layout.stack/v1` is quarantined on a layout 3.0.0, and its pane does not show, until it moves to v2.
  - The planned Ports pane is written against v1 (`docs/architecture/bundles/port-forwarding.md:103`, `:172`); that document moves to v2 ([Docs to update](#docs-to-update)).
  - A new Screens or MCP on a layout older than 3.0.0 is quarantined for the same reason, the other way round.
  - `versioning.md:33` covers bundles and the app shipping apart, and bundles adapting to the app's platform version; it does not cover two bundles at different versions, which is the `requires` check above.

#### 9.5 Follow-up: pane rows and headers

Source: the user's decision on the papercraft preview in conversation (2026-11-11), U12 and D18. It changes no contract.

- Screens and MCP rows align their icons with the pane header chevrons (row `pl-1.5` inside the content's `px-1.5`); the label and status run to the right edge.
- Row actions (remove; Screens' retry, left of remove on a failed row) show only while the row is hovered or holds focus, laid over the row's right edge with no space reserved; the row's status fades out while they show.
- MCP "Sign in" stays visible as an underlined link with an external-link icon and the title "Sign in (opens in your browser)"; while the row is hovered or holds focus it shifts left to make room for remove.
- An open pane with no rows shows "No screens open" (only with a Project selected) or "No MCP servers" (only once the servers are loaded and without a load failure, which shows its alert instead).
- The layout hides every pane's `headerTag` element until the header is hovered or holds focus, as a Thread row's actions are.
- Versions: layout 3.0.1, screen 2.0.2, mcp 1.2.3 (patch).

### 10. Files column: horizontal scrolling

`ProjectPanel` needs no change: it clips (`project-panel.tsx:126`), but each host's `ScrollArea` viewport scrolls inside it, and that viewport is the scroll container for this section.

#### 10.1 The scroll container

- `ScrollArea` gains `scrollbars?: 'vertical' | 'both'`, default `'vertical'`, which renders what it renders today. With `'both'` it also renders a horizontal `ScrollBar` after the vertical one. Base UI mounts a scrollbar only while its axis overflows (`node_modules/@base-ui/react/scroll-area/scrollbar/ScrollAreaScrollbar.mjs:27`, `:58-60`), and the existing `ScrollBar` styles cover the horizontal case (`scroll-area.tsx:38`). The prop is not passed on to the root element.
- The Files view and the Changes view pass `scrollbars="both"`, drop `overflow-x-hidden!` from their viewport, and make their tree (`role="tree"`) as wide as its widest row and never narrower than the viewport (`w-max min-w-full`). The tree keeps its 4 px padding (`px-1`, `files-tree.tsx:348`, `git-changes.tsx:363`).
- An older platform passes the unknown prop through to the root `div` as an inert `scrollbars` attribute ([SR14](#risks)).

#### 10.2 Rows

In `FileTree` and in the Changes repository row:

- The row wrapper becomes a flex row that no longer clips (`file-tree.tsx:205`, `changes-tree.tsx:147` lose `overflow-hidden`).
- Both nested groups add `overflow-visible` over `treeClassName`, which carries `overflow-hidden` (`tree-guides.tsx:8-9`): `FileTree`'s directory level (`file-tree.tsx:226`) and the Changes view's repository group (`SidebarMenuSub role="group"`, `changes-tree.tsx:171`), which holds the repository's `FileTree`. Without the second, every mark under a repository row would be clipped and would not pin. `treeClassName` itself is unchanged, because the Thread tree shares it.
- Every row is as wide as the tree. The button takes the row's width minus its mark ([§10.3](#103-pinned-trailing-marks)): it grows to fill the row (`flex-1`) and may shrink (`min-w-0`); `w-auto` overrides the menu button's `w-full`, so the mark keeps its room.
- Accepted trade-off (user decision, 2026-11-10): the hover and selected background is the button's, so on a decorated row it ends where the mark begins instead of running under the mark. An undecorated row's background spans the row.
- The button's right padding is 6 px (`pr-1.5`) on every row, which keeps the name 6 px from the mark. The fixed `pr-8` that reserved room for an absolute mark (`file-tree.tsx:127-128`, `changes-tree.tsx:103`) goes: the mark now takes its own width in the row, so line totals of any width, such as `+1204 −387`, push the tree wider instead of covering the label (G4).
- A name's full text counts toward the tree's width, so names no longer show an ellipsis in these trees; the path tooltip stays.
- Tree guides stay inside each row and scroll with it, at 14 + 20·level px from the row's left edge.
- The pending-entry row and the empty-directory notice take the tree's width with no change.

#### 10.3 Pinned trailing marks

Today a mark is `SidebarMenuBadge` (`absolute right-1`, `sidebar.tsx:611`) inside the row wrapper. The wrapper's right edge is the tree's content edge, 4 px inside the viewport (the tree's `px-1`), so the mark's right edge sits 8 px from the viewport's right edge. In a row as wide as the scrolled tree, that place can be off screen.

The mark becomes the row wrapper's last flex child, after the button: `<span aria-hidden data-slot="tree-row-mark">`, `position: sticky` with `right: 0.25rem`, `shrink-0`, with 4 px of right padding (`pr-1`) and the badge inside it. It is in the flow, so it reserves its own width.

- Horizontal position. The mark's place in the flow is the row's end, which is the tree's content edge, 4 px inside the viewport (the tree's `px-1`) when the row's end is visible. While the row's end lies beyond the viewport, `sticky` holds the mark's right edge 4 px inside the viewport's right edge; sticky never moves it out of its row, so it is never right of the row's end. The badge ends at the mark's 4 px right padding. In both cases the badge's right edge sits 4 + 4 = 8 px from the visible right edge, as today.
- Vertical position. The wrapper centers its children (`items-center`), so the 20 px badge sits 4 px from the top of the 28 px row, as today. The mark is a plain `span`, not `SidebarMenuBadge`: that component's `peer-data-[size=*]/menu-button:top-*` classes (`sidebar.tsx:611`) would match, because the mark is the button's later sibling, and on a sticky element `top` is a vertical sticky offset that would pin the mark to the top of the viewport.
- Colors. The mark is the button's later sibling (`peer/menu-button` is on the button, `sidebar.tsx:497`), so it carries the badge's text colors directly: `text-sidebar-foreground`, `peer-hover/menu-button:text-sidebar-accent-foreground` and `peer-data-active/menu-button:text-sidebar-accent-foreground`. A toned letter or count keeps its own color from its inner span, as today.
- The badge keeps today's look: `h-5 min-w-5 rounded-md px-1 text-xs tabular-nums`, `pointer-events-none select-none`, and the translucent background (`bg-sidebar/90`) over the name it covers while pinned.
- `sticky` resolves against the nearest scrolling ancestor, the viewport. Every element between the mark and the viewport (row wrapper, list item, nested level, tree) is `overflow: visible` after [§10.2](#102-rows).
- The markup is written in `file-tree.tsx` and in `changes-tree.tsx`, not exported, so `git` imports nothing an older platform lacks.

Keyboard focus. Tab moves focus between rows and the browser scrolls the focused row into view. In Chromium, and so in Electron 44.4.3 (`package.json:52`), `Element::focus` scrolls with "center if needed" alignment, except that horizontally a partially visible element is not scrolled (`align_x->rect_partial = kNoScroll`). The source comment names the case: list items that overflow horizontally should not cause horizontal changes (`third_party/blink/renderer/core/dom/element.cc`, `Element::focus`, Chromium `main`, read 2026-11-10). An element is scrolled horizontally only when it is entirely outside the viewport (`third_party/blink/renderer/core/scroll/scroll_into_view_util.cc`, `CalculateScrollAlignment`). The focused element is the row's button, which spans the tree's width minus its mark and the mark's 8 px from the edge. At any horizontal offset part of it is in the viewport, as long as the viewport is wider than the widest mark plus 8 px, so Tab never changes `scrollLeft`. Vertically, a row out of view is centered and a partly visible one is brought to the nearest edge, as today. Neither tree scrolls rows into view in code.

## Flows

**A parent waits for its children.** The reader prompts root Thread P at t0; P's row counts from `executionStartedAt` = t0. P spawns subthread C and its prompt ends at t1: P's record has `result.at` = t1 and `lastExecutionMs` = t1 − t0, so P's badge start stays t0. C runs: `threadActivity` marks C (from C's `executionStartedAt`) and P (from t0). C finishes; its result is queued into P (`runner.ts:244-274`). P starts again at t2 and counts from t2. When P ends and no descendant works, P has no entry and the badge and shimmer go.

**The reader stops the parent.** The reader stops P while C runs, and the stop pauses P's prompt: no result is written, so P keeps its shimmer and its hidden "Agent running" status and shows no time (D2). When the reader resumes P, its prompt starts again and P counts from the resume.

**An agent terminal outlives its prompt.** Agent subthread A starts a dev server in the background with `timeout_ms: 0`, and its prompt ends. The terminal store applies the update and notifies; the layout re-renders; `busy(A)` answers true; A and every ancestor are active, each counting from its own badge start. Days later the badge reads `3d 4h`. When the server exits, `busy(A)` turns false.

**A collapsed subtree.** The reader collapses P. Its rows are not drawn, so `count` is not called for them; `busy` still is, and P stays active while a hidden descendant works.

**A deep file.** The Files view shows a file eight levels down. The tree grows wider than the column and a horizontal scrollbar appears. The reader scrolls right and reads the whole name while its letter stays 8 px from the visible right edge.

## Contracts and versions

Versions below assume the phases land in order 1–4, then the follow-up of [§9.5](#95-follow-up-pane-rows-and-headers), written §9.5 in the Phase column. A phase that lands out of order bumps each bundle it touches from the version on `main` by the level stated in the "Why" column.

| Contract or bundle  | Phase | Before | After   | Why                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout` bundle     | 1     | 2.0.0  | 2.0.1   | Visual changes; no contract changes (`versioning.md:57`, patch).                                                                                                                                                                                                                                         |
| `terminal` bundle   | 1     | 1.1.0  | 1.1.1   | Row markup only.                                                                                                                                                                                                                                                                                         |
| `git` bundle        | 1     | 1.2.0  | 1.2.1   | Row markup only.                                                                                                                                                                                                                                                                                         |
| `layout.sidebar/v1` | 2     | 1.0.0  | 1.1.0   | New optional input method `busy` (`versioning.md:48`).                                                                                                                                                                                                                                                   |
| `layout` bundle     | 2     | 2.0.1  | 2.1.0   | A provided contract gains a minor (`versioning.md:57`).                                                                                                                                                                                                                                                  |
| `terminal` bundle   | 2     | 1.1.1  | 1.1.2   | Registers `busy`; no provided contract changes. `requires` keeps `layout.sidebar/v1@^1.0.0`.                                                                                                                                                                                                             |
| `layout.stack/v2`   | 3     | —      | 2.0.0   | Other semantics and removed fields (`versioning.md:49`).                                                                                                                                                                                                                                                 |
| `layout.stack/v1`   | 3     | 1.0.0  | removed | No longer provided; no alias ([§9.4](#94-layoutstackv2)).                                                                                                                                                                                                                                                |
| `layout` bundle     | 3     | 2.1.0  | 3.0.0   | A provided contract changes major and another disappears (`versioning.md:57`).                                                                                                                                                                                                                           |
| `screen` bundle     | 3     | 2.0.0  | 2.0.1   | `requires` moves to `layout.stack/v2@^2.0.0`; no provided contract changes.                                                                                                                                                                                                                              |
| `mcp` bundle        | 3     | 1.2.1  | 1.2.2   | The same.                                                                                                                                                                                                                                                                                                |
| `PLATFORM_VERSION`  | 4     | 1.5.0  | 1.6.0   | `ScrollArea` gains a prop; the platform moves a minor per addition (`versioning.md:31`, `packages/bundle/src/runtime/version.ts:1-10`). `PLATFORM_ASSETS_VERSION` stays 1.0.0. Bundles keep `engines.doric` at `^1.0.0`: they adapt to an older or newer app (`docs/features/ui-redesign.md:151`, UR25). |
| `files` bundle      | 4     | 1.7.0  | 1.7.1   | Host classes only.                                                                                                                                                                                                                                                                                       |
| `git` bundle        | 4     | 1.2.1  | 1.2.2   | Row markup and host classes only.                                                                                                                                                                                                                                                                        |
| `layout` bundle     | §9.5  | 3.0.0  | 3.0.1   | Pane header plus on hover or focus only; no contract change (patch).                                                                                                                                                                                                                                     |
| `screen` bundle     | §9.5  | 2.0.1  | 2.0.2   | Row alignment and hover actions; no contract change (patch).                                                                                                                                                                                                                                             |
| `mcp` bundle        | §9.5  | 1.2.2  | 1.2.3   | The same.                                                                                                                                                                                                                                                                                                |

The runtime and its contracts do not change.

## Persisted data

None new. The stack's open state stays in memory.

## Alternatives considered

- **A host field `lastExecutionStartedAt` (versions 1 and 2).** Rejected in version 3: the record already yields the start as `result.at − lastExecutionMs`. The cases it does not cover ([§1](#1-the-badge-start)) show no time rather than a wrong one, and recover at the next start. The field would have cost two runtime contract minors, a runtime release, a parity-test change and a README paragraph.
- **A host-side "working subtree" flag on each Thread.** Rejected: the host would write and publish every ancestor on each child or terminal change, and the renderer already holds every Thread of the selected Project and its terminals.
- **Counting a parent's badge from its earliest active descendant.** Rejected by U9.
- **Excluding background terminals with no timeout, or capping a badge at some age.** Rejected by D-A.
- **Resolving the Project inside `busy` with a cross-contract call on every call, as `count` does today.** Rejected by the cost requirement of [§3](#3-the-busy-answer-layoutsidebarv1-110): one call with validation and a linear lookup per Thread per render.
- **Calling `count` for every Thread to force the Project follow.** Rejected: `count` decides whether a row is expandable (`thread-branches.tsx:100`); `busy` carries its own follow.
- **A separate contract for activity (for example `layout.activity/v1`).** Rejected: one optional method on the existing registration reuses its subscription and is a minor.
- **Keeping the Threads pane as a headless, non-collapsible registration.** Rejected: `panes()` would keep listing a group the column no longer draws, and the view would keep its special cases.
- **`layout.stack/v1` 1.0.1 with the size fields ignored (versions 1–3).** Rejected by D-B: other semantics are a major (`versioning.md:49`).
- **Keeping `layout.stack/v1` as a deprecated alias over v2's store (version 4).** Rejected by the user (2026-11-10): v1's resizing could not be kept, so the alias would still change what v1 does, and every first-party consumer moves to v2 in the same phase.
- **A measured cap (ResizeObserver) for the 40% height.** Rejected: `max-height` in percent of the definite column does it in CSS.
- **Renaming `ThreadKindIcon` to `ThreadIcon` with an icon-name input (versions 1 and 2).** Rejected in version 3: an `untitled` input on the existing component does it without a rename.
- **A horizontal scrollbar on every `ScrollArea` (version 2).** Rejected in version 3: the conversation's viewport does not hide horizontal overflow (`bundles/desktop/chat/src/client/styles.css:108-110`), so wide content would gain a visible bar; the branch picker (`bundles/features/git/src/client/cwd/branch-picker.tsx:67`) and the binary-file notice (`bundles/features/files/src/client/file/file-view.tsx:147`) would also change without a requirement. The prop limits it to the two trees.
- **The mark inside the button, sticky there.** Rejected: the button clips (`overflow-hidden`, `sidebar.tsx:497`), which would make it the sticky element's scroll container.
- **A fixed right padding sized for the widest mark.** Rejected: line totals have no fixed width.
- **A zero-width sticky anchor at the row's end holding an absolutely positioned mark, with a hidden copy of the mark in the button to reserve its width (version 4).** Rejected by the user (2026-11-10): it let the background run under the mark, at the cost of an extra element per row and a duplicated mark; the in-flow sticky mark is simpler, and the background ending at the mark is accepted.
- **Removing the tree's 4 px padding, or adding `scroll-padding`, to steer focus scrolling.** Not needed: Chromium does not scroll a partially visible element horizontally on focus ([§10.3](#103-pinned-trailing-marks)).
- **An exported `TreeRowMark` component.** Rejected: an import an older platform lacks fails the bundle; the mark is written once in each of the two files.
- **Truncating names and showing the whole path in the tooltip only.** Rejected by U10.
- **Removing `overflow-hidden` from `treeClassName`.** Rejected: the Thread tree shares it and is not part of U10.
- **Keeping `pr-8` at rest on Thread rows with the plus.** Rejected by U5; the cost is a re-truncation on hover ([SR8](#risks)).

## Risks

- **SR1 — The 40% cap.** If the column's height were not definite, `max-h-[40%]` would not apply and an open pane would grow to its content, leaving the tree no height. Mitigation: [§9.3](#93-stack-panes) traces the chain to `h-svh`; happy-dom computes no layout, so the [1:1 verification](#11-verification) measures it.
- **SR2 — Short windows.** Let H be the column's height. The search block takes 48 px (36 + 12), the bottom padding 14 px, the Thread region's button and gap 40 px. With both panes open at their cap (0.4·H each), the tree's height is H − 48 − 0.8·H − 40 − 14 = 0.2·H − 102 px: zero at H = 510 px, one 28 px row at H = 650 px, about 105 px (3 rows) at the captured H = 1038 px. With one pane open at its cap and the other closed (28 px), it is 0.6·H − 130 px. Below 158 px (48 + 40 + two 28 px headers + 14) the column overflows and `Sidebar` clips its bottom. Accepted: U4 fixed the cap; the reader collapses a pane.
- **SR3 — Cost of `busy`.** `busy` is called for every Thread on every render, and resolving a Thread's Project crosses a contract. Mitigation: the bound of [§3](#3-the-busy-answer-layoutsidebarv1-110) (no repeated cross-contract call per Thread; linear time per render), which the plan meets and the review of the implementation checks. Measurement trigger: if a sidebar render with 500 Threads and 100 terminals takes more than 16 ms in a profile, the mechanism is revisited.
- **SR4 — Side effect during render.** `busy`, like `count` today, may start a Project follow during the layout's render. The subscription is asynchronous, so no store updates synchronously inside render.
- **SR5 — No time in edge cases.** An idle active Thread without a badge start ([§1](#1-the-badge-start)) shows the shimmer and no time until its next start. The hidden status keeps "Agent running" for assistive technology. Accepted: no wrong time is shown.
- **SR6 — Mixed sidebar versions.** A terminal bundle on a `layout.sidebar/v1` 1.0.0 gets no `busy` calls; a layout 2.1.0 with a terminal bundle without `busy` gets no answers. In both, rows are active only through running Threads, never through agent terminals; nothing else changes.
- **SR7 — Long-lived activity.** An agent background terminal with no timeout keeps its Thread and ancestors active until it exits, for days if it runs that long (D-A). The badge stays within 8 characters (D6).
- **SR8 — Hover re-truncation.** A long Thread name on a row with the plus re-truncates while the row is hovered or focused. Accepted (U5).
- **SR9 — Lost open-state cue on hover.** Without the Hover swap, an expandable row shows no open or closed cue on hover; the visible children under an open row remain the cue, and every expandable row of the three trees exposes `aria-expanded`. Accepted (U11).
- **SR10 — Long names widen the tree.** One very long name makes every row of that Files column tree as wide; the reader scrolls to read it. Accepted (U10).
- **SR11 — Sticky depends on unclipped ancestors.** Any `overflow` other than `visible` added later between the mark and the viewport stops the pinning. Mitigation: T-4.1 asserts the `FileTree` wrapper and directory level, T-4.4 the repository row's wrapper and group, and T-4.5 and T-4.6 the two trees and viewports.
- **SR12 — Focus scrolling.** The no-horizontal-scroll behavior rests on Chromium's focus rule ([§10.3](#103-pinned-trailing-marks)). A future Chromium that scrolled partially visible elements would move `scrollLeft` by up to 4 px on Tab. Mitigation: the 1:1 verification checks it on each Electron upgrade that touches this view.
- **SR13 — Security.** No new data crosses a boundary. `busy` runs in the renderer with a Thread id, and a throw is contained. No new permission, IPC or storage path.
- **SR14 — Mixed platform and bundle versions in the Files column.** A new `files` or `git` on an older platform: the tree is as wide as its widest row, but the old `ScrollArea` draws no horizontal scrollbar. A trackpad or Shift+wheel scrolls sideways, because the viewport scrolls on both axes (`node_modules/@base-ui/react/scroll-area/viewport/ScrollAreaViewport.mjs:279`); a mouse-only reader without Shift+wheel cannot. The old `FileTree` keeps its clipped rows with marks at their far end. An old host on the new platform keeps `overflow-x-hidden!` and a tree as wide as the viewport: rows look and behave as today.
- **SR15 — Removed `layout.stack/v1`.** On a layout 3.0.0, any bundle that still requires `layout.stack/v1` is quarantined with the unmet range as its reason, and its pane does not show; in this repository none remains after phase 3, and the planned Ports pane's document moves to v2. A new Screens or MCP on a layout older than 3.0.0 is quarantined the same way ([§9.4](#94-layoutstackv2)). Accepted (user decision, 2026-11-10).

## Phases

Each phase leaves `nx run-many -t lint typecheck test` green for the projects it touches, and updates the manifest tests for the versions it moves.

1. **Shared visuals.** [§5](#5-the-untitled-icon)–[§8](#8-terminal-lead-slot): Untitled icon, no Hover swap and `aria-expanded` on Thread rows, 20 px steps, terminal lead slot.
2. **Activity and rows.** [§1](#1-the-badge-start)–[§4](#4-thread-rows): badge start, activity rule, `layout.sidebar/v1` 1.1.0 and the terminal's `busy`, elapsed text, repository marks removed.
3. **Column.** [§9](#9-the-sidebar-column): Threads pane removed, New Thread under the tree, panes pinned without resizing, `layout.stack/v2`, Screens and MCP migrated.
4. **Files column scrolling.** [§10](#10-files-column-horizontal-scrolling): `ScrollArea` prop and `PLATFORM_VERSION` 1.6.0, `FileTree` rows and their sticky marks, the two hosts and the repository row. It depends on no other phase.

Follow-up ([§9.5](#95-follow-up-pane-rows-and-headers)): pane rows, empty notices and the header reveal, after phase 3.

## Files to change

### Phase 1

- `packages/desktop/src/panels/tree-guides.tsx`
- `packages/desktop/src/panels/file-tree.tsx`
- `bundles/features/terminal/src/client/rows/terminal-rows.tsx`
- `bundles/features/terminal/manifest.json`
- `bundles/features/git/src/client/changes/changes-tree.tsx`
- `bundles/features/git/manifest.json`
- `bundles/desktop/layout/src/client/domain/thread-kind.ts`
- `bundles/desktop/layout/src/client/components/molecules/thread-mark.tsx`
- `bundles/desktop/layout/src/client/components/molecules/thread-branches.tsx`
- `bundles/desktop/layout/src/client/components/molecules/thread-breadcrumb.tsx`
- `bundles/desktop/layout/src/client/components/organisms/workspace-tabs.tsx`
- `bundles/desktop/layout/manifest.json`
- `bundles/desktop/layout/stories/support/terminal-rows.tsx`
- Tests: `packages/desktop/tests/tree-guides.test.ts`, `packages/desktop/tests/panels.test.ts`, `bundles/features/terminal/tests/client/render.test.ts`, `bundles/features/terminal/tests/manifest.test.ts`, `bundles/features/git/tests/changes-tree.test.ts`, `bundles/features/git/tests/manifest.test.ts`, `bundles/desktop/layout/tests/thread-kind.test.ts`, `bundles/desktop/layout/tests/client/thread-rows.test.ts`, `bundles/desktop/layout/tests/client/shell.test.ts`, `bundles/desktop/layout/tests/tabs-menus.test.ts`.

### Phase 2

- `bundles/desktop/layout/src/contracts/index.ts` (`ThreadRows.busy`, validator)
- `bundles/desktop/layout/src/client/stores/thread-rows.ts`
- `bundles/desktop/layout/src/client/domain/thread-tree.ts`
- `bundles/desktop/layout/src/client/domain/sidebar.ts` (removals)
- `bundles/desktop/layout/src/client/utility/duration.ts`
- `bundles/desktop/layout/src/client/hooks/use-execution-time.ts`
- `bundles/desktop/layout/src/client/components/molecules/thread-mark.tsx`
- `bundles/desktop/layout/src/client/components/molecules/row-add-action.tsx`
- `bundles/desktop/layout/stories/components/molecules/row-add-action.stories.tsx` (its `Idle`, `Running` and `LongRun` stories pass the new `active`)
- `bundles/desktop/layout/src/client/components/molecules/thread-branches.tsx`
- `bundles/desktop/layout/src/client/components/organisms/project-sidebar.tsx`
- `bundles/desktop/layout/manifest.json` (`layout.sidebar/v1@1.1.0`, version)
- `bundles/desktop/layout/stories/components/molecules/thread-branches.stories.tsx`
- `bundles/desktop/layout/stories/support/fake-host.ts` (fixture `terminalBusy?: readonly string[]`, the Thread ids with a busy agent terminal)
- `bundles/desktop/layout/stories/support/layout-host.tsx` (`busy` from that fixture)
- `bundles/desktop/layout/stories/support/data.ts` (a parent with a `result` and `lastExecutionMs`)
- `bundles/features/terminal/src/client/peers.ts`
- `bundles/features/terminal/src/client/domain/terminals.ts`
- `bundles/features/terminal/src/client/index.ts`
- `bundles/features/terminal/manifest.json`
- Tests: `bundles/desktop/layout/tests/thread-tree.test.ts`, `bundles/desktop/layout/tests/duration.test.ts`, `bundles/desktop/layout/tests/sidebar-service.test.ts`, `bundles/desktop/layout/tests/sidebar.test.ts` (the `threadIconKind` cases go), `bundles/desktop/layout/tests/client/thread-rows.test.ts`, `bundles/desktop/layout/tests/tabs-menus.test.ts`, `bundles/features/terminal/tests/manifest.test.ts`, new `bundles/features/terminal/tests/client/sidebar-rows.test.ts`.

### Phase 3

- `bundles/desktop/layout/src/client/components/organisms/project-sidebar.tsx`
- `bundles/desktop/layout/src/client/domain/sidebar-stack.ts`
- `bundles/desktop/layout/src/client/index.ts`
- `bundles/desktop/layout/src/contracts/index.ts` (`layout.stack/v2` replaces v1)
- `bundles/desktop/layout/src/client/services/layout-stack.ts` (provides v2)
- `bundles/desktop/layout/src/client/stores/stack.ts` (header comment `:1-2`: `layout.stack/v2`, no Threads pane)
- `bundles/desktop/layout/manifest.json` (`layout.stack/v2@2.0.0`, no `layout.stack/v1`, version 3.0.0)
- `bundles/desktop/layout/stories/support/fake-host.ts` (`screenPane`, `:164-174`, loses `minSize` and `maxSize`; it is used by `bundles/desktop/layout/stories/support/layout-host.tsx:33`, `:161`, `bundles/desktop/layout/tests/client/search.test.ts:431` and `bundles/desktop/layout/stories/components/organisms/project-sidebar.stories.tsx:18`)
- `bundles/desktop/layout/stories/components/organisms/project-sidebar.stories.tsx` (its stories follow the pinned panes)
- Comments only, naming `layout.stack/v1`, the Threads pane or resizing: `bundles/desktop/layout/src/client/services/layout-stack.ts:1-4`, `bundles/desktop/layout/src/client/domain/sidebar-stack.ts:1-4`, `bundles/desktop/layout/src/client/components/organisms/project-sidebar.tsx:115`
- `bundles/features/screen/src/client/peers.ts` (`:59-63` size fields, `:66-71` reference), `bundles/features/screen/src/client/index.ts` (`:30-33` comment, `:43-44`, `:59`), `bundles/features/screen/src/client/elements.tsx:1-5` (comment), `bundles/features/screen/manifest.json`
- `bundles/features/mcp/src/client/peers.ts` (`:42-44` size fields, `:47-52` reference), `bundles/features/mcp/src/client/index.ts` (`:2` comment, `:40-41`, `:55`), `bundles/features/mcp/src/client/elements.tsx:1-5` (comment), `bundles/features/mcp/manifest.json`
- Tests: `bundles/desktop/layout/tests/sidebar-stack.test.ts` (the Threads pane and `paneExpanded` cases go), `bundles/desktop/layout/tests/stack-store.test.ts` (`:29` loses `minSize`), new `bundles/desktop/layout/tests/stack-service.test.ts`, `bundles/desktop/layout/tests/client/search.test.ts`, `bundles/desktop/layout/tests/client/shell.test.ts`, `bundles/desktop/layout/tests/tabs-menus.test.ts`, `bundles/features/screen/tests/client/sidebar.test.ts` (comment `:6`), `bundles/features/mcp/tests/client/sidebar.test.ts` (`:358` fake contract id, `:975-978`).

### Follow-up (§9.5)

- `bundles/desktop/layout/src/client/components/organisms/project-sidebar.tsx` (header action revealed on hover or focus)
- `bundles/desktop/layout/src/contracts/index.ts` (comment only), `bundles/desktop/layout/manifest.json` (3.0.1)
- `bundles/features/screen/src/client/elements.tsx`, `bundles/features/screen/manifest.json` (2.0.2)
- `bundles/features/mcp/src/client/elements.tsx`, `bundles/features/mcp/manifest.json` (1.2.3)
- Tests: `bundles/desktop/layout/tests/client/shell.test.ts`, `bundles/desktop/layout/tests/tabs-menus.test.ts`, `bundles/features/screen/tests/client/sidebar.test.ts`, `bundles/features/mcp/tests/client/sidebar.test.ts`.

### Phase 4

- `packages/desktop/src/components/scroll-area.tsx`
- `packages/desktop/PROVENANCE.md` and `packages/desktop/scripts/verify-provenance.mjs` (the vendored files' recorded patches)
- `packages/desktop/src/panels/file-tree.tsx`
- `packages/bundle/src/runtime/version.ts` (1.6.0 and its comment)
- `bundles/features/files/src/client/tree/files-tree.tsx`
- `bundles/features/files/manifest.json`
- `bundles/features/git/src/client/changes/git-changes.tsx`
- `bundles/features/git/src/client/changes/changes-tree.tsx`
- `bundles/features/git/manifest.json`
- Tests: `packages/desktop/tests/panels.test.ts`, new `packages/desktop/tests/scroll-area.test.ts`, `packages/bundle/tests/platform-version.test.ts`, `bundles/features/files/tests/client/render.test.ts`, `bundles/features/files/tests/manifest.test.ts`, `bundles/features/git/tests/changes-tree.test.ts`, `bundles/features/git/tests/client/render.test.ts`, `bundles/features/git/tests/manifest.test.ts`.

## Test plan

Tests go through public exports and rendered markup, as the existing suites do. happy-dom computes no layout, so geometry is read from the classes that draw it (`bundles/desktop/layout/tests/client/thread-rows.test.ts:11-12`).

### Phase 1 tests

- **T-1.1** (`packages/desktop/tests/tree-guides.test.ts`) — `indentation` gives 6, 26 and 66 px at depths 0, 1 and 3; `TreeGuides` at depth 3 draws guides at 14, 34 and 54 px.
- **T-1.2** (`bundles/features/terminal/tests/client/render.test.ts`) — Every terminal row's button holds one `[data-slot="terminal-lead"]` of 16 px (`size-4`) with one `svg.lucide-terminal` in it, and no `svg` as its own direct child.
- **T-1.3** (`bundles/desktop/layout/tests/thread-kind.test.ts`) — `isUntitled` is true for `''` and false for any other name, including the literal `'Untitled'`. The `threadKindIcon` table test is unchanged.
- **T-1.4** (`bundles/desktop/layout/tests/client/thread-rows.test.ts`) — An Untitled row's lead slot holds `svg.lucide-message-circle-dashed` and no kind icon; a named row's holds no Untitled icon.
- **T-1.5** (`bundles/desktop/layout/tests/client/shell.test.ts`) — With an Untitled Thread selected, the breadcrumb's last crumb holds `svg.lucide-message-circle-dashed`; a conversation tab of that Thread holds it in its trigger; a tab of a Thread missing from the tree keeps `svg.lucide-message-circle`.
- **T-1.6** (U11; `bundles/desktop/layout/tests/client/thread-rows.test.ts`, replacing the two Hover swap cases) — The lead slot of every Thread row, open, closed or not expandable, holds exactly one `svg`: its kind icon, with no `hidden`, `group-hover/tree-row:*` or `group-focus-within/tree-row:*` class; no tree row draws `svg.lucide-chevron-right`. Selecting an expandable row and activating it again still collapses it.
- **T-1.7** (U11; `packages/desktop/tests/panels.test.ts`, replacing the two directory swap cases) — A closed directory's lead slot holds only `svg.lucide-folder`, an open one's only `svg.lucide-folder-open`, neither with a hover or focus class; no row draws `svg.lucide-chevron-right`; directory rows keep `aria-expanded` `false` and `true`.
- **T-1.8** (U11; `bundles/features/git/tests/changes-tree.test.ts`, replacing the two repository swap cases) — The repository row's lead slot holds only `svg.lucide-git-branch` while closed and while open, with no hover or focus class, and keeps `aria-expanded`.
- **T-1.9** (SQ2; `bundles/desktop/layout/tests/client/thread-rows.test.ts`) — A Thread row with a child Thread has `aria-expanded="true"` on its `[role="treeitem"]` while open and `"false"` after it is collapsed; a row whose only children are registered rows (a fixture with a terminal under the Thread) has it too; a row with no children has no `aria-expanded` attribute.
- **T-1.10** (versions) — `bundles/desktop/layout/tests/tabs-menus.test.ts` asserts layout 2.0.1; `bundles/features/terminal/tests/manifest.test.ts` terminal 1.1.1; `bundles/features/git/tests/manifest.test.ts` git 1.2.1.

### Phase 2 tests

- **T-2.1** (`bundles/desktop/layout/tests/thread-tree.test.ts`) — An idle tree with `busy` always false gives an empty map.
- **T-2.2** (`bundles/desktop/layout/tests/thread-tree.test.ts`) — A running grandchild G of child C of root R marks G, C and R; R's idle sibling has no entry. G's `startedAt` is its `executionStartedAt`. C, idle with `result.at` = t1 and `lastExecutionMs` = 90 000, has `startedAt` = t1 − 90 s.
- **T-2.3** (`bundles/desktop/layout/tests/thread-tree.test.ts`) — `busy` true for an idle leaf marks the leaf and every ancestor. With `busy` false everywhere, a record in `state: 'running'` without `activePromptId` marks nothing (`isThreadRunning` false).
- **T-2.4** (`bundles/desktop/layout/tests/thread-tree.test.ts`) — An active idle Thread with no `result`, and one with a `result` but no `lastExecutionMs` (a paused latest prompt), each get an entry with no `startedAt` (D2).
- **T-2.5** (`bundles/desktop/layout/tests/thread-tree.test.ts`) — `busy` is called exactly once per Thread of the level, including Threads under a node the caller draws collapsed.
- **T-2.6** (`bundles/desktop/layout/tests/sidebar-service.test.ts`) — `addThreadRows` accepts a registration with a `busy` function and one without, and refuses `busy: 1` with the validator's message. `threadRowsBusy` is false with no `busy`, false when `busy` throws, and true when any registration answers true; a throw is not logged.
- **T-2.7** (`bundles/desktop/layout/tests/client/thread-rows.test.ts`, rendered workspace) — With Plan idle (`result.at` one minute ago, `lastExecutionMs` four minutes) and its child Form running, Plan's row has one `[role="status"]` named "Agent running" whose text starts `05:`, and Plan's name has the class `shimmer`; Audit, idle with nothing under it, has neither. A fixture with `terminalBusy: [validate.id]` and nothing running marks Validate, Form and Plan; after collapsing Plan, Plan stays active. A Plan with no `lastExecutionMs` and a running child has the `shimmer` class and one `[role="status"]` named "Agent running" with the class `sr-only` and no text.
- **T-2.8** (`bundles/desktop/layout/tests/client/thread-rows.test.ts`, replacing the two repository-mark cases) — No row draws `span[title="Git repository"]` or `span[title="GitHub repository"]` though Threads have `cwdRepo`; the elapsed badge sits at the row's right edge (`right-1`). Each row's button carries `threadRowPadding`'s classes for its state: a timed row with the plus has `pr-14`, and its elapsed badge has `group-hover/tree-row:opacity-0` and `group-focus-within/tree-row:opacity-0` while the plus has `group-hover/tree-row:opacity-100`; an idle row with the plus has `pr-1.5` and `group-hover/tree-row:pr-8`; an active row without a badge start has `pr-1.5`; no row has `pr-16` or `pr-8` at rest.
- **T-2.9** (`bundles/desktop/layout/tests/duration.test.ts`) — `elapsedBadge` gives `00:00` for −5 s and 0; `05:12`; `1:00:00` at 1 h; `99:59:59` just under 100 h; `4d 4h` at 100 h; `99d 23h` just under 100 days; `99d+` at 100 days and at 400 days. Below 100 h, `elapsedBadge(ms)` equals `duration(ms)` for 0, 59 s, 1 h and 99 h 59 min 59 s. `duration` keeps its cases.
- **T-2.10** (new `bundles/features/terminal/tests/client/sidebar-rows.test.ts`) — `registerTerminalSurfaces` with fakes for the regions, the sidebar (capturing the registration), the store and `workspace().thread`: `busy` is true for a Thread whose terminal is agent and `running` or `starting`, false for agent `exited` and for user `running`; the first `busy` call follows the Thread's Project when `count` was never called; `subscribe` passes the store's listener through. With five Threads of one Project, a first round of `busy` for each makes at most five calls to the fake `workspace().thread`, and a second round makes none; a Thread for which the fake first answers `undefined` is asked again on the next call. After the store reports the agent terminal exited, `busy` answers false for its Thread; after it reports a new agent terminal starting under another Thread, `busy` answers true for that one. `count` keeps its answers.
- **T-2.11** (versions) — `bundles/desktop/layout/tests/tabs-menus.test.ts` asserts layout 2.1.0 providing `layout.sidebar/v1@1.1.0`; `bundles/features/terminal/tests/manifest.test.ts` terminal 1.1.2 requiring `layout.sidebar/v1@^1.0.0`.
- **T-2.12** (`bundles/desktop/layout/tests/sidebar.test.ts`) — `threadRowPadding` returns `'pr-14'` for (timed, with the plus) and (timed, without), `'pr-1.5 group-hover/tree-row:pr-8 group-focus-within/tree-row:pr-8'` for (not timed, with the plus) and `'pr-1.5'` for (not timed, without).

### Phase 3 tests

- **T-3.1** (`bundles/desktop/layout/tests/client/search.test.ts`, rewriting the Threads-header case) — With no registered pane and with the Screens pane, no button is named "Collapse Threads" or "Expand Threads"; with the Screens pane, one is named "Expand Screens".
- **T-3.2** (`bundles/desktop/layout/tests/client/shell.test.ts`, replacing "the Threads pane header has no New thread control") — The button named "New Thread" follows every `[role="treeitem"]`, has no text content, holds one `svg.lucide-plus`, and is full width and secondary (`w-full`, `bg-secondary`); every `[data-slot="sidebar-pane"]` follows it. Inside `[data-slot="thread-tree"]`, the error alert comes before the rows; while loading, the skeleton rows are there; with a query that matches nothing, `[data-threads-empty]` is its last child and the New Thread button follows the scroller.
- **T-3.3** (`bundles/desktop/layout/tests/client/shell.test.ts`) — The sidebar holds no `[data-slot="resizable-handle"]` and no `[data-slot="resizable-panel-group"]`.
- **T-3.4** (`bundles/desktop/layout/tests/client/shell.test.ts`) — Each `[data-slot="sidebar-pane"]` has `max-h-[40%]` and `min-h-7`; once expanded, its content has `min-h-0` and `overflow-y-auto`. `[data-slot="thread-region"]` has `flex-1` and `min-h-10`; `[data-slot="thread-tree"]` has `min-h-0` and `overflow-y-auto`; the New Thread button has `shrink-0`.
- **T-3.5** (`bundles/desktop/layout/tests/client/shell.test.ts`) — "Collapse Screens" removes the Screens content and keeps its header; "Expand Screens" brings it back. After activation, `layout.stack/v2.panes()` lists only the fixture's panes, with no `threads` id.
- **T-3.6** (new `bundles/desktop/layout/tests/stack-service.test.ts`) — Through `createTestServices({ bundle: { id: 'screen' }, provide: [createLayoutStack()] })` and `services.use(LayoutStackV2)`, as `bundles/desktop/layout/tests/sidebar-service.test.ts:39-48` does for the sidebar: `register` with `minSize`, with `maxSize` and with `defaultSize` each throws a `ContractError` with code `invalid_input`, because the strict `stackPaneSchema` (`contracts/index.ts:387-401`) runs at dispatch (`packages/bundle/src/runtime/dispatch.ts:177`); the store itself checks no schema (`stores/stack.ts:30-43`). `register` without them succeeds, and `setOpen` and `toggle` change `isOpen`.
- **T-3.7** (`bundles/features/screen/tests/client/sidebar.test.ts`, `bundles/features/mcp/tests/client/sidebar.test.ts:975-978`) — Each bundle registers its pane through `layout.stack/v2`, without `minSize` or `maxSize`.
- **T-3.8** (versions) — `bundles/desktop/layout/tests/tabs-menus.test.ts` asserts layout 3.0.1 (3.0.0 at phase 3) providing `layout.stack/v2@2.0.0` and no `layout.stack/v1`; the Screens and MCP sidebar tests read their manifests and assert screen 2.0.2 and mcp 1.2.3 (2.0.1 and 1.2.2 at phase 3), each requiring `layout.stack/v2@^2.0.0` and not `layout.stack/v1`.
- **T-3.9** (unchanged, still passing) — `bundles/desktop/layout/tests/client/shell.test.ts`: New Thread opens the draft row at the end of the tree, stays disabled without a Project and clears a query; Screens sits below the tree. `bundles/desktop/layout/tests/stack-store.test.ts`: the existing cases.

### Follow-up tests (§9.5)

- **T-F.1** (`bundles/desktop/layout/tests/client/shell.test.ts`) — A pane header reveals its action only while it is hovered or holds focus.
- **T-F.2** (`bundles/features/screen/tests/client/sidebar.test.ts`) — A view row's icon sits on the chevron column and its label runs to the right edge; a ready row's Remove is laid over the right edge on hover or focus; a failed row's Retry sits left of Remove, revealed with it; the status fades out while the actions show; Remove and Retry act on the row's view; an open pane with no views for the Project says "No screens open", and not once one is open.
- **T-F.3** (`bundles/features/mcp/tests/client/sidebar.test.ts`) — Every row's Remove is laid over its right edge on hover or focus and its status fades out; Sign in reads as a link that stays shown and steps left of Remove on hover; the pane is loading, not empty, until the watch answers, then says "No MCP servers"; a failed watch shows its alert, not the notice; the loading placeholders sit on the rows' icon column.
- **T-F.4** (versions) — covered by T-3.8.

### Phase 4 tests

- **T-4.1** (`packages/desktop/tests/panels.test.ts`) — In a rendered `FileTree`, each decorated row has a `[data-slot="tree-row-mark"]` as the last child of its `group/tree-row` wrapper, right after the button, with `sticky`, `right-1`, `shrink-0`, `pr-1`, `text-sidebar-foreground`, `peer-hover/menu-button:text-sidebar-accent-foreground` and `peer-data-active/menu-button:text-sidebar-accent-foreground`, and with no `absolute`, `w-0` or `top-*` class; it holds the letter or count. An undecorated row has none. Every wrapper is a flex row with `items-center` and without `overflow-hidden`; an open directory's `[role="group"]` has `overflow-visible`. The existing badge, description and strike cases keep passing.
- **T-4.2** (`packages/desktop/tests/panels.test.ts`) — Every row's button has `flex-1`, `min-w-0` and `pr-1.5`, and no `pr-8`.
- **T-4.3** (new `packages/desktop/tests/scroll-area.test.ts`) — `ScrollArea` without `scrollbars` and with `scrollbars="both"` renders its children in `[data-slot="scroll-area-viewport"]`, and neither puts a `scrollbars` attribute on `[data-slot="scroll-area"]`. Whether the horizontal bar mounts depends on measured overflow, which happy-dom lacks (T-4.8).
- **T-4.4** (`bundles/features/git/tests/changes-tree.test.ts`) — The repository row's line totals sit in a `[data-slot="tree-row-mark"]`, the wrapper's last child after the button, with `sticky`, `right-1` and `shrink-0`; its button has `flex-1`, `min-w-0` and `pr-1.5`, and no `pr-8`; its wrapper is a flex row without `overflow-hidden`. Once open, the repository's `[role="group"]` (`changes-tree.tsx:171`) has `overflow-visible`, and a file mark inside it is a `[data-slot="tree-row-mark"]` with `sticky`.
- **T-4.5** (`bundles/features/files/tests/client/render.test.ts`) — The Files view's `[role="tree"]` has `w-max` and `min-w-full`, and its `[data-slot="scroll-area"]` class has no `overflow-x-hidden`.
- **T-4.6** (`bundles/features/git/tests/client/render.test.ts`) — The Changes view's tree has `w-max` and `min-w-full`, and its viewport no `overflow-x-hidden`.
- **T-4.7** (versions) — `packages/bundle/tests/platform-version.test.ts` asserts `PLATFORM_VERSION` 1.6.0; `bundles/features/files/tests/manifest.test.ts` files 1.7.1 (1.6.1 before rebasing onto main's files 1.7.0); `bundles/features/git/tests/manifest.test.ts` git 1.2.2.
- **T-4.8** — Not unit-tested: whether the horizontal scrollbar appears, the marks stay pinned while scrolling, and Tab keeps `scrollLeft`. The [1:1 verification](#11-verification) covers them.

## 1:1 verification

In the running app, against the [Visual target](#visual-target):

- Sidebar column: 12 px from the search field to the first row, 12 px from the last row to New Thread, 14 px under the last pane header; New Thread 268×28 at x 6; each pane header 28 px tall.
- Three levels of Threads and terminals: icons at 6, 26 and 46 px from the row's left edge, guides at 14 and 34 px.
- Hovering and focusing an open and a closed Thread, directory and repository row: the lead icon stays.
- MCP with enough servers to pass 40% of the column: the pane stops at 40% and scrolls; the tree scrolls in the rest (SR1). With the window shortened until the Thread region reaches 40 px, New Thread stays above the pane headers and does not overlap them (SR2).
- A root Thread whose agent spawned a subagent: the parent's badge keeps counting from its own last start while the child runs, and moves when the parent wakes. Stopping the parent while the child runs leaves its shimmer and no time.
- Thread rows with the elapsed badge forced to `99:59:59` and to `99d 23h` (by a story fixture): neither badge overlaps the name's last visible letter.
- Files and Changes at the default 328 px column with a changed file eight directories deep and a repository with line totals over four digits each:
  - a horizontal scrollbar appears;
  - scrolled fully right, every name and the repository label read whole and end at least 6 px before their mark;
  - while scrolling, letters, counts and totals stay 8 px from the visible right edge, in the hover and selected colors on hovered and selected rows, vertically centered;
  - on a decorated row the hover and selected background ends 6 px or less before the mark's left edge and does not run under the mark; on an undecorated row it reaches the tree's right end;
  - Tab and Shift+Tab between rows, at scroll offsets 0, the middle and the end, leave `scrollLeft` unchanged (SR12).
- Files and Changes with no overflow: no horizontal scrollbar; each mark's right edge 8 px from the viewport's right edge and its top 4 px below its row's top, as in `files-view.png` and `changes-view.png`.
- The conversation, the branch picker and the binary-file notice show no horizontal scrollbar.

## Docs to update

- `docs/features/ui-redesign.md`:
  - Terms "Pane" (`:41`: `layout.stack/v2`, pinned to the bottom, no resizing) and "Resizable handle" (`:72`, no longer in the sidebar column).
  - Shape of the target shell (`:201`: New Thread under the tree, no Threads header).
  - Current behavior (`:379`): 20 px steps; the lead icon no longer swaps for a chevron; Thread rows with children expose `aria-expanded`; the Files and Changes trees scroll sideways with their marks pinned; the activity rule, the elapsed text and the Untitled icon.
  - Evolution: one dated entry linking this spec, noting that U11 replaces the phase 2 decision S25 (`:394`).
- `docs/architecture/bundles/layout.md:18`, `:59`: panes of `layout.stack/v2` pinned under the tree with no resizing, and `layout.stack/v1` no longer provided; `layout.sidebar/v1`'s `busy`.
- `bundles/desktop/layout/README.md:21`, `:91-92`: `addThreadRows` with `count` and `busy`; `layout.stack/v2` without size limits, replacing `layout.stack/v1`.
- `bundles/features/terminal/README.md:67-68`: the rows answer `busy` for agent terminals.
- `bundles/features/mcp/README.md:44`: `layout.stack/v2`; the always-visible "Sign in" row link and "No MCP servers" (§9.5).
- `bundles/features/screen/README.md`: hover- or focus-only row actions and header "+", and "No screens open" (§9.5).
- `bundles/desktop/layout/src/contracts/index.ts` (`layout.stack/v2` comment): the `headerTag` reveal (§9.5).
- `docs/features/ui-redesign.md` and `GROUNDING.md`: the follow-up of §9.5.
- `docs/architecture/bundles/port-forwarding.md:103`, `:172`: the planned Ports pane registers through `layout.stack/v2` without `minSize`.
- `GROUNDING.md`: the sidebar's panes and handle, the activity rule and the Untitled icon, the Files column's sideways scrolling, and the contract history.
- `packages/desktop/PROVENANCE.md` and `packages/desktop/scripts/verify-provenance.mjs`: the recorded patches of the vendored files this change edits.
- Not changed: `docs/designs/ui-redesign.md` (the record of that change as built), `docs/architecture/bundles/implementation-decisions.md` (history), and `bundles/runtime/runtime/README.md` (no runtime change).

## Deferred to the plan

The stage 4 review's Nits, left to the plan by the user's decision (2026-11-10). All are resolved (2026-11-10): U10's wording and SR6's "layout 1.0.0" are fixed in this spec; the others were resolved in the plan's "Deferred nits, resolved" table.

- T-1.1 should assert the rem values `indentation` returns (`0.375rem`, `1.625rem`, `4.125rem`), not px.
- U10's "background spans the full scrolled width" reads against D16 (the background ends at the mark); align the wording.
- Name and type the `ThreadBranches` prop that carries the activity map.
- SR6's "layout 1.0.0" means `layout.sidebar/v1` 1.0.0.
- T-1.2 does not cover the rename field's `TerminalIcon` lead slot (§8).
- G3 lists `isAgentBusy`, which has no unit test of its own.
- `useThreadRows` lives in `bundles/desktop/layout/src/client/hooks/use-thread-rows.ts`.
- Place the 14 px bottom spacing (on `SidebarContent` or the last pane).
- §1: `executionStartedAt` falls back to `updatedAt` when `lastStarted` names another prompt (`threads.ts:134-139`).
- Docs to update are not assigned to phases.
- §3 and SR4: cite the follow's other effects (`output-watch.ts:155-160`, a toast during render).
- The breadcrumb shows an empty label for an Untitled Thread (`thread-breadcrumb.tsx:118`, `:131`).
- §4 misses a caller of `threadIconKind`: `bundles/desktop/layout/tests/sidebar.test.ts:25`, `:195-203`.
- §7 misses other `0.75rem` uses (chat styles; papercraft `styles.css:17`).
- §2: `threadLevel` excludes orphan Threads.
- Line ranges to correct: `workspace.ts:105-125`, `contracts/index.ts:331-420`, `bundles/features/screen/src/client/index.ts:35-45`.
- §10.2: unselected rows have no hover background (`rowInteraction(false)` is `hover:bg-transparent`, `tree-guides.tsx:19-22`), and the repository row is always unselected (`changes-tree.tsx:104`).
- §9.3: the height chain passes through react-resizable-panels' inner `div`.

## Open questions

None. Closed:

- **SQ1 — Pane header height.** Closed (2026-11-10, the user): the Screens and MCP pane headers stay 28 px (`h-7`). The captures draw them 20 px; Figma is being updated to match, and this spec's text is the reference.
- **SQ2 — `aria-expanded` on Thread rows.** Closed (2026-11-10, the user): Thread rows with children get `aria-expanded`, `true` while open and `false` while closed; rows without children have none ([§6](#6-lead-icon-without-hover-swap), T-1.9).

## Revisions

- **Version 1** (2026-11-10): written from U1–U9, the papercraft preview and Figma `266:22228`.
- **Version 2** (2026-11-10): the user's requirement U10.
- **Version 3** (2026-11-10): the first review of version 2, and the user's requirement U11.
  - The host field `lastExecutionStartedAt` was withdrawn; an idle Thread's badge start is derived as `result.at − lastExecutionMs`.
  - U10 stays in this spec by the user's decision; its phase depends on no other.
  - `ScrollArea` gained the `scrollbars` prop instead of a horizontal bar everywhere; `PLATFORM_VERSION` 1.6.0.
  - Design kept contracts, rules, data flow and observable behavior; helper bodies, local variables, class lists that no test reads, import lists, and line numbers of code the spec does not describe were left to the plan.
  - `ThreadKindIcon` kept its name and gained `untitled`.
  - U11: no Hover swap. SQ1 closed: pane headers stay 28 px. SQ2 closed: `aria-expanded` on Thread rows with children (T-1.9).
- **Version 4** (2026-11-10): the stage 2 review of version 3 (Comprehension, Critique, Structural and Style), and the user's decisions D-A, D-B and D-C.
  - Visual target (D-C, M1, Y1): a new section describes the target in text and references the captures `docs/designs/sidebar-alignment/{sidebar-column,files-view,changes-view}.png` (Figma, 2026-11-10); Figma and the papercraft preview are informative.
  - C1: §1 lists pauses (`prompt.paused`, no result) among the cases without a badge start, states the condition exactly (the latest result belongs to the latest started prompt), and says that resuming publishes a new `prompt.started`.
  - C2 (D-A): U9 keeps agent background terminals with no timeout counting; D6 and `elapsedBadge` bound the text to 8 characters past 99:59:59; SR7, a flow and T-2.9.
  - C3: the terminal registration resolves each Thread's Project once and answers `count` and `busy` from a per-snapshot index; SR3 states the cost; T-2.10 pins it.
  - C4: the anchor carries the badge's hover and selected colors as the button's `peer` sibling; the mark sets `top-1` itself; T-4.1 asserts both.
  - C5 (CONTEST): Chromium's focus scrolling does not scroll a partially visible element horizontally, so Tab keeps `scrollLeft`; §10.3 cites the source; SR12 and the verification check it.
  - C6: a hidden copy of the mark reserves its exact width in the button, replacing `pr-8`; T-4.2 and T-4.4.
  - C7: the 40% cap sits on the pane group, with the definite-height chain traced to `h-svh`; T-3.4 matches.
  - C8: the Thread region has a 40 px minimum and the button never shrinks; panes shrink to their headers after the region; T-3.4.
  - C9 (D-B): `layout.stack/v2`; v1 kept as a deprecated alias over the same store; Screens and MCP migrate; layout 3.0.0; T-3.6–T-3.8.
  - Critique nits: SR2 derived; SR14 names mouse-only readers; D2 keeps a hidden status; a throwing `busy` is logged once per registration.
  - Comprehension: Terms point to `docs/features/ui-redesign.md:28-44` and add the user and reader, prompt, execution and idle, Thread record, `lastStarted`, `ThreadRows`, follow, shimmer, the plus, draft row, level, the Threads pane's special cases, sidebar column and Files column, and the tools named. "Busy" means only a registration's answer. "Root Thread" replaces "main Thread"; the visual "draft" is now the papercraft preview.
  - Structural: every path from the repository root; each phase tests its own version moves (T-1.10, T-2.11, T-3.8, T-4.7); decisions renumbered D1–D17 in section order; sections Goals, Non-goals, Requirements, Design decisions and Open questions; every test names its file.
  - Style: one term each for badge start, elapsed badge and kind icon; a table maps requirements to surfaces; G3 lists its functions; vague phrases and outcomes replaced with observable ones; review labels from earlier versions replaced with what changed.
  - Risks renumbered SR1–SR15; tests renumbered.
- **Version 5** (2026-11-10): the stage 3 Scope review of version 4, with the user's decisions on M1 and M3.
  - M1 (user decision): the layout no longer provides `layout.stack/v1`, with no alias; Screens and MCP move to v2. [§9.4](#94-layoutstackv2) states that a bundle still requiring v1 is quarantined for its unmet range, names the planned Ports pane, and corrects the citations (`versioning.md:33` is about bundles and the app; `:66` is cited only for its last sentence). D14, the versions table, SR15, T-3.6, T-3.8, the Phase 3 files and the docs lines follow.
  - M2: [§3](#3-the-busy-answer-layoutsidebarv1-110) states only the cost requirement on `busy` (no repeated cross-contract call per Thread; linear time per render) and leaves the mechanism to the plan; `count` is unchanged. D4 and SR3 follow; T-2.10 checks answers, not internal calls.
  - M3 (user decision): the trailing mark is the row wrapper's last flex child after the button, `sticky` at `right-1`, `shrink-0`, reserving its own width, with the `peer-*` colors; the hover and selected background ends where the mark begins (accepted). The zero-width anchor and the hidden copy move to Alternatives. D16, D17, [§10.2](#102-rows), [§10.3](#103-pinned-trailing-marks), T-4.1, T-4.2, T-4.4 and the 1:1 checks follow; line totals keep G4 by taking their own width.
  - N1: a throwing `busy` reads as false with nothing logged, as a throwing `count` does today; the contract comment no longer mentions logging; T-2.6 and SR13 follow.
  - N2: `elapsedBadge` is composed on `duration`, which stays unchanged; T-2.9 checks that they agree below 100 h.
- **Version 6** (2026-11-10): the Major findings of the stage 4 Readiness and Codebase review of version 5. Its Nits are listed in [Deferred to the plan](#deferred-to-the-plan), by the user's decision.
  - R1 and B1: the Phase 3 files add `fake-host.ts`'s `screenPane`, the Screens and MCP peer mirrors' size fields, and the comments that still name `layout.stack/v1`, the Threads pane or resizing; its tests add `stack-service.test.ts` and the MCP test's fake contract id.
  - R2: one set of names. v2 keeps `StackPane`, `LayoutStack`, `stackPaneSchema` and `layoutStackMethods`, edited in place; only the reference is renamed, `LayoutStackV1` to `LayoutStackV2`. `StackPaneV2` is gone.
  - R3: the Phase 2 files add `row-add-action.stories.tsx`, whose stories pass `active`.
  - R4: [§4](#4-thread-rows) states the trailing slot's states and the padding rule `threadRowPadding(timed, addable)`, which replaces `running ? 'pr-16' : 'pr-8'`; hover or focus still hides the elapsed badge and shows the plus. T-2.8 reads the classes and T-2.12 tests the rule.
  - R5: [§9.1](#91-the-thread-region) places the error alert, the skeleton rows and the "No threads match" notice inside the tree scroller, above the New Thread button; T-3.2 checks it.
  - R6: [§3](#3-the-busy-answer-layoutsidebarv1-110) defines the window as one registration's life, keeps a Thread's resolved Project for that life (a Thread cannot move between Projects), keeps the follow on every call, and notes that `store.threadTerminals` scans all terminals. T-2.10 asserts the fake `workspace().thread` call count.
  - R7 and B2: T-3.6 moves to a new service test through `createTestServices`, where the strict schema runs at dispatch.
  - R8: [§10.2](#102-rows) adds `overflow-visible` to the Changes view's repository group (`changes-tree.tsx:171`); T-4.4 asserts it, and SR11 names the tests that cover each element.
- **Accepted** (2026-11-10): the user approved version 6; the status moves from `proposed` to `accepted`. The content of version 6 is unchanged.
- **Implemented** (2026-11-10): phases 1–4 built; the version stays 6. U10's background wording follows D16 and SR6 names `layout.sidebar/v1` 1.0.0. Tree row buttons add `w-auto` to override `SidebarMenuButton`'s base `w-full`, so a row's button stops where its pinned mark begins. Rebased onto main's windowed `FileTree` (#56), which draws its lines flat with no nested directory group: the directory level's `overflow-visible` has no element to sit on there, so T-4.2 checks that no ancestor of a mark clips it; files moves 1.7.0 → 1.7.1.
- **Follow-up** (2026-11-11): Screens and MCP pane rows align their icons with the pane header chevrons (row `pl-1.5` inside the content's `px-1.5`). Row actions (remove; Screens' retry) show only on row hover or focus, over the row's right edge, fading the status out, with no space reserved. MCP "Sign in" stays visible as an underlined link with an external-link icon and the title "Sign in (opens in your browser)"; it shifts left on row hover or focus to make room for remove. An open pane with no rows shows "No screens open" (only with a Project selected) or "No MCP servers" (only once loaded and without a load failure). The layout's pane header plus shows only on header hover or focus. Versions: layout 3.0.1, screen 2.0.2, mcp 1.2.3 (patch; no contract change).
- **Version 7** (2026-11-11): the follow-up above is written into the body as U12, D18 and [§9.5](#95-follow-up-pane-rows-and-headers), with its files, tests T-F.1–T-F.4 and docs; the `headerTag` reveal is added to [§9.3](#93-stack-panes); T-3.8 asserts the follow-up versions. The status notes the follow-up as implemented.
