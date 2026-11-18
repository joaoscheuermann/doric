# Layout bundle

`layout` is the Doric workspace window's frame and its slots: the sidebar
column, the title bar, the conversation in the middle, the viewer tabs and the
Project panel beside it, and footers for status. It draws no navigation and no
feature of its own. The [`workspace`](../workspace/README.md) bundle fills the
sidebar, the title bar and the page form with the Dashboard, the Project tabs
and each Project's tree of Threads; Files, Git, terminals and usage are other
bundles that fill the slots it offers; `resources` fills `account`'s
`account.status` slot, not a layout slot.

It is a desktop bundle with one client part (the frame and its contracts),
loaded by the `bundle` platform. See the [main README](../../../README.md) for
Doric as a whole and [`packages/bundle`](../../../packages/bundle/README.md)
for how bundles work.

## What it provides

- **UI:** `<layout-workspace>`, the frame, registered at `/`. `workspace`
  registers `/projects` and `/projects/:projectId` as its child routes, and the
  [`chat`](../chat/README.md) bundle mounts the conversation inside it as the
  child route `/projects/:projectId/threads/:threadId`. The frame has two
  forms: the page form while `shell.page` holds an item, and the conversation
  form otherwise.
- **No navigation:** since 5.0.0 the sidebar, the Project tabs and the
  Dashboard are `workspace`'s elements in the shell's slots; the `account`
  bundle fills `shell.window.actions`. Without `workspace` the frame draws its
  slots empty.
- **Contracts:** `layout.tabs/v2`, `layout.panel/v3`, `layout.conversation/v1`
  and `layout.stack/v2`, all client contracts in the workspace window.
- **Slot names:** `layout/contracts` exports one constant per shell slot
  (`SHELL_SIDEBAR`, `SHELL_SIDEBAR_FOOTER`, `SHELL_TITLEBAR_TABS`,
  `SHELL_PAGE`, `SHELL_WINDOW_ACTIONS`, `SHELL_HEADER_ACTIONS`,
  `SHELL_CONVERSATION_FOOTER`, `SHELL_CONVERSATION_BOTTOM`,
  `SHELL_CONVERSATION_OVERLAY`, `SHELL_PANEL` and `SHELL_PANEL_FOOTER`). A
  filler writes the name as a literal checked against it:
  `'shell.panel' satisfies typeof SHELL_PANEL`, with
  `import type { SHELL_PANEL } from 'layout/contracts'`.
- **Regions:** named slots where other bundles add elements.

The bundle requires `hooks/v1`, `ui/v1`, `navigation/v1`, `regions/v1` and
`commands/v1`, lists nothing under `optional`, and has no settings. Since 5.0.0
it reads no records: Projects and Threads are `workspace`'s, which reads them
from the runtime's records mirror.

Since 3.2.4 the layout imports `ElementHost` and `useRegionItems` from the
platform's `desktop/ui/element-host` and has `engines.doric` `^1.8.0`: a
desktop app older than platform 1.8.0 cannot load it and lists it on its start
screen. `files`, `git` and `terminal` require `layout.tabs/v2`, so such an app
quarantines them along with the layout.

## What you see

- **Quarantined bundles.** When the window's bundle catalog
  (`doric.catalog/v1`) lists quarantined bundles, one warning notice at the
  bottom of the left sidebar (in the conversation form at its bottom edge after
  the stack panes; in the page form directly above the `shell.sidebar.footer`
  items) names them all ("N
  extension(s) couldn't start"), its details one bundle per line with its
  reasons; the regions they would fill stay empty. An element whose creation
  throws shows a compact notice in its place.
- **Conversation.** The selected Thread fills the main area; a child Thread
  opens as a tab beside its root Thread instead of replacing it. Each of these
  viewer tabs has a context menu: the entries the bundle that opened it
  stated, each with its icon, then "Close tab", then its destructive entries
  last. A tab's icon is the element its opener names (`iconTag`); the frame
  shows the tabs of the owner `layout.tabs/v2` `setOwner` last named, which
  `workspace` sets from the route's Thread, else the selected Project. A failed
  close of a tab is reported on the console (`Doric: …`).
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
  (`layout.tabs/v2`), as the chat opens a child Thread's
  `<chat-thread-panel>`, whose footer band stands on the card's bottom edge;
  any other tab keeps the card's 8 px
  ([SR12](../../../docs/designs/conversation-footer.md#risks)). The Files column
  footer (`shell.panel.footer`) is one 28 px row under the Project panel.
  Settings open from the entries the `settings` bundle adds to the
  Dashboard's footer and to the account menu.

## Contracts

| Contract                 | What another bundle can do                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Used by                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `layout.tabs/v2`         | open, focus or close a tab drawn by its own element in the tabs of the active owner, with an icon element (`iconTag`, created with the tab's props), `openBottom`, an aria label, a tooltip and context-menu entries, each with an optional React-element icon; retitle it; read the current tab; subscribe; name the owner whose tabs the frame shows (`setOwner`); close a tab in every owner (`everyOwner`). The request is strict: an unknown key, such as v1's `icon`, fails `invalid_input` | `files`, `git`, `terminal`, and the layout's own Thread tabs |
| `layout.panel/v3`        | select the Project panel's view; the panel starts with no view selected, and an id no item has yet is kept until that item registers                                                                                                                                                                                                                                                                                                                                                              | `files`                                                      |
| `layout.conversation/v1` | show or hide the `shell.conversation.bottom` split for one item (`setBottomVisible`)                                                                                                                                                                                                                                                                                                                                                                                                              | none yet                                                     |
| `layout.stack/v2`        | register a sidebar pane with title, order, header action and collapse state; panes are pinned to the column's bottom, with no sizes                                                                                                                                                                                                                                                                                                                                                               | `screen`, `mcp`                                              |

`layout.workspace/v1`, `layout.dashboard/v1` and `layout.sidebar/v1` left
the layout in 5.0.0: `workspace` provides them, unchanged, until it retires
them, and `workspace/contracts` declares them.

A duplicate pane id fails with `registration_conflict`, and opening a
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
| `shell.sidebar`              | the sidebar column, in both forms; one region element moves between the forms, so its items do not remount on a switch                | `workspace`'s `<workspace-sidebar>`                                                |
| `shell.sidebar.footer`       | the sidebar column's foot, under the quarantine notice; drawn only while it has items                                                 | `<workspace-sidebar-footer>`, while the route is `/` or `/projects`                |
| `shell.titlebar.tabs`        | the title bar, in both forms                                                                                                          | `<workspace-project-tabs>`                                                         |
| `shell.page`                 | the page form's body; an item here switches the frame to the page form                                                                | `<workspace-dashboard>`, while the route is `/` or `/projects`                     |
| `shell.window.actions`       | the window's actions: the end of the Project tab bar in the page form, the end of the Project panel's header in the conversation form | `account` (`<account-status>`)                                                     |
| `shell.header.actions`       | the end of the Project tab bar, in the conversation form                                                                              | `terminal`'s "New terminal" button                                                 |
| `shell.panel`                | the Project panel's views                                                                                                             | `files`, `git`                                                                     |
| `shell.conversation.footer`  | the conversation footer, a 44 px band floating over the conversation's bottom                                                         | `settings`' execution picker, `chat`'s composer, `usage`                           |
| `shell.panel.footer`         | the Files column footer, in one 28 px row                                                                                             | `git` (the working directory and branch)                                           |
| `shell.conversation.bottom`  | a split under the conversation                                                                                                        | shown while an item asks through `layout.workspace/v1` or `layout.conversation/v1` |
| `shell.conversation.overlay` | a floating layer over the conversation                                                                                                | items place themselves; the layer never intercepts a pointer                       |

Layout 4.2.0 to 4.7.0 gave the six slots that existed before these names, one
slot per version; an item added under an old name is not drawn. Layout 4.7.1
dropped `layout.account.status`, which became `account`'s `account.status`
(see [account's README](../account/README.md)). The CSS
variable the conversation frame sets is `--shell-conversation-footer-height`
(it was `--chat-footer-height`).

A `shell.panel` item carries `{ label, iconTag?, badgeTag? }` (`PanelItemProps`):
its tab trigger draws the `iconTag` element as the view's icon and the
`badgeTag` element inside it, and its element mounts only while the item is
selected. The Dashboard's slots, `workspace.dashboard.nav`,
`workspace.dashboard.page` and `workspace.dashboard.footer`, are `workspace`'s
(see [its README](../workspace/README.md)); 5.0.0 renamed the two
`layout.dashboard.*` slots, and an item under an old name is not drawn.

## Development

```console
npx nx build bundle-layout
npx nx typecheck bundle-layout
npx nx test bundle-layout
```

Most tests are DOM-free; `tests/client/shell.test.ts` renders the shell in a
DOM with stand-in items in the navigation's slots, and
`tests/client/footer-styles.test.ts` reads the bundle's stylesheet from disk.
They cover the frame, the tabs, the sidebar stack and the contract services. Stories under
`stories/` are CSF3, and `.storybook/preview.tsx` is the harness that wraps
them. The build writes `bundles/desktop/layout/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/layout`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
