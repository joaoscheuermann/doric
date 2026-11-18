# workspace

Choosing what the window shows: Projects, Threads and the selection, as a
client-only bundle (bundle isolation step 4(c)). It fills the slots of the
[`layout`](../layout/README.md) frame with the Dashboard, the Project tabs and
each Project's tree of Threads. It needs platform `^1.8.0`. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it draws

Six elements, each a React root of its own:

- `<workspace-sidebar>` in `shell.sidebar`: the Dashboard's sidebar on `/` and
  `/projects`, the Project sidebar (header, search, the Chat and Archived tabs
  and the Thread tree) elsewhere, and the delete dialog. It alone runs the
  once-per-window effects: the Projects load, the follow and the selection's
  persistence.
- `<workspace-project-tabs>` in `shell.titlebar.tabs`: the Project tab bar.
  Its end holds the `shell.window.actions` region on `/` and `/projects` and
  the `shell.header.actions` region elsewhere.
- `<workspace-dashboard>` in `shell.page` and `<workspace-sidebar-footer>` in
  `shell.sidebar.footer`, while the route is `/` or `/projects`: the
  Dashboard's content and its footer entries.
- `<workspace-projects-route>` (`/projects`, draws nothing) and
  `<workspace-project-empty>` (`/projects/:projectId`, the Project's empty
  state), child routes of `/`.

- **Dashboard.** Every Project as a grid or a list, with search, activity,
  creation time and state, and a "New project" action; a Project's context
  menu opens it, colors it or deletes it. Its sidebar holds the
  search, "All projects", a Projects group, the groups other bundles add
  (`workspace.dashboard.nav`), and the footer entries other bundles add
  (`workspace.dashboard.footer`; `settings`' "All settings").
- **Project tabs.** One tab per open Project, which you can reorder, rename
  and close; each remembers its last path, saved in the window's local
  storage. A tab's context menu starts a new Thread in the Project, renames
  it, colors it and closes tabs; a close entry that would close nothing is
  hidden. The sidebar header's Dashboard
  button opens the Dashboard and shows as current while it is open.
- **Sidebar.** The selected Project's recursive Thread tree. Rows can be
  renamed, and a context menu asks for a Thread in a new tab (a sub-thread or
  an agent Thread "in viewer") through `onOpenThreadHook`, adds, copies and
  deletes. The frame draws the panes other bundles add under the Thread
  region (`layout.stack/v2`). Two icon-only
  tabs, Chat and Archived, sit above the tree (`sidebar-tabs.tsx`). Rows
  archive (hover or menu, with an Undo toast), pin and unpin; the Archived tab
  (`archived-threads.tsx`) groups archived Threads by date (Today, Last 7 days,
  Older) with Restore and Delete
  ([thread archive](../../../docs/features/thread-archive.md)).
- **Errors.** A failed workspace request is shown once, by the workspace error
  notice (`workspace-error-notice.tsx`): in the sidebar in the conversation form,
  in the dashboard body in the page form. A failed Projects or Threads
  load offers Retry, which loads it again (the dashboard keeps the last list
  failure on screen while it reloads); a failed create, rename, color change
  or delete offers none. The name field shows no toast; its validation reason
  is a line under the name.

The selection is the window path (`/`, `/projects/<projectId>` or
`/projects/<projectId>/threads/<threadId>`); a saved selection is validated
against the host on startup.

The selection and the Project tabs are kept in the window's local storage
under `doric.selection` and `doric.project-tabs`. The tab owner is named to
`layout.tabs/v2` with `setOwner` whenever its key changes: the route's
Thread, else `project:<id>` on a Project route, else none.

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
or while a `busy` registration (`workspace.sidebar/v1`, or `layout.sidebar/v1` 1.1.0,) answers true; the
badge times from the Thread's own last start. Rename/delete stay hidden where the kind forbids
them, and the row's tooltip names the kind. The breadcrumb and a conversation tab
wear the same mark. The reader's three levers on an agent Thread live in `chat`'s
footer, where the composer would be.

## Contracts

| Contract                 | What another bundle can do                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `workspace.selection/v1` | read the validated selection as ids (`current()`, the same object until it changes) and subscribe          |
| `workspace.hooks/v1`     | observe `onOpenThreadHook({ projectId, threadId })`: the reader asked for a Thread beside the conversation |
| `workspace.sidebar/v1`   | add rows under each Thread of the tree (`addThreadRows`), with an optional `busy(threadId)`                |
| `workspace.dashboard/v1` | read, show or close the `workspace.dashboard.page` item the Dashboard draws instead of its Project list    |

Until the bundles that read them move, `workspace` also provides
`layout.workspace/v1`, `layout.sidebar/v1` and `layout.dashboard/v1`,
unchanged; `workspace/contracts` declares them (`src/contracts/transition.ts`).
The chat observes `onOpenThreadHook` and opens its Thread tab; without the
chat the hook opens nothing.

## Slots

The names are in `workspace/contracts`; a filler writes the name as a literal
checked by `satisfies typeof`, with `import type`.

| Slot                         | What it holds                                                                                             | Filled by                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `workspace.dashboard.nav`    | groups of the Dashboard sidebar, after Projects; each element draws its own `SidebarGroup`                | `settings`' Providers group                        |
| `workspace.dashboard.page`   | a page the Dashboard draws instead of its Project list, while `workspace.dashboard/v1` shows it           | `settings`' provider page                          |
| `workspace.dashboard.footer` | data items: `props` are `DashboardFooterItemProps` (`label`, `command`, optional `input`), `tag` the icon | `settings` ("All settings", `settings-entry-icon`) |

Picking a footer entry executes its `command` with its `input` through
`commands/v1`, once per pick. An item whose props fail the type is not drawn
and is reported once per id per activation with a `Doric:` error. With no
drawable item the footer draws nothing.

## Development

```console
npx nx build bundle-workspace
npx nx typecheck bundle-workspace
npx nx test bundle-workspace
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
