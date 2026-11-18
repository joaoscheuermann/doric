# Layout bundle

`layout` is the Doric workspace window you work in: a dashboard of your
Projects, a tab per open Project, a sidebar with each Project's tree of
Threads, the conversation in the middle, a Project panel and tabs beside it,
and footers for status. It draws no feature of its own. Files, Git, terminals
and usage are other bundles that fill the slots it offers; `resources` fills
`account`'s `account.status` slot, not a layout slot.

It is a desktop bundle with one client part (the frame and its contracts),
loaded by the `bundle` platform. See the [main README](../../../README.md) for
Doric as a whole and [`packages/bundle`](../../../packages/bundle/README.md)
for how bundles work.

## What it provides

- **UI:** `<layout-workspace>`, the frame, registered at `/`. `/projects`
  (`<layout-projects-route>`, which draws nothing) and `/projects/:projectId`
  (`<layout-project-empty>`, the Project's empty state) are its child routes,
  and the [`chat`](../chat/README.md) bundle mounts the conversation inside it
  as the child route `/projects/:projectId/threads/:threadId`. The frame has
  two forms: the page form while `shell.page` holds an item, and the
  conversation form otherwise.
- **Navigation elements:** until the navigation moves to its own bundles, the
  layout fills the shell's slots with four elements of its own, defined in
  `src/client/elements/navigation-elements.tsx`: `<layout-sidebar>`
  (`shell.sidebar`), `<layout-project-tabs>` (`shell.titlebar.tabs`), and,
  while the route is `/` or `/projects`, `<layout-dashboard>` (`shell.page`)
  and `<layout-sidebar-footer>` (`shell.sidebar.footer`). The `account` bundle
  fills `shell.window.actions`.
- **Contracts:** `layout.tabs/v2`, `layout.workspace/v1`, `layout.panel/v3`,
  `layout.conversation/v1`, `layout.dashboard/v1`, `layout.sidebar/v1` and
  `layout.stack/v2`, all client contracts in the workspace window.
- **Slot names:** `layout/contracts` exports one constant per shell slot
  (`SHELL_SIDEBAR`, `SHELL_SIDEBAR_FOOTER`, `SHELL_TITLEBAR_TABS`,
  `SHELL_PAGE`, `SHELL_WINDOW_ACTIONS`, `SHELL_HEADER_ACTIONS`,
  `SHELL_CONVERSATION_FOOTER`, `SHELL_CONVERSATION_BOTTOM`,
  `SHELL_CONVERSATION_OVERLAY`, `SHELL_PANEL` and `SHELL_PANEL_FOOTER`). A
  filler writes the name as a literal checked against it:
  `'shell.panel' satisfies typeof SHELL_PANEL`, with
  `import type { SHELL_PANEL } from 'layout/contracts'`.
- **Regions:** named slots where other bundles add elements.

The bundle requires `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`,
and `commands/v1`, optionally `core.open-settings/v1` and
`runtime.records/v1`, and has no settings. Since 3.2.3 it reads Projects and
Threads from the runtime's records mirror, `runtime.records/v1`, and calls no
method of `runtime/v1` or `runtime.threads/v1`; both left its `requires`.
Layout 3.2.3 needs runtime 2.9.0 or later in the same bundle set, which the
resolver does not check because `optional` carries no range. Without a
`runtime.records/v1` provider (an older runtime, or a quarantined runtime
client part) every layout load fails with `unavailable`, and the layout shows
the outage message "Doric backend is unavailable.".

Since 3.2.4 the layout imports `ElementHost` and `useRegionItems` from the
platform's `desktop/ui/element-host` and has `engines.doric` `^1.8.0`: a
desktop app older than platform 1.8.0 cannot load it and lists it on its start
screen. `files`, `git` and `terminal` require `layout.tabs/v2`, so such an app
quarantines them along with the layout.

## What you see

- **Dashboard.** Every Project as a grid or a list, with search, activity,
  creation time and state, and a "New project" action; a Project's context
  menu opens it, colors it or deletes it. Its sidebar holds the
  search, "All projects", a Projects group, the groups other bundles add, and
  "All settings".
- **Project tabs.** One tab per open Project, which you can reorder, rename
  and close; each remembers its last path, saved in the window's local
  storage. A tab's context menu starts a new Thread in the Project, renames
  it, colors it and closes tabs; a close entry that would close nothing is
  hidden. The sidebar header's Dashboard
  button opens the Dashboard and shows as current while it is open.
- **Sidebar.** The selected Project's recursive Thread tree. Rows can be
  renamed, and a context menu opens a Thread in a new tab (a sub-thread or an
  agent Thread "in viewer"), adds, copies and deletes. Other bundles add
  panes only under the Thread region, pinned to the column's bottom; each
  pane collapses but does not resize (`project-sidebar.tsx`). Two icon-only
  tabs, Chat and Archived, sit above the tree (`sidebar-tabs.tsx`). Rows
  archive (hover or menu, with an Undo toast), pin and unpin; the Archived tab
  (`archived-threads.tsx`) groups archived Threads by date (Today, Last 7 days,
  Older) with Restore and Delete. Open Threads report presence through
  `view` of `runtime.records/v1`
  ([thread archive](../../../docs/features/thread-archive.md)).
- **Errors.** A failed workspace request is shown once, by the workspace error
  notice (`workspace-error-notice.tsx`): in the sidebar in the conversation form,
  in the dashboard body in the page form. A failed Projects or Threads
  load offers Retry, which loads it again (the dashboard keeps the last list
  failure on screen while it reloads); a failed create, rename, color change
  or delete offers none. The name field shows no toast; its validation reason
  is a line under the name.
- **Quarantined bundles.** When the window's bundle catalog
  (`doric.catalog/v1`) lists quarantined bundles, one warning notice at the
  bottom of the left sidebar (in the conversation form at its bottom edge after
  the stack panes; in the page form directly above the "All settings"
  footer) names them all ("N
  extension(s) couldn't start"), its details one bundle per line with its
  reasons; the regions they would fill stay empty. An element whose creation
  throws shows a compact notice in its place.
- **Conversation.** The selected Thread fills the main area; a child Thread
  opens as a tab beside its root Thread instead of replacing it. Each of these
  viewer tabs has a context menu: the entries the bundle that opened it
  stated, each with its icon, then "Close tab", then its destructive entries
  last. A tab's icon is the element its opener names (`iconTag`); the frame
  shows the tabs of the owner `layout.tabs/v2` `setOwner` last named, which
  the layout sets from the route's Thread, else the selected Project.
- **Project panel.** An icon tab strip of views beside the conversation, always
  shown; it resizes but cannot be hidden or collapsed. It starts with no view
  selected (`layout.panel/v3`); `files` selects the Files view when it
  activates.
- **Footers.** Two footers. The conversation footer (`shell.conversation.footer`) floats
  over the conversation's bottom 44 px, to the card's bottom edge (the card
  draws no bottom padding); its height, fill and blur are this bundle's sheet
  rule, and the conversation frame sets `--shell-conversation-footer-height: 2.75rem` for
  `<chat-view>` (see [chat's README](../chat/README.md)). The viewer card draws
  no bottom padding while its selected tab was opened with `openBottom`
  (`layout.tabs/v2`), as the layout opens a child Thread's
  `<chat-thread-panel>`, whose footer band stands on the card's bottom edge;
  any other tab keeps the card's 8 px
  ([SR12](../../../docs/designs/conversation-footer.md#risks)). The Files column
  footer (`shell.panel.footer`) is one 28 px row under the Project panel.
  Settings open from the dashboard's "All settings"; the account menu's entry
  is the `settings` bundle's. Each runs `core`'s `core.open-settings/v1` with
  `defaultPath: '/settings'` and no `path`: the command (1.1.0) focuses an open
  settings window, and otherwise opens one at `defaultPath`. Layout 3.0.3 needs
  chat 1.6.2 or later in the same bundle set. Layout 3.2.2 needs core 1.15.0 or
  later in the same bundle set: an older core rejects `defaultPath`, so
  settings do not open, and the resolver does not catch it because the layout
  lists `core.open-settings/v1` under `optional`, which carries no range.

The selection is the window path (`/`, `/projects/<projectId>` or
`/projects/<projectId>/threads/<threadId>`); a saved selection is validated
against the host on startup.

## Thread kinds

A Thread is one of three kinds, decided by where it came from
(`domain/thread-kind.ts`):

| Kind         | How it is opened                                  | What the reader may do                                                  |
| ------------ | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `main`       | The reader, at the Project root                   | Everything: prompts, stop, rename, delete, and open sub-threads         |
| `sub-thread` | The reader, inside a main Thread                  | The same, except opening further sub-threads                            |
| `sub-agent`  | The agent, with its `thread-spawn` tool, anywhere | Watch it, and pause, continue or retry the run — never prompt or delete |

The host records who opened a Thread (`Thread.origin` in `runtime/contracts`,
written by the runner's `spawn`); a Thread without it reads as the reader's, so
an older workspace keeps every Thread it had. The sidebar draws the kind as the
row's leading mark — a bubble for a main Thread, a bubble with a plus for the
sub-thread that opened it, the bot that owns an agent Thread (`threadKindIcon`) —
and offers `+` only where the reader may open a sub-thread. The trailing slot
shows only the elapsed badge and that `+`, which hover or keyboard focus
reveals. An Untitled Thread wears `message-circle-dashed` on its row, the
breadcrumb and its tab. A row is active while its Thread or any descendant runs,
or while a `busy` registration (`layout.sidebar/v1` 1.1.0) answers true; the
badge times from the Thread's own last start. Rename/delete stay hidden where the kind forbids
them, and the row's tooltip names the kind. The breadcrumb and a conversation tab
wear the same mark. The reader's three levers on an agent Thread live in `chat`'s
footer, where the composer would be.

## Contracts

| Contract                 | What another bundle can do                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Used by                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `layout.tabs/v2`         | open, focus or close a tab drawn by its own element in the tabs of the active owner, with an icon element (`iconTag`, created with the tab's props), `openBottom`, an aria label, a tooltip and context-menu entries, each with an optional React-element icon; retitle it; read the current tab; subscribe; name the owner whose tabs the frame shows (`setOwner`); close a tab in every owner (`everyOwner`). The request is strict: an unknown key, such as v1's `icon`, fails `invalid_input` | `files`, `git`, `terminal`, and the layout's own Thread tabs                  |
| `layout.workspace/v1`    | read the tree, the selection, a Project's Threads and the connection; subscribe; show or hide the `shell.conversation.bottom` split                                                                                                                                                                                                                                                                                                                                                               | `chat`, `files`, `git`, `resources`, `screen`, `terminal`, `threads`, `usage` |
| `layout.panel/v3`        | select the Project panel's view; the panel starts with no view selected, and an id no item has yet is kept until that item registers                                                                                                                                                                                                                                                                                                                                                              | `files`                                                                       |
| `layout.conversation/v1` | show or hide the `shell.conversation.bottom` split for one item (`setBottomVisible`)                                                                                                                                                                                                                                                                                                                                                                                                              | none yet                                                                      |
| `layout.dashboard/v1`    | read, show or close the `layout.dashboard.page` item the `/projects` dashboard draws instead of its project list; subscribe                                                                                                                                                                                                                                                                                                                                                                       | `settings`                                                                    |
| `layout.sidebar/v1`      | add rows under each Thread of the sidebar tree (`addThreadRows`); since 1.1.0 a registration may answer `busy(threadId)`, which keeps the Thread and its ancestors active                                                                                                                                                                                                                                                                                                                         | `terminal`                                                                    |
| `layout.stack/v2`        | register a sidebar pane with title, order, header action and collapse state; panes are pinned to the column's bottom, with no sizes                                                                                                                                                                                                                                                                                                                                                               | `screen`, `mcp`                                                               |

A duplicate pane or row id fails with `registration_conflict`, and opening a
tab with no owner fails with `unavailable`. Since layout 4.0.0 the tabs and
the panel are provided only at these major versions; a bundle that requires an
older one is quarantined with `missing_dependency`.

## Regions

The frame draws the slots of its current form. The page form, while
`shell.page` holds an item, draws the sidebar column beside the title bar over
the page. The conversation form draws the sidebar column, the title bar, the
conversation, the viewer tabs and the Project panel.

| Region                       | Where                                                                                                                                 | Items today                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `shell.sidebar`              | the sidebar column, in both forms; one region element moves between the forms, so its items do not remount on a switch                | `<layout-sidebar>`                                                                 |
| `shell.sidebar.footer`       | the sidebar column's foot, under the quarantine notice; drawn only while it has items                                                 | `<layout-sidebar-footer>` ("All settings"), while the route is `/` or `/projects`  |
| `shell.titlebar.tabs`        | the title bar, in both forms                                                                                                          | `<layout-project-tabs>`                                                            |
| `shell.page`                 | the page form's body; an item here switches the frame to the page form                                                                | `<layout-dashboard>`, while the route is `/` or `/projects`                        |
| `shell.window.actions`       | the window's actions: the end of the Project tab bar in the page form, the end of the Project panel's header in the conversation form | `account` (`<account-status>`)                                                     |
| `shell.header.actions`       | the end of the Project tab bar, in the conversation form                                                                              | `terminal`'s "New terminal" button                                                 |
| `shell.panel`                | the Project panel's views                                                                                                             | `files`, `git`                                                                     |
| `shell.conversation.footer`  | the conversation footer, a 44 px band floating over the conversation's bottom                                                         | `settings`' execution picker, `chat`'s composer, `usage`                           |
| `shell.panel.footer`         | the Files column footer, in one 28 px row                                                                                             | `git` (the working directory and branch)                                           |
| `shell.conversation.bottom`  | a split under the conversation                                                                                                        | shown while an item asks through `layout.workspace/v1` or `layout.conversation/v1` |
| `shell.conversation.overlay` | a floating layer over the conversation                                                                                                | items place themselves; the layer never intercepts a pointer                       |
| `layout.dashboard.nav`       | groups of the `/projects` dashboard sidebar, after Projects                                                                           | `settings`' Providers group                                                        |
| `layout.dashboard.page`      | a page the dashboard draws instead of its project list                                                                                | `settings`' provider page, shown through `layout.dashboard/v1`                     |

Layout 4.2.0 to 4.7.0 gave the six slots that existed before these names, one
slot per version; an item added under an old name is not drawn. Layout 4.7.1
dropped `layout.account.status`, which became `account`'s `account.status`
(see [account's README](../account/README.md)). The CSS
variable the conversation frame sets is `--shell-conversation-footer-height`
(it was `--chat-footer-height`).

A `shell.panel` item carries `{ label, iconTag?, badgeTag? }` (`PanelItemProps`):
its tab trigger draws the `iconTag` element as the view's icon and the
`badgeTag` element inside it, and its element mounts only while the item is
selected. A `layout.dashboard.nav` item draws its own `SidebarGroup`; a
`layout.dashboard.page` item mounts only while `layout.dashboard/v1` shows it.

## Development

```console
npx nx build bundle-layout
npx nx typecheck bundle-layout
npx nx test bundle-layout
```

Most tests are DOM-free; `tests/client/shell.test.ts` renders the shell in a
DOM, and `tests/client/footer-styles.test.ts` reads the bundle's stylesheet
from disk. They cover the tree, the selection route, tabs, the
sidebar stack, Thread navigation and the contract services. Stories under
`stories/` are CSF3, and `.storybook/preview.tsx` is the harness that wraps
them. The build writes `bundles/desktop/layout/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/layout`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
