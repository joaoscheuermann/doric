# Semantic versioning

- Status: living document. It describes the versions of the platform, of bundles and of contracts as implemented on 2026-11-20.

## Summary

The platform, each bundle and each contract has its own semantic version. A contract id carries its major as the suffix `/vN`, so two majors are two different contracts, while the minors and patches of one major are interchangeable. A bundle lists the contracts it provides with an exact version under `provides`, and the contracts it depends on with a range under `requires`; contracts it uses only when present are listed under `optional`, with no range. When a bundle loads, the catalog checks its `engines.doric` range against the platform version and each range under `requires` against the active provider, and a bundle whose range is not met is quarantined with a reason ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

Which version a change takes follows the [rules by contract type](#rules-by-contract-type). Nothing checks that choice automatically: the build generates the JSON Schemas of a bundle's contracts but compares them with no earlier version ([`cli.ts`](../../../packages/bundle/src/build/cli.ts)).

## What has a version

| What     | Where it is declared                                                                  | Example                 |
| -------- | ------------------------------------------------------------------------------------- | ----------------------- |
| Platform | `PLATFORM_VERSION` in [`version.ts`](../../../packages/bundle/src/runtime/version.ts) | `1.11.0`                |
| Bundle   | `version` in the bundle's `manifest.json`                                             | `git` `1.3.0`           |
| Contract | The entry under `provides` of the bundle that provides it, `<id>/v<major>@<version>`  | `git.commands/v1@1.1.0` |

The platform version covers the desktop app, the preload, the loader and the shared client packages. It rises by a minor each time something is added to the platform. The version segment of the platform's folders and URLs (`desktop@<v>`, `bundle@<v>`, `splash@<v>`, `shell@<v>`) is a separate constant, `PLATFORM_ASSETS_VERSION`, which is `1.0.0`: a platform minor moves no folder and no URL ([`version.ts`](../../../packages/bundle/src/runtime/version.ts)).

Services, hooks, events, commands and settings are contracts, defined in zod with the `define*` family described in [Contracts and the `define*` family](./contracts.md). The versioned id is the first argument of `defineService` and `defineHooks` (`defineService('git.commands/v1', …)`), the `type` of `defineEvent` and the `id` of `defineCommand` and `defineSettings` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)). Routes are not contracts and have no version: a route is a URL path registered with `navigation/v1`, and the path is its identity ([Navigation and routes](./navigation.md)).

## Basic contracts

The basic contracts are versioned like any other, because any bundle may provide them. `bundle/contracts` exports their references and types, and fixes the cardinality and the environments of each ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts)):

| Contract                                                                                                                                                                                            | Cardinality | Default provider                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/v1`, `log/v1`, `tools/v1`, `skills/v1`, `settings/v1`, `secrets/v1`, `storage/v1`, `events/v1`, `models/v1`, `commands/v1`, `ui/v1`, `navigation/v1`, `regions/v1`, `windows/v1`, `menus/v1` | `one`       | `core` ([manifest](../../../bundles/foundation/core/manifest.json), [README](../../../bundles/foundation/core/README.md))             |
| `storage.backend/v1`, `secrets.backend/v1`                                                                                                                                                          | `one`       | `postgres` ([manifest](../../../bundles/foundation/postgres/manifest.json), [README](../../../bundles/foundation/postgres/README.md)) |
| `models.provider/v1`                                                                                                                                                                                | `many`      | None: `claude`, `codex`, `openai` and `openrouter` each provide it                                                                    |

The build refuses a bundle that provides a basic contract with another cardinality than the one `bundle/contracts` fixes ([`record.ts`](../../../packages/bundle/src/build/record.ts)). The contracts that belong to `core` itself, such as `core.hooks/v1` and `core.open-settings/v1`, are exported from `core/contracts` and versioned by `core` ([README](../../../bundles/foundation/core/README.md)).

## Platform contracts

A contract whose id starts with `doric.` belongs to the platform ([`ids.ts`](../../../packages/bundle/src/contracts/ids.ts)). The platform provides each of them, no bundle can, and each carries the platform version as its contract version ([`services.ts`](../../../packages/bundle/src/runtime/services.ts)). They are `doric.about/v1`, `doric.app.hooks/v1`, `doric.appearance/v1`, `doric.browser/v1`, `doric.bundle/v1`, `doric.cache/v1`, `doric.catalog/v1`, `doric.connection/v1`, `doric.diagnostics/v1`, `doric.elements/v1`, `doric.generation/v1`, `doric.log/v1`, `doric.menus/v1`, `doric.migrations/v1`, `doric.network/v1`, `doric.notifications/v1`, `doric.startup/v1`, `doric.tokens/v1`, `doric.window.hooks/v1` and `doric.windows/v1` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)).

A manifest never lists a `doric.*` contract: the manifest schema refuses one under `provides` or `requires`, and the bundle id `doric` is reserved for the platform ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). A bundle states its compatibility with the platform contracts, and with the shared client packages, by `engines.doric` alone. A bundle of the foundation is quarantined with `foundation_requires` when it lists a contract under `requires`, unless it replaces a facade and requires a backend contract, so its compatibility is usually stated by `engines.doric` only ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

## Major in the id, ranges in `requires`

The manifest schema sets the format of each list ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)):

| List       | Entry                     | Rule                                                                                                                           |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `provides` | `<id>/v<major>@<version>` | The version is exact and its major equals the `/v<major>` of the id                                                            |
| `requires` | `<id>/v<major>@<range>`   | The range is a semver range and admits only the major of the id (`git.commands/v1@^1.2.0` means 1.2.0 or newer, still major 1) |
| `optional` | `<id>/v<major>`           | No version and no range                                                                                                        |

An id appears at most once in `provides` and at most once in `requires`. Two majors are two ids, so a bundle may provide `x/v1` and `x/v2` at the same time, and a consumer of one is not a consumer of the other.

Every contract a bundle reaches with `services.use` is listed under `requires` or `optional`, the basic contracts of `core` included; `use` on any other contract that the bundle does not provide, and that is not a `doric.*` contract, throws `undeclared_requirement` ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts)). A contract under `optional` is usable when it is present and is not an activation dependency: the catalog checks no version for it and does not order the bundle after its provider. The full format of the manifest is in [The bundle manifest](./manifest.md).

## Checks when a bundle loads

The catalog resolves each environment of the composition and quarantines a bundle, with a reason code and a text, when a version does not match ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

| Reason                   | When                                                                                        | Text                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `engines_unsatisfied`    | The platform version is outside the bundle's `engines.doric`                                | `requires doric ^1.10.0; platform is 1.9.0`                        |
| `incompatible_version`   | The active provider of a contract under `requires` has a version outside the range          | `requires files/v1@^1.4.0; active 1.3.0 (files 1.9.0)`             |
| `dependency_quarantined` | The provider of a contract under `requires` is itself quarantined                           | `requires <id>@<range>; its provider is quarantined`               |
| `missing_dependency`     | No enabled bundle provides a contract under `requires`, in any environment                  | `requires <id>@<range>; no enabled bundle provides it`             |
| `unchosen_provider`      | A second provider of a `one` contract, without a choice in the composition's `providers`    | `second provider of <id> without a choice in providers; active: …` |
| `unchosen_provider`      | A provider of a `one` contract for which the composition's `providers` chose another bundle | `provider of <id> not chosen in providers; active: …`              |

The check runs to a fixpoint, so a quarantine cascades to the bundles that require what the quarantined bundle provides. For a contract of cardinality `many`, every live provider must satisfy the range. `core` also lists ranges under `requires`, for the contracts the foundation provides (`storage.backend/v1`, `secrets.backend/v1`); when one of them is not met, the host enters recovery mode instead of quarantining `core`. Quarantine and recovery are described in [Core and quarantine](./core.md) and shown in [Splash and recovery](./splash-and-recovery.md).

The diagnostics list, for each contract, the bundles that list it under `requires`, so they show who still depends on a contract a provider means to drop ([`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts), [Observability and diagnosis](./observability.md)).

## Providers of a contract

A bundle that replaces the default provider of a `one` contract declares, under `provides`, a version of the same major, and the composition chooses it in `providers`; consumers keep their ranges under `requires`, which the catalog checks against the active provider of each environment. Without a choice, `core` stays the active provider of a contract it provides, and any other provider of that `one` contract is quarantined with `unchosen_provider`. The providers of a `many` contract, such as the four model providers of `models.provider/v1`, live side by side, each with its own version ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). How a composition chooses providers is in [Composition and distribution](./composition-and-distribution.md).

## Rules by contract type

The author of a change picks the version the change takes from this table.

| Change                                                                                 | Service, command or hooks | Durable event                | Settings                                 |
| -------------------------------------------------------------------------------------- | ------------------------- | ---------------------------- | ---------------------------------------- |
| A fix with no change of schema                                                         | patch                     | patch                        | patch                                    |
| A new method or hook, a new optional input field, a new output field                   | minor                     | minor (a new optional field) | minor (an optional field with a default) |
| A field or member removed or given another name, a new required field, another meaning | major: a new id `/v2`     | major: a new type `/v2`      | major: a new id `/v2`                    |

Two contracts keep their id at a minor version although their current version lacks a member, or gives a meaning, that the last row would put under a new id; a consumer of either reads the contract in its owner's README, since its range under `requires` does not tell it so:

| Contract                | Version | What the contract is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner                                                                           |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `core.open-settings/v1` | 1.1.0   | A command whose input is `{ path?: string, defaultPath?: string }`. Without `path`, an open settings window is focused and keeps its section; with none open, a new one opens at `defaultPath`. A call with neither `path` nor `defaultPath` fails with `invalid_input` when no settings window is open ([`commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts)). The route `/settings` is registered by the `settings` bundle, which opens the window there by passing `{ defaultPath: '/settings' }` ([`settings/src/client/index.ts`](../../../bundles/desktop/settings/src/client/index.ts)). | [`core` README](../../../bundles/foundation/core/README.md#coreopen-settingsv1) |
| `runtime.lease/v1`      | 1.3.0   | Operations on the sandbox leased to the calling Project: `describe`, `exec`, `readFile`, `readFileBytes`, `writeFile`, `ssh` and the local `withLease`. It has no reads of the workspace: a bundle reads files through `files/v1`, Git through `git.commands/v1` and resources through `resources/v1` ([`lease.ts`](../../../bundles/runtime/runtime/src/contracts/lease.ts)).                                                                                                                                                                                                                                       | [`runtime` README](../../../bundles/runtime/runtime/README.md#runtimeleasev1)   |

The platform has no mechanism that converts a durable event of one type into another, or a settings value of one id into another. `defineEvent` takes only a `type` and a `payload`, `defineSettings` only an `id` and a `schema` ([`define.ts`](../../../packages/bundle/src/contracts/define.ts)), and neither `events/v1` nor `settings/v1` has a member that converts or migrates ([`basic/events.ts`](../../../packages/bundle/src/contracts/basic/events.ts), [`basic/settings.ts`](../../../packages/bundle/src/contracts/basic/settings.ts)). The owner of an event type or of a settings id that takes a new major reads the rows or the value of the earlier id itself, if it keeps them.

## Rules for readers and writers

- An error code is an open set: the platform's codes are listed in [`error.ts`](../../../packages/bundle/src/contracts/error.ts), and a consumer treats a code it does not know as a generic error of the contract. A new error code is therefore a minor. The code is the `code` of the `ContractError` with which a method rejects.
- The writer of a durable event validates its payload against the schema it registered: the provider of `events/v1` refuses a payload the registered `payload` does not accept, with `invalid_input` ([`core/src/host/events/facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts)). A reader of a stream reads it through its own storage and accepts the major it knows, ignoring fields of a newer minor. `events/v1` appends rows and has no member that changes one ([Events and nodes](./events-and-nodes.md), [Storage and history](./storage.md)).
- A bundle's version follows the largest change among its contracts: a major when a contract it provides takes a new major or leaves `provides`, a minor when a contract or a contribution appears or takes a minor, and a patch otherwise.
- The platform takes a major when a shared client package takes a major, or when the bridge or the loader breaks compatibility; that is why `engines.doric` is enough to cover the shared packages ([Platform packages and theme tokens](./platform-packages.md)).
- A provider that moves a contract to a new major keeps providing the earlier major alongside it while bundles still require it; the diagnostics show who does.

## What the build checks

`build <bundleDir>` validates the manifest, dry-activates each part and records the contracts it provides, defines or registers, and writes the bundle's `dist` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`record.ts`](../../../packages/bundle/src/build/record.ts)). About versions it checks that:

- every recorded contract is listed under `provides`, and every id under `provides` is recorded during `activate`;
- no contract is recorded twice in one environment, and one contract has the same schemas in every environment that records it;
- a basic contract has the cardinality `bundle/contracts` fixes.

It then writes one JSON Schema 2020-12 document per contract, generated from the zod definitions, at `dist/schemas/<id>.json`, and the descriptor `dist/contracts.json`, which lists each contract with the version taken from `provides` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`descriptor.ts`](../../../packages/bundle/src/runtime/descriptor.ts)); the schemas come from [`json-schema.ts`](../../../packages/bundle/src/runtime/json-schema.ts). No bundle writes a JSON Schema by hand.

The build compares nothing with an earlier version: it reads no earlier descriptor or schema of the bundle, and the build neither reads nor writes a `contracts.published.json` in the bundle's directory. The CLI's commands are `build`, `stage` and `copy-md` ([`cli.ts`](../../../packages/bundle/src/build/cli.ts), [`build.test.ts`](../../../packages/bundle/tests/build.test.ts)). Whether a change took the version the [rules](#rules-by-contract-type) ask for is checked in review.

## The app and the bundles are released apart

The bundles come from the host and may be newer or older than the desktop app that loads them. A bundle that needs a platform addition states it by raising `engines.doric`, and a client part whose range the platform does not meet is quarantined before it is imported ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A bundle therefore raises `engines.doric` only for what it cannot work without, a static import of a shared module or a contract it must have; it reaches a platform contract it can do without through `services.whenAvailable`, whose callback runs for each compatible provider of the contract, now and whenever one activates later ([`context.ts`](../../../packages/bundle/src/contracts/context.ts)), and it loads a `desktop/ui` module it can do without with a dynamic `import()`.

## Examples

1. `files` 1.9.0 provides `files/v1@1.3.0`, and `papercraft` requires `files/v1@^1.1.0`: the range is met and `papercraft` activates ([`files` manifest](../../../bundles/features/files/manifest.json), [`papercraft` manifest](../../../bundles/features/papercraft/manifest.json)). A bundle that required `files/v1@^1.4.0` would be quarantined with `incompatible_version` and the text `requires files/v1@^1.4.0; active 1.3.0 (files 1.9.0)`.
2. `files` declares `engines.doric: "^1.10.0"`. On platform 1.11.0 it activates; on a desktop app at platform 1.9.0 its client part is quarantined with `engines_unsatisfied`.
3. `layout` provides `layout.tabs/v2@2.0.0`, and `chat`, `workspace`, `files`, `git` and `terminal` require `layout.tabs/v2@^2.0.0` ([`layout` manifest](../../../bundles/desktop/layout/manifest.json), [`layout` README](../../../bundles/desktop/layout/README.md)). A `layout.tabs/v1` would be another contract, which none of them requires.
4. `git` lists `chat.hooks/v2` under `optional`, with no range: it observes the hooks of `chat` when `chat` is present, and activates without it ([`git` manifest](../../../bundles/features/git/manifest.json)).

## Related documents

- [Contracts and the `define*` family](./contracts.md): how contracts are defined and their JSON Schemas generated.
- [The bundle manifest](./manifest.md): `version`, `engines.doric`, `provides`, `requires` and `optional`.
- [Core and quarantine](./core.md): quarantine when a range is not met, and the activation order.
- [Splash and recovery](./splash-and-recovery.md): how quarantined bundles and their reasons are shown.
- [Composition and distribution](./composition-and-distribution.md): which bundles a composition enables and which provider it chooses in `providers`.
- [Services and channels](./services-and-channels.md): the directory that resolves a contract by its id, major included.
- [Hooks and the app's lifecycle](./hooks.md): hooks contracts grouped by `defineHooks`, versioned by their id.
- [Events and nodes](./events-and-nodes.md) and [Storage and history](./storage.md): durable events and the streams they are appended to.
- [Platform packages and theme tokens](./platform-packages.md): the shared packages `engines.doric` covers.
- [Observability and diagnosis](./observability.md): the diagnostics that list the consumers of each contract.
