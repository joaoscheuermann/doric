# account

`account` draws the reader's account status in the window: the reader's
avatar, the account menu it opens, and the menu's About line. It is a
client-only bundle: it has a contracts module and a client part, and no host
or desktop part. See the [main README](../../../README.md) for Doric as a
whole and [`packages/bundle`](../../../packages/bundle/README.md) for how
bundles work. The feature doc of the window is
[ui-redesign](../../../docs/features/ui-redesign.md).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| `manifestVersion` | `1`                                                       |
| `id`              | `account`                                                 |
| `version`         | `1.0.1`                                                   |
| `engines.doric`   | `^1.8.0`                                                  |
| `description`     | The reader's account status and menu, and About.          |
| `provides`        | none                                                      |
| `requires`        | `ui/v1@^1.0.0`, `regions/v1@^1.0.0`, `commands/v1@^1.0.0` |
| `optional`        | none                                                      |

The bundle provides no contract. It declares two slots, which other bundles
fill (see [Slots](#slots)).

`engines.doric` starts at `1.8.0` because the client part imports
`desktop/ui/element-host`, the newest platform module it uses, which the
platform has from 1.8.0 on
([`packages/bundle/src/runtime/version.ts`](../../../packages/bundle/src/runtime/version.ts)).
When the platform's version is outside the range, the bundle is quarantined
with `engines_unsatisfied`. For a `requires` entry, it is quarantined with
`missing_dependency` when no enabled bundle provides the contract in any
environment, with `dependency_quarantined` when a provider exists but none
is live, and with `incompatible_version` when a live
provider's version is outside the range
([`packages/bundle/src/runtime/catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).
A quarantined bundle draws nothing
([The core bundle and quarantine](../../../docs/architecture/bundles/core.md#quarantine)).

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts)),
  exported as `account/contracts`: the slot names `ACCOUNT_STATUS` and
  `ACCOUNT_MENU`, and the type `AccountMenuItemProps`. It holds no contract
  id.
- **Client** ([`src/client/index.ts`](src/client/index.ts)): the activation,
  the element `<account-status>` and the menu.

## Contracts used

- `ui/v1`: defines the element `account-status`, and creates and disposes the
  elements that fill the two slots
  ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `regions/v1`: adds `<account-status>` to the shell's slot and reads the
  items of `account.status` and `account.menu`
  ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/hooks/use-menu-items.ts`](src/client/hooks/use-menu-items.ts),
  [`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `commands/v1`: executes the command of a picked menu entry
  ([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `doric.about/v1` (platform): gives the app version the About line shows
  (see [About line](#about-line)). Its shape is in
  [Contexts](../../../docs/architecture/bundles/contexts.md#shapes-of-the-platform-contracts).
- The slot name `SHELL_WINDOW_ACTIONS` of `layout/contracts`, imported as a
  type only ([`src/client/index.ts`](src/client/index.ts)).

## Activation

`activate` ([`src/client/index.ts`](src/client/index.ts)):

1. starts following `doric.about/v1` (see [About line](#about-line));
2. defines the element `account-status` through `ui/v1`;
3. adds the item `{ id: 'account', tag: 'account-status' }` to the shell's
   slot `shell.window.actions` through `regions/v1`.

Its cleanup removes the slot item, ends the element definition, stops
following `doric.about/v1` and clears the version, and forgets which
malformed menu items it has reported
([`src/client/index.ts`](src/client/index.ts)). Ending the definition does
not undefine the element: a custom element cannot be undefined, so
`account-status` stays defined in the window with no owner
([`packages/desktop/src/client/elements.ts`](../../../packages/desktop/src/client/elements.ts)).
An `<account-status>` created after that is a hidden `<core-unavailable>`
(see [Elements that cannot be drawn](#elements-that-cannot-be-drawn)).

### Activation errors

`activate` raises what its steps raise, and does not undo the earlier steps
itself ([`src/client/index.ts`](src/client/index.ts)):

- `define` fails with `invalid_input` when the tag does not start with the
  bundle's id and `-` (`account-status` does)
  ([`bundles/foundation/core/src/client/ui.ts`](../../foundation/core/src/client/ui.ts)).
- `define` fails with `registration_conflict` when the tag is already defined
  in the window. While a definition of it is current, the message is
  `<account-status> is already defined by bundle "<owner>".`; once that
  definition has ended, or when the tag was defined outside `ui/v1`, it is
  `<account-status> is already defined in this window.`
  ([`packages/desktop/src/client/elements.ts`](../../../packages/desktop/src/client/elements.ts)).
  Because a definition stays after its cleanup, a second activation of
  `account` in the same window fails this way.
- `add` fails with `registration_conflict` when `shell.window.actions`
  already holds an item with the id `account`
  ([`packages/bundle/src/contracts/basic/regions.ts`](../../../packages/bundle/src/contracts/basic/regions.ts)).

When `activate` throws, the platform disposes every registration the bundle
made through its services in that attempt (the following of
`doric.about/v1`, the element definition, the slot item), closes the
bundle's services and quarantines it: with `registration_failed` for a
`registration_conflict`, with `activate_failed` for any other error
([`packages/bundle/src/runtime/activation.ts`](../../../packages/bundle/src/runtime/activation.ts),
[`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
A tag defined before the failure stays defined with no owner.

### Where `<account-status>` is drawn

`shell.window.actions` is the window's actions slot. Two elements draw it
([`layout` README](../layout/README.md),
[`workspace` README](../workspace/README.md)):

- in the conversation form, the `layout` bundle draws it at the end of the
  Project panel's header
  ([`bundles/desktop/layout/src/client/views/workspace-view.tsx`](../layout/src/client/views/workspace-view.tsx));
- the `workspace` bundle's Project tab bar (`<workspace-project-tabs>`, the
  item of `shell.titlebar.tabs`) ends with it on the routes `/` and
  `/projects`; on every other route the tab bar's end holds
  `shell.header.actions` instead
  ([`bundles/desktop/workspace/src/client/elements/navigation-elements.tsx`](../workspace/src/client/elements/navigation-elements.tsx)).

## What it draws

`<account-status>`, the account status drawn by `account`
([`src/client/elements/account-status-element.tsx`](src/client/elements/account-status-element.tsx),
[`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
The element takes no attributes. It is a 20×24 px box (`h-6 w-5`) that holds:

- a button named "Account" (`aria-label`), which shows the reader's avatar,
  20 px square (`ReaderAvatar` of `desktop/ui/reader-avatar`, `size-5`,
  [`packages/desktop/src/identity/reader-avatar.tsx`](../../../packages/desktop/src/identity/reader-avatar.tsx)),
  for `READER_NAME` of `desktop/ui/identity`, whose value is
  `'jao.scheuermann'`
  ([`packages/desktop/src/identity/identity-mark.ts`](../../../packages/desktop/src/identity/identity-mark.ts)),
  and opens the account menu;
- the `account.status` slot: a 14×14 px box (`size-3.5`) at 10 px from the
  left and 12 px from the top, over the avatar's bottom-right corner. It is a
  sibling of the button, not inside it, so an item whose element is
  focusable is its own Tab stop. Each item is drawn as its element (`tag`)
  with its `props`, in the slot's order (see [Limits](#limits)).

Each `account.status` item and each `account.menu` icon is mounted with
`ElementHost` of `desktop/ui/element-host`
([`packages/desktop/src/element-host.tsx`](../../../packages/desktop/src/element-host.tsx)).
It creates the element through `ui/v1` when it mounts and again whenever the
item's `tag` changes, passes a badge its item's `props` at creation only (an
icon gets none), and disposes the element through `ui/v1` when the item goes,
when the `tag` changes or, for an icon, when the menu closes. When `ui/v1`
`create` throws, it draws a compact notice "View failed to open" in the
element's place, announced to assistive technology and naming the element,
and logs
``console.error(`Doric: the element <${tag}> could not be created:`, error)``.
The `props` of `account.status` items are not checked.

### Elements that cannot be drawn

When no active bundle owns an item's `tag` (its filler is absent,
quarantined, has ended its definition or has not defined it yet), `ui/v1`
`create` throws nothing: it returns an empty `<core-unavailable>` whose
`data-tag` names the tag and which hides itself once connected
([`bundles/foundation/core/src/client/ui.ts`](../../foundation/core/src/client/ui.ts),
[`bundles/foundation/core/src/client/elements/unavailable.ts`](../../foundation/core/src/client/elements/unavailable.ts)).
Then nothing is logged and no notice is drawn:

- a badge is invisible;
- a menu entry still draws its label, with no icon.

A badge whose owner defines its tag after the badge is mounted stays hidden
until the badge is mounted again, because the element is created only on
mount and on a change of `tag`
([`packages/desktop/src/element-host.tsx`](../../../packages/desktop/src/element-host.tsx)).
A menu icon is created each time the menu opens.

### The account menu

The account menu is a dropdown menu 240 px wide (`w-60`), opened below the
button, 4 px from it, aligned to the button's end, and drawn in the window's
portal container. Its height is capped at the space available and it scrolls
vertically beyond that
([`packages/desktop/src/components/dropdown-menu.tsx`](../../../packages/desktop/src/components/dropdown-menu.tsx)).
From top to bottom
([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)):

1. the header: a 32 px avatar (`size-8`), `READER_NAME` above "Local
   account";
2. when at least one `account.menu` entry is drawable: a separator, then each
   entry as one menu item, its icon element first and its `label` after, in
   the slot's order;
3. a separator;
4. the About line: an info icon, "Doric" above the license text.

Picking an entry closes the menu (the menu item's default) and executes its
`command` with its `input` through `commands/v1`, once per pick. A pick does
not wait for the command; when the command rejects, the bundle logs
``console.error(`Doric: the command ${command} could not run:`, error)``
([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).

### About line

The license text reads `MIT License · v<version>` while a version is known,
and `MIT License` alone otherwise
([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).

The version is held in one store per window (a `zustand` vanilla store), and
the menu re-renders only when it changes
([`src/client/domain/about.ts`](src/client/domain/about.ts)):

- while a provider of `doric.about/v1` exists, its `get()` answer
  (`{ version: string }`) becomes the version;
- when `get()` rejects, the version stays unset and nothing is logged;
- when the provider goes away, or the activation's cleanup runs, the version
  is cleared;
- an answer that resolves after its provider went away or after the cleanup
  is dropped;
- without a provider the version is never set, and nothing fails.

The bundle builds the reference from the id with `ref('doric.about/v1')` and
imports the `DoricAbout` interface as a type only, rather than importing the
reference `DoricAboutV1` that `bundle/contracts` exports
([`src/client/domain/about.ts`](src/client/domain/about.ts),
[`packages/bundle/src/contracts/platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).
`bundle/contracts` is the window's own module, so a named import the window's
module lacks fails to load the client part; a reference built from the id
depends on no export. It follows the contract with `services.whenAvailable`
and lists it in no manifest field. The manifest schema refuses a `doric.*` id
under `provides` and `requires` ("is a platform contract and is never
declared"); `optional` accepts any id that matches the contract-id pattern,
`doric.about/v1` included
([`packages/bundle/src/runtime/manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)).
The bundle does not list it under `optional` because listing adds nothing:
every bundle may use a `doric.*` contract without declaring it, at build and
at run time
([`packages/bundle/src/contracts/ids.ts`](../../../packages/bundle/src/contracts/ids.ts),
[`packages/bundle/src/build/record.ts`](../../../packages/bundle/src/build/record.ts),
[`packages/bundle/src/runtime/services.ts`](../../../packages/bundle/src/runtime/services.ts)).
Every client window registers the provider, answering the app's version
([`packages/desktop/src/client/platform.ts`](../../../packages/desktop/src/client/platform.ts)),
and every platform version `engines.doric` accepts has it, so the path
without a provider is reached only on the fake host of the tests and stories
(its `absent` option).

## Slots

Both names are exported from `account/contracts`
([`src/contracts/index.ts`](src/contracts/index.ts)). A filler imports the
name with `import type` and writes the slot as a literal checked against it
(`'account.menu' satisfies typeof ACCOUNT_MENU`), as the
[bundles' rules](../../AGENTS.md) require of every slot name of another
bundle.

| Slot             | Constant         | Items                                                                                   |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `account.status` | `ACCOUNT_STATUS` | Elements: `tag` is drawn with its `props` in the 14×14 px box over the avatar's corner. |
| `account.menu`   | `ACCOUNT_MENU`   | Data items: `props` are `AccountMenuItemProps`; `tag` is the entry's icon element.      |

In the composed window, `resources` puts its connection badge (the resource
monitor, tag `resources-monitor`, `order: 10`) in `account.status`
([`bundles/features/resources/src/client/index.ts`](../../features/resources/src/client/index.ts)),
and `settings` puts its "Settings" entry in `account.menu`, with the icon
`settings-entry-icon` and the command `core.open-settings/v1` with input
`{ defaultPath: '/settings' }`
([`bundles/desktop/settings/src/client/index.ts`](../settings/src/client/index.ts)).
Without `settings` the menu has no entry; without `resources` the corner is
empty.

### `AccountMenuItemProps`

```ts
interface AccountMenuItemProps {
  readonly label: string;
  /** A contract id: the command executed through `commands/v1` on a pick. */
  readonly command: string;
  readonly input?: Readonly<Record<string, unknown>>;
}
```

An item of `account.menu` is drawable when its `props` are an object (not
`null`, not an array) whose `label` is a string, whose `command` passes
`isContractId` of `bundle/contracts`, and whose `input` is absent or an
object that is not `null` and not an array. Extra keys are allowed and
ignored ([`src/client/domain/menu-items.ts`](src/client/domain/menu-items.ts)).
`isContractId` accepts segments separated by `.`, the first starting with a
lowercase letter and each made of lowercase letters, digits and `-`, then
`/v` and a positive major without a leading zero, such as
`core.open-settings/v1`
([`packages/bundle/src/contracts/ids.ts`](../../../packages/bundle/src/contracts/ids.ts)).

An item that fails the check is not drawn. The bundle reports it once per
item id until the activation's cleanup, with
`console.error('Doric: the account menu item "<id>" of <owner> has malformed props and is not drawn:', props)`,
where `<owner>` is the id of the bundle that added the item
([`src/client/hooks/use-menu-items.ts`](src/client/hooks/use-menu-items.ts),
[`packages/bundle/src/contracts/basic/regions.ts`](../../../packages/bundle/src/contracts/basic/regions.ts)).

The bundle does not size an entry's icon element. The menu item's `svg` rule
sizes an SVG without a `size-*` class to 16 px (`size-4`), and it is the only
sizing
([`packages/desktop/src/components/dropdown-menu.tsx`](../../../packages/desktop/src/components/dropdown-menu.tsx)).
The element's host gives it the muted colour (`text-muted-foreground`) and
passes it no props, so the filler's SVG takes `currentColor`
([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
While the menu item is focused, the menu item's rule turns its text and
every descendant, the icon included, to `accent-foreground`
([`packages/desktop/src/components/dropdown-menu.tsx`](../../../packages/desktop/src/components/dropdown-menu.tsx)).

### Limits

- Order: both slots are drawn in the order `regions/v1` gives: by `order`
  ascending, items without `order` last, then in the order they were added
  ([`packages/bundle/src/contracts/basic/regions.ts`](../../../packages/bundle/src/contracts/basic/regions.ts)).
- Count: the number of badges and of menu entries is not limited.
- Badges: every badge is drawn in the same 14×14 px box, which neither lays
  them out nor clips them, so several badges flow one after another and
  overflow the box
  ([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- Menu height: capped at the space available, then scrolled (see
  [The account menu](#the-account-menu)).

## Data and side effects

- The bundle stores nothing: it has no settings, no persistence and no
  configuration. The reader's name is the constant `READER_NAME`, and the
  account line is the fixed text "Local account".
- Its side effects are the slot item and element definition of its
  activation ([`src/client/index.ts`](src/client/index.ts)); the fillers'
  elements it creates and disposes through `ui/v1`, the commands it executes
  on a pick, and its `console.error` line for a command that rejects
  ([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx));
  its `console.error` line for a malformed menu item
  ([`src/client/hooks/use-menu-items.ts`](src/client/hooks/use-menu-items.ts));
  and the `console.error` line `ElementHost` logs for an element that cannot
  be created
  ([`packages/desktop/src/element-host.tsx`](../../../packages/desktop/src/element-host.tsx)).

## How it runs in a window

The client part is `dist/client/index.js`. It leaves to the window's import
map `react`, `desktop/ui/*` and `bundle/contracts` (`layout/contracts` is
imported as a type only and leaves no import), and bundles `zustand` and
`lucide-react` into the file
([`packages/bundle/src/build/externals.ts`](../../../packages/bundle/src/build/externals.ts)).
A window loads the file once, so its version store, module state of the file,
exists once per window, and its React is the window's.

The bundle has no stylesheet of its own. Its Tailwind classes are compiled
into the renderer's stylesheet, which scans `bundles/*/*/src/client/**/*`
([`app/desktop/doric-renderer/src/styles.css`](../../../app/desktop/doric-renderer/src/styles.css)).

## Build and test

Each command runs from the repository root.

```console
npx nx run bundle-account:build
npx nx run bundle-account:typecheck
npx nx run bundle-account:test
```

- `build` ([`project.json`](project.json)) depends on `^build`. It compiles
  `src/contracts/` to `dist/contracts/` (`tsconfig.json`), typechecks the
  client, stories and preview harness (`tsconfig.client.json`), and runs the
  bundle build, which writes `dist/client/index.js`, `dist/manifest.json`,
  `dist/contracts.json` and `dist/package.json`.
- `typecheck` depends on `^build`. It emits only the declarations of
  `src/contracts/` and typechecks the client, stories and preview harness,
  without the bundle build.
- `test` depends on `build` and `^build`. It deletes `dist-tests`, compiles
  `tests/` with `tsconfig.spec.json` (the contracts, `src/client/domain/` and
  `tests/*.ts`, which matches no file: every test is under `tests/client/`)
  and `tsconfig.client-spec.json` (`tests/client/`), and runs them with
  `node --test --test-force-exit`. The tests under `tests/client/` boot
  `happy-dom`; those that test what the element draws mount
  `<account-status>` on a fake host
  ([`tests/client/support/render-account.ts`](tests/client/support/render-account.ts)).

The stories
([`stories/components/organisms/account-status.stories.tsx`](stories/components/organisms/account-status.stories.tsx),
title "Account/Organisms/Account status") are `Connected` and `Disconnected`:
each draws `<account-status>` in the light and the dark theme side by side,
with a badge in `account.status` drawn as a 14×14 dot in its tone and the
"Settings" entry in `account.menu`. They bind the account to the fake host
([`stories/support/account-host.tsx`](stories/support/account-host.tsx),
[`stories/support/fake-host.ts`](stories/support/fake-host.ts)): its
`doric.about/v1` answers `{ version: '0.0.1' }`, and its `absent` option
lists contract ids it does not provide (`services.use` throws for them and
`services.whenAvailable` never calls back). Its `ui/v1` draws every tag the
account does not define as a labelled stand-in naming the element and the
bundle that draws it in the app
([`stories/support/placeholder.tsx`](stories/support/placeholder.tsx)). The
preview harness [`.storybook/preview.tsx`](.storybook/preview.tsx) loads the
platform theme `desktop/ui/theme.css`.

The Doric host loads `account` because its id is in the `enabled` list of
[`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json)
(see the [host README](../../../app/backend/doric-host/README.md)).

To rebuild and stage every bundle under `bundles/`:

```console
npx nx run doric-host:build-bundles
```
