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

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts)),
  exported as `account/contracts`: the slot names `ACCOUNT_STATUS` and
  `ACCOUNT_MENU`, and the type `AccountMenuItemProps`. It holds no contract
  id.
- **Client** ([`src/client/index.ts`](src/client/index.ts)): the activation,
  the element `<account-status>` and the menu.

## Contracts used

- `ui/v1`: defines the element `account-status`, and hosts the elements that
  fill the two slots ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `regions/v1`: adds `<account-status>` to the shell's slot and reads the
  items of `account.status` and `account.menu`
  ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/hooks/use-menu-items.ts`](src/client/hooks/use-menu-items.ts),
  [`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `commands/v1`: executes the command of a picked menu entry
  ([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
- `doric.about/v1` (platform): gives the app version the About line shows. The
  bundle builds its reference from the id with `ref('doric.about/v1')` and
  follows it with `services.whenAvailable`, so it runs whether or not the
  platform provides it ([`src/client/domain/about.ts`](src/client/domain/about.ts)).
- The slot name `SHELL_WINDOW_ACTIONS` of `layout/contracts`, imported as a
  type only ([`src/client/index.ts`](src/client/index.ts)).

## Activation

`activate` ([`src/client/index.ts`](src/client/index.ts)):

1. starts following `doric.about/v1` (see [About line](#about-line));
2. defines the element `account-status` through `ui/v1`;
3. adds the item `{ id: 'account', tag: 'account-status' }` to the shell's
   slot `shell.window.actions` through `regions/v1`.

Its cleanup removes the slot item, removes the element definition, stops
following `doric.about/v1` and clears the version, and forgets which
malformed menu items it has reported.

`shell.window.actions` is the window's actions slot: the end of the Project
tab bar in the page form, the end of the Project panel's header in the
conversation form ([`layout` README](../layout/README.md)).

## What it draws

`<account-status>`, the account status drawn by `account`
([`src/client/elements/account-status-element.tsx`](src/client/elements/account-status-element.tsx),
[`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).
The element takes no attributes. It is a 20×24 px box (`h-6 w-5`) that holds:

- a button named "Account" (`aria-label`), which shows the reader's avatar
  (`ReaderAvatar` of `desktop/ui/reader-avatar`, for `READER_NAME` of
  `desktop/ui/identity`) and opens the account menu;
- the `account.status` slot: a 14×14 px box (`size-3.5`) at 10 px from the
  left and 12 px from the top, over the avatar's bottom-right corner. It is a
  sibling of the button, not inside it, so each of its items is its own Tab
  stop. Each item is drawn as its element (`tag`) with its `props`, in region
  order.

Each `account.status` item and each `account.menu` icon is mounted with
`ElementHost` of `desktop/ui/element-host`
([`packages/desktop/src/element-host.tsx`](../../../packages/desktop/src/element-host.tsx)),
which creates the element through `ui/v1` when its `tag` first appears,
passes a badge its item's `props` at that moment only (an icon gets none),
and disposes it when the item goes or, for an icon, when the menu closes.
When the element cannot be created, a compact notice "View failed to open" is
drawn in its place and
``console.error(`Doric: the element <${tag}> could not be created:`, error)``
is logged. The `props` of `account.status` items are not checked.

The account menu is a dropdown menu 240 px wide (`w-60`), aligned to the
button's end. From top to bottom:

1. the header: a 32 px avatar, `READER_NAME` above "Local account";
2. when at least one `account.menu` entry is drawable: a separator, then each
   entry as one menu item, its icon element first and its `label` after;
3. a separator;
4. the About line: an info icon, "Doric" above the license text
   ([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).

Picking an entry executes its `command` with its `input` through
`commands/v1`, once per pick. A pick does not wait for the command; when the
command rejects, the bundle logs
`console.error('Doric: the command <command> could not run:', error)`
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

## Slots

Both names are exported from `account/contracts`
([`src/contracts/index.ts`](src/contracts/index.ts)). A filler imports the
name with `import type` and writes the slot as a literal checked against it
(`'account.menu' satisfies typeof ACCOUNT_MENU`).

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
`isContractId` of `bundle/contracts` (lowercase segments separated by `.`,
then `/v` and a positive major, such as `core.open-settings/v1`:
[`packages/bundle/src/contracts/ids.ts`](../../../packages/bundle/src/contracts/ids.ts)),
and whose `input` is absent or an object
that is not `null` and not an array. Extra keys are allowed and ignored
([`src/client/domain/menu-items.ts`](src/client/domain/menu-items.ts)).

An item that fails the check is not drawn. The bundle reports it once per
item id until the activation's cleanup, with
`console.error('Doric: the account menu item "<id>" of <owner> has malformed props and is not drawn:', props)`
([`src/client/hooks/use-menu-items.ts`](src/client/hooks/use-menu-items.ts)).

The bundle does not size an entry's icon element. The menu item's `svg` rule
sizes an SVG without a `size-*` class to 16 px (`size-4`), and it is the only
sizing
([`packages/desktop/src/components/dropdown-menu.tsx`](../../../packages/desktop/src/components/dropdown-menu.tsx)).
The element's host gives it the muted colour
(`text-muted-foreground`) and passes it no props, so the filler's SVG takes
`currentColor`
([`src/client/components/organisms/account-status.tsx`](src/client/components/organisms/account-status.tsx)).

## Data and side effects

- The bundle stores nothing: it has no settings, no persistence and no
  configuration. The reader's name is the constant `READER_NAME`, and the
  account line is the fixed text "Local account".
- Its only side effects are the slot item and element definition of its
  activation, the commands it executes on a pick, and the `console.error`
  lines above ([`src/client/index.ts`](src/client/index.ts)).

## Build and test

Each command runs from the repository root.

```console
npx nx run bundle-account:build
npx nx run bundle-account:typecheck
npx nx run bundle-account:test
```

- `build` ([`project.json`](project.json)) compiles `src/contracts/` to
  `dist/contracts/` (`tsconfig.json`), typechecks the client, stories and
  preview harness (`tsconfig.client.json`), and runs the bundle build, which
  writes `dist/client/index.js`, `dist/manifest.json`, `dist/contracts.json`
  and `dist/package.json`.
- `typecheck` emits only the declarations of `src/contracts/` and typechecks
  the client, stories and preview harness, without the bundle build.
- `test` builds the bundle, compiles `tests/` with `tsconfig.spec.json` (the
  contracts, `src/client/domain/` and `tests/*.ts`) and
  `tsconfig.client-spec.json` (`tests/client/`), and runs them with
  `node --test`. The tests under `tests/client/` boot `happy-dom`; those that
  test what the element draws mount `<account-status>` on a fake host
  ([`tests/client/support/render-account.ts`](tests/client/support/render-account.ts)).

The stories under `stories/` render `<account-status>` on the same fake host
([`stories/support/account-host.tsx`](stories/support/account-host.tsx),
[`stories/support/fake-host.ts`](stories/support/fake-host.ts)), wrapped by
the preview harness [`.storybook/preview.tsx`](.storybook/preview.tsx), which
loads the platform theme `desktop/ui/theme.css`; the bundle has no stylesheet
of its own.

The Doric host loads `account` because its id is in the `enabled` list of
[`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json)
(see the [host README](../../../app/backend/doric-host/README.md)).

To rebuild and stage every bundle the Doric host uses:

```console
npx nx run doric-host:build-bundles
```
