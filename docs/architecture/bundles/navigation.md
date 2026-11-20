# Navigation and routes

- Status: living document. It describes routes and the router as implemented on 2026-11-20.

## Summary

A route is a URL path. Every app window loads the same shell at `doric://app`, and the path of the window's URL, such as `/projects/p1/threads/t1`, chooses what the window shows. A bundle registers a path pattern with a `create` function that makes the route's element, and optionally a `parent` route. The `core` bundle provides the router, the contract `navigation/v1`, in each window, and the element `<core-outlet>`, which plays the part of React Router's `<Outlet>`: it shows the element of the active route and, for a child route, shows the child inside the parent's own outlet ([`navigation.ts`](../../../packages/bundle/src/contracts/basic/navigation.ts), [`core/src/client/navigation.ts`](../../../bundles/foundation/core/src/client/navigation.ts), [`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts)).

Navigating changes the window's URL through the History API, so Back, Forward and reload work as on a web site. An app window is a key plus a path: opening one is opening a path under a key, and the desktop main process remembers the last path of each key, which is how the selected Thread outlives a restart ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

The full contract of `navigation/v1` and of `<core-outlet>` is in the [README of `core`](../../../bundles/foundation/core/README.md#navigationv1); this document states the mechanism every bundle that draws a route follows.

## A route is a path

A bundle registers its routes in the `activate` of its client part. The `chat` bundle registers the Thread route as a child of `/` ([`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts)):

```ts
const ui = services.use(UiV1);
ui.define('chat-view', ChatViewElement);

const route = services.use(NavigationV1).register({
  path: '/projects/:projectId/threads/:threadId',
  parent: '/',
  create: (match) => ui.create('chat-view', match.params),
});
```

A route has three properties ([`navigation.ts`](../../../packages/bundle/src/contracts/basic/navigation.ts)):

| Property | Required | What it is                                                                                                                                                         |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`   | Yes      | The pattern. A segment `:name` is a parameter; its value is always a string.                                                                                       |
| `create` | Yes      | A function that receives the match `{ path, pattern, params }` and returns the route's element, usually through `ui/v1.create(tag, props)`.                        |
| `parent` | No       | The pattern of another registered route. The route is then shown inside the `<core-outlet>` that the parent's element holds, and the parent's element stays shown. |

The rules of a pattern ([`route-match.ts`](../../../bundles/foundation/core/src/client/route-match.ts)):

- It starts with `/` and has no empty segment; one trailing `/` is dropped, so `/settings/` is `/settings`. A parameter name matches `[A-Za-z_][A-Za-z0-9_]*` and appears once. Any other pattern makes `register` throw `invalid_input`.
- Routes are matched against `location.pathname` only; the query and the fragment are not part of a match. Each parameter value is decoded with `decodeURIComponent`, and a value with a malformed `%` escape does not match. Whoever builds a path encodes each parameter with `encodeURIComponent`, as the helpers of `workspace` and `papercraft` do ([`route-selection.ts`](../../../bundles/desktop/workspace/src/client/domain/route-selection.ts), [`papercraft/src/contracts/index.ts`](../../../bundles/features/papercraft/src/contracts/index.ts)).
- When several routes match, a static segment wins over a parameter at the first position where two patterns differ, so `/projects` wins over a `/:x` and `/settings/git` over a `/settings/:id`.
- Two routes conflict when they have the same number of segments, parameters at the same positions, and equal static segments, since no path could tell them apart: `/projects/:a` and `/projects/:b` conflict. The second `register` throws `route_conflict`, naming the path and the bundle that holds it. Thrown from `activate`, it quarantines the second bundle with that reason, and the first route keeps working ([`core/src/client/navigation.ts`](../../../bundles/foundation/core/src/client/navigation.ts), [`route-conflict.test.ts`](../../../bundles/foundation/core/tests/client/route-conflict.test.ts)).

A route has no versioned id and no schema of its parameters: the pattern is its identity, and an element that needs a valid parameter checks it itself. `register` returns a `Disposable`; disposing it removes the route. The runtime tracks every `Disposable` a service call returns in the caller's scope, so a route also goes away when the bundle that registered it is deactivated ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).

`parent` is explicit, not deduced from a prefix of the path, because a path such as `/settings` starts with `/` and is not shown inside the workspace frame.

### The routes of the shipped bundles

| Pattern                                      | Bundle       | Parent      | Element                                                      |
| -------------------------------------------- | ------------ | ----------- | ------------------------------------------------------------ |
| `/`                                          | `layout`     | —           | `<layout-workspace>`, the window's frame                     |
| `/projects`                                  | `workspace`  | `/`         | `<workspace-projects-route>`, which draws nothing; see below |
| `/projects/:projectId`                       | `workspace`  | `/`         | `<workspace-project-empty>`                                  |
| `/projects/:projectId/threads/:threadId`     | `chat`       | `/`         | `<chat-view>`                                                |
| `/papercraft/:projectId/:threadId/:identity` | `papercraft` | —           | `<papercraft-canvas>`                                        |
| `/settings`                                  | `settings`   | —           | `<settings-page>`                                            |
| `/settings/<section>`                        | `settings`   | `/settings` | `<settings-<section>>`                                       |
| `/settings/git`                              | `git`        | `/settings` | `<git-settings-versioning>`                                  |

Sources: [`layout/src/client/index.ts`](../../../bundles/desktop/layout/src/client/index.ts), [`workspace/src/client/index.ts`](../../../bundles/desktop/workspace/src/client/index.ts), [`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts), [`papercraft/src/client/index.ts`](../../../bundles/features/papercraft/src/client/index.ts), [`settings/src/client/index.ts`](../../../bundles/desktop/settings/src/client/index.ts), [`git/src/client/index.ts`](../../../bundles/features/git/src/client/index.ts).

The sections of `settings` are `profile`, `providers`, `execution`, `threads`, `tools` and `credentials`, always registered, and `appearance`, registered only while `doric.appearance/v1` is available ([`sections.ts`](../../../bundles/desktop/settings/src/client/domain/sections.ts), [`appearance-section.ts`](../../../bundles/desktop/settings/src/client/appearance-section.ts)). What each element draws is described in the README of its bundle: [`layout`](../../../bundles/desktop/layout/README.md), [`workspace`](../../../bundles/desktop/workspace/README.md), [`chat`](../../../bundles/desktop/chat/README.md), [`papercraft`](../../../bundles/features/papercraft/README.md), [`settings`](../../../bundles/desktop/settings/README.md) and [`git`](../../../bundles/features/git/README.md).

### The workspace window's paths

In the workspace window the path is the selection ([`route-selection.ts`](../../../bundles/desktop/workspace/src/client/domain/route-selection.ts)):

- `/` is Home, and `/projects` is the full list of Projects. On both, `workspace` adds `<workspace-dashboard>` to the frame's `shell.page` slot and `<workspace-sidebar-footer>` to `shell.sidebar.footer`; on any other path it removes them ([`workspace/src/client/index.ts`](../../../bundles/desktop/workspace/src/client/index.ts)). While `shell.page` holds an item, `<layout-workspace>` draws its page form, which has no Thread pane and no inner `<core-outlet>`, so the element of `/projects` is never created there: the route exists so that `/projects` matches and is not "not found" ([`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)). The Dashboard button in the sidebar header navigates to `/projects`, on the Dashboard and on every other path, and so does the sidebar's entry for all Projects ([`dashboard.tsx`](../../../bundles/desktop/workspace/src/client/components/organisms/dashboard.tsx), [`navigation-elements.tsx`](../../../bundles/desktop/workspace/src/client/elements/navigation-elements.tsx)).
- `/projects/<projectId>` is a Project with no Thread selected.
- `/projects/<projectId>/threads/<threadId>` is a selected Thread. Opening this path directly selects that Thread; a link to it works from anywhere in the window.

When the user selects a Project or a Thread, `workspace` writes the matching path with `navigate`, as a new history entry; a selection the app makes on its own, such as the restore at start, replaces the current entry. With nothing selected and nothing changed, it leaves the path as it is, so `/projects`, the route of another bundle or a path with no route stays ([`stores/route-selection.ts`](../../../bundles/desktop/workspace/src/client/stores/route-selection.ts)).

## The router: `navigation/v1`

`navigation/v1` is a basic contract of cardinality `one`, in the `client` environment only, one instance per window ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). The `core` bundle provides it, version 1.1.0 ([`core/manifest.json`](../../../bundles/foundation/core/manifest.json)); another bundle may provide it when the composition chooses that bundle under `providers` ([manifest](manifest.md)). A bundle reaches it with `services.use(NavigationV1)`, where `NavigationV1` comes from `bundle/contracts`, and lists `navigation/v1` under `requires` in its manifest.

| Method                          | What it does                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(route)`               | Registers a route; returns a `Disposable`.                                                                                                                                                       |
| `navigate(path, { replace? }?)` | Goes to `path` with `history.pushState`, or `history.replaceState` when `replace` is `true`.                                                                                                     |
| `back()`                        | `history.back()`.                                                                                                                                                                                |
| `forward()`                     | `history.forward()`.                                                                                                                                                                             |
| `history()`                     | `{ canGoBack, canGoForward }`: whether the window's history can move from its current entry.                                                                                                     |
| `current()`                     | The match of the active route, `{ path, pattern, params }`, or `undefined` when no route matches.                                                                                                |
| `chain()`                       | The active route and its ancestors through `parent`, root first, as `{ match, route }` entries; `[]` when no route matches.                                                                      |
| `subscribe(listener)`           | Calls `listener(current())` after every `navigate` and every Back and Forward, whether or not the match changed, and after a registration change that changes the match; returns a `Disposable`. |

`forward` and `history` are the contract's optional methods: a provider may omit them (`basicContracts['navigation/v1'].optional`), and a caller checks that they exist before it calls them ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)). The core provides them when the app's `navigationMethods` lists both ([`core/src/client/navigation.ts`](../../../bundles/foundation/core/src/client/navigation.ts)). `register` and `subscribe` take functions, and `chain` returns route registrations that hold functions, so the three work only in the window's own process; a call from another process is refused with `local_only` ([`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts), [`values.ts`](../../../packages/bundle/src/runtime/envelope/values.ts)).

In a match, `path` is the concrete path (`/projects/p1/threads/t1`), `pattern` is the registered pattern that matched (`/projects/:projectId/threads/:threadId`), and `params` holds the parameter values (`{ projectId: 'p1', threadId: 't1' }`). In `chain()`, every entry has the same `path`; an ancestor's `pattern` is its own, and its `params` are the matched values of the parameters its own pattern names ([`route-match.ts`](../../../bundles/foundation/core/src/client/route-match.ts)). A parent that is not registered, because its bundle is not in the composition or is quarantined, ends the chain there, and so does a cycle of parents.

The core's router behaves as follows ([`core/src/client/navigation.ts`](../../../bundles/foundation/core/src/client/navigation.ts)):

- `navigate` resolves `path` against the window's URL and refuses a URL of another origin, compared by scheme and host, with `invalid_input` ([`origin.ts`](../../../bundles/foundation/core/src/client/origin.ts)). A target equal to the current path, query and fragment is ignored unless `replace` is set.
- `current()` and `chain()` return the same frozen objects until the match changes, so a caller may compare them by reference.
- Subscribers run after every `navigate`, after every Back and Forward (the `popstate` event), and after a `register` or a disposal that changes the match. A subscriber that throws is logged to the console and the others still run.
- Each history entry the core writes holds exactly `{ doric: { index, max } }`: the entry's place in the window's history and the length of the list it can move forward to. `history()` answers `canGoBack = index > 0` and `canGoForward = index < max`. Nothing is written to storage: a reload keeps the list, and closing the window ends it.

```ts
const navigation = services.use(NavigationV1);

navigation.navigate(`/projects/${encodeURIComponent(projectId)}`);
navigation.navigate('/', { replace: true });
navigation.back();
```

### Links

A click on an `<a href="/projects/p1/threads/t1">` anywhere in the window navigates too, inside a shadow root as well: the core takes a plain primary click, with no modifier key, on an anchor that has an `href` and no `target` or `download`, whose URL is in the window's origin, cancels the default action and calls `navigate` with the URL's path, query and fragment. Every other click keeps the browser's behavior ([`links.ts`](../../../bundles/foundation/core/src/client/links.ts)).

### The route in menus and keybindings

After each change of the route, the core's client part sets the window's menu context `path` to `current().pattern`, or `null` when no route matches, through `menus/v1.setContext` ([`menu-context.ts`](../../../bundles/foundation/core/src/client/menu-context.ts)). A menu item or keybinding whose `when` is `{ path: '/projects/:projectId/threads/:threadId' }` therefore applies only on that route; `when` is the strict object `{ path?, focus? }`, and `chat` and `papercraft` write `when: { path: THREAD_ROUTE }` and `when: { path: CANVAS_ROUTE }` ([`menus.ts`](../../../packages/bundle/src/contracts/basic/menus.ts), [`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts), [`papercraft/src/client/index.ts`](../../../bundles/features/papercraft/src/client/index.ts), [menus and keybindings](menus-and-keybindings.md)).

## The outlet: `<core-outlet>`

`<core-outlet>` is a Web Component of the `core` bundle, not a React component ([`outlet.ts`](../../../bundles/foundation/core/src/client/elements/outlet.ts)):

1. When a window starts, the bootstrap replaces the children of `body` with one `<core-outlet>`, the top outlet ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts)).
2. Each outlet counts its `<core-outlet>` ancestors, crossing shadow roots through their host, and shows the entry of `chain()` at that depth: the top outlet shows the root of the chain, an outlet inside the root's element shows the next entry, and so on. An outlet therefore works inside Shadow DOM.
3. For `/projects/p1/threads/t1` the chain is `/` → `/projects/:projectId/threads/:threadId`. The top outlet shows `<layout-workspace>`; the `<core-outlet>` that the frame places in its Thread pane shows `<chat-view>` ([`workspace-view.tsx`](../../../bundles/desktop/layout/src/client/views/workspace-view.tsx)).
4. When the active route is the parent itself (path `/`), the outlet inside it has no entry and is empty. The parent decides what to show then; on `/` and `/projects` the frame draws its page form, which holds no inner outlet at all.

```text
URL: doric://app/projects/p1/threads/t1

<body>
  <core-outlet>                                      ← top outlet, made by the bootstrap
    <layout-workspace>                               ← route "/" (layout)
      … sidebar, header, slots …
      <core-outlet>                                  ← outlet in the frame's Thread pane
        <chat-view> (projectId="p1", threadId="t1")  ← child route (chat)
```

On every change of the route, each outlet compares the entry it shows with the new one:

- **The same route and pattern, other parameters** (another Thread): the outlet keeps the element and assigns the new parameters to it as properties, `Object.assign(element, params)`. That is why the properties of a route's element have the names of the pattern's `:name` segments.
- **Another route**: the outlet disposes of the old element through `ui/v1.dispose` and calls the new route's `create(match)`. If `create` throws, the error is logged to the console and the outlet stays empty.
- **No route matches**: the top outlet shows `<core-not-found>` with the window's path ("Nothing is registered at …"); a deeper outlet with no entry shows nothing ([`not-found.ts`](../../../bundles/foundation/core/src/client/elements/not-found.ts)). A route whose bundle is quarantined is not registered, so the same applies. The URL stays as it is, and the window shows the route again once its bundle registers it.

An outlet shows one element at a time. Keeping several views alive, as tabs do, is up to the parent's element; the outlet does not take part in it ([layout](layout.md)).

## Opening a path in a window

An app window is a key plus a path. A bundle asks for one through `windows/v1.open({ key, path, appearance?, primary? })`, a contract of the desktop main process that the core provides; the same method opens a window over a page of the host with `{ key, view }` instead of `path`, and `primary` marks the app's primary window ([`windows.ts`](../../../packages/bundle/src/contracts/basic/windows.ts)). The main process refuses a path that does not start with `/` ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). The core prefixes the key with the calling bundle's id, so two bundles never share a key ([`core/src/desktop/windows.ts`](../../../bundles/foundation/core/src/desktop/windows.ts), [windows](windows.md)). `papercraft` opens a canvas this way ([`papercraft/src/desktop/commands.ts`](../../../bundles/features/papercraft/src/desktop/commands.ts)):

```ts
await services.use(WindowsV1).open(
  {
    key: canvasIdOf({ kind: 'program', threadId, identity }),
    path: canvasPathOf({ projectId, threadId, segment: identity }),
    appearance: CANVAS_APPEARANCE,
  },
  call,
);
```

The main process carries the request out ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)):

- It loads `doric://app<path>`. The [`doric://` protocol](doric-protocol.md) answers a document request for any path outside its asset prefixes (`/platform/`, `/bundles/`, `/schemas/`, `/papercraft-modules/` and `/frame/`) with the shell, so a reload keeps the route ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)).
- When the key is already open, it focuses the window and, when the window's path differs from the requested one, loads the new path.
- It records the pathname of every navigation of the window, in-page navigations included, as the key's last path, and writes the paths to `userData/doric/windows.json` 250 ms after the last change, and at once when a window closes or the app quits ([`state.ts`](../../../app/desktop/doric/src/platform/state.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).
- The data a window needs goes in its path; there is no separate input.

### The selected Thread across restarts

When the app is ready, the core opens the primary window under the key `workspace`, at that key's last path, or at `/` when there is none ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts)). Since the workspace window's path is its selection, the selected Project or Thread is the one the window showed when the app last ran. `workspace` then looks a Thread path up on the host ([`stores/route-selection.ts`](../../../bundles/desktop/workspace/src/client/stores/route-selection.ts), [`use-workspace.ts`](../../../bundles/desktop/workspace/src/client/hooks/use-workspace.ts)):

- A Thread the host finds is selected; a sub-Thread resolves to its main Thread, which is selected.
- A Thread the host does not find gives way to its Project's path, or to `/` when the loaded Projects do not include that Project.
- When the user acts before the lookup ends, the restore is dropped and the user's selection stays.
- Nothing is written until the lookup settles; after a failed lookup, nothing is written until the next change of the selection.

The [README of `workspace`](../../../bundles/desktop/workspace/README.md#selection-and-routes) is the home of these rules.

At start the window reads the `localStorage` key `doric.selection` (`{ version: 1, selectedThreadId }`), and uses it only when it opens at `/`: the Thread it names is looked up like a Thread path. The key is removed whenever the start's load settles as `none` or `restored`, at any path, and so is a value that does not parse; after a failed lookup the key stays until the next selection is written ([`stores/route-selection.ts`](../../../bundles/desktop/workspace/src/client/stores/route-selection.ts), [`selection.ts`](../../../bundles/desktop/workspace/src/client/domain/selection.ts)).

Before it opens the primary window, the core calls `doric.migrations/v1.storage({ key: 'doric.selection', marker: 'selectionOrigin' })`; a failure is logged as a warning and does not keep the window closed ([`core/src/desktop/migrations.ts`](../../../bundles/foundation/core/src/desktop/migrations.ts)). In a packaged build, the platform then copies the key once from a `file://` page it ships (`assets/legacy-origin.html`) into `doric://app`, never over an existing value, and records the marker; in any other build it records the marker and copies nothing ([`storage-origin.ts`](../../../app/desktop/doric/src/platform/migration/storage-origin.ts)). The full shape of `doric.migrations/v1` is in [the `doric://` protocol](doric-protocol.md#copying-storage-from-the-file-origin-doricmigrationsv1).

## An element written in React

A React component reads the route with `useSyncExternalStore`, because `current()` returns the same object until the next change. `subscribe` returns a `Disposable`, so the component wraps it. The workspace's sidebar reads the window's path this way ([`navigation-elements.tsx`](../../../bundles/desktop/workspace/src/client/elements/navigation-elements.tsx)):

```tsx
const useRoutePath = (): string => {
  const navigation = useMemo(() => workspaceServices().use(NavigationV1), []);
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = navigation.subscribe(listener);
      return () => subscription.dispose();
    },
    [navigation],
  );
  const read = () => navigation.current()?.path ?? '/';
  return useSyncExternalStore(subscribe, read, read);
};
```

No bundle imports React Router. How a React element receives the properties the outlet assigns is in [React inside Web Components](react-web-components.md). Reference: [React: `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore).

## Related documents

- [README of `core`](../../../bundles/foundation/core/README.md): the full contract of `navigation/v1`, `ui/v1`, `regions/v1` and the structural elements.
- [Core](core.md): what the core provides in each environment, and `ui.create` step by step.
- [Layout](layout.md): the shell that registers `/` and places the outlet of the child routes.
- [Windows](windows.md): `windows/v1.open`, the last path of a key and closing a window.
- [The `doric://` protocol](doric-protocol.md): the shell served for any route path.
- [React inside Web Components](react-web-components.md): how a React element reacts to the properties the outlet assigns.
- [Menus and keybindings](menus-and-keybindings.md): the `when` condition on the route's pattern.
- [Contracts](contracts.md) and [Manifest](manifest.md): basic contracts, `requires` and `providers`.
- [Boundaries](boundaries.md): what a bundle's client part may import.
