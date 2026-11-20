# workspace

`workspace` lets the reader choose what the window shows: the Dashboard of
Projects, one tab per open Project, and each Project's tree of Threads. It
fills the slots of the [`layout`](../layout/README.md) frame with that
navigation, keeps the selection in the window path, and tells the frame's tabs
which Thread or Project owns them. It draws no Thread conversation and no
Thread tab: it asks for a Thread through a hook, and the bundle that draws
Threads answers.

It is a client-only bundle: a contracts module and a client part that runs in
each app window. The [main README](../../../README.md) describes Doric as a
whole, and [`packages/bundle`](../../../packages/bundle/README.md) how a bundle
is built, loaded and activated. The feature docs
[Projects and Threads](../../../docs/features/projects-and-threads.md),
[thread archive](../../../docs/features/thread-archive.md),
[UI redesign](../../../docs/features/ui-redesign.md) and
[error messages](../../../docs/features/error-messages.md) describe the
behavior across bundles, and the feature docs of the bundles that use its
contracts name it: [Git](../../../docs/features/git.md),
[Screen](../../../docs/features/screen.md),
[usage](../../../docs/features/usage.md), [MCP](../../../docs/features/mcp.md)
and [Settings](../../../docs/features/settings.md). This README is the bundle's complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field         | Value                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `workspace`, version `1.0.0`, engine `doric ^1.8.0`                                                                                                        |
| `description` | "Choosing what the window shows: Projects, Threads and the selection."                                                                                     |
| `provides`    | `workspace.selection/v1@1.0.0`, `workspace.hooks/v1@1.0.0`, `workspace.sidebar/v1@1.0.0`, `workspace.dashboard/v1@1.0.0`                                   |
| `requires`    | `hooks/v1@^1.0.0`, `ui/v1@^1.0.0`, `navigation/v1@^1.1.0`, `regions/v1@^1.0.0`, `commands/v1@^1.0.0`, `runtime.records/v1@^1.0.0`, `layout.tabs/v2@^2.0.0` |
| `optional`    | none                                                                                                                                                       |

The bundle has no host or desktop part, no settings, no tools, no commands of
its own and no stylesheet of its own: its elements draw with the components of
`desktop/ui` and the window's theme.

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts) and
  [`src/contracts/navigation.ts`](src/contracts/navigation.ts), exported as
  `workspace/contracts` through [`package.json`](package.json)): the four
  `workspace.*` contracts, their method schemas, the three slot names and
  `DashboardFooterItemProps`, listed under
  [Exports of `workspace/contracts`](#exports-of-workspacecontracts).
- **Client** ([`src/client/index.ts`](src/client/index.ts)): on activation it
  stores the activation services
  ([`services/workspace-services.ts`](src/client/services/workspace-services.ts)),
  defines `workspace.hooks/v1`, binds the window's `runtime.records/v1` mirror
  when it is available, defines six elements, registers two routes, adds its
  slot items, follows the route for the Dashboard's items and the tab owner,
  and provides `workspace.selection/v1`, `workspace.sidebar/v1` and
  `workspace.dashboard/v1`. The cleanup it returns disposes all of it,
  unbinds the records, and resets the route selection, the Dashboard, the
  "New project" mark, the Thread rows, the query client and the footer
  reports; the Project tabs are read again from storage at the next
  activation.

The client's folders:

| Folder                                                                                 | What it holds                                                                                                   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`src/client/elements/`](src/client/elements)                                          | The six custom elements, each a React root of its own                                                           |
| [`src/client/components/`](src/client/components)                                      | The sidebar, the Project tabs, the Dashboard and their molecules                                                |
| [`src/client/hooks/`](src/client/hooks)                                                | React hooks: the workspace model and its actions, the route selection, the Project tabs, the footer items       |
| [`src/client/stores/`](src/client/stores)                                              | Module stores (zustand) shared by the element roots                                                             |
| [`src/client/queries/`](src/client/queries)                                            | The window's TanStack Query client and its keys                                                                 |
| [`src/client/domain/`](src/client/domain), [`src/client/utility/`](src/client/utility) | Pure rules: the tree, the selection, the routes, the Thread kinds, the archive tabs, the tabs, the footer items |
| [`src/client/services/`](src/client/services)                                          | The providers of the three client contracts and the activation services                                         |

## Contracts provided

All four are client contracts, local to the window that provides them.

### `workspace.selection/v1` (1.0.0)

Defined in [`src/contracts/index.ts`](src/contracts/index.ts) and provided by
[`src/client/services/workspace-selection.ts`](src/client/services/workspace-selection.ts):

```ts
interface WorkspaceSelection {
  readonly projectId?: string;
  readonly threadId?: string;
}

interface WorkspaceSelectionService {
  current(call?: CallArg): WorkspaceSelection;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}
```

- `current()` answers the ids of the selection the sidebar shows, and only of
  records the window's tree describes: a selected Project the tree does not
  list, or a selected Thread its Project's Threads do not hold, is left out.
  It answers the same object until either id changes.
- `subscribe(listener)` calls `listener` after each change of `current()`, and
  not after a store change that leaves it the same object. Disposing stops the
  calls.

### `workspace.hooks/v1` (1.0.0)

Defined in [`src/contracts/index.ts`](src/contracts/index.ts) with
`defineHooks`, and defined at activation through `hooks/v1`
([`src/client/index.ts`](src/client/index.ts)):

```ts
onOpenThreadHook: defineHook({
  kind: 'observe',
  input: z.object({ projectId: z.string(), threadId: z.string() }).strict(),
});
```

The workspace executes `onOpenThreadHook` when the reader asks for a Thread
beside the conversation: "Open in new tab" on a main Thread's row, "Open in
viewer" on a sub-thread's or an agent Thread's row, and the opening of a
sub-thread through a route
([`src/client/hooks/thread-navigation.ts`](src/client/hooks/thread-navigation.ts)).
With no observer it opens nothing and reports nothing. An execution that
throws is stored as the workspace error (see
[Errors and failure behavior](#errors-and-failure-behavior)).

### `workspace.sidebar/v1` (1.0.0)

Defined in [`src/contracts/navigation.ts`](src/contracts/navigation.ts),
provided by
[`src/client/services/workspace-sidebar.ts`](src/client/services/workspace-sidebar.ts)
and backed by
[`src/client/stores/thread-rows.ts`](src/client/stores/thread-rows.ts):

```ts
interface ThreadRows {
  readonly id: string;
  readonly tag: string; // mounted as <tag thread-id="…"> before the Thread's child Threads
  count(threadId: string): number; // above 0, the Thread row is expandable
  subscribe(listener: () => void): Disposable; // the owner calls it after every change of any count or busy answer
  busy?(threadId: string): boolean;
}

interface WorkspaceSidebar {
  addThreadRows(rows: ThreadRows, call?: CallArg): Disposable;
}
```

- `addThreadRows` accepts only an object with a non-empty `id` and `tag`,
  functions `count` and `subscribe`, and `busy` absent or a function; any
  other input fails the schema ("Expected { id, tag, count, subscribe, busy?
  }."). A second registration with an `id` already registered fails with
  `registration_conflict`. Disposing removes the rows and stops the
  subscription; a second dispose does nothing.
- Registrations are kept in registration order. A `count` that throws reads
  as 0.
- `busy(threadId)` is asked once for every Thread of the selected Project on
  every render of the tree, whether the Thread is drawn, collapsed or hidden
  by a search, so it must answer from memory. While any registration answers
  `true`, the Thread and every ancestor are active
  ([`src/client/domain/thread-tree.ts`](src/client/domain/thread-tree.ts)).
  A `busy` that throws, or is absent, reads as `false`; asking stops at the
  first `true`.

### `workspace.dashboard/v1` (1.0.0)

Defined in [`src/contracts/navigation.ts`](src/contracts/navigation.ts),
provided by
[`src/client/services/workspace-dashboard.ts`](src/client/services/workspace-dashboard.ts)
and backed by [`src/client/stores/dashboard.ts`](src/client/stores/dashboard.ts):

```ts
interface WorkspaceDashboard {
  active(call?: CallArg): string | undefined;
  show(id: string, call?: CallArg): void;
  close(call?: CallArg): void;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}
```

- `active()` is the id of the `workspace.dashboard.page` item the Dashboard
  draws instead of its Project list; `undefined` while the list shows.
- `show(id)` shows that page. An empty id fails with `invalid_input`. An id no
  item has is stored, and the Project list draws. Showing the page already
  shown notifies no one.
- `close()` returns to the Project list; closing with no page shown notifies
  no one.
- `subscribe(listener)` calls `listener` after every change of the
  Dashboard's store
  ([`src/client/stores/dashboard.ts`](src/client/stores/dashboard.ts),
  [`src/client/services/workspace-dashboard.ts`](src/client/services/workspace-dashboard.ts)):
  a change of `active()`, and also each change of the search, the highlight
  or the create form, so a listener reads `active()` and compares. Showing
  the page already shown, or closing with no page shown, calls no one.
- When a page is shown while the window is on the home body (below), the
  Dashboard navigates to `/projects`, which draws it
  ([`src/client/components/organisms/dashboard.tsx`](src/client/components/organisms/dashboard.tsx)).
  The home body closes any shown page when it mounts.
- The reader's own actions also close a shown page: typing a non-empty
  Project search, "New project" (button or ⌘N/Ctrl+N), and "All projects"
  ([`dashboard.tsx`](src/client/components/organisms/dashboard.tsx)).

### Slots declared

The names are exported from [`src/contracts/index.ts`](src/contracts/index.ts).

| Slot                         | Items                                                                                                                     | Drawn by                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workspace.dashboard.nav`    | `{ id, tag, order? }`: groups of the Dashboard sidebar, after Projects; each element draws its own `SidebarGroup`         | [`dashboard.tsx`](src/client/components/organisms/dashboard.tsx)                                                          |
| `workspace.dashboard.page`   | `{ id, tag, order? }`: a page the Dashboard draws instead of its Project list while `workspace.dashboard/v1` shows its id | [`dashboard.tsx`](src/client/components/organisms/dashboard.tsx), [`domain/dashboard.ts`](src/client/domain/dashboard.ts) |
| `workspace.dashboard.footer` | data items: `props` are `DashboardFooterItemProps`, `tag` is the 16 px icon element                                       | [`dashboard-sidebar.tsx`](src/client/components/organisms/dashboard-sidebar.tsx)                                          |

```ts
interface DashboardFooterItemProps {
  readonly label: string;
  readonly command: string; // a contract id, executed through commands/v1
  readonly input?: Readonly<Record<string, unknown>>;
}
```

- A footer item is drawn only when its `props` pass
  [`src/client/domain/footer-items.ts`](src/client/domain/footer-items.ts):
  `label` is a string, `command` passes `isContractId`, and `input` is absent
  or a non-null object that is not an array; extra keys are allowed. A
  malformed item is not drawn and is reported once per item id per activation
  with `console.error('Doric: the dashboard footer item "<id>" of <owner> has malformed props and is not drawn:', props)`
  ([`src/client/hooks/use-footer-items.ts`](src/client/hooks/use-footer-items.ts)).
- Each drawn item is a button whose accessible name is its `label`, showing
  its `tag` element, then the label. The icon takes the button's color, so an
  icon drawn with `currentColor` at 16 px fits.
- A pick executes `command` with `input` through `commands/v1`, once per pick,
  without awaiting it; a rejection is logged with
  `console.error('Doric: the command <command> could not run:', error)`.
- With no drawable item the footer draws nothing.

### Exports of `workspace/contracts`

From [`src/contracts/index.ts`](src/contracts/index.ts):
`WORKSPACE_DASHBOARD_NAV`, `WORKSPACE_DASHBOARD_PAGE`,
`WORKSPACE_DASHBOARD_FOOTER`, `DashboardFooterItemProps`,
`WorkspaceSelection`, `WorkspaceSelectionService`,
`workspaceSelectionMethods`, `WorkspaceSelectionV1`, `WorkspaceHooksV1`,
`ThreadRows`, `WorkspaceSidebar`, `workspaceSidebarMethods`,
`WorkspaceSidebarV1`, `WorkspaceDashboard`, `workspaceDashboardMethods` and
`WorkspaceDashboardV1`. The `*V1` refs are built with `ref` or `defineHooks`
of `bundle/contracts`; no file of the module imports `runtime/contracts`.

## Contracts used

| Contract             | What for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/v1`           | Defines `workspace.hooks/v1` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ui/v1`              | Defines the six elements, creates route elements, and hosts with `ElementHost` the Thread-row tags, the footer icons and the nav and page items ([`src/client/index.ts`](src/client/index.ts), [`thread-branches.tsx`](src/client/components/molecules/thread-branches.tsx), [`dashboard-sidebar.tsx`](src/client/components/organisms/dashboard-sidebar.tsx), [`dashboard.tsx`](src/client/components/organisms/dashboard.tsx)).                                                                                                                                                           |
| `navigation/v1`      | Registers the two routes, reads and follows the route, navigates (push or replace), and draws Back and Forward from `history()`, `back()` and `forward()` ([`history-buttons.tsx`](src/client/components/molecules/history-buttons.tsx)).                                                                                                                                                                                                                                                                                                                                                   |
| `regions/v1`         | Adds the slot items of the frame's slots and reads the items of its own three slots ([`src/client/index.ts`](src/client/index.ts), [`dashboard.tsx`](src/client/components/organisms/dashboard.tsx)).                                                                                                                                                                                                                                                                                                                                                                                       |
| `commands/v1`        | Executes a picked footer item's command ([`dashboard-sidebar.tsx`](src/client/components/organisms/dashboard-sidebar.tsx)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `runtime.records/v1` | Every Project and Thread read and write: `projects`, `threads`, `reload`, `subscribe`, `follow`, `findThread`, `activity`, `createProject`, `renameProject`, `setProjectColor`, `terminateProject`, `deleteProject`, `createThread`, `renameThread`, `terminateThread`, `deleteThread`, `archiveThread`, `restoreThread`, `setThreadPinned` ([`stores/workspace.ts`](src/client/stores/workspace.ts), [`hooks/use-workspace.ts`](src/client/hooks/use-workspace.ts)). The types `Project`, `Thread`, `ProjectColor` and `ProjectActivity` come from `runtime/contracts` with `import type`. |
| `layout.tabs/v2`     | Names the owner of the frame's tabs with `setOwner` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The slot names of the frame (`shell.sidebar`, `shell.sidebar.footer`,
`shell.titlebar.tabs`, `shell.page`, `shell.window.actions`,
`shell.header.actions`) come from `layout/contracts` with `import type`.

## What it draws

### Elements, routes and slot items

Registered in [`src/client/index.ts`](src/client/index.ts):

| Element                      | Where                                                                                  | Drawn by                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `<workspace-sidebar>`        | `shell.sidebar` (item `navigation`), in every window                                   | [`navigation-elements.tsx`](src/client/elements/navigation-elements.tsx)     |
| `<workspace-project-tabs>`   | `shell.titlebar.tabs` (item `project-tabs`), in every window                           | [`navigation-elements.tsx`](src/client/elements/navigation-elements.tsx)     |
| `<workspace-dashboard>`      | `shell.page` (item `dashboard`), while the path is `/` or `/projects`                  | [`navigation-elements.tsx`](src/client/elements/navigation-elements.tsx)     |
| `<workspace-sidebar-footer>` | `shell.sidebar.footer` (item `dashboard-footer`), while the path is `/` or `/projects` | [`navigation-elements.tsx`](src/client/elements/navigation-elements.tsx)     |
| `<workspace-projects-route>` | route `/projects`, child of `/`; draws nothing                                         | [`project-empty-element.tsx`](src/client/elements/project-empty-element.tsx) |
| `<workspace-project-empty>`  | route `/projects/:projectId`, child of `/`                                             | [`project-empty-element.tsx`](src/client/elements/project-empty-element.tsx) |

`<workspace-sidebar>` draws the Dashboard's sidebar on `/` and `/projects`, and
the Project sidebar elsewhere; on both it also draws the delete dialog. It is
the one element that runs the once-per-window work of
[`useWorkspace({ effects: true })`](src/client/hooks/use-workspace.ts): the
Projects load, the route selection and its restore, and the `follow` of the
selected Project. `<workspace-project-tabs>` ends with a `core-region` of
`shell.window.actions` on `/` and `/projects`, and of `shell.header.actions`
elsewhere. `<workspace-project-empty>` draws the Project's name, "Start a
thread or select one from the sidebar." and a "New thread" button; for a
Project the records do not hold it draws "No project selected" and no button.

Every element root except `<workspace-projects-route>` is wrapped in the
window's query client and a `TooltipProvider`
([`navigation-elements.tsx`](src/client/elements/navigation-elements.tsx)).
After a navigation from the tabs or the sidebar header, focus moves, one
animation frame later, to the first element in document order that is
`[aria-label="Thread conversation"]` or `main`.

### Dashboard

Drawn by [`dashboard.tsx`](src/client/components/organisms/dashboard.tsx) and
[`dashboard-sidebar.tsx`](src/client/components/organisms/dashboard-sidebar.tsx):

- **List form** (`/projects`, and `/` unless it was reached through "New
  project"): every Project of `runtime.records/v1.activity()` under the
  columns Name, Activity, Created and State, filtered by a "Search projects"
  field that matches the name case-insensitively. With a query, ArrowDown and
  ArrowUp move a highlight and Enter opens the highlighted Project; ⌘F (Apple
  platforms) or Ctrl+F focuses the field. An empty result reads "No results
  found. Maybe a typo?", an empty list "No projects yet". A shown
  `workspace.dashboard.page` item replaces the list.
- **Home body** (`/` reached through the tab bar's "New project"): "New
  project" (⌘N or Ctrl+N), "Browse all projects" (to `/projects`), the search
  field, the create form while it is open, and the ten most recent Projects.
- **Sidebar**: the search, "All projects", the Projects group, the
  `workspace.dashboard.nav` groups, and the footer of
  `workspace.dashboard.footer` items.
- A Project's context menu opens it, colors it or deletes it. The colors are
  `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet` and `pink`
  ([`domain/workspace.ts`](src/client/domain/workspace.ts)).

### Project tabs

Drawn by [`project-tabs.tsx`](src/client/components/organisms/project-tabs.tsx)
with the state of [`use-project-tabs.ts`](src/client/hooks/use-project-tabs.ts)
and [`domain/project-tabs.ts`](src/client/domain/project-tabs.ts):

- One tab per open Project, in the reader's order; a tab can be dragged to a
  new place, renamed and closed ("Close <name> tab"). Each tab remembers the
  last path under its Project and opens it again.
- Every path under `/projects/<id>` opens the tab of `<id>`. Once the Projects
  load without error, a tab whose Project is gone is dropped.
- Closing the active tab opens its neighbor at the same position, else
  `/projects`.
- A tab's context menu offers "New thread", "Rename", the colors, "Close tab",
  "Close other tabs", "Close tabs to the right" and "Close all tabs"; an entry
  that would close nothing is hidden.
- "New project" at the end of the bar opens the home body.

### Project sidebar

Drawn by [`project-sidebar.tsx`](src/client/components/organisms/project-sidebar.tsx),
[`sidebar-header.tsx`](src/client/components/organisms/sidebar-header.tsx),
[`thread-branches.tsx`](src/client/components/molecules/thread-branches.tsx),
[`archived-threads.tsx`](src/client/components/organisms/archived-threads.tsx)
and [`item-context-menu.tsx`](src/client/components/molecules/item-context-menu.tsx):

- The header ([`sidebar-header.tsx`](src/client/components/organisms/sidebar-header.tsx),
  drawn by both sidebars) holds the "Dashboard" button (to `/projects`,
  marked as the current page in the Dashboard's sidebar, which also adds a
  "Search" button that focuses its search) and Back and Forward. Back and
  Forward are disabled while
  `navigation/v1.history()` says they cannot move, and draw nothing when the
  app's navigation has no `history` method, when `history()` throws, or when
  `desktop/ui/button-group` fails to load.
- A "Search Threads" field filters the tree: a Thread matches when its shown
  name (`name`, or "Untitled" when empty) contains the query
  case-insensitively, and its ancestors stay drawn
  ([`domain/thread-filter.ts`](src/client/domain/thread-filter.ts)).
- Two icon-only tabs, Chat and Archived
  ([`sidebar-tabs.tsx`](src/client/components/molecules/sidebar-tabs.tsx)).
  Chat draws every Thread not archived and, as context, every archived
  ancestor of one; Archived groups archived Threads by their `archivedAt` in
  local time into Today, Last 7 days and Older, with their ancestors as
  context ([`domain/thread-archive.ts`](src/client/domain/thread-archive.ts)).
- The tree nests Threads by `parentThreadId`
  ([`domain/thread-tree.ts`](src/client/domain/thread-tree.ts)); the rows
  other bundles add (`workspace.sidebar/v1`) sit before a Thread's child
  Threads. Below the tree, on the Chat tab, a "New Thread" button opens a
  draft row.
- A row's leading mark is its kind's icon, or `message-circle-dashed` for an
  Untitled Thread ([`thread-mark.tsx`](src/client/components/molecules/thread-mark.tsx)),
  and its tooltip names the kind. Its trailing slot shows the elapsed badge
  while the row is active, and on hover or keyboard focus its actions: `+`
  where a sub-thread may be opened, archive and pin.
- A row's context menu offers, as its kind allows: "Open in new tab" (main
  Thread) or "Open in viewer" (sub-thread, agent Thread), add a sub-thread,
  "Copy thread ID", "Pin thread" or "Unpin thread", "Archive thread" or
  "Restore thread", rename, and "Delete thread".
- Archiving offers itself only for a Thread that is not archived and whose
  state is not `queued`, `running` or `cancelling`. It calls
  `runtime.records/v1.archiveThread({ threadId })`, which picks the
  descendants archived with it and answers `{ batch }`, then shows the toast
  "Thread archived" / `"<name or Untitled>" moved to Archived` with an Undo
  that calls `restoreThread({ threadId, batch })`
  ([`use-workspace.ts`](src/client/hooks/use-workspace.ts)). Restore from a
  row calls `restoreThread({ threadId })` and shows no toast.
- Deleting asks in [`delete-dialog.tsx`](src/client/components/molecules/delete-dialog.tsx);
  for an archived Thread the dialog names how many descendants are still in
  Chat. Confirming terminates, then deletes the Project or the Thread.

### Thread kinds

[`domain/thread-kind.ts`](src/client/domain/thread-kind.ts) decides a Thread's
kind from its record:

| Kind         | Record                                   | Icon                  | Label          | Reader may                                        |
| ------------ | ---------------------------------------- | --------------------- | -------------- | ------------------------------------------------- |
| `main`       | no `parentThreadId`                      | `message-circle`      | "Main thread"  | prompt, rename, delete, open a sub-thread         |
| `sub-thread` | `parentThreadId`, `origin` not `'agent'` | `message-circle-plus` | "Sub-thread"   | prompt, rename, delete                            |
| `sub-agent`  | `parentThreadId`, `origin === 'agent'`   | `bot-message-square`  | "Agent thread" | pause, continue, retry (rename and delete hidden) |

A record without `origin` reads as the reader's. An archived Thread of any
kind may be deleted. The tooltips are "Main thread · you control it",
"Sub-thread · you control it" and "Agent thread · you can pause, continue or
retry it". A Thread is Untitled exactly when its `name` is the empty string.

### Activity

A Thread is active while its own prompt runs (`state === 'running'` with an
`activePromptId`), while a `busy` registration answers `true` for it, or while
any descendant is active; every Thread of the Project is visited, drawn or not
([`domain/thread-tree.ts`](src/client/domain/thread-tree.ts)). An active row
shimmers and shows the elapsed badge from the Thread's own last start, updated
by [`use-execution-time.ts`](src/client/hooks/use-execution-time.ts). The
badge reads `mm:ss` under 1 h, `h:mm:ss` under 100 h, `{d}d {h}h` under 100
days, then `99d+` ([`utility/duration.ts`](src/client/utility/duration.ts)).

## Selection and routes

[`domain/route-selection.ts`](src/client/domain/route-selection.ts),
[`stores/route-selection.ts`](src/client/stores/route-selection.ts) and
[`hooks/use-route-selection.ts`](src/client/hooks/use-route-selection.ts):

- The selection is the window path: `/` (none), `/projects/<projectId>` or
  `/projects/<projectId>/threads/<threadId>`, each id URI-encoded. The Thread
  route is registered by the bundle that draws Threads; the workspace reads
  it.
- Selecting a Project with no Thread named selects its first main Thread that
  is not archived, if any ([`domain/project-tree.ts`](src/client/domain/project-tree.ts)).
- A selection the reader makes pushes a history entry; any other write
  replaces the current one. With nothing selected and nothing changed the
  path is left as it is, so `/projects` and the routes of other bundles stay.
- On startup the route's Thread is looked up with `findThread` and selected if
  it still exists, unless the reader acted first. A sub-thread resolves to its
  main Thread, which is selected, and the sub-thread is asked for through
  `onOpenThreadHook` ([`domain/thread-navigation.ts`](src/client/domain/thread-navigation.ts)).
  A Thread link whose Thread is gone falls back to its Project, or to `/`
  when the loaded Projects list does not hold that Project. Nothing is written until the lookup
  settles; after a failed lookup the first write waits for a change.
- A navigation the workspace did not make (Back, Forward, a link) selects
  what the route names; a route whose Project disagrees with the selected
  Thread is replaced with the Thread's own path.
- The owner of the frame's tabs is the route's Thread id, else
  `project:<projectId>` on `/projects/:projectId` with a selected Project,
  else none; `layout.tabs/v2.setOwner` is called whenever that key changes
  ([`src/client/index.ts`](src/client/index.ts)).

## Data and persistence

The workspace keeps no records of its own: Projects and Threads are a
projection of `runtime.records/v1`, rebuilt on every notice of the mirror
([`stores/workspace.ts`](src/client/stores/workspace.ts)). The Threads of a
Project are read only after the Project is requested (selected, opened or
reached by a route). Module stores hold what the element roots share:

| Store                                                               | State                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`stores/workspace.ts`](src/client/stores/workspace.ts)             | the tree, the selection, drafts, rename, delete, the one error, loading flags    |
| [`stores/route-selection.ts`](src/client/stores/route-selection.ts) | the selection, its load state (`none`, `restored`, `failed`), whether it changed |
| [`stores/project-tabs.ts`](src/client/stores/project-tabs.ts)       | the Project tabs and the last path                                               |
| [`stores/dashboard.ts`](src/client/stores/dashboard.ts)             | the shown page, the search, the highlight, the create form                       |
| [`stores/new-tab.ts`](src/client/stores/new-tab.ts)                 | whether `/` was opened through "New project"                                     |
| [`stores/thread-rows.ts`](src/client/stores/thread-rows.ts)         | the `workspace.sidebar/v1` registrations                                         |

Two keys of the window's `localStorage`:

- `doric.project-tabs`: `{ order: string[], paths: Record<string, string>, homePath: '/' | '/projects' }`,
  written after every change of the tabs by an effect of
  [`hooks/use-project-tabs.ts`](src/client/hooks/use-project-tabs.ts) and read
  at activation by `restoreProjectTabs` of
  [`stores/project-tabs.ts`](src/client/stores/project-tabs.ts). Entries
  whose path is not under their own Project are dropped on read; an
  unreadable value reads as no tabs
  ([`domain/project-tabs.ts`](src/client/domain/project-tabs.ts)).
- `doric.selection`: `{ version: 1, selectedThreadId: string }`, read at
  every startup and used only when the window opens at `/` with no Thread in
  the route, where its Thread is looked up as a route's Thread is. It is
  removed when startup settles as `none` or `restored`, on any route, and,
  after a `failed` startup, once the next selection is written
  (`startRestore` of
  [`stores/route-selection.ts`](src/client/stores/route-selection.ts);
  [`domain/selection.ts`](src/client/domain/selection.ts)).

Storage that cannot be read or written is ignored: the tabs stay in memory.

## Side effects

- Calls to `runtime.records/v1` for every read and write listed under
  [Contracts used](#contracts-used), and a `follow` of the selected Project
  while it is selected.
- Navigation through `navigation/v1` (push or replace), and `setOwner` on
  `layout.tabs/v2`.
- Executions of `onOpenThreadHook` and of footer commands through
  `commands/v1`.
- Writes to `localStorage` and `navigator.clipboard` ("Copy thread ID").
- Toasts through `desktop/ui/sonner`, `console.error` lines prefixed
  `Doric:`, focus moves after navigation, and `keydown` listeners on
  `document` for the Dashboard's shortcuts while it is mounted.

## Configuration

None: the bundle reads no setting. It needs a platform of `^1.8.0`; Back and
Forward need `navigation/v1` with `history` (1.1.0, which `requires` asks for)
and the module `desktop/ui/button-group`.

## Limits

- Names are 1 to 80 code points after trimming, without NUL; a name field
  stops at 80 code points and shows "Enter a name between 1 and 80
  characters." or "Names cannot contain a null character." on a line under
  it ([`domain/workspace.ts`](src/client/domain/workspace.ts)).
- The home body lists the ten most recent Projects.
- The window's query client never retries and never refetches on focus or
  reconnect ([`queries/client.ts`](src/client/queries/client.ts)).
- The sidebar holds one error at a time; a newer one replaces it.

## Errors and failure behavior

- A failed request is stored as the one workspace error,
  `{ error: ErrorInfo, retry?: { kind: 'projects' } | { kind: 'threads', projectId } }`
  ([`domain/sidebar.ts`](src/client/domain/sidebar.ts)): a failed load
  carries its target, and any other failure carries none. `ErrorInfo` keeps
  the failure's own code and message.
- [`workspace-error-notice.tsx`](src/client/components/molecules/workspace-error-notice.tsx)
  draws it with `ErrorNotice` of `desktop/ui/error-notice`, announced, in the
  Project sidebar and both Dashboard bodies. Titles come from
  [`domain/error-catalog.ts`](src/client/domain/error-catalog.ts), merged
  over the shared catalog. A code neither catalog knows falls back by
  target: `projects_load_failed` "Projects not loaded",
  `threads_load_failed` "Threads not loaded", or, with no target,
  `workspace_action_failed` "Change not saved". Retry shows only when a
  target is set, and loads that target again.
- `project_stream_failed` is titled "Live updates stopped" and explained
  "The sidebar stopped following this project; select it again to
  reconnect."; `clipboard_failed` ("Could not copy", message "Unable to copy
  the thread ID.") is written by this bundle
  ([`use-workspace.ts`](src/client/hooks/use-workspace.ts)). Every other
  message is the one the error carries.
- The error is cleared by a successful load of its target, by Retry, by
  "Copy thread ID", by selecting a Project, by opening the new-Project or
  new-Thread draft, and by confirming a delete; selecting a Thread keeps it
  ([`domain/sidebar.ts`](src/client/domain/sidebar.ts),
  [`use-workspace.ts`](src/client/hooks/use-workspace.ts)).
- A `project_stream_failed` read of the selected Project is reported once per
  failure.
- The Dashboard's list draws its own `activity()` failure in place of the
  list, with Retry, and keeps the last failure on screen, Retry busy, while
  it reads again.
- With no `runtime.records/v1` bound, every read fails as `unavailable`
  ("Doric backend is unavailable.") and the tree stays as it was
  ([`stores/workspace.ts`](src/client/stores/workspace.ts)).
- A sub-thread whose main Thread cannot be found reports `not_found` "The
  parent thread was not found."
- A Projects load that does not list the selected Project clears the
  selection and rewrites the path to `/`.
- The workspace's actions never reject: each failure becomes the workspace
  error.

## Build and test

```console
npx nx run bundle-workspace:build
npx nx run bundle-workspace:typecheck
npx nx run bundle-workspace:test
```

The build compiles the contracts with
[`tsconfig.json`](tsconfig.json), typechecks the client, stories and Storybook
harness with [`tsconfig.client.json`](tsconfig.client.json), and bundles the
parts into `dist` ([`project.json`](project.json)); `doric-host:build-bundles`
stages it for the host. The `test` target builds the bundle first, compiles
[`tsconfig.spec.json`](tsconfig.spec.json) (the contracts, `domain`,
`queries`, `services`, `stores`, `utility` and `tests/*.ts`) and
[`tsconfig.client-spec.json`](tsconfig.client-spec.json) (`tests/client/`) to
`dist-tests`, and runs them with `node --test`.

- [`tests/`](tests): DOM-free tests of the pure rules, the stores and the
  services, plus [`manifest.test.ts`](tests/manifest.test.ts), which pins the
  manifest's version, `provides` and `requires`, and
  [`records-boundary.test.ts`](tests/records-boundary.test.ts), which fails
  when a file under `src/` names `runtime/v2` or `runtime.threads/v1`.
- [`tests/client/`](tests/client): the elements in a happy-dom window,
  mounted in the frame's slots by
  [`support/render-workspace.ts`](tests/client/support/render-workspace.ts)
  on the fake host of [`stories/support/`](stories/support).
- [`stories/`](stories): CSF3 stories of the components, wrapped by
  [`.storybook/preview.tsx`](.storybook/preview.tsx).
