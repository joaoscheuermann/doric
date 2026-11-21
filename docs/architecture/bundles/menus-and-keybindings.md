# Menus and keybindings

- Status: living document. It describes the native application menu, keyboard shortcuts and command dispatch on the desktop as implemented on 2026-11-20.

## Summary

The desktop's application menu and keyboard shortcuts are registered by code. Three contracts work together:

- `doric.menus/v1`, a platform contract that the desktop main process provides in `desktopMain`. It holds the menu skeleton of each generation, the items and keybindings bundles registered, and the menu context of each window, and builds the native menu from them ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)).
- `menus/v1`, a basic contract that bundles use to add menu items and keybindings and to report a window's context. The `core` bundle provides it in `desktopMain` over `doric.menus/v1`, recording the calling bundle as the owner of each registration ([`basic/menus.ts`](../../../packages/bundle/src/contracts/basic/menus.ts), [`core/src/desktop/menus.ts`](../../../bundles/foundation/core/src/desktop/menus.ts)).
- `commands/v1`, the registry of commands in `desktopMain` and in each window's `client`. A menu item or a keybinding names a command by its id; a click or a key press dispatches that command ([`basic/commands.ts`](../../../packages/bundle/src/contracts/basic/commands.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

The core sets the menu skeleton when the app is ready: Electron's own menus, one role per top-level menu, with no Settings item and no `Cmd+,` shortcut ([`core/src/desktop/menu.ts`](../../../bundles/foundation/core/src/desktop/menu.ts)). Each window handles keybindings with a single keydown listener that follows the table main sends it ([`packages/desktop/src/client/keybindings.ts`](../../../packages/desktop/src/client/keybindings.ts)).

## Who registers what

| Who                                   | Uses                                   | For                                                                                               |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The core, `desktopMain` part          | `doric.menus/v1`                       | Setting the skeleton at `onAppReadyHook`; forwarding every `menus/v1` registration with its owner |
| The core, `client` part               | `menus/v1.setContext`                  | Reporting the window's active route pattern as the context `path` after every navigation          |
| Any bundle, `client` or `desktopMain` | `menus/v1.addItem`, `addKeybinding`    | Adding menu items and keybindings that point to a command id                                      |
| Any bundle, `client` or `desktopMain` | `commands/v1.register`                 | Registering the command an item or keybinding dispatches                                          |
| The desktop main process              | `commands/v1.execute` of each registry | Dispatching the command of a clicked item or a pressed key                                        |

A `desktopMain` or `client` part reaches these contracts only through `services.use`; its activation context carries nothing else ([Contexts](contexts.md)). `doric.menus/v1` is a platform contract: it always exists in `desktopMain`, a part uses it without a manifest line, and no bundle can provide it ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). It is not exposed to windows. A bundle that adds items or keybindings lists `menus/v1` under `requires` in its manifest, and `commands/v1` when it registers commands; `requires` is one list for the whole bundle, with no field per part. `chat` and `papercraft` list both, and use them from their `client` parts ([`chat/manifest.json`](../../../bundles/desktop/chat/manifest.json), [`papercraft/manifest.json`](../../../bundles/features/papercraft/manifest.json)). The core uses `menus/v1` from its `client` part without a manifest line, because it provides the contract itself ([`core/src/client/index.ts`](../../../bundles/foundation/core/src/client/index.ts), [`core/manifest.json`](../../../bundles/foundation/core/manifest.json)).

## The contract `menus/v1`

`MenusV1` and its schemas are exported by `bundle/contracts` ([`basic/menus.ts`](../../../packages/bundle/src/contracts/basic/menus.ts)):

```ts
type MenuWhen = { path?: string; focus?: string };

interface Menus {
  addItem(item: {
    id: string;
    location: string; // 'app/<menu id>' or 'dock'
    command: string; // the id of a command in commands/v1
    label: string;
    when?: MenuWhen;
    order?: number;
  }): Promise<void>;
  addKeybinding(binding: {
    command: string;
    key: string; // an Electron accelerator, such as 'CmdOrCtrl+Shift+B'
    when?: MenuWhen;
  }): Promise<void>;
  setContext(entry: {
    key: 'path' | 'focus';
    value: string | null;
  }): Promise<void>;
}

const MenusV1 = ref<Menus>('menus/v1');
```

Each input object is strict: an unknown field is refused with `invalid_input`. All three methods are exposed to desktop windows (`expose: 'desktop'`), so a `client` part calls them across the bridge to `desktopMain`. Like every method, each takes the parent `call` as an optional last argument.

The contract takes no scope key from a window. The core's manifest lists no `desktopScope` entry for `menus/v1`, so the desktop process refuses a window's call that carries a scope key, such as `projectId`, `threadId` or `promptId`, with `invalid_input`, and fills `call.scope.windowKey` itself with the key of the calling window ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`core/manifest.json`](../../../bundles/foundation/core/manifest.json), [`core-scope.test.ts`](../../../app/desktop/doric/tests/core-scope.test.ts)). How scope keys and `desktopScope` work is in [Contexts](contexts.md#scope-keys) and [The bundle manifest](manifest.md).

The core's provider, `coreMenus`, forwards each method to `doric.menus/v1` with the same `call` ([`core/src/desktop/menus.ts`](../../../bundles/foundation/core/src/desktop/menus.ts)):

- `addItem` and `addKeybinding` add `owner`, the `bundleId`, `version` and `generation` of `call.caller`. On the hop to `doric.menus/v1` the caller becomes the core, so the owner travels in the input: it is the bundle that called `menus/v1`.
- `setContext` adds `windowKey` from `call.scope.windowKey`. A call with no window key, such as one from a `desktopMain` part that serves no window call, is refused with `invalid_input` ("setContext needs a calling window").

## The platform contract `doric.menus/v1`

`DoricMenusV1` is exported by `bundle/contracts`; it exists in `desktopMain` only, and the desktop main process provides it in every `desktopMain` generation ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)):

```ts
type MenuSkeleton = readonly {
  readonly id: string;
  readonly label: string;
  readonly role?: string; // an Electron menu role, such as 'editMenu'
  readonly submenu?: MenuSkeleton;
}[];

interface Caller {
  readonly bundleId: string;
  readonly version: string;
  readonly generation: number; // an integer
}

interface DoricMenus {
  setSkeleton(skeleton: MenuSkeleton, call?: CallArg): Promise<void>;
  add(
    item: MenuItem & { readonly owner: Caller },
    call?: CallArg,
  ): Promise<void>;
  addKeybinding(
    binding: Keybinding & { readonly owner: Caller },
    call?: CallArg,
  ): Promise<void>;
  setContext(
    entry: {
      readonly windowKey: string;
      readonly key: 'path' | 'focus';
      readonly value: string | null;
    },
    call?: CallArg,
  ): Promise<void>;
}

const DoricMenusV1 = ref<DoricMenus>('doric.menus/v1');
```

`MenuItem` and `Keybinding` are the inputs of `menus/v1.addItem` and `addKeybinding` above. Every input object, at every level of the skeleton, is strict. Each method returns once main has applied it, and rejects with the error main raised ([`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts), [`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts)):

| Method          | Effect                                                                                                                                                               | Errors                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `setSkeleton`   | Stores the skeleton of the caller's generation, makes it the last skeleton set, and rebuilds the menu                                                                | `invalid_input` for a malformed skeleton                                                                                          |
| `add`           | Records the item under the caller's generation and the owner's `bundleId`, and rebuilds the menu                                                                     | `registration_conflict` when the same owner already registered an item with the same `id` in that generation                      |
| `addKeybinding` | Records the keybinding under the caller's generation and the owner's `bundleId`, sends the new table to the windows pinned to that generation, and rebuilds the menu | `registration_conflict` when a keybinding of that generation has the same `key` and the same `when` (see [Conflicts](#conflicts)) |
| `setContext`    | Sets `path` or `focus` of the window's context, sends the window its new keybinding table, and rebuilds the menu when that window has focus                          | `not_found` when no window with that key is open                                                                                  |

The generation of a registration is `call.caller.generation`, the generation of the bundle that made the hop; `owner` decides only whose registration it is.

## The menu skeleton

The core's `desktopMain` part sets the skeleton in its handler of `onAppReadyHook` of `doric.app.hooks/v1`, before it opens the first window ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [Hooks](hooks.md)). The skeleton is Electron's default menu, one role per top-level menu ([`core/src/desktop/menu.ts`](../../../bundles/foundation/core/src/desktop/menu.ts)):

| `id`     | `label`  | `role`       |
| -------- | -------- | ------------ |
| `app`    | `App`    | `appMenu`    |
| `file`   | `File`   | `fileMenu`   |
| `edit`   | `Edit`   | `editMenu`   |
| `view`   | `View`   | `viewMenu`   |
| `window` | `Window` | `windowMenu` |
| `help`   | `Help`   | `help`       |

Electron expands each role into its own submenu, so the labels, accelerators and native roles of those entries are Electron's, including the clipboard shortcuts of the Edit menu. The skeleton has no Settings item and binds no `Cmd+,`. The core registers the command `core.open-settings/v1` in its `desktopMain` `commands/v1`, but no menu item or keybinding points to it; the command is described in the core's [README](../../../bundles/foundation/core/README.md) ([`core/src/desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts)).

## Building the application menu

Main rebuilds the application menu when a skeleton, item or keybinding is added or dropped, when the focused window changes, when a window is pinned to a generation, when the focused window's context changes, and when a generation's process is respawned ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). A rebuild:

1. takes the generation the focused window is pinned to, or the newest generation when the focused window is not pinned or no window has focus;
2. takes that generation's skeleton, or else the last skeleton any generation set. Until a skeleton exists, the menu is left alone and Electron's default menu shows;
3. takes the items and keybindings of that generation whose `when` holds in the focused window's context (see [The `when` condition](#the-when-condition-and-the-window-context));
4. builds one menu entry per skeleton entry, at every level of the skeleton, with these rules ([`skeleton.ts`](../../../app/desktop/doric/src/platform/menus/skeleton.ts)):
   - an entry with role `appMenu` appears only on macOS;
   - an entry with role `help` appears only when a nested entry or a contributed item fills it;
   - any other entry with a role and neither nested entries nor contributed items is the bare role; otherwise it is Electron's submenu of that role, then the nested entries, then a separator, then the items, so a role entry with nested entries and no items ends with a separator;
   - an entry without a role is a submenu with its nested entries, a separator when both are present, and the items;
5. puts in each menu the items whose `location` is `app/<id of that entry>`, sorted by `order` (0 when absent), then by the order in which their owners first registered in the generation. Each item shows its `label` and, when a keybinding of the same command is active, that key as its accelerator; the accelerator is shown only, not registered, because the window's listener handles the key. A click dispatches the item's command for the focused window;
6. on macOS, when at least one item has `location` `dock`, sets the dock menu to those items in registration order. When no dock item is left, the dock menu set last stays.

An item addresses any entry of the skeleton by its id, top-level or nested. An item does not appear, and no error is raised, when its `location` is neither `dock` nor `app/` followed by the id of an entry at some level, or when it targets the `appMenu` entry, or an entry nested under it, on a platform other than macOS.

## The `when` condition and the window context

Each window has a context with two keys, `path` and `focus`, both `null` when the window opens ([`registry.ts`](../../../app/desktop/doric/src/platform/windows/registry.ts), [`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). A `when` holds when each key it names equals the window's value for that key; a `when` with no key, or no `when`, always holds. With no focused window there is no context, so only items and keybindings whose `when` names no key apply ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts)).

The comparison is exact string equality, with no pattern matching. The value of `path` is the route pattern, not the concrete path: the core's `client` part subscribes to `navigation/v1` and, on activation and after every navigation that changes the pattern, calls `setContext({ key: 'path', value })` with the pattern of the matched route, such as `/projects/:projectId/threads/:threadId`, or `null` when no route matches. A failed call is logged with `log/v1` ([`menu-context.ts`](../../../bundles/foundation/core/src/client/menu-context.ts), [Navigation](navigation.md)). So a `when: { path: '/projects/:projectId/threads/:threadId' }` holds in any window showing a Thread. No shipped part sets `focus`.

## Keybindings in a window

Main keeps, for each window, its effective table: the keybindings of the window's generation (the generation it is pinned to, or the newest) whose `when` holds in its context, as `{ key, command }` entries. It sends the table on the window's `keybindings` stream of the shell protocol whenever it changes ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`protocol.ts`](../../../packages/desktop/src/client/protocol.ts)).

Each window installs one capture-phase `keydown` listener during its bootstrap, so bundles do not add listeners of their own for these shortcuts ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts), [`keybindings.ts`](../../../packages/desktop/src/client/keybindings.ts)):

- It parses each `key` as an accelerator: modifiers `Cmd`/`Command`/`Meta`/`Super`, `Ctrl`/`Control`, `CmdOrCtrl`/`CommandOrControl` (Meta on macOS, Control elsewhere), `Alt`/`Option` and `Shift`, then one key, case-insensitive, with the aliases `Esc`, `Return`, `Space`, `Plus`, `Up`, `Down`, `Left`, `Right` and `Del`. A key it cannot parse is left out of the table.
- A `keydown` matches an entry when its key and all four modifier states are equal to the chord. On a match the listener calls `preventDefault` and sends the `keybinding` notification with the entry's `key`.
- Main looks the key up in the window's current table and dispatches its command for that window, or answers `not_found` when the table has no entry for that key ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts)).

A keybinding acts only in a focused Doric window: no global shortcut is registered. The Edit menu's clipboard shortcuts are Electron's native accelerators and never appear in the table.

## Dispatching a command

A command is defined with `defineCommand({ id, input, execute })`, where `id` is a bundle contract id, `input` a zod schema and `execute` receives `(input, call, services)`, and is registered with `services.use(CommandsV1).register(command)`, which returns a disposable ([`define.ts`](../../../packages/bundle/src/contracts/define.ts), [`basic/commands.ts`](../../../packages/bundle/src/contracts/basic/commands.ts)):

```ts
interface Commands {
  register(command: Registrable<BoundCommand>): Disposable;
  execute(
    command: AnyServiceRef | ContractId,
    input?: unknown,
    call?: CallArg,
  ): Promise<void>;
}

const CommandsV1 = ref<Commands>('commands/v1');
```

`commands/v1` exists in `desktopMain` and in `client`, not in `host`. The core provides both registries. Each is a map by id: registering an id already present is `registration_conflict`; `execute` parses the input with the command's schema (`{}` when absent) and refuses a failure with `invalid_input`. In `desktopMain` an unknown id is `unknown_command`; in a window, an id no part of the window registered is sent to `desktopMain` through the core's own contract `core.commands/v1`, whose miss is that same `unknown_command` ([`core/src/desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts), [`core/src/client/commands.ts`](../../../bundles/foundation/core/src/client/commands.ts), [`core/src/desktop/commands-bridge.ts`](../../../bundles/foundation/core/src/desktop/commands-bridge.ts)). `core.commands/v1` is described in the core's [README](../../../bundles/foundation/core/README.md).

A click on a menu item or a matched key dispatches the command id with the input `{}`, for the window it came from or else the focused window ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)):

1. When that window's generation (or, for an unpinned window or none, the newest generation) has a live process, main executes the id in that generation's `desktopMain` `commands/v1`, with `call.scope.windowKey` set to the window's key. If it runs, dispatch ends. With no live process this step is skipped.
2. On `unknown_command`, or when step 1 was skipped, and only if the window has subscribed to its `commands` stream, main asks the window, over its `commands` stream, to execute the id in its `client` `commands/v1`, and waits for the result ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`packages/desktop/src/client/commands.ts`](../../../packages/desktop/src/client/commands.ts)).
3. On `unknown_command` there too, with no window, or with a window that has not subscribed to its `commands` stream, main logs the warning "No registry has this command" with `kind: 'command_not_found'`.

Any other error at step 1 or 2 is logged as "Command failed" and ends the dispatch. Because dispatch passes no input, a command reached from a menu or a key derives what it needs from the window, its route or its own state.

## Conflicts

Two keybindings conflict when they are in the same generation, have the same `key` string and the same `when`, comparing `path` and `focus` with an absent key equal to `null`. The owner does not matter: the second registration is refused with `registration_conflict`, whose details name the key and the command and owner already bound, and the first one stays ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts)). The error goes back to the caller of `addKeybinding`; nothing else reports it. Two keybindings with the same key and different `when` do not conflict: both `chat` and `papercraft` bind `CmdOrCtrl+Enter`, on different routes. Keys are compared as written, so `CmdOrCtrl+Enter` and `Ctrl+Enter` do not conflict even where they name the same chord.

## Lifetimes

Registrations belong to a generation and an owner ([`native-menus.ts`](../../../app/desktop/doric/src/platform/menus/native-menus.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)):

- Each time main receives a diagnostics snapshot of a generation, it drops the items and keybindings owned there by every bundle whose state in the snapshot is not `active`, including `inactive` before the bundle first activates, and the menu and the window tables are rebuilt without them; the bundle needs no cleanup of its own.
- When a generation's process is lost, its items and keybindings are dropped and its skeleton kept; when the process is respawned, the menu is rebuilt.
- When a generation is retired, its items, keybindings and skeleton are dropped. If its skeleton was the last one set, it still serves as the last skeleton for a generation that has none.
- A generation that never set a skeleton, because it did not get `onAppReadyHook`, shows the last skeleton set with its own items.

A window's context lives in the window's entry and goes with the window.

## Shipped registrations

| Bundle       | Part    | Registers                                                                                                                                                                    |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       | desktop | The skeleton; the command `core.open-settings/v1` ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts))                                     |
| `core`       | client  | The context `path` of each window ([`menu-context.ts`](../../../bundles/foundation/core/src/client/menu-context.ts))                                                         |
| `chat`       | client  | The command `chat.send-prompt/v1` and its keybinding `CmdOrCtrl+Enter` on the Thread route ([`chat/src/client/index.ts`](../../../bundles/desktop/chat/src/client/index.ts)) |
| `papercraft` | client  | The commands of the canvas bar and their keybindings on the canvas route ([`papercraft/src/client/index.ts`](../../../bundles/features/papercraft/src/client/index.ts))      |

No shipped bundle adds a menu item. The commands of `chat` are described in its [README](../../../bundles/desktop/chat/README.md), and those of `papercraft` in `bundles/features/papercraft/README.md`.

## Replacing the provider of `menus/v1`

`menus/v1` has no `doric.` prefix, so another bundle may provide it in `desktopMain` when the composition chooses it under `providers`. The core's `services.provide(coreMenus)` is then inert, and the core's own uses of `menus/v1` reach the chosen provider ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [Contexts](contexts.md#activation-order-and-the-foundation)). A replacement reaches the native menu only through `doric.menus/v1`, and it names the owner of each registration itself, as the core does with `call.caller`.

## Related documents

- [Contexts](contexts.md): `services`, the call, scope keys and the platform contracts.
- [Contracts](contracts.md): `defineService`, `defineMethod`, `defineCommand` and refs.
- [The bundle manifest](manifest.md): `requires`, `provides` and `desktopScope`.
- [Boundaries](boundaries.md): what a bundle may import and use.
- [Hooks](hooks.md): `onAppReadyHook`, at which the core sets the skeleton.
- [Windows](windows.md): window keys, focus and generations of windows.
- [Navigation](navigation.md): the routes whose patterns become the context `path`.
- [Core README](../../../bundles/foundation/core/README.md#corecommandsv1): `core.commands/v1` and `core.open-settings/v1`.
- [Core README](../../../bundles/foundation/core/README.md#menusv1): the methods of `menus/v1` and the behavior of the core's provider.
