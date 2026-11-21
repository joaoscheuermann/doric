# Settings bundle

`settings` draws the settings window, where the reader edits the host
configuration: the providers Doric may call, the default execution new
top-level Threads start on, the turn limit, the profile, the auto-archive
policy and the stored credentials. It also draws the Providers group and the
provider page of the `/projects` dashboard, and it tells the conversation
footer's execution picker, which the [`chat`](../chat/README.md) bundle draws,
what to offer (`settings.models/v1`). Every change saves itself: the window has
no Save button.

It is a desktop bundle with one part, the client part `src/client/`, and a
contracts module, `settings/contracts`. See
[`packages/bundle`](../../../packages/bundle/README.md) for how a bundle is
loaded and activated.

Feature docs that describe this bundle's behavior across bundles:
[settings](../../../docs/features/settings.md),
[per-thread model](../../../docs/features/per-thread-model.md),
[credentials](../../../docs/features/credentials.md),
[models and providers](../../../docs/features/models-and-providers.md),
[provider sign-in](../../../docs/features/provider-sign-in.md),
[git](../../../docs/features/git.md),
[thread archive](../../../docs/features/thread-archive.md),
[UI redesign](../../../docs/features/ui-redesign.md) and
[error messages](../../../docs/features/error-messages.md).

## Manifest

[`manifest.json`](manifest.json):

- `id`: `settings`; `version`: `1.12.2`; `engines.doric`: `^1.9.0`;
  `description`: "The settings window."
- `provides`: `settings.config/v1@1.1.0`, `settings.models/v1@1.0.0`.
- `requires`: `hooks/v1@^1.0.0`, `ui/v1@^1.0.0`, `navigation/v1@^1.0.0`,
  `regions/v1@^1.0.0`, `host-config/v1@^1.2.0`, `secrets/v1@^1.0.0`,
  `models/v1@^1.3.0`, `tools/v1@^1.0.0`.
- `optional`: `core.open-settings/v1`, `workspace.dashboard/v1`.

The package ([`package.json`](package.json)) exports only `./contracts` and
`./package.json`.

## Activation

`activate` of the client part ([`src/client/index.ts`](src/client/index.ts))
does, in order:

1. Binds the host adapter to the activation's services
   ([`src/client/api/settings-api.ts`](src/client/api/settings-api.ts)).
2. Provides `settings.config/v1` and `settings.models/v1`.
3. Defines the custom elements `settings-page`, `settings-link`, one
   `settings-<id>` per built-in section (`profile`, `appearance`, `providers`,
   `execution`, `threads`, `tools`, `credentials`),
   `settings-dashboard-providers`, `settings-dashboard-provider` and
   `settings-entry-icon`.
4. Registers the route `/settings`, which creates `settings-page`, and, for
   every built-in section but Appearance, the child route `/settings/<id>` and
   its link in the `settings.sections` slot. Appearance's route and link exist
   only while a `doric.appearance/v1` provider is available, and are removed
   when it goes ([`src/client/appearance-section.ts`](src/client/appearance-section.ts)).
5. Adds its items to other bundles' slots (see
   [Items in other bundles' slots](#items-in-other-bundles-slots)).
6. Follows the window's route so that the bare `/settings` moves to a section
   (see [Routes](#routes)).
7. Records whether a `workspace.dashboard/v1` provider is available.

The function it returns disposes every registration in reverse order, stops
the `settings.models/v1` service, clears the window's query cache and unbinds
the adapter.

Every host call of the window goes through the one adapter of
[`src/client/api/settings-api.ts`](src/client/api/settings-api.ts), bound to
the activation's services; an element's own services are never used for it,
because they are disposed with the element. While the bundle is not active,
the adapter fails every call with `SettingsApiError('internal', 'Doric backend
is unavailable.')`.

## Contracts it provides

Both are client contracts, provided in each window that loads the part, and
local: their methods take functions and hand back live values. Their
declarations are in [`src/contracts/`](src/contracts/).

### `settings.config/v1` (1.1.0)

The settings window's one autosave draft, for a section another bundle draws
([`src/contracts/config.ts`](src/contracts/config.ts),
[`src/client/services/settings-config.ts`](src/client/services/settings-config.ts)).

```ts
interface SettingsConfig {
  draft(call?: CallArg): ConfigurationDraft | undefined;
  setDraft(
    update: (draft: ConfigurationDraft) => ConfigurationDraft,
    call?: CallArg,
  ): void;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}
type ConfigurationDraft = Configuration; // see Data
```

- `draft()` answers the window's draft, or `undefined` before the
  configuration has loaded and while no settings view is mounted.
- `setDraft(update)` replaces the draft with `update(draft)` at once, so two
  calls in a row compose; it is ignored while there is no draft. The change
  is then saved exactly like a change of a built-in section (see
  [Saving](#saving)).
- `subscribe(listener)` calls `listener` after every change of the draft; a
  listener that throws is logged and does not stop the others.

### `settings.models/v1` (1.0.0)

Everything the footer execution picker shows, and the execution each pick
yields ([`src/contracts/models.ts`](src/contracts/models.ts),
[`src/client/services/settings-models.ts`](src/client/services/settings-models.ts)).
The chat draws the view and writes a Thread's execution through
`runtime.threads/v1`; nothing writes the default execution through this
contract.

```ts
interface SettingsModels {
  view(stored?: StoredExecution, call?: CallArg): ExecutionView;
  subscribe(listener: () => void, call?: CallArg): Disposable;
  reload(call?: CallArg): void;
}
interface StoredExecution {
  providerId?: string;
  model?: string;
  effort?: string;
}
interface ModelChoice {
  label: string;
  value: string;
  icon?: string;
  execution: ModelExecution;
}
interface ModelGroup {
  label?: string;
  choices: readonly ModelChoice[];
}
interface EffortChoice {
  label: string;
  value: ReasoningEffort;
  note?: string;
  execution: ModelExecution;
}
type ExecutionView =
  | { status: 'loading'; error?: ErrorInfo; reloading: boolean }
  | {
      status: 'ready';
      error?: ErrorInfo;
      reloading: boolean;
      execution: ModelExecution; // the execution shown
      icon?: string; // SVG of the shown model's icon
      value: string; // the `value` of the shown model's choice
      listsModels: boolean; // false: no provider lists a model
      groups: readonly ModelGroup[];
      efforts: readonly EffortChoice[];
      effortLabel: string;
      typedProviderId: string; // the provider a model typed by hand is written on
    };
```

`CallArg` and `Disposable` are the types of `bundle/contracts`
([`packages/bundle`](../../../packages/bundle/README.md)): the optional call
argument every contract method takes, and `{ dispose(): void }`. `ErrorInfo`
is the error shape of `desktop/reads`:
`{ code: string; message: string; provider?: string; status?: number; retryable?: boolean; causes: { code?; provider?; status?; retryable?; message }[]; at?: string }`.
The method schemas are strict, and the platform checks each answer against
them: a view with a key its type does not name fails the call with
`invalid_output` ([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts),
`settle`).

- `view(stored)` reads the stored configuration from the window's query cache
  (key `['config', 'snapshot']`). Before the configuration was read it answers
  `{ status: 'loading' }`. Once it was read it answers a ready view of
  `stored`, resolved against the configuration by `resolveThreadExecution` of
  [`runtime/contracts`](../../runtime/runtime/README.md), or of the default
  execution `models.execution` when `stored` is absent:
  - `groups` are the models each provider lists, one group per provider in
    configuration order, each labelled with the provider's id, or `Provider
<n>` while the id is empty; with a single provider the one group has no
    label. A model the providers do not list but the execution names is still
    a choice, first in its provider's group, or, when no provider has that id,
    in an unlabelled group of its own placed before every other group; an
    empty execution model adds no choice
    ([`src/client/domain/config.ts`](src/client/domain/config.ts),
    `modelGroups`).
  - a choice's `value` is `<providerId>\u0000<model>`; its `execution` is the
    execution picking it yields: that model, with the effort the model starts
    at (`modelStartEffort` of `runtime/contracts`) and no effort when the
    model lists none.
  - `efforts` are the efforts the shown model lists, without `none`, each
    labelled with its value capitalised (`High`); the effort the model's
    catalog names as its default has `note: '(default)'`. `effortLabel` is
    the shown effort's label, `None` when the execution names none, and
    `Unavailable` when `efforts` is empty.
  - `typedProviderId` is the shown provider when a configured provider has
    that id, else the default execution's provider.
  - `icon` and each choice's `icon` come from `models/v1.icons` (see
    [Icons](#icons)); a failed icon read draws no icon.
  - `error` is the last failure of the configuration read, kept while a read
    that follows it runs and dropped once a read succeeds
    ([`src/client/domain/read-failure.ts`](src/client/domain/read-failure.ts));
    a ready view keeps the last configuration beside it. `reloading` is true
    while a read runs.
  - Equal arguments answer the same object until the configuration, an icon or
    the read's state changes. The service keeps the views of at most 8
    distinct `stored` values, the least recently read evicted first.
- `subscribe(listener)` calls `listener` after every change of what `view`
  answers. The first subscriber starts the configuration read and the icon
  reads; on every window focus the configuration is read again; the last
  subscriber leaving stops them. A listener that throws is logged.
- `reload()` reads the configuration again. It returns at once and never
  throws; a call while a read runs starts no second one.

A save of the settings window or of the dashboard's provider page invalidates
`['config', 'snapshot']`, so the footer sees a model the provider page adds at
once ([`src/client/hooks/use-config.ts`](src/client/hooks/use-config.ts)).

### Slots

Declared in [`src/contracts/slots.ts`](src/contracts/slots.ts) and drawn by
this bundle.

- **`settings.sections`** (`SETTINGS_SECTIONS`): the window's navigation.
  Each item is a `settings-link` element with the props
  `{ label: string; path: string; icon?: string; description?: string }`
  ([`src/client/elements.ts`](src/client/elements.ts)). `icon` names one of
  `user`, `sun-moon`, `server`, `zap`, `wrench`, `git-branch`, `key-round`,
  `messages-square` ([`src/client/domain/sections.ts`](src/client/domain/sections.ts),
  [`src/client/components/molecules/section-icon.tsx`](src/client/components/molecules/section-icon.tsx));
  an item draws in `order`. A bundle that adds a section adds its item here and
  registers its own child route of `/settings`, as
  [`git`](../../features/git/README.md) does for Versioning at `/settings/git`.
- **`settings.provider.field`** (`SETTINGS_PROVIDER_FIELD`): one field of one
  provider kind's form, drawn by another bundle, as
  [`claude-login`](../../features/claude-login/README.md) does for the Claude
  sign-in. An item is an element whose props are
  `ProviderFieldItemProps { kind: string; field: string }`
  ([`src/client/domain/provider-fields.ts`](src/client/domain/provider-fields.ts),
  [`src/client/components/organisms/settings-provider.tsx`](src/client/components/organisms/settings-provider.tsx),
  [`src/client/components/molecules/provider-field-element.tsx`](src/client/components/molecules/provider-field-element.tsx)):
  - An item whose props are not two non-empty strings is not drawn. Of two
    items for one kind and field, the first in region order is drawn.
  - On a provider page of that kind, the item's element is created through the
    activation's `ui/v1` (`ui.create(tag, { view })`) and drawn in the field's
    place, in the settings window and on the dashboard's provider page. When
    `ui.create` throws, the error is logged and the page draws the field
    itself for as long as the page stays open.
  - The page sets the element's `view` property, a `ProviderFieldView`
    `{ kind; field; value?; label?; problem? }`: `value` is the field's value
    in the draft (absent while empty); `label` is the name of the stored
    `API_TOKEN` credential `value` names, for a `secret` field; `problem` is
    set only while the provider has an id and cannot be saved: `missing` for
    a required field that is empty, `unknown` for a `secret` field whose value
    names no stored `API_TOKEN` credential.
  - The element answers with the bubbling, composed DOM event
    `settings-provider-field`, `detail: { value: string }`. The page stops the
    event at the field's frame, reads the credentials again, and then writes
    `value` into the field if the open provider is still of the item's kind
    ([`src/client/hooks/use-provider-page.ts`](src/client/hooks/use-provider-page.ts)).
  - While a drawn item reports a `problem`, the page draws no "This provider
    cannot be saved yet" alert.

### The contracts module

`settings/contracts` ([`src/contracts/index.ts`](src/contracts/index.ts),
built to `dist/contracts/`) exports the two contract refs
(`SettingsConfigV1`, `SettingsModelsV1`) and their method schemas
(`settingsConfigMethods`, `settingsModelsMethods`), the types of
`settings.models/v1`, the configuration types of [Data](#data)
(`ConfigurationDraft`, `Configuration`, `ProviderConfiguration`,
`ProviderModel`, `ProviderKindId`, `ModelExecution`, `ContextCompactionConfig`,
`Profile`, `AutoArchive`), and the slot names and types `SETTINGS_SECTIONS`,
`SETTINGS_PROVIDER_FIELD`, `ProviderFieldItemProps` and `ProviderFieldView`.

## Items in other bundles' slots

Added in [`src/client/index.ts`](src/client/index.ts). The slot names and prop
types come from `account/contracts` and `workspace/contracts` by `import type`
only, so the part loads in a composition without `account` or `workspace`; the
item is then not drawn.

| Slot                         | Item id             | Element                        | Props                                                                                              |
| ---------------------------- | ------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `account.menu`               | `settings`          | `settings-entry-icon`          | `{ label: 'Settings', command: 'core.open-settings/v1', input: { defaultPath: '/settings' } }`     |
| `workspace.dashboard.footer` | `settings`          | `settings-entry-icon`          | `{ label: 'All settings', command: 'core.open-settings/v1', input: { defaultPath: '/settings' } }` |
| `workspace.dashboard.nav`    | `providers`         | `settings-dashboard-providers` | none; `order: 100`                                                                                 |
| `workspace.dashboard.page`   | `settings.provider` | `settings-dashboard-provider`  | none                                                                                               |

`settings-entry-icon` draws the settings glyph at 16 px in the colour of the
entry that hosts it, hidden from assistive technology
([`src/client/views/entry-icon.tsx`](src/client/views/entry-icon.tsx)). The
`account` and `workspace` bundles run the entry's command:
`core.open-settings/v1` of [`core`](../../foundation/core/README.md) with
`defaultPath: '/settings'` focuses an open settings window, or opens one at
`/settings` when none is open.

## Contracts it uses

Through the adapter ([`src/client/api/settings-api.ts`](src/client/api/settings-api.ts)):

- `host-config/v1` ([`host-config`](../../foundation/host-config/README.md)):
  `current()` reads the configuration with its `revision` and `updatedAt`;
  `replace(input)` replaces it.
- `models/v1`: `kinds()` lists the provider kinds; `kind(id)` and
  `catalog({ kind, configuration })` read a provider's model catalog from its
  endpoint; `icons({ requests })` answers provider and model icons.
- `secrets/v1`: `list`, `create`, `update` and `delete` of credentials.
- `tools/v1`: `catalog()` lists the tools of the loaded bundles with the
  configuration fields each declares.
- `workspace.dashboard/v1` (optional, provided by
  [`workspace`](../../desktop/workspace/README.md)): `active()`, `show(id)` and
  `subscribe(listener)` of the dashboard's shown page. Its ref is built from
  its id ([`src/client/api/navigation-refs.ts`](src/client/api/navigation-refs.ts)).
  Without a provider, `active()` answers `undefined`, `show` does nothing and
  a subscription never hears a change.
- `doric.browser/v1`: `open(url)` opens a provider's site in the system
  browser.

Directly:

- `ui/v1`, `navigation/v1` and `regions/v1`, for the elements, routes and
  slot items of [Activation](#activation).
- `hooks/v1` with `doric.window.hooks/v1`: `onFlushHook` settles a pending save
  as the window closes
  ([`src/client/hooks/use-config-autosave.ts`](src/client/hooks/use-config-autosave.ts)).
- `doric.appearance/v1`, the app's theme preference: `get()` and
  `set({ theme })`, `theme` one of `dark`, `light`, `system`
  ([`src/client/api/appearance.ts`](src/client/api/appearance.ts); the
  contract is described in
  [window appearance](../../../docs/architecture/bundles/window-appearance.md)).
- `resolveThreadExecution`, `modelEfforts`, `modelStartEffort` and
  `modelDefaultEffort` of `runtime/contracts`, for the execution rules.

## Routes

[`src/client/domain/section-route.ts`](src/client/domain/section-route.ts):

- `/settings` creates `settings-page`; each section is a child route
  `/settings/<id>`.
- When the route is the bare `/settings`, the window replaces it (a
  `navigate(..., { replace: true })` after the current notification) with the
  last section route that window showed, or with `/settings/providers` when it
  has shown none. The memory is per window and outlives the page.
- The provider page is state of the page, not a route.

## The settings window

`settings-page` is the window's one React root; it sets `document.title` to
`Doric Settings` and mounts its own toaster
([`src/client/views/settings-page.tsx`](src/client/views/settings-page.tsx)).
The view ([`src/client/views/settings-view.tsx`](src/client/views/settings-view.tsx))
draws, inside the window template
([`src/client/components/templates/settings-window.tsx`](src/client/components/templates/settings-window.tsx)):

- **Nav:** every `settings.sections` item, in order, as a menu button with its
  icon and label; the item whose `path` is the current route is active, and
  selecting one closes an open provider page and navigates to its path.
- **Search:** keeps the nav items whose label or description contains the
  query, case-insensitively; a blank query keeps all. The section on screen
  stays even when the query hides its item
  ([`src/client/domain/settings-search.ts`](src/client/domain/settings-search.ts)).
- **Heading and breadcrumb:** the label and icon of the `settings.sections`
  item whose `path` is the route, so a section another bundle adds is named by
  its own item. While a provider page is open the heading is `Add provider` or
  `Edit provider`, the breadcrumb is `Settings › <section> › <provider>`, and
  a Back control and the section crumb close the page.
- **Issue alert:** while the draft cannot be saved, a destructive alert
  "This change cannot be saved yet" with the first reason (see
  [Validation](#validation)).
- **Footers:** the content footer shows `Revision <n> · Updated <local time>`
  of the last answer and the save state; the nav footer shows the save state
  alone. The save state is `Not saved` (destructive) after a failed save,
  `Saving…` while a save runs or a valid change waits, `Saved` when the draft
  equals the host's copy.
- A skeleton stands in for the section until the configuration is read. A
  blur on any field of the content sends the pending change.

### Sections

The built-in sections, in nav order
([`src/client/domain/sections.ts`](src/client/domain/sections.ts)):

| Order | Path                    | Label       | Icon              | Component                                                                              |
| ----- | ----------------------- | ----------- | ----------------- | -------------------------------------------------------------------------------------- |
| 5     | `/settings/profile`     | Profile     | `user`            | [`settings-profile.tsx`](src/client/components/organisms/settings-profile.tsx)         |
| 7     | `/settings/appearance`  | Appearance  | `sun-moon`        | [`settings-appearance.tsx`](src/client/components/organisms/settings-appearance.tsx)   |
| 10    | `/settings/providers`   | Providers   | `server`          | [`settings-providers.tsx`](src/client/components/organisms/settings-providers.tsx)     |
| 20    | `/settings/execution`   | Execution   | `zap`             | [`settings-execution.tsx`](src/client/components/organisms/settings-execution.tsx)     |
| 25    | `/settings/threads`     | Threads     | `messages-square` | [`settings-threads.tsx`](src/client/components/organisms/settings-threads.tsx)         |
| 30    | `/settings/tools`       | Tools       | `wrench`          | [`settings-tools.tsx`](src/client/components/organisms/settings-tools.tsx)             |
| 50    | `/settings/credentials` | Credentials | `key-round`       | [`settings-credentials.tsx`](src/client/components/organisms/settings-credentials.tsx) |

Each section has a description the search matches, in
[`sections.ts`](src/client/domain/sections.ts).

- **Profile:** a Name field and a Time zone combobox, saved in `profile`. The
  combobox offers "Host time zone" first, which removes `profile.timezone` so
  the host's own zone applies, then every zone `Intl.supportedValuesOf` lists
  plus `UTC` and the stored zone, once each, sorted. A cleared field removes
  its key, and a profile with no key is removed. The window never fills these
  from the operating system
  ([`config.ts`](src/client/domain/config.ts), `updateProfileName`,
  `updateProfileTimezone`, `timeZoneChoices`).
- **Appearance:** a Theme radio group of three tiles, Dark (default), Light,
  and System ("Follow the macOS appearance"). It reads the theme through
  `doric.appearance/v1` each time it mounts; the tiles are disabled while a
  read or a save runs, and the selection moves only once the app saved it.
  Arrow keys move along the group and choose. A failed read shows "Could not
  read the appearance."; a failed save shows "Could not save the appearance.
  Try again." The theme is not part of the host configuration.
- **Providers:** a table of the configured providers (id, kind, address, model
  count, actions Edit and Remove provider), with a name filter, paging and an
  Add provider control, disabled while the host declares no kind. The address
  is the value of the kind's `url` field, or `—`. Removing the provider the
  default execution names sets the execution's provider to the first
  remaining provider (empty when none remains) and keeps its model and
  effort. Above it: the kinds-read notice (see [Errors](#errors-and-failure)),
  an alert "No provider kind is available" when the host declares none, and
  an alert "No API token is stored yet" while no `API_TOKEN` credential
  exists. Add and Edit open the provider page
  ([`settings-providers.tsx`](src/client/components/organisms/settings-providers.tsx),
  [`config.ts`](src/client/domain/config.ts), `removeProvider`).
- **Execution:** the default execution and the run limits: a Provider picker
  over the configured providers; a Model picker over that provider's models,
  or a text field when it lists none; a Reasoning effort picker over the
  efforts the model lists, without `none` ("Not offered by this model" when
  it lists none); a Turn limit; and a Tool result limit, empty for the host's
  default. Changing the provider or the model sets the effort to the one the
  new model starts at, or none when it lists none
  ([`settings-execution.tsx`](src/client/components/organisms/settings-execution.tsx),
  [`config.ts`](src/client/domain/config.ts), `updateModel`).
- **Threads:** a switch "Archive finished agent threads"
  (`threads.autoArchive.agentThreads`, default on) and a choice "Archive
  inactive main threads after" of 1 day, 7 days (default), 30 days or Never
  (`mainThreadsAfter` `1d`, `7d`, `30d`, `never`). A change stores both keys
  ([`config.ts`](src/client/domain/config.ts), `autoArchiveOf`,
  `updateAutoArchive`).
- **Tools:** one group per tool of the `tools/v1` catalog that declares
  fields, each field drawn by its kind (`enum` as a picker over its options,
  every other kind as a text input), editing `tools[<tool>][<field>]`. It
  shows "Loading tools…" during the first read and "No tool declares
  configuration yet." when none does
  ([`settings-tools.tsx`](src/client/components/organisms/settings-tools.tsx)).
- **Credentials:** a table of the stored credentials of the kinds this window
  manages, with a dialog to add or edit one and a Remove action. The kinds
  are API token (`API_TOKEN`: a secret), Username and password
  (`USERNAME_PASSWORD`: a username and a secret) and Git identity (`GIT`: a
  username and an email, no secret). A secret is never read back: the host
  answers only `hasSecret`. Writes go to `secrets/v1` at once, not through the
  configuration draft
  ([`settings-credentials.tsx`](src/client/components/organisms/settings-credentials.tsx),
  [`use-credentials.ts`](src/client/hooks/use-credentials.ts),
  [`config.ts`](src/client/domain/config.ts), `credentialFields`).

The configuration's `gitCredentialId` and `githubCredentialId` are edited by
the Versioning section of [`git`](../../features/git/README.md), through
`settings.config/v1`.

### The provider page

[`settings-provider.tsx`](src/client/components/organisms/settings-provider.tsx),
[`use-provider-page.ts`](src/client/hooks/use-provider-page.ts):

- **Kind:** a combobox of the kinds `models/v1` lists, with the kind's
  description. Choosing a kind starts the draft over: an empty id, every
  declared field empty, and an empty model list when the kind keeps `models`.
- **Name:** the provider's `id`.
- **Fields:** each field the kind declares, in its order, drawn by its kind:
  `enum` offers its options, `secret` offers the stored `API_TOKEN`
  credentials, and `text`, `url` and `number` are typed. Fields marked
  `advanced` sit under a collapsed "Advanced settings". A field an item of
  `settings.provider.field` draws is drawn by that item.
- **Models**, when the kind keeps `models`:
  - a kind with `modelsFromCatalog` draws its models read-only: once its
    `secret` field names a credential (at once for a kind with no `secret`
    field) the page reads the catalog, and a read that lists models other
    than the draft's becomes the draft's list, with the catalog's efforts,
    default effort and `mandatory` when the kind keeps `reasonings`
    ([`provider-catalog-models.tsx`](src/client/components/organisms/provider-catalog-models.tsx));
  - a kind that declares a `modelsUrl` field offers the models its catalog
    lists to choose from, read when the picker opens and again on Reload
    ([`provider-model-picker.tsx`](src/client/components/organisms/provider-model-picker.tsx),
    [`use-provider-catalog.ts`](src/client/hooks/use-provider-catalog.ts));
  - any other kind has a model editor: one card per model with its name and,
    when the kind keeps `reasonings`, toggles for the efforts it accepts
    ([`provider-models-editor.tsx`](src/client/components/molecules/provider-models-editor.tsx)).
- **Issue alert:** "This provider cannot be saved yet" with the first reason
  the provider would be refused, unless a drawn field item reports a
  `problem`.
- The page owns no save: each change that makes the provider valid is
  written into the configuration draft at once (a new provider is appended
  and then edited at its position), and the window's autosave carries it. A
  change that leaves the provider invalid stays on the page only
  ([`config.ts`](src/client/domain/config.ts), `applyProviderDraft`).

## The dashboard's Providers

`settings-dashboard-providers` is a root of its own in the workspace window
([`src/client/views/dashboard-providers.tsx`](src/client/views/dashboard-providers.tsx)):

- The group ([`dashboard-providers.tsx`](src/client/components/organisms/dashboard-providers.tsx))
  folds from its label "Providers" and draws one row per configured provider,
  with its icon and name; the row of the open page is active. Its "+" (Add
  provider) opens a page for a new provider of the first kind; it is absent
  while the host lists no kind. A skeleton row stands in until the
  configuration is read. A failed kinds read, or else a failed credentials
  read, draws a compact, announced error notice with Retry after the rows.
- Opening a row, or "+", opens the provider page and asks the dashboard to
  show the page `settings.provider` (`workspace.dashboard/v1.show`). The page
  is drawn into `settings-dashboard-provider` while the dashboard shows it;
  when the dashboard shows another page, the provider page closes.
- The page ([`dashboard-provider-page.tsx`](src/client/components/organisms/dashboard-provider-page.tsx))
  has a title bar with the provider's icon and name (`Add provider` for a new
  one) and, for a kind whose descriptor names a `site`, a control labelled
  with the site's label that opens its URL in the system browser; then the
  same form as the settings window. The settings window's provider page has
  no such control.
- The group and the page share one draft, which saves as the settings window's
  does (see [Saving](#saving)); a blur on the page, and the group leaving the
  dashboard, send the pending change.

## Data

The configuration types ([`src/contracts/configuration.ts`](src/contracts/configuration.ts)):

```ts
type Configuration = {
  providers: readonly ProviderConfiguration[];
  models: { execution: ModelExecution };
  execution: {
    maxTurns: number;
    maxToolResultChars?: number;
    contextCompaction?: ContextCompactionConfig;
  };
  tools?: Record<string, Record<string, string>>; // tool name → field key → value
  gitCredentialId?: string; // the GIT credential git commits as
  githubCredentialId?: string; // the API_TOKEN credential GitHub authenticates with
  profile?: Profile;
  threads?: { autoArchive?: AutoArchive };
};
type ProviderConfiguration = {
  id: string;
  kind: string; // ProviderKindId
  configuration: Record<string, string>; // field key → value; a secret field holds a credential id
  models?: readonly ProviderModel[]; // present exactly when the kind keeps `models`
};
type ProviderModel = {
  name: string;
  reasonings?: readonly string[]; // present exactly when the kind keeps `reasonings`
  defaultEffort?: string;
  mandatory?: boolean; // reasoning cannot be turned off
};
type ModelExecution = {
  providerId: string;
  model: string;
  effort?: ReasoningEffort;
};
type ContextCompactionConfig = {
  enabled: boolean;
  pressurePercent: number;
  tailMinMessages: number;
  summaryMaxChars: number;
  charBudget: number;
};
type Profile = { name?: string; timezone?: string };
type AutoArchive = {
  agentThreads?: boolean;
  mainThreadsAfter?: '1d' | '7d' | '30d' | 'never';
};
```

`ReasoningEffort` is one of `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`. A read answers the configuration with `revision: number` and
`updatedAt: string`. The host owns and stores the configuration; this bundle
stores nothing of its own, and reads no setting, environment variable or
storage key of its own. Its client-side cache is one TanStack Query client
per window, with no retry and no refetch on focus or reconnect of its own
([`src/client/queries/client.ts`](src/client/queries/client.ts),
[`src/client/queries/keys.ts`](src/client/queries/keys.ts)).

The adapter also reads ([`src/client/domain/config.ts`](src/client/domain/config.ts)):

- a provider kind: `{ id, label, description, fields, lists, modelsFromCatalog?, site? }`,
  with fields `{ key, label, kind: 'text'|'url'|'number'|'enum'|'secret', required, description?, placeholder?, options?, advanced? }`
  and `lists` among `models` and `reasonings`; `site` (`{ url, label }`) is
  kept only when its URL parses with the `https:` scheme and its label is not
  empty, and is dropped otherwise without failing the kind;
- a catalog model: `{ id, name?, reasonings, parameters, defaultEffort?, mandatory? }`;
- a tool: `{ name, description?, settings }`, with fields shaped like a
  kind's plus `default?`;
- a credential: `{ id, kind, name, username?, email?, hasSecret }`.

### Saving

[`src/client/hooks/use-config.ts`](src/client/hooks/use-config.ts),
[`src/client/hooks/use-config-autosave.ts`](src/client/hooks/use-config-autosave.ts):

- Mounting a surface reads the configuration, and every answered read seeds
  both the host's copy and the draft. On load, a draft whose execution names
  a model that can reason but no effort, or `none`, gets the effort the model
  starts at.
- The draft is read again whenever the window regains focus, so one window's
  draft does not write over a change another window saved.
- A draft that differs from the host's copy and passes
  [Validation](#validation) is sent once typing settles for 500 ms, at once on
  a field blur, and before the window closes, through `onFlushHook` of
  `doric.window.hooks/v1`. A draft that fails validation is never sent.
- A save sends `host-config/v1.replace` with only `providers`,
  `models.execution`, `execution.maxTurns`, `gitCredentialId`,
  `githubCredentialId`, `profile` and `threads`; an empty or `null`
  credential reference is sent as none
  ([`settings-api.ts`](src/client/api/settings-api.ts), `desktopConfiguration`).
  The Tools section's values, `execution.maxToolResultChars` and
  `execution.contextCompaction` are not sent. The host's `replace` takes the
  whole configuration, so the stored configuration then holds none of them
  ([`bundles/foundation/host-config/src/host/config/service.ts`](../../foundation/host-config/src/host/config/service.ts)),
  and a draft that changed only them takes the host's answer back after the
  save.
- An accepted save replaces the host's copy, and replaces the draft unless it
  changed while the save ran; it shows the toast "Settings saved." (id
  `config-save`) after dismissing `config-save-failed`, once per revision. The
  first load is not announced.
- A refused save keeps the draft and shows an error toast (id
  `config-save-failed`) with the host's message; the next save replaces it.

### Validation

`configurationIssue` ([`src/client/domain/config.ts`](src/client/domain/config.ts))
answers the first reason the host would refuse a draft, as the sentence the
window shows under "This change cannot be saved yet", checking in this order
(`<id>` is the provider's id, `<label>` a field's label, `<name>` a model's
name):

1. Providers (`configurationIssue`, then `providerFieldsIssue` and
   `modelsIssue` for each provider in order):
   - no provider: "Add at least one provider.";
   - an id empty after trimming or longer than 128 characters: "Enter an id
     between 1 and 128 characters for every provider.";
   - an id already used: "Provider ids must be unique.";
   - a kind the host does not declare: "Choose a kind for <id>.";
   - a value under a key the kind does not declare: "Provider <id> carries a
     field its kind does not declare.";
   - then each declared field, in order, its value trimmed: a required field
     empty: "Enter <label> for <id>."; a `url` field that is not an `http:` or
     `https:` URL: "Enter an http:// or https:// address for <label> on
     <id>."; a `number` field that is not a finite number: "Enter a number for
     <label> on <id>."; an `enum` field outside its options: "Choose <label>
     for <id>.";
   - models on a kind that does not keep `models`: "Provider <id>'s kind does
     not keep models."; no model list on a kind that keeps it: "Provider <id>
     must carry its models.";
   - then each model, in order, its name trimmed: empty: "Every model must be
     named for <id>."; longer than 512 characters: "Enter a model of at most
     512 characters for <id>."; already listed: "Every model must be unique
     for <id>."; efforts on a kind that does not keep `reasonings`: "The kind
     of <id> does not keep a model's reasoning efforts."; no effort list on a
     kind that keeps it: "Model <name> must carry its reasoning efforts for
     <id>."; then each effort: empty: "Every reasoning effort must be filled
     in for <name>."; repeated: "Every reasoning effort must be unique for
     <name>."; outside the known set: "Choose a known reasoning effort for
     <name>."; and a default effort the model does not list: "Model <name>
     defaults to an effort it does not list.".
2. The default execution: a provider id no provider has: "Choose the provider
   that runs prompts."; a model empty after trimming or longer than 512
   characters: "Enter a model between 1 and 512 characters."; an effort
   outside the known set, refused even when the model lists no efforts, or no
   effort when the model lists efforts: "Choose a reasoning effort.".
3. A turn limit that is not an integer of 1 or more: "Enter a turn limit of 1
   or more.".
4. A tool result limit present and not an integer of 1 or more: "Enter a tool
   result limit of 1 or more, or leave it empty.".
5. A context-compaction policy, when present (`contextCompactionIssue`):
   `enabled` not a boolean: "Choose whether context compaction runs.";
   `pressurePercent` not an integer of 50 to 95: "Enter a compaction pressure
   between 50 and 95 percent."; `tailMinMessages` not an integer ≥ 1: "Enter
   a compaction tail of 1 or more messages."; `summaryMaxChars` not an
   integer ≥ 200: "Enter a compaction summary limit of 200 or more
   characters."; `charBudget` not an integer ≥ 1000: "Enter a compaction
   context budget of 1000 or more characters.".
6. The profile (`profileIssue`): a name empty after trimming or longer than
   100 characters: "Enter a name between 1 and 100 characters, or leave it
   empty."; a name with a line break: "Enter a name on one line."; a time zone
   `Intl.DateTimeFormat` refuses: "Choose a time zone this computer knows, or
   the host time zone.".

The provider page shows, under "This provider cannot be saved yet", the first
reason of `providerIssue` for its draft alone: the id length rule of item 1
(not its uniqueness, which only the whole list shows), the
field and model rules of item 1, and then, for each `secret` field whose
value names no stored `API_TOKEN` credential, "Choose the API token <id>
authenticates with."; with no kind chosen it shows "Choose a provider kind."
([`settings-provider.tsx`](src/client/components/organisms/settings-provider.tsx)).
Whether a `secret` field names a stored credential is checked only there,
where the credentials are in hand.

## Host adapter

[`src/client/api/settings-api.ts`](src/client/api/settings-api.ts) checks each
input before the call and each answer's shape after it.

- **Inputs.** A configuration save: provider ids and kinds and field keys 1
  to 128 characters after trimming, field values and model names 1 to 512
  after trimming, the execution's provider id 1 to 128 and model 1 to 512
  after trimming, efforts from the known set, `maxTurns` a positive safe
  integer, credential references at most 128 characters and no NUL, a
  `profile` whose `name` and `timezone` are strings when present, and a
  `threads.autoArchive` with `agentThreads` a boolean and `mainThreadsAfter`
  one of `1d`, `7d`, `30d`, `never` when present; otherwise
  `invalid_input` "The configuration is invalid.". A catalog read: a kind or
  a field key or value outside those bounds fails first with `invalid_input`
  "The configuration is invalid."; then the kind's trimmed id must be 1 to
  128 characters and known to `models/v1`, and the values must name only the
  kind's declared fields, each non-empty and accepted by its kind (`url`
  `http(s)://`, `number` finite, `enum` an option, `secret` a UUID), with
  every required one present; otherwise `invalid_input` "The provider values
  are invalid." (`guardedProviderValues`, `fieldsAccepted`). A credential
  (all `invalid_input`):
  - a secret that is not 1–512 printable ASCII characters without whitespace,
    or, on create, a username that is not 1–128 characters after trimming,
    fails with "The configuration is invalid." (`guardedSecret`,
    `optionalField`);
  - any other malformed input (a kind outside the three managed kinds, a name
    not 1–128 characters after trimming, an email that is not an address of
    at most 254 characters after trimming, an update's username not 1–128
    characters) fails with "The credential is invalid.";
  - the checks of the host route that follow (a name or username trimmed to
    1–128, an email of at most 256 characters, a secret of 1–512 characters
    without a line break, and on create exactly the fields its kind requires)
    fail with "The credential does not match its kind.";
  - an id that is empty, longer than 200 characters or holds a NUL fails with
    "The item identifier is invalid." (`guardedIdentifier`), and an id that is
    not a UUID with "The credential ID is invalid.".

  An update sends absent or `null` to keep a field, `''` to clear it, and a
  value to set it.

- **Answers.** An answer of the wrong shape fails with `invalid_output`
  "Doric returned an invalid response.". The credential list leaves out every
  entry whose `kind` is a string outside the three managed kinds, such as
  another bundle's sign-in tokens; a malformed entry of a managed kind, or one
  whose kind is not a string, still fails the list. An icon answer is checked
  against its requests: as many answers and models as asked, every SVG
  starting with `<svg` and at most `MODEL_ICON_MAX_LENGTH` long.
- **Errors.** Every rejection is a `SettingsApiError`, a `ClientError` of
  `desktop/reads` with `name: 'SettingsApiError'`, a `code` and a `message`:
  - a host out of reach (`unavailable`, `disconnected`, `generation_lost`,
    `protocol_error`): that code, "Doric backend is unavailable.";
  - a save: `invalid_input` with the host's message when it answers
    `invalid`; `internal` "The Doric configuration could not be activated."
    when it answers `rejected` or fails otherwise;
  - a catalog read that does not answer `read`: `internal` "The provider
    model catalog could not be read.";
  - a credential create or update: `credential_invalid` with the host's
    message, `credential_missing` "The credential was not found.",
    `credential_kind_immutable` and `credential_name_taken` "The credential
    cannot perform this operation.", `credential_storage_unavailable` "The
    host cannot store credential secrets."; a remove answered `missing` is
    `not_found` "The credential was not found.", and one answered
    `referenced` is `conflict` "The credential cannot perform this
    operation.";
  - any other failure: the host's contract error code (or `internal`) with
    "The request could not be completed.".
    `cause` holds the host's error when its code is not `internal`.

### Icons

Provider and model icons come from `models/v1.icons`, one request per provider
in configuration order with its kind, values and model names: its own models,
then the execution model when it is that provider's and not listed; names
longer than `MODEL_ICON_MAX_NAME` (512) are left out and at most
`MODEL_ICON_MAX_MODELS` (1000) names are asked per provider; an answered SVG
is at most `MODEL_ICON_MAX_LENGTH` (16,384) characters. The requests are not
capped at `MODEL_ICON_MAX_REQUESTS` (64): with more than 64 providers the
call is refused and the window draws no icon. The constants are those of
`models/v1` in `bundle/contracts`
([`packages/bundle/src/contracts/basic/models.ts`](../../../packages/bundle/src/contracts/basic/models.ts)).
The provider id never leaves the window. No request makes no call. A failed
icon read draws no icon and shows no error
([`src/client/domain/model-icons.ts`](src/client/domain/model-icons.ts)).

## Errors and failure

The bundle's error catalog
([`src/client/domain/error-catalog.ts`](src/client/domain/error-catalog.ts))
titles the notices and toasts it draws:

| Code                      | Title                  | Retry |
| ------------------------- | ---------------------- | ----- |
| `config_save_failed`      | Settings not saved     | yes   |
| `catalog_read_failed`     | Models not read        | yes   |
| `tools_read_failed`       | Tools not loaded       | yes   |
| `kinds_read_failed`       | Providers not loaded   | yes   |
| `credentials_read_failed` | Credentials not loaded | yes   |
| `credential_write_failed` | Credential not saved   | no    |
| `browser_failed`          | Page not opened        | no    |

Each notice shows the error's own message.

- A failed read of the provider kinds: an announced block notice with Retry
  in the Providers section; a compact one in the dashboard's group.
- A failed read of the credentials: an announced block notice with Retry in
  place of the Credentials list; a compact one in the dashboard's group.
- A failed read of the tool catalog: an announced block notice with Retry in
  the Tools section.
- A failed catalog read on a provider page: an announced notice with Retry in
  place of the models.
- A refused credential create or update: an announced notice in the dialog,
  which keeps what was typed; an accepted one closes the dialog and shows
  "Credential added." or "Credential saved." (id `credentials-write`) after
  dismissing `credentials-write-failed`.
- A refused credential remove: an error toast (id
  `credentials-write-failed`); an accepted one shows "Removed <name>." (id
  `credentials-write`).
- A failure to open a provider's site: an error toast (id
  `provider-open-site`).
- A save: see [Saving](#saving). A failed read of `settings.models/v1`: the
  view's `error`.

## Limits

- Autosave settle: 500 ms.
- `settings.models/v1` keeps at most 8 views.
- Icons: at most 1000 model names of at most 512 characters per provider, an
  SVG of at most 16,384 characters, and no icon with more than 64 providers
  (see [Icons](#icons)).
- Field limits are those of [Host adapter](#host-adapter) and
  [Validation](#validation).
- Nothing retries on its own: a read happens when a surface mounts, on a
  window focus (the configuration only) and on Retry.

## Build and test

```console
npx nx run bundle-settings:typecheck
npx nx run bundle-settings:test
npx nx run bundle-settings:build
```

The build ([`project.json`](project.json)) compiles `src/` except `src/client/`
with [`tsconfig.json`](tsconfig.json) (the contracts module to
`dist/contracts/`), checks the client with
[`tsconfig.client.json`](tsconfig.client.json), and bundles the part into
`dist/` with the `bundle` build. `doric-host:build-bundles` stages every
bundle's `dist/` into `app/backend/doric-host/dist/bundles/`.

The test target builds the bundle first, removes `dist-tests`, compiles
`tests/*.test.ts` ([`tsconfig.spec.json`](tsconfig.spec.json)) and
`tests/client/*.test.ts` ([`tsconfig.client-spec.json`](tsconfig.client-spec.json)),
and runs both under `node --test`. The tests under `tests/` are DOM-free; the
tests under `tests/client/` boot a happy-dom window with the built `core` and
`settings` client parts and fake the host contracts
([`tests/client/support/window.ts`](tests/client/support/window.ts)).
Stories under `stories/` are CSF3, wrapped by
[`.storybook/preview.tsx`](.storybook/preview.tsx).
