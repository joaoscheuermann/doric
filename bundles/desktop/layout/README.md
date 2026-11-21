# layout

`layout` draws the frame of the Doric workspace window and declares its slots:
the sidebar column, the title bar, the conversation in the middle, the viewer
of tabs beside it, the Project panel on the right, and the footers. It draws no
navigation and no feature of its own: other bundles fill every slot with their
elements, open tabs in the viewer, add views to the Project panel and register
panes under the sidebar.

It is a desktop bundle with one client part, which runs in each workspace
window. The [main README](../../../README.md) describes Doric as a whole, and
[`packages/bundle`](../../../packages/bundle/README.md) how a bundle is built,
loaded and activated. How the window looks and behaves across bundles is
described in the feature doc [UI redesign](../../../docs/features/ui-redesign.md),
and how bundles fill the shell in the architecture document
[The layout bundle](../../../docs/architecture/bundles/layout.md). The feature
docs [Conversation](../../../docs/features/conversation.md),
[Files](../../../docs/features/files.md) and
[Terminal](../../../docs/features/terminal.md) describe what those features
draw in the frame. This README is the bundle's complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field         | Value                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `id`          | `layout`, version `5.0.1`, engine `doric ^1.8.0`                                                         |
| `description` | "The workspace window's frame and its slots."                                                            |
| `provides`    | `layout.tabs/v2@2.0.0`, `layout.panel/v3@3.0.0`, `layout.conversation/v1@1.0.0`, `layout.stack/v2@2.0.0` |
| `requires`    | `hooks/v1@^1.0.0`, `ui/v1@^1.0.0`, `navigation/v1@^1.1.0`, `regions/v1@^1.0.0`, `commands/v1@^1.0.0`     |
| `optional`    | none                                                                                                     |

The bundle has no host or desktop part, no settings, no tools, no storage types
and no `desktopScope`. Every contract it provides is a client contract of the
workspace window, and each window has its own state.

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts), exported as
  `layout/contracts` through [`package.json`](package.json)): the slot names,
  the four contracts, their schemas and their types, listed under
  [Exports of `layout/contracts`](#exports-of-layoutcontracts).
- **Client** ([`src/client/index.ts`](src/client/index.ts)): on activation it
  keeps the activation services for the frame
  ([`services/layout-services.ts`](src/client/services/layout-services.ts)),
  defines the element `<layout-workspace>` through `ui/v1`
  ([`elements/workspace-element.tsx`](src/client/elements/workspace-element.tsx)),
  registers the route `/` with `navigation/v1`, whose `create` makes a
  `<layout-workspace>`, and provides the four contracts. Its cleanup clears the
  Project panel's selection, the bottom split's requests and the sidebar
  stack, and forgets the activation services; it does not clear the tabs.

The client's folders: `elements/` (the custom element), `views/` (the frame,
[`workspace-view.tsx`](src/client/views/workspace-view.tsx)), `components/`
(molecules, organisms and templates the frame composes), `hooks/`, `stores/`
(Zustand vanilla stores, one per contract), `domain/` and `utility/` (pure
rules), and `services/` (the contract providers).

## Contracts provided

Each method's input is validated against its schema in
[`src/contracts/index.ts`](src/contracts/index.ts) before the method runs
([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)); an
input that fails it fails with `ContractError('invalid_input')`. Every object
schema is strict: an unknown key fails. Every method also takes an optional
last argument `call?: CallArg` of `bundle/contracts`, left out of the blocks
below.

### `layout.tabs/v2` (2.0.0)

The viewer's tabs. Tabs belong to an **owner**, a string the caller names
(a Thread id, or `project:<projectId>` for a Project); the
frame shows the tabs of the current owner only. Provider:
[`services/layout-tabs.ts`](src/client/services/layout-tabs.ts), over the store
[`stores/workspace-tabs.ts`](src/client/stores/workspace-tabs.ts) and the rules
of [`domain/workspace-tabs.ts`](src/client/domain/workspace-tabs.ts).

```ts
interface TabMenuItem {
  id: string;
  label: string;
  icon?: ReactElement; // any value that is not a valid React element fails invalid_input
  destructive?: boolean;
  run: () => void;
}

interface TabRequest {
  id: string; // min 1, unique among one owner's tabs
  title: string;
  tag: string; // min 1: the element ui/v1 creates for the tab's content
  props?: Record<string, unknown>;
  iconTag?: string; // min 1: the trigger's 16 px icon, created with the tab's props
  openBottom?: boolean; // the viewer card drops its bottom padding while the tab is selected
  ariaLabel?: string; // defaults to title
  tooltip?: string; // the trigger's title attribute; defaults to title
  menu?: TabMenuItem[];
}

interface CurrentTab {
  id: string;
  props?: Record<string, unknown>;
}

interface LayoutTabs {
  open(input: TabRequest): Promise<void>;
  close(input: {
    id: string; // min 1
    threadId?: string; // min 1
    everyOwner?: boolean;
  }): Promise<void>;
  focus(input: { id: string /* min 1 */ }): Promise<void>;
  retitle(input: {
    id: string; // min 1
    title: string;
    threadId?: string; // may be empty
    everyOwner?: boolean;
  }): Promise<void>;
  current(): CurrentTab | undefined;
  subscribe(listener: () => void): Disposable;
  setOwner(input: { owner?: string /* min 1 */ }): void;
}
```

- `open` refuses with `ContractError('unavailable', 'No thread or project is
selected.')` while no owner is set. When the owner already has a tab with
  that id it only selects it: title, props and menu stay as they were. Else it
  creates the element with `ui.create(tag, props)`, appends the tab at the end
  of the owner's tabs and selects it.
- `close` removes the tab from the owner `threadId` names, or from the current
  owner when `threadId` is absent, and disposes its element with `ui.dispose`.
  When the current owner is needed and none is set, it refuses with
  `unavailable`. An id the owner does not hold changes nothing. With
  `everyOwner: true` it removes the tab with that id from every owner and
  disposes each, and `threadId` is ignored. When the selected tab closes, the
  last remaining tab is selected.
- `focus` selects the tab in the current owner (`unavailable` with no owner);
  an unknown id changes nothing.
- `retitle` sets the title of the tab in the owners `close` would reach, with
  the same `unavailable` rule; an unknown id changes nothing, but with
  `everyOwner: true` subscribers are notified even when no tab matches
  (`retitleEverywhere` in
  [`stores/workspace-tabs.ts`](src/client/stores/workspace-tabs.ts)).
- `current` answers the selected tab of the current owner, with the props it
  was opened with, or `undefined` with no owner or no selection.
- `subscribe` calls the listener after every change of any owner's tabs and of
  the owner; disposing it is idempotent
  ([`services/subscription.ts`](src/client/services/subscription.ts)).
- `setOwner` names the owner; naming the current owner again notifies no one,
  and an absent `owner` leaves no owner.
- The asynchronous methods answer a refusal of the layout (`unavailable`) as a
  rejected promise; an input that fails its schema throws `invalid_input` from
  the call itself, before any promise exists
  ([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
  No other process can call these contracts: the window keeps its own
  providers local
  ([`packages/desktop/src/client/activate.ts`](../../../packages/desktop/src/client/activate.ts)),
  and no method declares `expose`.
  Selecting the selected tab notifies no one.
- Tabs are kept per owner for the life of the window and are not persisted.

### `layout.panel/v3` (3.0.0)

```ts
interface LayoutPanel {
  select(id: string): void; // id min 1
}
interface PanelItemProps {
  label: string;
  iconTag?: string;
  badgeTag?: string;
}
```

`select` names the Project panel's view by the id of its `shell.panel` item
([`services/layout-panel.ts`](src/client/services/layout-panel.ts),
[`stores/panel.ts`](src/client/stores/panel.ts)). The panel starts with no
view selected. An id no item has yet is kept, and the panel draws no view until
an item with that id registers. Selecting the selected view notifies no one.
The panel has no open state and nothing about it is persisted.

### `layout.conversation/v1` (1.0.0)

```ts
interface LayoutConversation {
  setBottomVisible(itemId: string, visible: boolean): void; // input [string min 1, boolean]
}
```

The split `shell.conversation.bottom` is shown while at least one item id has
asked for it with `true` and not withdrawn with `false`; repeating a request
changes nothing
([`services/layout-conversation.ts`](src/client/services/layout-conversation.ts),
[`stores/bottom.ts`](src/client/stores/bottom.ts)).

### `layout.stack/v2` (2.0.0)

The panes other bundles register under the sidebar's content
([`services/layout-stack.ts`](src/client/services/layout-stack.ts),
[`stores/stack.ts`](src/client/stores/stack.ts),
[`domain/sidebar-stack.ts`](src/client/domain/sidebar-stack.ts)).

```ts
interface StackPane {
  id: string; // min 1, unique in the stack
  order?: number;
  title: string;
  tag?: string; // min 1: the pane's content element
  props?: Record<string, unknown>;
  headerTag?: string; // min 1: an element drawn in the header, the pane's action
  collapsible?: boolean; // default true
  initiallyOpen?: boolean; // default true
}

interface LayoutStack {
  register(pane: StackPane): Disposable;
  panes(): readonly StackPane[];
  isOpen(paneId: string): boolean; // paneId min 1
  setOpen(paneId: string, open: boolean): void; // paneId min 1
  toggle(paneId: string): void; // paneId min 1
  subscribe(listener: () => void): Disposable;
}
```

- `register` fails with `ContractError('registration_conflict',
'The sidebar pane "<id>" is already registered.', { id })` for an id already
  registered ([`stores/stack.ts`](src/client/stores/stack.ts)); a pane with a size key (`defaultSize`,
  `minSize`, `maxSize`) or any other unknown key fails `invalid_input`. A pane
  starts open unless `initiallyOpen` is `false`. Disposing removes the pane and
  its open state, once.
- `panes` answers the panes in ascending `order`, panes without `order` last,
  registration order within a tie (the order `regions/v1` gives region items).
  It answers the same array until the stack changes.
- `isOpen` is `false` for an unknown id; an empty id fails `invalid_input`.
  It is always `true` for a pane with `collapsible: false`. `setOpen` and `toggle` change nothing for an unknown id
  or a pane that cannot collapse.
- `subscribe` calls the listener after every change of the panes or of one
  pane's open state.

### Exports of `layout/contracts`

- Slot names, as string constants: `SHELL_SIDEBAR` (`shell.sidebar`),
  `SHELL_SIDEBAR_FOOTER` (`shell.sidebar.footer`), `SHELL_TITLEBAR_TABS`
  (`shell.titlebar.tabs`), `SHELL_PAGE` (`shell.page`), `SHELL_WINDOW_ACTIONS`
  (`shell.window.actions`), `SHELL_HEADER_ACTIONS` (`shell.header.actions`),
  `SHELL_CONVERSATION_FOOTER` (`shell.conversation.footer`),
  `SHELL_CONVERSATION_BOTTOM` (`shell.conversation.bottom`),
  `SHELL_CONVERSATION_OVERLAY` (`shell.conversation.overlay`), `SHELL_PANEL`
  (`shell.panel`) and `SHELL_PANEL_FOOTER` (`shell.panel.footer`).
- Contract references: `LayoutTabsV2`, `LayoutPanelV3`, `LayoutConversationV1`
  and `LayoutStackV2`.
- Method tables: `layoutTabsMethods`, `layoutPanelMethods`,
  `layoutConversationMethods` and `layoutStackMethods`; schemas:
  `tabRequestSchema` and `stackPaneSchema`.
- Types: `TabMenuItem`, `CurrentTab`, `TabRequest`, `LayoutTabs`,
  `LayoutPanel`, `PanelItemProps`, `LayoutConversation`, `StackPane` and
  `LayoutStack`.

The module imports `bundle/contracts`, `react` (for `isValidElement`) and
`zod`.

## Contracts used

- `ui/v1` (core): defines `<layout-workspace>`, creates and disposes tab
  elements, and hosts the elements of panel views, tab icons and stack panes
  through `ElementHost` of `desktop/ui/element-host`.
- `navigation/v1` (core): registers the route `/`.
- `regions/v1` (core): reads the items of `shell.page`,
  `shell.sidebar.footer` and `shell.panel` with `useRegionItems` of
  `desktop/ui/element-host`. Every slot is drawn as a `<core-region name>`,
  core's element, which draws the slot's items in order.
- `doric.catalog/v1` (platform): reads the bundle catalog for the quarantine
  notice ([`hooks/use-quarantine-notice.ts`](src/client/hooks/use-quarantine-notice.ts)).
- `hooks/v1` and `commands/v1` are listed under `requires`; the client calls
  neither.

## The frame

`<layout-workspace>` renders the frame in a React `StrictMode` root, under a
`TooltipProvider`, with the window's only `Toaster` of `desktop/ui/sonner`, and
sets `document.title` to `Doric`
([`views/workspace-view.tsx`](src/client/views/workspace-view.tsx)). The frame
has two forms: the **page form** while `shell.page` holds at least one item,
the **conversation form** otherwise. One `<core-region name="shell.sidebar">`
element is created once and moved between the forms, so the items of
`shell.sidebar` keep their elements when the form changes. Without items the
frame draws its slots empty.

### Page form

The sidebar column, 280 px wide and not resizable, in an
`aside aria-label="Dashboard navigation"`: `shell.sidebar`, then the quarantine
notice, then `shell.sidebar.footer` (drawn only while it has items). Beside it,
`div[data-slot="dashboard-content"]` holds `shell.titlebar.tabs` over
`shell.page` ([`views/workspace-view.tsx`](src/client/views/workspace-view.tsx)).

### Conversation form

Four columns in a horizontal resizable group
([`components/templates/workspace-layout.tsx`](src/client/components/templates/workspace-layout.tsx)).
No size is persisted.

| Column        | Size                                  | Content                                                                                                             |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sidebar       | 280 px by default, 11rem to 24rem     | `shell.sidebar`, the stack panes, the quarantine notice, `shell.sidebar.footer`                                     |
| Conversation  | at least 16rem, the rest of the width | `shell.titlebar.tabs` over the conversation card                                                                    |
| Viewer        | 448 px by default, 18rem to 60rem     | the tab triggers over the viewer card; present only while an owner is set and has at least one tab                  |
| Project panel | 328 px by default, 14rem to 30rem     | a 40 px header (the view tabs, then `shell.window.actions`), the selected view, the footer row `shell.panel.footer` |

- **Sidebar column**
  ([`components/organisms/project-sidebar.tsx`](src/client/components/organisms/project-sidebar.tsx)):
  each stack pane is a group (`data-slot="sidebar-pane"`, `data-pane-id`) with
  a 28 px header and, while open, the pane's `tag` element with its props. A
  collapsible pane's header is a button with `aria-expanded` and the label
  `Collapse <title>` or `Expand <title>`; a pane that cannot collapse shows
  its title only. The `headerTag` element is shown only while the header is
  hovered or holds focus. A group is as tall as its content, at most 40% of
  the column, never shorter than its header; past the cap its content scrolls.
- **Conversation card**: an inset card
  ([`components/templates/inset-card.ts`](src/client/components/templates/inset-card.ts):
  10 px radius, 8 px padding, `shadow-sm`, the background fill) with no bottom
  padding. It holds `<section aria-label="Thread conversation">` around a
  `<core-outlet>`, core's element
  ([Core](../../../docs/architecture/bundles/core.md)), where the child routes
  of `/` render
  ([`components/templates/thread-pane.tsx`](src/client/components/templates/thread-pane.tsx)).
  Over its bottom floats the conversation footer,
  `footer[data-slot="workspace-footer"]`, 44 px with 8 px over and under its
  row, holding `shell.conversation.footer`, whose items align to the end with
  a 4 px gap, in 11 px text of normal weight; the frame sets
  `--shell-conversation-footer-height: 2.75rem` on the conversation frame
  ([`components/templates/conversation-frame.tsx`](src/client/components/templates/conversation-frame.tsx)).
  While the bottom split is shown, the card is split vertically: the
  conversation keeps at least 20%, and `shell.conversation.bottom` opens at
  35% with at least 6rem; its items mount only while it is shown
  ([`components/templates/conversation-terminals.tsx`](src/client/components/templates/conversation-terminals.tsx)).
  Over the whole card lies `div[data-slot="workspace-overlay"]` with
  `shell.conversation.overlay`; the layer takes no pointer events, and its
  items place themselves.
- **Viewer**
  ([`components/organisms/workspace-tabs.tsx`](src/client/components/organisms/workspace-tabs.tsx)):
  the triggers are a tab strip labelled "Files, changes, terminals and
  threads"; each shows its title, `ariaLabel` and `tooltip`, and the `iconTag`
  element with the tab's props. The reader reorders triggers by dragging, which
  changes the owner's tab order, and closes a tab with its close button through
  `layout.tabs/v2.close`; a failed close is logged with
  `console.error('Doric: the tab could not close:', reason)`. A trigger's
  context menu shows the opener's non-destructive entries, a separator,
  "Close tab", then the destructive entries behind a separator; an entry
  without an icon is inset. The tab contents sit in a `section` with the same
  label, and every tab's element stays mounted while another is selected. The viewer card is an inset card with no bottom padding while
  the selected tab has `openBottom: true`.
- **Project panel**
  ([`components/organisms/project-panel.tsx`](src/client/components/organisms/project-panel.tsx)):
  always shown, never collapsed. The header's "Project views" strip draws one
  icon-only toggle per `shell.panel` item, with its `label` (a non-string
  `label` gives the toggle an empty name), its `iconTag` element and its
  `badgeTag` element (an empty `iconTag` or `badgeTag` draws nothing). The
  reader reorders the toggles by dragging; the order is kept while the
  conversation form stays mounted, a new view is appended in region order, and
  a view that leaves `shell.panel` leaves the order
  ([`domain/panel-order.ts`](src/client/domain/panel-order.ts)). Choosing a
  toggle selects that view, as `layout.panel/v3.select` does. Only the
  selected item's element is mounted. The footer row is 28 px with 8 px above
  and below.
- An inset card gets an 8 px bottom margin, and an 8 px right margin when it is
  the last column of the row.

### Hooks other code reads

Other bundles and the end-to-end suite rely on these names
([`workspace-layout.tsx`](src/client/components/templates/workspace-layout.tsx),
[`workspace-tabs.tsx`](src/client/components/organisms/workspace-tabs.tsx),
[`conversation-frame.tsx`](src/client/components/templates/conversation-frame.tsx)):

- `--shell-conversation-footer-height` (`2.75rem`), set on
  `div[data-slot="conversation-frame"]`; chat's
  [`chat-view.tsx`](../chat/src/client/views/chat-view.tsx) and
  [`styles.css`](../chat/src/client/styles.css) read it.
- The `data-slot` values `workspace-layout`, `workspace-viewer-header`,
  `workspace-files-header` and `workspace-files-footer`, and
  `section[aria-label="Viewer"]`; the end-to-end suite selects them
  ([`shell-page.ts`](../../../app/desktop/doric-e2e/tests/support/shell-page.ts),
  [`prototype-states.ts`](../../../app/desktop/doric-e2e/tests/support/prototype-states.ts)).
- The viewer header and the Project panel header are 40 px high and drag the
  window (`[-webkit-app-region:drag]`); the controls inside them do not.
- Both tab strips are `TabStrip` of `desktop/ui/panels`
  ([`tab-strip.tsx`](../../../packages/desktop/src/panels/tab-strip.tsx)),
  which gives each trigger `data-tab-id` and each close button
  `data-slot="tab-close"`, and provides drag reordering and the context menu.

### Slots

| Slot                         | Where it is drawn                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `shell.sidebar`              | the sidebar column, in both forms                                                                             |
| `shell.sidebar.footer`       | the sidebar column's foot, under the quarantine notice; only while it has items                               |
| `shell.titlebar.tabs`        | the title bar: over the page in the page form, over the conversation card in the conversation form            |
| `shell.page`                 | the page form's body; an item here switches the frame to the page form                                        |
| `shell.window.actions`       | the end of the Project panel's header, in the conversation form; the layout does not draw it in the page form |
| `shell.header.actions`       | not drawn by the layout: the name is declared for the item of `shell.titlebar.tabs` to draw at its end        |
| `shell.panel`                | the Project panel's views; an item's props are a `PanelItemProps`                                             |
| `shell.conversation.footer`  | the conversation footer                                                                                       |
| `shell.panel.footer`         | the Project panel's footer row                                                                                |
| `shell.conversation.bottom`  | the split under the conversation, while `layout.conversation/v1` has a request                                |
| `shell.conversation.overlay` | the layer over the conversation card                                                                          |

A slot item is a `regions/v1` item `{ id, tag, order?, props? }`; an item under
any other name is not drawn. Another bundle writes a slot name as a literal
checked against the constant: `'shell.panel' satisfies typeof SHELL_PANEL`,
with `import type { SHELL_PANEL } from 'layout/contracts'`.

### Quarantine notice

When `doric.catalog/v1.get()` lists bundles with the state `quarantined`, the
sidebar column shows one notice (`ErrorNotice` of `desktop/ui/error-notice`,
block variant, `PackageXIcon`) after `shell.sidebar` and the stack panes and
before `shell.sidebar.footer`
([`components/molecules/bundle-health-notice.tsx`](src/client/components/molecules/bundle-health-notice.tsx)).
Its data ([`domain/bundle-health.ts`](src/client/domain/bundle-health.ts)):

- error code `bundle_quarantined`, message `Turned off: <ids>.` with the ids
  joined by `, ` in the catalog's order, no causes and no `at`;
- title `1 extension couldn't start` or `<n> extensions couldn't start`,
  warning tone, not retryable;
- one context line per bundle, keyed `<id>@<version>`, valued with its reasons
  joined by `; `, each reason `<message>` or `<message> (<contract>)`, or
  `no reason given`.

Bundles in any other state, `disabled` included, are not listed. The catalog
is read once per mount of the notice, so a later change shows on the next
mount. When the catalog cannot be read, no notice is drawn.

## Data, side effects and configuration

- All state is in memory, per window, in four Zustand vanilla stores: the tabs
  and the owner, the panel's selected view, the bottom split's requests, and
  the stack's panes with their open state
  ([`stores/`](src/client/stores)). Nothing is persisted.
- The client's stylesheet, [`src/client/styles.css`](src/client/styles.css),
  holds one unlayered rule: `[data-slot='workspace-footer']` takes its height
  from `--shell-conversation-footer-height`, the background at 70% and a 2 px
  backdrop blur. It emits no utility classes.
- Side effects: `document.title` is set to `Doric`; elements are created and
  disposed through `ui/v1`.
- The bundle has no settings.

## Limits

- One owner's tabs are shown at a time; tabs of other owners stay in memory
  until closed ([`views/workspace-view.tsx`](src/client/views/workspace-view.tsx)).
- A stack pane takes at most 40% of the sidebar column.
- The panel's view order is lost when the conversation form unmounts, as on a
  switch to the page form.
- The layout needs platform 1.8.0 (`engines.doric ^1.8.0`), for
  `desktop/ui/element-host`
  ([`packages/bundle/src/runtime/version.ts`](../../../packages/bundle/src/runtime/version.ts)).

## Errors and failure behavior

- `invalid_input`: any input that fails a schema, including an unknown key,
  thrown by the call before the method runs
  ([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
- `unavailable` (`No thread or project is selected.`): a tabs operation that
  needs the current owner while none is set
  ([`services/layout-tabs.ts`](src/client/services/layout-tabs.ts)).
- `registration_conflict` (`The sidebar pane "<id>" is already registered.`):
  a stack pane id registered twice ([`stores/stack.ts`](src/client/stores/stack.ts)).
- An element that `ElementHost` cannot create (a panel view, a tab icon, a
  stack pane or its action) is replaced by a compact notice naming it
  ([`packages/desktop/src/element-host.tsx`](../../../packages/desktop/src/element-host.tsx)).
- A failed tab close from the frame is logged, not shown.

## Build and test

```console
npx nx run bundle-layout:build
npx nx run bundle-layout:typecheck
npx nx run bundle-layout:test
```

The build compiles the contracts and the client and writes
`bundles/desktop/layout/dist` ([`project.json`](project.json));
`doric-host:build-bundles` stages it into
`app/backend/doric-host/dist/bundles`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
The `test` target builds the bundle, compiles the tests to `dist-tests` and
runs them with `node --test`.

- [`tests/*.test.ts`](tests) are DOM-free, compiled with
  [`tsconfig.spec.json`](tsconfig.spec.json) together with `src/contracts/` and
  the client's `domain/`, `services/`, `stores/` and `utility/`: they cover the
  contract services, the stores, the tab, panel-order and stack rules, and the
  quarantine notice's data.
- [`tests/client/*.test.ts`](tests/client), compiled with
  [`tsconfig.client-spec.json`](tsconfig.client-spec.json), render the frame
  in `happy-dom` through
  [`tests/client/support/render-shell.ts`](tests/client/support/render-shell.ts),
  which activates the layout on the stories' fake host
  ([`stories/support/fake-host.ts`](stories/support/fake-host.ts)) with
  stand-in items in the slots: both forms, the notices, the tab menu and the
  footer rule read from the stylesheet on disk.
- [`stories/`](stories) holds CSF3 stories of the frame and its components,
  which the papercraft previews and Storybook render;
  [`.storybook/preview.tsx`](.storybook/preview.tsx) wraps them. `typecheck`
  and `build` type-check both, through
  [`tsconfig.client.json`](tsconfig.client.json).
