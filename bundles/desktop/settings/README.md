# Settings bundle

`settings` is where you connect Doric to your models. Its settings window lets
you add providers, pick the workspace default model and reasoning effort that
new top-level Threads start on, set the turn limit and store credentials, and
every change saves itself as you type. The conversation footer carries a quick
model and effort picker for the selected Thread, so you can switch its model
without leaving the chat.

It is a desktop bundle with one client part (the settings window and the
footer picker), loaded by the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **UI:** `<settings-page>` at `/settings`, the settings window's one React
  root, and `<settings-execution-picker>`, a `layout.footer` item (order 20)
  in the [`layout`](../layout/README.md) bundle's conversation footer. It
  edits the selected Thread's provider, model and effort through
  `runtime.threads/v1.setThreadExecution`. With no Thread selected it shows
  the workspace default read-only, titled "New threads start on the workspace
  default. Change it in Settings." It never writes `models.execution`: the workspace default
  changes only in Settings. The bundle requires `runtime.threads/v1` and
  reads `layout.workspace/v1` optionally.
- **Sections:** six child routes of `/settings`, each listed in the window's
  nav through the `settings.sections` region.
- **Region:** `settings.sections`, where other bundles add their own sections.
- **Contract:** `settings.config/v1` (client), the window's one autosave draft
  for sections other bundles draw.

The window is opened by `core`'s `core.open-settings/v1` command, which the
layout's settings button runs. In 1.1.0 the command focuses an open settings
window when it gets no `path`; otherwise it opens one at `path ?? defaultPath`,
and with neither it fails with `invalid_input`. The layout passes
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
- The footer picker writes each choice at once through `setThreadExecution`,
  without a toast; a typed model commits on blur or Enter, and a refused write
  shows an inline error notice with its reason.
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
  the dashboard's Providers group; a failed Claude sign-in is an error toast
  (id `claude-login-failed`, the success keeps `claude-login`), and a failure
  to open a provider's site is an error toast (id `provider-open-site`);
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
