# settings

Apply these rules to `bundles/desktop/settings/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the settings window and the surfaces that edit the host
configuration and the stored credentials (the window's sections, the provider
page, the dashboard's Providers group and the footer picker's data of
`settings.models/v1`), and store nothing of its own: the configuration belongs
to the bundle that provides `host-config/v1`, and the credentials to the one
that provides `secrets/v1`. Do not draw another bundle's section or a provider
kind's own field: a section belongs to the bundle that owns what it edits, and
a field a kind draws its own way belongs to the bundle that owns the kind.

## Rules

- Keep the layers of `src/client/`: `components/{molecules,organisms,templates}/`
  for presentation and for the reads and local state of one section, which
  change the configuration draft only through `onChange`; `views/` for the
  pages, which own the configuration draft and compose templates;
  `elements.ts` for the custom elements `ui/v1` defines; `hooks/` for every
  exported `use*` hook; `queries/` for the TanStack Query keys and the
  window's client; `domain/` for pure rules; `api/` for the host adapter and
  the refs built from contract ids; `services/` for the providers of
  `settings.config/v1` and `settings.models/v1`.
- Call `host-config/v1`, `models/v1`, `secrets/v1`, `tools/v1`,
  `workspace.dashboard/v1` and `doric.browser/v1` only through `api()` of
  `src/client/api/settings-api.ts`; check there both the input before the
  call and the answer's shape after it, and fail only with a
  `SettingsApiError` that carries a code and the message the surface shows.
- Create another bundle's element for `settings.provider.field`, and read that
  slot's items, only through the `ui/v1` and `regions/v1` of
  `settingsServices()`, never through an element's services: an element's
  services hand back a scoped view that is never drawn.
- Put a rule that can be stated in terms of its arguments in `domain/`. Import
  from a `tests/*.test.ts` file only the files of `src/` that
  [`tsconfig.spec.json`](tsconfig.spec.json) includes
  (`src/client/domain/*.ts`, `src/client/services/*.ts`,
  `src/client/api/settings-api.ts`, `src/client/api/appearance.ts`,
  `src/client/appearance-section.ts`, `src/contracts/`), and add to its
  `include`, in the same change, any other file of `src/` such a test
  imports.
- Keep `configurationIssue` in `src/client/domain/config.ts` equal to the
  validation of the bundle that provides `host-config/v1`, and change both in
  one change: a draft it refuses is never sent, so a rule missing here reaches
  the reader only as a refused save.
- Keep every rule the conversation footer's execution picker shows in
  `settings.models/v1` (`src/client/services/settings-models.ts` over
  `domain/config.ts`): the chat draws the view and computes nothing of it.
- Never let a credential's secret reach the window: a credential view carries
  only `hasSecret`, and no call reads a secret back.
- List and write only the credential kinds of `credentialKinds` in
  `domain/config.ts`, and leave every other kind out of the list without
  failing it: other bundles store credentials of their own kinds.
- Name no provider kind in the provider page or the dashboard: draw every
  field from the kind's descriptor, and leave a field a kind draws its own way
  to an item of `settings.provider.field`, importing no other bundle's
  contracts for it.
- Reach `workspace.dashboard/v1` and `doric.appearance/v1` only through the
  refs built from their ids in `src/client/api/navigation-refs.ts` and
  `src/client/api/appearance.ts`, and import their types with `import type`,
  so that the part loads without `workspace` and offers Appearance only while
  an app answers `doric.appearance/v1`; keep `workspace.dashboard/v1` and
  `core.open-settings/v1` under `optional` in [`manifest.json`](manifest.json).
- Give every notice and error toast a code of `settingsErrorCatalog` in
  `src/client/domain/error-catalog.ts` as its `fallbackCode`, pass that
  catalog, and give each toast one fixed id per outcome, so that a new toast
  replaces the last one of its outcome.
- Add no unlayered rule to `src/client/styles.css`, and keep its `@source` of
  `packages/desktop/src`: the sheet holds only the utilities layer, so that a
  utility both it and the platform theme emit keeps one order, which
  `tests/styles-cascade.test.ts` checks.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "settings"`.
- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Add a built-in section in one change: its id in the `id` union of
  `SettingsSectionEntry` and its entry in `sections` of
  `src/client/domain/sections.ts` (id, label, an icon of `SectionIconName`,
  order and the description the search matches), and, for a new icon, its
  name in `SectionIconName` and its drawing in
  `src/client/components/molecules/section-icon.tsx`; its id in `sectionIds` and
  `sectionHosts` of `src/client/elements.ts`; its case in `Section` and in
  `useSectionHost` of `src/client/views/settings-view.tsx`; and its organism
  under `components/organisms/`, which edits the draft only through
  `onChange`. Give a section that depends on an optional contract its route
  and link only while that contract is available, as
  `src/client/appearance-section.ts` does.
- Add a configuration field in one change: its type in
  `src/contracts/configuration.ts`; its rule in `configurationIssue` and its
  comparison in `isSameConfiguration` of `src/client/domain/config.ts`; and its
  check in `desktopConfiguration` and its reading in `configurationFrom` of
  `src/client/api/settings-api.ts`, where a field `desktopConfiguration` does
  not keep never reaches the host; and, in the same change, the field in
  `ConfigInputSchema` of the bundle that provides `host-config/v1` and in
  `ConfigurationValue` of `host-config/contracts`, which `runtime/contracts`
  re-exports: the host's schema is strict and refuses a save that carries a
  key it does not declare.
- Add a host call to `SettingsApi` in `src/client/api/settings-api.ts`, its
  cache key to `src/client/queries/keys.ts`, and the hook that reads it under
  `hooks/`.
- Add what the footer picker shows as an optional field of `ExecutionView` in
  `src/contracts/models.ts`, in both the type and `viewSchema` (the schema is
  strict), computed in `src/client/services/settings-models.ts`.
- Test a host call or an answer reader in a `tests/*-adapter.test.ts` against
  the fakes of [`tests/support/host.ts`](tests/support/host.ts), and a
  behavior of the window in `tests/client/` through
  [`tests/client/support/window.ts`](tests/client/support/window.ts).
- Keep every file under `stories/` and `.storybook/` compiling: the typecheck
  target checks them with `src/client/`.
- Update the feature doc a change belongs to:
  [settings](../../../docs/features/settings.md) for the window and its
  sections, [per-thread model](../../../docs/features/per-thread-model.md) for
  `settings.models/v1`, [credentials](../../../docs/features/credentials.md)
  for the Credentials section,
  [thread archive](../../../docs/features/thread-archive.md) for the Threads
  section, [error messages](../../../docs/features/error-messages.md) for the
  error catalog, notices and toasts, [git](../../../docs/features/git.md) for
  `settings.config/v1`,
  [models and providers](../../../docs/features/models-and-providers.md) for
  the provider pages and the default execution,
  [provider sign-in](../../../docs/features/provider-sign-in.md) for the
  `settings.provider.field` slot, and [UI redesign](../../../docs/features/ui-redesign.md)
  for the items in `account.menu` and `workspace.dashboard.footer`.

## Verify

- `npx nx run bundle-settings:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-settings:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle first, because the window tests load the built client part from
  `dist/`.
- `npx nx run bundle-settings:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
