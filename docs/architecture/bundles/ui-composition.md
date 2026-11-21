# UI composition

- Status: living document. It describes how bundles compose the UI of a Doric window as implemented on 2026-11-20.

## Summary

Every screen of a Doric window is drawn by bundles. The public boundary between them is the custom element: a bundle defines elements whose tag starts with its own id, and another bundle shows them by tag, without importing their code. The renderer holds no product UI. Its bootstrap activates the window's client parts and puts the core's outlet in the `body`; the path of the window's URL chooses the route that appears there ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts)).

Four client contracts that the `core` bundle provides in each window carry the composition ([`core/src/client/index.ts`](../../../bundles/foundation/core/src/client/index.ts), [`core/manifest.json`](../../../bundles/foundation/core/manifest.json)):

- `ui/v1` defines elements by tag and creates them with their owner's services;
- `navigation/v1` registers routes, which are URL paths, and moves the window between them;
- `regions/v1` keeps the items of named regions, the places where one bundle's frame shows other bundles' elements;
- `commands/v1` registers and runs commands.

A route's element, a region's items and the elements other contracts take by tag are created through `ui/v1`, so each element receives the services of the bundle that owns its tag. Elements talk to their surroundings through JavaScript properties, simple attributes and DOM events; a domain operation is a call to a service stub ([Services and channels](services-and-channels.md)). This document describes those mechanisms and the parts of a window built with them. The full shape of each core contract is in the [README of `core`](../../../bundles/foundation/core/README.md#window-client-contracts); the frame of the workspace window and its slots are in [The layout bundle](layout.md).

## Elements are the boundary

- **A tag belongs to the bundle that defines it.** `ui.define(tag, Class)` refuses, with `invalid_input`, a tag that does not start with the calling bundle's id followed by `-` (`core-outlet`, `layout-workspace`, `workspace-sidebar`, `chat-view`, `settings-page`). It records the bundle as the tag's owner through the platform contract `doric.elements/v1` and returns a `Disposable` ([`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)). The prefix keeps two bundles' tags apart with no registry of names.
- **A tag is defined once per window.** A tag already defined in the window fails with `registration_conflict`. Disposing a definition leaves the tag defined and without an owner, because the browser cannot undefine a custom element, so a new implementation of a tag needs a new window document ([`elements.ts`](../../../packages/desktop/src/client/elements.ts)). The shape of `doric.elements/v1` (`define`, `owner`, `attach`, `release`), which only the window's active provider of `ui/v1` may call, is in [Contexts and capabilities](contexts.md#shapes-of-the-platform-contracts).
- **An element is created with its owner's services.** `ui.create(tag, props?)` creates the element, gives it a `services` property that is a child scope of the owning bundle's services, then assigns `props` as properties, and returns it unconnected, so the first render already has both. Calls made through those services carry the owner as `call.caller`, whoever created the element. When no active bundle owns the tag, `create` answers a hidden `<core-unavailable>` whose `data-tag` names the tag ([`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts), [`elements.ts`](../../../packages/desktop/src/client/elements.ts)). The child scope and its lifetime are in [Contexts and capabilities](contexts.md#lifetimes).
- **Typed values go in properties.** Objects, ids and handles are JavaScript properties; an attribute holds only a simple value, such as the `name` of `<core-region>`, the `path` of `<core-not-found>` or the `data-tag` of `<core-unavailable>` ([`core` README](../../../bundles/foundation/core/README.md#structural-elements)).
- **A visual intent is a DOM event.** An element tells the element around it what the reader did with a `CustomEvent` that has `bubbles: true` and `composed: true`, and the element that contains it decides what to do. The settings page's provider form, for example, takes a field's value from the `settings-provider-field` event that the item in its `settings.provider.field` slot dispatches, and stops the event at its frame ([`claude-login-field.tsx`](../../../bundles/features/claude-login/src/client/claude-login-field.tsx), [`provider-field-element.tsx`](../../../bundles/desktop/settings/src/client/components/molecules/provider-field-element.tsx)). A DOM event stays in the window; an operation that changes data goes through a service or a command.
- **Disposal is explicit.** The bundle that creates an element keeps it while it only moves in the DOM, and calls `ui.dispose(element)` when the view closes for good. `dispose` acts once per element: it calls the element's `remove()` and `dispose()` when it has them, then ends the element's scope ([`core/src/client/ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)). The core's structural elements and the elements built with `defineReactElement` tear down only when they are still disconnected a microtask after a disconnection, so a move within the document keeps their state ([`lifecycle.ts`](../../../bundles/foundation/core/src/client/elements/lifecycle.ts), [`react-element.ts`](../../../packages/desktop/src/react-element.ts)).

Inside its elements a bundle draws as it likes: plain DOM, React mounted in the element ([React inside Web Components](react-web-components.md)), or another library. Only the elements that cross a bundle's boundary are custom elements; a button or a shared component inside one is not.

## Kinds of element

| Kind                | Who creates it                                                                                                                                                                 | How it is named                                                                                  | Example                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural          | The bootstrap (the outlet in the `body`) and the frames that draw regions and outlets                                                                                          | The core's four tags                                                                             | `<core-outlet>`, `<core-region>`, `<core-not-found>`, `<core-unavailable>`                                                                            |
| Route element       | An outlet, through the route's `create(match)`                                                                                                                                 | The tag the route's `create` passes to `ui.create`; it receives the route's params as properties | `<layout-workspace>` at `/`, `<chat-view>` at a Thread's path                                                                                         |
| Region item element | `<core-region>`, once per item, with `ui.create(tag, props)`, disposing the element when the item leaves; or the region's owner, which reads the items and creates them itself | The item's `tag`                                                                                 | `<workspace-sidebar>` in `shell.sidebar`; the element a `settings.provider.field` item names, which the settings page creates in place of one field   |
| Region data item    | Nobody: the region's owner reads the item and draws it itself                                                                                                                  | The item's `props` carry the data; `tag` names the filler's icon element                         | The `settings` entry in `account.menu`, whose `props` name a label and a command                                                                      |
| Element by contract | The bundle that provides the contract, through `ui/v1`, from a tag another bundle gives it                                                                                     | A tag in the contract's input                                                                    | A viewer tab of `layout.tabs/v2`, a pane of `layout.stack/v2`, the rows under a Thread of `workspace.sidebar/v1`, a block renderer of `chat.views/v1` |
| Element by tag      | Any bundle that calls `ui.create` directly                                                                                                                                     | A tag it knows from the owner's contracts module or README                                       | An element of another bundle placed in a view of one's own                                                                                            |

The outlet and the region are described in the [README of `core`](../../../bundles/foundation/core/README.md#structural-elements); the outlet's matching, its depth and nested outlets in [Navigation](navigation.md#the-outlet-core-outlet). The account menu's items are data items: `account` draws each entry from its `props` (`label`, `command`, `input`) and runs the command through `commands/v1` when the reader picks it ([`account/src/contracts/index.ts`](../../../bundles/desktop/account/src/contracts/index.ts)). The contracts that take tags are in the READMEs of [`layout`](../../../bundles/desktop/layout/README.md), [`workspace`](../../../bundles/desktop/workspace/README.md) and [`chat`](../../../bundles/desktop/chat/README.md).

## Regions and slots

A region is a named list of items, `{ id, tag, props?, order? }`, kept by `regions/v1`. `add(region, item)` returns a `Disposable` and refuses an id already in the region with `registration_conflict`; `items(region)` answers the items sorted by `order`, absent last, then by add order, each with the `owner` that added it; `subscribe(region, listener)` runs the listener after every change ([`core/src/client/regions.ts`](../../../bundles/foundation/core/src/client/regions.ts), [`regions.ts`](../../../packages/bundle/src/contracts/basic/regions.ts)). A region needs no declaration to exist: any name can hold items, and an item in a region nobody draws is not shown.

A **slot** is a region that one bundle draws and lets others fill. Its owner exports the name from its contracts module as a constant with no type annotation, so that its type is the literal, and draws it with that constant, either as a `<core-region name>` or by reading `items`. A filler writes the name as a string literal checked against the constant through a type-only import, so it loads in a window without the owner and a misspelled name fails its typecheck ([Bundle boundaries](boundaries.md#what-a-client-part-may-import-and-slot-names)):

```ts
import type { SHELL_SIDEBAR } from 'layout/contracts';

regions.add('shell.sidebar' satisfies typeof SHELL_SIDEBAR, {
  id: 'navigation',
  tag: 'workspace-sidebar',
});
```

The slots of the shipped bundles, by owner:

| Owner                                                       | Slots                                                                                                                                                                                                                                                     | Declared in                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`layout`](../../../bundles/desktop/layout/README.md)       | `shell.sidebar`, `shell.sidebar.footer`, `shell.titlebar.tabs`, `shell.page`, `shell.window.actions`, `shell.header.actions`, `shell.conversation.footer`, `shell.conversation.bottom`, `shell.conversation.overlay`, `shell.panel`, `shell.panel.footer` | [`layout/src/contracts/index.ts`](../../../bundles/desktop/layout/src/contracts/index.ts)       |
| [`workspace`](../../../bundles/desktop/workspace/README.md) | `workspace.dashboard.nav`, `workspace.dashboard.page`, `workspace.dashboard.footer`                                                                                                                                                                       | [`workspace/src/contracts/index.ts`](../../../bundles/desktop/workspace/src/contracts/index.ts) |
| [`settings`](../../../bundles/desktop/settings/README.md)   | `settings.sections`, `settings.provider.field`                                                                                                                                                                                                            | [`settings/src/contracts/slots.ts`](../../../bundles/desktop/settings/src/contracts/slots.ts)   |
| [`account`](../../../bundles/desktop/account/README.md)     | `account.status`, `account.menu`                                                                                                                                                                                                                          | [`account/src/contracts/index.ts`](../../../bundles/desktop/account/src/contracts/index.ts)     |

`layout` declares every `shell.*` slot, but two of them are drawn by `workspace`: the Project tab bar, which `workspace` puts in `shell.titlebar.tabs`, ends with a `<core-region>` of `shell.window.actions` while the route is `/` or `/projects` and of `shell.header.actions` on every other route; `layout` itself draws `shell.window.actions` at the end of the Project panel's header and does not draw `shell.header.actions` ([`navigation-elements.tsx`](../../../bundles/desktop/workspace/src/client/elements/navigation-elements.tsx), [`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)). Where each `shell.*` slot appears and which bundles fill it are in [The layout bundle](layout.md#the-slots); each other owner's README describes its slots and the props of their items.

## How a window is composed

A window is a key and a path. The core opens the workspace window, key `workspace`, when the app is ready, at the last path that window had or at `/`, and the command `core.open-settings/v1` opens the settings window, key `settings`, at its `path`, focusing and navigating the window when one is open; without a `path` it focuses an open settings window, which keeps its section, or opens one at `defaultPath`, and with neither it fails with `invalid_input` ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`core/src/desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts)). A bundle that needs a window of its own asks `windows/v1` for a key and a path ([Windows](windows.md)). Every window then follows the same sequence:

1. **The shell.** For a navigation to any path outside the asset prefixes that does not name a file, the main process answers with the one shell page; a path whose last segment carries a file extension is a 404 ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [The `doric://` protocol](doric-protocol.md)). [`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts) adds the import map and a link to the platform theme, `desktop/ui/theme.css`, at the start of the page's `<head>`. The shell's own stylesheet comes after the theme ([`doric-renderer` README](../../../app/desktop/doric-renderer/README.md)).
2. **The bootstrap.** The shell's script calls `bootstrapWindow({})` ([`doric-renderer/src/bootstrap.ts`](../../../app/desktop/doric-renderer/src/bootstrap.ts)). It reads the window's description and applies its chrome, reads the window's catalog, and activates the client parts ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts)).
3. **Activation.** The window's platform contracts, `doric.elements/v1` among them, are provided first; then a `<link>` to each scheduled client part's stylesheet is appended to `<head>`, in activation order; then each client part's `activate` runs, the foundation and the core before the others ([`activate.ts`](../../../packages/desktop/src/client/activate.ts), [`styles.ts`](../../../packages/desktop/src/client/styles.ts), [The core bundle](core.md#activation-order-foundation-core-others)). While they activate, the bundles define their elements, register their routes and add their region items.
4. **The outlet.** The bootstrap replaces the `body`'s children with one `<core-outlet>`, where `core` is the id of the composition's core bundle. The outlet shows the root of the route chain that matches `location.pathname`, and each nested outlet shows the next route of the chain ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts), [`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts)). When no route matches, the outermost outlet shows `<core-not-found>`.
5. **Ready or failure.** The bootstrap tells the main process the window is ready. An exception during these steps is reported to the main process as a `bootstrap` failure. A core that did not define its outlet, or, in the primary window, a quarantined core, is reported as a `core` failure; when the primary window reports one, the main process opens the splash again with its recovery actions ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [Splash and recovery](splash-and-recovery.md)).

The full sequence, with each option of `bootstrapWindow`, is in the [README of `packages/desktop`](../../../packages/desktop/README.md#bootstrapwindow).

### The workspace window

In the shipped composition ([`composition.json`](../../../app/backend/doric-host/composition.json)) the workspace window is built from these pieces:

- `layout` registers `/` with `<layout-workspace>`, the frame. The frame draws a `<core-region>` for each `shell.*` slot it draws and, in its conversation form, an inner `<core-outlet>` ([`layout/src/client/index.ts`](../../../bundles/desktop/layout/src/client/index.ts), [`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)).
- `workspace` adds `<workspace-sidebar>` to `shell.sidebar` and `<workspace-project-tabs>` to `shell.titlebar.tabs`, and while the route is `/` or `/projects` it adds `<workspace-dashboard>` to `shell.page` and `<workspace-sidebar-footer>` to `shell.sidebar.footer`. An item in `shell.page` switches the frame to its page form. `workspace` also registers `/projects` and `/projects/:projectId` as children of `/` ([`workspace/src/client/index.ts`](../../../bundles/desktop/workspace/src/client/index.ts)).
- `chat` registers `/projects/:projectId/threads/:threadId` as a child of `/` with `<chat-view>`, which appears in the frame's inner outlet, and adds its composer to `shell.conversation.footer` ([`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts)).
- `account` adds `<account-status>` to `shell.window.actions`; `files`, `git`, `terminal` and `usage` add their items to the panel, the footers and the header actions ([The layout bundle](layout.md#the-slots)); `resources` adds its monitor to `account.status` ([`resources/src/client/index.ts`](../../../bundles/features/resources/src/client/index.ts)); and `terminal` adds rows under each Thread of the sidebar through `workspace.sidebar/v1` ([`terminal/src/client/index.ts`](../../../bundles/features/terminal/src/client/index.ts)).

So a Thread's path shows: `<core-outlet>` → `<layout-workspace>` → its inner `<core-outlet>` → `<chat-view>`, with the other bundles' elements in the frame's slots. How the window behaves is in the feature doc [UI redesign](../../features/ui-redesign.md); the routes of the window are in [Navigation](navigation.md#the-workspace-windows-paths).

### The settings window

`settings` registers `/settings` with `<settings-page>`, which draws the `settings.sections` region as its navigation and a `<core-outlet>` for the section. Each section is a child route of `/settings`, and its link is a `settings-link` item of `settings.sections` ([`settings/src/client/index.ts`](../../../bundles/desktop/settings/src/client/index.ts), [`settings-view.tsx`](../../../bundles/desktop/settings/src/client/views/settings-view.tsx)). The window's pages and sections are in the [README of `settings`](../../../bundles/desktop/settings/README.md#the-settings-window).

## What a client part contributes

A client part contributes to the window by calling contracts in its `activate`; nothing is declared in a separate catalog. Every registration it makes through its services is tracked in its activation scope, which is disposed in reverse order when the part deactivates ([Contexts and capabilities](contexts.md#lifetimes)).

| Contribution                       | Contract                                               | Call                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element                            | `ui/v1`                                                | `define(tag, Class)`                                                                                                                                                                                                                                                                                                                                                                                  |
| Route                              | `navigation/v1`                                        | `register({ path, create(match), parent? })` ([Navigation](navigation.md))                                                                                                                                                                                                                                                                                                                            |
| Region item                        | `regions/v1`                                           | `add(region, { id, tag, props?, order? })`                                                                                                                                                                                                                                                                                                                                                            |
| Command                            | `commands/v1`                                          | `register(command)`, with a command defined by `defineCommand` ([Contracts](contracts.md))                                                                                                                                                                                                                                                                                                            |
| Menu item, keybinding              | `menus/v1`                                             | `addItem(item)`, `addKeybinding({ command, key, when? })`, served by the main process ([Menus and keybindings](menus-and-keybindings.md))                                                                                                                                                                                                                                                             |
| Tab, panel view, pane              | `layout.tabs/v2`, `layout.panel/v3`, `layout.stack/v2` | The `layout` contracts ([README of `layout`](../../../bundles/desktop/layout/README.md))                                                                                                                                                                                                                                                                                                              |
| Rows under a Thread in the sidebar | `workspace.sidebar/v1`                                 | `addThreadRows({ id, tag, count, subscribe, busy? })`, and `workspace` creates `tag` through `ui/v1`, with the Thread's id as the property `thread-id`, inside each expanded Thread before its child Threads ([`thread-branches.tsx`](../../../bundles/desktop/workspace/src/client/components/molecules/thread-branches.tsx), [README of `workspace`](../../../bundles/desktop/workspace/README.md)) |
| Renderer in the conversation       | `chat.views/v1`                                        | `registerRenderer`, `registerToolRenderer`, `registerFenceRenderer` and the others ([README of `chat`](../../../bundles/desktop/chat/README.md))                                                                                                                                                                                                                                                      |

In a window, `commands/v1` runs a command registered there and sends any other id to the main process through `core.commands/v1` ([`core/src/client/commands.ts`](../../../bundles/foundation/core/src/client/commands.ts)); no host part registers commands. The visual theme is not a contribution: a bundle reads the platform's tokens and adds no token of its own ([Platform packages and theme tokens](platform-packages.md#theme-tokens)).

A bundle lists every contract it uses under `requires` or `optional` in its manifest, otherwise `services.use` throws `undeclared_requirement` ([The manifest line of every use](contexts.md#the-manifest-line-of-every-use)). The client part of `chat` shows most of the table ([`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts), shortened, without its cleanup):

```ts
export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  ui.define('chat-view', ChatViewElement);
  ui.define('chat-composer', ChatComposerElement);

  services.use(NavigationV1).register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (match) => ui.create('chat-view', match.params),
  });
  services
    .use(RegionsV1)
    .add(
      'shell.conversation.footer' satisfies typeof SHELL_CONVERSATION_FOOTER,
      { id: 'composer', tag: 'chat-composer', order: 40 },
    );
  services.use(CommandsV1).register(sendPromptCommand);
  void services.use(MenusV1).addKeybinding({
    command: SEND_PROMPT_COMMAND,
    key: 'CmdOrCtrl+Enter',
    when: { path: '/projects/:projectId/threads/:threadId' },
  });
}
```

## Styles

A window loads its styles in this order ([`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts), [`activate.ts`](../../../packages/desktop/src/client/activate.ts)):

1. **The platform theme**, `desktop/ui/theme.css`: preflight, fonts, tokens and the shared components' utilities ([Platform packages and theme tokens](platform-packages.md#styles-and-the-tailwind-rule)).
2. **The shell's stylesheet**, which keeps only the rules for the whole window: the base layer every page wears, the `.chrome-bar` class and the footer's single font weight. It also emits the sorted set of utilities that the shared components and every bundle's client sources use, so that a class two sheets emit keeps the order one compiled stylesheet gives it ([`doric-renderer/src/styles.css`](../../../app/desktop/doric-renderer/src/styles.css)).
3. **Each bundle's stylesheet**, one `<link data-bundle="<id>">` per scheduled client part that ships `client/styles.css`, in activation order ([`styles.ts`](../../../packages/desktop/src/client/styles.ts)). The build writes that file from the bundle's `src/client/styles.css` and from the CSS its client entry imports; the CSS of a lazily loaded chunk ships beside the chunk as `client/chunks/<name>.css`. A bundle with neither a sheet nor imported CSS ships no `client/styles.css`, as `workspace` and `account` ship none ([`parts.ts`](../../../packages/bundle/src/build/parts.ts)).

A bundle's sheet that emits utilities references `desktop/ui/tailwind.css` and imports Tailwind's utilities into the shared `utilities` layer; its build fails on `@theme`, so a bundle adds no token to the theme ([Platform packages and theme tokens](platform-packages.md#styles-and-the-tailwind-rule)). Because every sheet writes into one `utilities` layer, the later sheet wins between two equal rules: a sheet that emits a plain utility (`inline-flex`) after another sheet's responsive variant (`md:hidden`) overrides it. The sheets of the feature bundles `files`, `git`, `openui`, `resources`, `terminal`, `threads` and `usage` therefore `@source` the platform's components and the client folders of `layout`, `chat`, `settings`, `account` and `workspace`, so in those sheets a class the window bundles use is emitted in its sorted place and never lands after another sheet's variant ([`files/src/client/styles.css`](../../../bundles/features/files/src/client/styles.css)). The sheets of `chat`, `settings` and `papercraft` scan their own client folder and the platform's components only ([`chat/src/client/styles.css`](../../../bundles/desktop/chat/src/client/styles.css)). The sheets of `mcp` and `screen` scan no source: they import the utilities with `source(none)` and emit only the classes an `@source inline(…)` list names ([`mcp/src/client/styles.css`](../../../bundles/features/mcp/src/client/styles.css)). The sheet of `layout` emits no utilities: it holds one rule of its own, the conversation footer's height, fill and blur, and relies on the shell's sheet for its classes ([`layout/src/client/styles.css`](../../../bundles/desktop/layout/src/client/styles.css)).

## Shadow DOM

No element of the shipped bundles attaches a shadow root: every element renders in the window's document, under the theme, the shell's sheet and the bundle sheets in `<head>`. Shadow DOM is an element's choice, not a rule of the platform, and the platform works with it where it can:

- an outlet counts the outlets above it across shadow roots, so a nested outlet inside a shadow root still finds its depth ([`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts));
- `PortalContainerProvider` from `desktop/ui` sends the overlays of the shared components (dialogs, popovers, menus, tooltips) into a container the element names instead of the document's body, so a React root inside a shadow root keeps its overlays under its own styles ([`portal-container.tsx`](../../../packages/desktop/src/portal-container.tsx), [README of `packages/desktop`](../../../packages/desktop/README.md#portalcontainerprovider-and-useportalcontainer));
- events that cross elements are `composed`, so they leave a shadow root ([`claude-login-field.tsx`](../../../bundles/features/claude-login/src/client/claude-login-field.tsx)).

The window links every stylesheet in the document's `<head>` ([`styles.ts`](../../../packages/desktop/src/client/styles.ts)), and a shadow root does not inherit them: an element that attaches one brings its own styles into it.

## Replacing a piece

A composition changes the UI by enabling other bundles; no file of the platform changes ([Composition and distribution](composition-and-distribution.md)).

- **Another frame.** A composition leaves out `layout` and enables a bundle that registers `/`. Each bundle that requires a `layout.*` contract (`workspace`, `chat`, `files`, `git`, `terminal`, `mcp`, `screen`) is quarantined with `missing_dependency` unless an enabled bundle provides that contract at a version its range accepts ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). Without any bundle at `/`, a window opened there shows `<core-not-found>`, and a route whose `parent` is not registered fills the window from the top-level outlet ([The layout bundle](layout.md#a-composition-without-the-layout-or-with-another)).
- **Another conversation or page.** A composition leaves out the bundle that registers the path and enables one that registers it with its own element, whose tag carries its own id. Two enabled bundles cannot hold one path: a second registration of a path with the same segments, where every parameter stands in the same place, fails with `route_conflict` ([`navigation.ts`](../../../bundles/foundation/core/src/client/navigation.ts), [`route-match.ts`](../../../bundles/foundation/core/src/client/route-match.ts)). Where the bundle that owned a tag is absent, `ui.create` of that tag answers `<core-unavailable>`.
- **Another provider of a core contract.** `ui/v1`, `navigation/v1`, `regions/v1` and `commands/v1` have cardinality `one` ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)); a composition that names another bundle for one of them under `providers` makes that bundle the active provider in each environment where it provides the contract, and the core's `provide` of it is inert. The catalog's rules for that choice are in [The core bundle](core.md#replacing-a-contract-the-core-provides).

## Related documents

- [The core bundle and quarantine](core.md): the client contracts and the structural elements, activation order and the choice of providers.
- [The layout bundle](layout.md): the frame of the workspace window, its `shell.*` slots and its contracts.
- [Navigation](navigation.md): routes as paths, `parent`, the outlet and the workspace window's paths.
- [React inside Web Components](react-web-components.md): an element written in React, and creating and disposing it through `ui/v1`.
- [Contexts and capabilities](contexts.md): the element's child scope and the shape of `doric.elements/v1`.
- [Bundle boundaries](boundaries.md): what a client part may import, and how a bundle names a slot.
- [Contracts](contracts.md): `defineCommand`, `defineService` and how a contract is referenced.
- [Services and channels](services-and-channels.md): service stubs, and DOM events among the channels.
- [Platform packages and theme tokens](platform-packages.md): the import map, the shared components, the theme and the Tailwind rule.
- [Menus and keybindings](menus-and-keybindings.md): menu items and keybindings bound to commands.
- [Windows](windows.md): opening a window by key and path.
- [The `doric://` protocol](doric-protocol.md): the shell served for every route path.
- [Hooks and the app's lifecycle](hooks.md): the window's close hooks that the bootstrap wires.
