# Layout bundle

`layout` is the Doric workspace window you work in: a dashboard of your
Projects, a tab per open Project, a sidebar with each Project's tree of
Threads, the conversation in the middle, a Project panel and tabs beside it,
and footers for status. It draws no feature of its own. Files, Git, terminals,
usage and resources are other bundles that fill the slots it offers.

It is a desktop bundle with one client part (the frame and its contracts),
loaded by the `bundle` platform. See the [main README](../../../README.md) for
Doric as a whole and [`packages/bundle`](../../../packages/bundle/README.md)
for how bundles work.

## What it provides

- **UI:** `<layout-workspace>`, registered at `/`, `/projects` and
  `/projects/:projectId`. The [`chat`](../chat/README.md) bundle mounts the
  conversation inside it as the child route
  `/projects/:projectId/threads/:threadId`.
- **Contracts:** `layout.tabs/v1`, `layout.workspace/v1`, `layout.panel/v2`,
  `layout.dashboard/v1`, `layout.sidebar/v1` and `layout.stack/v1`, all client
  contracts in the workspace window.
- **Regions:** named slots where other bundles add elements.

The bundle requires `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1`,
`commands/v1`, `runtime/v1` and `runtime.threads/v1`, and has no settings.

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
  agent Thread "in viewer"), adds, copies and deletes. The sidebar is a stack of resizable, collapsible panes, so other
  bundles can add groups above or below the Threads.
- **Conversation.** The selected Thread fills the main area; a child Thread
  opens as a tab beside its root Thread instead of replacing it. Each of these
  viewer tabs has a context menu: the entries the bundle that opened it
  stated, each with its icon, then "Close tab", then its destructive entries
  last.
- **Project panel.** An icon tab strip of views beside the conversation, always
  shown; it resizes but cannot be hidden or collapsed.
- **Footers.** The conversation footer, and one window-wide footer with the
  host connection status and the settings button, which runs `core`'s
  `core.open-settings/v1`.

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
and offers `+` only where the reader may open a sub-thread, revealing it on hover
in the same trailing slot that shows the repository the Thread's cwd sits in (a
branch, or the GitHub mark). Rename/delete stay hidden where the kind forbids
them, and the row's tooltip names the kind. The breadcrumb and a conversation tab
wear the same mark. The reader's three levers on an agent Thread live in `chat`'s
footer, where the composer would be.

## Contracts

| Contract              | What another bundle can do                                                                                                                                                                                                                              | Used by                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `layout.tabs/v1`      | open, focus or close a tab drawn by its own element (with icon, aria label, tooltip and, from 1.2.0, its context-menu entries, each with an optional React-element icon) in the active Thread's or Project's tabs; retitle it (1.2.0); read the current | `files`, `git`, `terminal`                                                    |
| `layout.workspace/v1` | read the tree, the selection, a Project's Threads and the connection; subscribe; show or hide the `layout.main.bottom` split                                                                                                                            | `chat`, `files`, `git`, `resources`, `screen`, `terminal`, `threads`, `usage` |
| `layout.panel/v2`     | select the Project panel's view                                                                                                                                                                                                                         | `files`                                                                       |
| `layout.dashboard/v1` | read, show or close the `layout.dashboard.page` item the `/projects` dashboard draws instead of its project list; subscribe                                                                                                                             | `settings`                                                                    |
| `layout.sidebar/v1`   | add rows under each Thread of the sidebar tree (`addThreadRows`)                                                                                                                                                                                        | `terminal`                                                                    |
| `layout.stack/v1`     | register a sidebar pane with title, order, header action and size limits                                                                                                                                                                                | `screen`                                                                      |

A duplicate pane or row id fails with `registration_conflict`, and opening a
tab with no Thread or Project selected fails with `unavailable`.

## Regions

| Region                  | Where                                                                                  | Items today                                                    |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `layout.header`         | the right end of the Project tab bar                                                   | `terminal`'s "New terminal" button                             |
| `layout.panel`          | the Project panel's views                                                              | `files`, `git`                                                 |
| `layout.footer`         | the conversation footer                                                                | `settings`' execution picker, `chat`'s composer, `usage`       |
| `layout.panel.footer`   | the Files column footer, in one 28 px row                                              | `git` (the working directory and branch)                       |
| `layout.account.status` | a 14×14 slot over the account avatar's bottom-right corner, in the Files column header | `resources` (the connection badge)                             |
| `layout.main.bottom`    | a split under the conversation                                                         | shown while an item asks through `layout.workspace/v1`         |
| `layout.overlay`        | a floating layer over the conversation                                                 | items place themselves; the layer never intercepts a pointer   |
| `layout.dashboard.nav`  | groups of the `/projects` dashboard sidebar, after Projects                            | `settings`' Providers group                                    |
| `layout.dashboard.page` | a page the dashboard draws instead of its project list                                 | `settings`' provider page, shown through `layout.dashboard/v1` |

A `layout.panel` item carries `{ label, icon, badgeTag? }`; its element mounts
only while the item is selected. A `layout.dashboard.nav`
item draws its own `SidebarGroup`; a `layout.dashboard.page` item mounts only
while `layout.dashboard/v1` shows it.

## Development

```console
npx nx build bundle-layout
npx nx typecheck bundle-layout
npx nx test bundle-layout
```

Most tests are DOM-free; `tests/client/shell.test.ts` renders the shell in a
DOM. They cover the tree, the selection route, tabs, the
sidebar stack, Thread navigation and the contract services. Stories under
`stories/` are CSF3, and `.storybook/preview.tsx` is the harness that wraps
them. The build writes `bundles/desktop/layout/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/layout`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
