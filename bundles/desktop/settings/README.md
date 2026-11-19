# Settings bundle

`settings` is where you connect Doric to your models. Its settings window lets
you add providers, pick the workspace default model and reasoning effort that
new top-level Threads start on, set the turn limit and store credentials, and
every change saves itself as you type. It also tells the conversation footer's
model and effort picker, which the [`chat`](../chat/README.md) bundle draws,
what to offer and what each choice runs on (`settings.models/v1`).

It is a desktop bundle with one client part (the settings window), loaded by
the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **UI:** `<settings-page>` at `/settings`, the settings window's one React
  root. `core.open-settings/v1` and `workspace.dashboard/v1` are `optional`;
  the bundle builds the reference of `workspace.dashboard/v1` from its id
  (`src/client/api/navigation-refs.ts`) and imports only its type from
  `workspace/contracts`, which the `workspace` bundle provides (settings
  1.11.1).
- **Sections:** six child routes of `/settings`, each listed in the window's
  nav through the `settings.sections` region.
- **Region:** `settings.sections`, where other bundles add their own sections.
- **Provider field slot** (from 1.12.0): `settings.provider.field`
  (`SETTINGS_PROVIDER_FIELD`), where another bundle draws one field of one
  provider kind's form. An item is an element whose `props` are
  `ProviderFieldItemProps` (`kind`, `field`); on a provider page of that kind,
  `settings` draws the element in place of the field it names, in the settings
  window's Providers section and on the Dashboard's provider page. It sets the
  element's `view` (`ProviderFieldView`: `kind`, `field`, the draft's `value`,
  the `label` of the credential that value names, set only when it names a
  stored `API_TOKEN` credential, and `problem`,
  while that field keeps the provider from being saved: `missing` for a
  required field that is empty, `unknown` for a `secret` field that names no
  stored credential; an optional field that is empty has none, from 1.12.2)
  and takes the
  element's answer from the bubbling, composed DOM event
  `settings-provider-field` (`detail: { value }`): it reads the credentials
  again, then writes `value` into the field if the open provider is still of
  that kind. With two items for one kind and field the first by `order` is
  drawn; with none, or with an item whose props are not two non-empty strings,
  `settings` draws the field itself. When `ui.create` throws for an item's
  tag, `settings` draws the field itself too (from 1.12.2) and takes no
  `problem` from that item. While a drawn item reports a `problem`,
  the item shows the message and the page draws no "This provider cannot be
  saved yet" alert. The provider page names no kind: the Claude sign-in is
  the [`claude-login`](../../features/claude-login/README.md) bundle's item.
- **Account menu entry:** the "Settings" data item in the `account` bundle's
  `account.menu` slot, drawn with `<settings-entry-icon>`; it runs
  `core.open-settings/v1` with `defaultPath: '/settings'`. `settings` loads
  without `account`: it imports `account/contracts` as a type only
  (`import type`), so the entry is simply not drawn.
- **Dashboard entries:** the "All settings" data item in the `workspace`
  bundle's `workspace.dashboard.footer` slot, drawn with
  `<settings-entry-icon>`, which runs the same command; the Providers group in
  `workspace.dashboard.nav` and the provider page in
  `workspace.dashboard.page`. `settings` names these slots and
  `DashboardFooterItemProps` by `import type` from `workspace/contracts`, so it
  loads without `workspace`, and then the Dashboard has no settings entry.
  `<settings-entry-icon>` draws the settings glyph at 16 px in the colour of
  the entry that hosts it (from 1.10.0).
- **Contracts:** `settings.config/v1` (client, 1.1.0), the window's one
  autosave draft for sections other bundles draw, and, from 1.11.0,
  `settings.models/v1` (client, 1.0.0): for one stored execution, or for the
  workspace default, the picker's groups of models with their icons, the
  efforts the shown model accepts and their labels, and the execution each
  pick yields. Every rule behind it is this bundle's (`domain/config.ts`,
  `domain/model-icons.ts`, and `resolveThreadExecution` of
  `runtime/contracts`); the chat applies none. It is read only: the chat
  writes a Thread's execution through `runtime.threads/v1`, and nothing
  writes the default through it. The view reads the window's
  `['config', 'snapshot']` query, read again on a window focus and after a
  save, so a model the provider page adds reaches the footer at once.
- **Contracts module:** `settings/contracts` (`src/contracts/`, emitted to
  `dist/contracts/`): the two contracts, the eight types a configuration draft
  is made of, `SETTINGS_SECTIONS`, the name of the `settings.sections`
  slot, and, from 1.12.0, the provider field slot's `SETTINGS_PROVIDER_FIELD`,
  `ProviderFieldItemProps` and `ProviderFieldView`. No file of it imports
  `src/client`; `git` imports `SettingsConfigV1` from it, the chat its types,
  and `claude-login` the slot's types.

The window is opened by `core`'s `core.open-settings/v1` command, which two
entries run: the Dashboard's "All settings", which this bundle adds to
`workspace.dashboard.footer` and `workspace` executes, and the account menu's
"Settings", which this bundle adds to `account.menu` and `account` executes. In 1.1.0, with no `path`, the command focuses an open settings
window, or opens one at `defaultPath` when none is open; with a `path`, it
focuses an open settings window and navigates it to `path`, or opens one there;
with neither `path` nor `defaultPath` and no window open it fails with
`invalid_input`. Both entries pass
`defaultPath: '/settings'`, so the window opens at `/settings` and moves to the
last section that window showed, or Providers.

## Sections

| Path                    | Section     | What it edits                                                                    |
| ----------------------- | ----------- | -------------------------------------------------------------------------------- |
| `/settings/profile`     | Profile     | your optional name and time zone, which the agent's prompts will use             |
| `/settings/providers`   | Providers   | every provider Doric may call, its fields, its models and the credential it uses |
| `/settings/execution`   | Execution   | the workspace default provider, model and reasoning effort, and the turn limit   |
| `/settings/threads`     | Threads     | when agent threads and inactive main threads move to Archived (Auto-archive)     |
| `/settings/tools`       | Tools       | the fields each tool of the loaded bundles declares in the `tools/v1` catalog    |
| `/settings/credentials` | Credentials | the secrets of the kinds it manages, which the host stores and never sends back  |

Other bundles add sections the same way:

- [`git`](../../features/git/README.md) adds Versioning at `/settings/git`;
- `artifacts` adds Review at `/settings/review`.

The nav has a search that keeps the sections whose label or description
matches, so typing "turns" finds Execution and "time zone" finds Profile.

Profile comes first in the nav, but a window that has shown no section yet
still opens on Providers. Its Name field and Time zone combobox save into
`profile` of the configuration (`host-config/v1@^1.1.0`). The combobox lists
the zones `Intl` supports, always UTC, and "Host time zone", which removes
`profile.timezone` so the host's own zone applies; clearing both fields
removes `profile`. The name and zone are never taken from the host's
operating system, because the host can be remote. `settings.config/v1` 1.1.0
carries `profile` in the shared draft.

## Saving

- There is no Save button. A change is sent once typing settles (500 ms), at
  once on a field blur, and before the window closes through the window's
  `onFlushHook`.
- The window confirms an accepted save with a "Settings saved." toast (id
  `config-save`) and shows a refused one as an error toast (id
  `config-save-failed`) with the host's reason; a later success dismisses the
  failure toast.
- `domain/config.ts` mirrors the host's validation, so a draft the host would
  refuse is never sent; the host validates again.
- A section from another bundle edits through `settings.config/v1` (`draft`,
  `setDraft`, `subscribe`), so it shares the window's one draft, debounce and
  save.
- A secret is never read back: the host answers only whether one is stored.

**Known limitation:** values edited in the Tools section, along with
`execution.maxToolResultChars` and `execution.contextCompaction`, are not sent
to the host. This behavior is kept from the earlier renderer on purpose and
covered by the adapter tests.

## Host contracts

All host calls go through one adapter, `src/client/api/settings-api.ts`:

- `host-config/v1` reads and replaces the configuration;
- `models/v1` lists provider kinds and reads a provider's model catalog from
  its endpoint; a kind that sets `modelsFromCatalog` (Claude) has no model
  editor: its models are that catalog, read once the provider can sign in and
  shown read-only;
- `secrets/v1` lists, creates, updates and removes credentials; the window
  lists only the kinds it manages (API token, Username and password, Git
  identity) and leaves out every other kind, such as the MCP bundle's sign-in
  tokens; a malformed entry of a managed kind, or one whose kind is not a
  string, still fails the list, and the Credentials section then shows an
  announced block error notice with Retry instead of the list; a refused
  create, update or remove is an error toast (id `credentials-write-failed`),
  and a success toast (id `credentials-write`) first dismisses it;
- a failed read of the provider kinds shows an announced block error notice
  with Retry in the settings window's Providers section, and a compact one in
  the dashboard's Providers group;
- on the Dashboard's provider page, a kind whose descriptor names an `https:`
  site draws a control that opens it in the browser; a failure to open it is
  an error toast (id `provider-open-site`); the settings window's provider
  screen (`SettingsProviderScreen`) draws no such control;
- `tools/v1` reads the tool catalog and each tool's declared fields.

## Development

```console
npx nx build bundle-settings
npx nx typecheck bundle-settings
npx nx test bundle-settings
```

`tests/*.test.ts` are DOM-free; `tests/client/*.test.ts` boot a happy-dom window
with the built core and settings parts. Stories under `stories/` are CSF3, and
`.storybook/preview.tsx` is the harness that wraps them. The build writes
`bundles/desktop/settings/dist`, which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/settings`. To rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
