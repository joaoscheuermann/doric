# Settings bundle

`settings` is where you connect Doric to your models. Its settings window lets
you add providers, pick the model that runs your prompts and its reasoning
effort, set the turn limit and store credentials, and every change saves itself
as you type. The conversation footer carries a quick model and effort picker,
so you can switch models without leaving the chat.

It is a desktop bundle with one client part (the settings window and the
footer picker), loaded by the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **UI:** `<settings-page>` at `/settings`, the settings window's one React
  root, and `<settings-execution-picker>`, a `layout.footer` item (order 20)
  in the [`layout`](../layout/README.md) bundle's conversation footer.
- **Sections:** four child routes of `/settings`, each listed in the window's
  nav through the `settings.sections` region.
- **Region:** `settings.sections`, where other bundles add their own sections.
- **Contract:** `settings.config/v1` (client), the window's one autosave draft
  for sections other bundles draw.

The window is opened by `core`'s `core.open-settings/v1` command, which the
layout's settings button runs. It opens at `/settings` and moves to the last
section that window showed, or Providers.

## Sections

| Path                    | Section     | What it edits                                                                     |
| ----------------------- | ----------- | --------------------------------------------------------------------------------- |
| `/settings/providers`   | Providers   | every provider Doric may call, its fields, its models and the credential it uses  |
| `/settings/execution`   | Execution   | the provider and model that run a prompt, its reasoning effort and the turn limit |
| `/settings/tools`       | Tools       | the fields each tool of the loaded bundles declares in the `tools/v1` catalog     |
| `/settings/credentials` | Credentials | secrets the host stores and never sends back                                      |

Other bundles add sections the same way:

- [`git`](../../features/git/README.md) adds Versioning at `/settings/git`;
- `artifacts` adds Review at `/settings/review`.

The nav has a search that keeps the sections whose label or description
matches, so typing "turns" finds Execution.

## Saving

- There is no Save button. A change is sent once typing settles (500 ms), at
  once on a field blur, and before the window closes through the window's
  `onFlushHook`.
- The window confirms an accepted save with a "Settings saved." toast and shows
  the host's reason for a refused one.
- `domain/config.ts` mirrors the host's validation, so a draft the host would
  refuse is never sent; the host validates again.
- The footer picker saves the same way, without a flush on close and without a
  toast.
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
- `secrets/v1` lists, creates, updates and removes credentials;
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
