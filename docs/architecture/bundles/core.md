# The core bundle and quarantine

- Status: living document. It describes the core bundle's place in a composition, the replacement of its contracts, quarantine and recovery as implemented on 2026-11-20.

## Summary

The composition names one bundle as its **core**. The shipped core is the bundle `core` ([`bundles/foundation/core`](../../../bundles/foundation/core/README.md)), and it is the default provider of the basic contracts every other bundle builds on: hooks, log, tools, skills, settings, secrets, storage, events and models on the host; windows, menus and commands in the desktop's main process; UI elements, navigation and regions in each window. The core receives the same context as any bundle (`{ services }`) and registers its contracts with `services.provide`; the loader finds the core through the composition's `core` field, and nothing in the code names `core` as a special id ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

In each environment the loader activates three phases in order: the **foundation** (the providers the composition chose for contracts the core provides or requires, such as `postgres` for `storage.backend/v1` and `secrets.backend/v1`), then the core, then the other bundles. Any contract without the `doric.` prefix, the core's included, may be provided by another bundle that the composition chooses under `providers`.

A bundle that fails to validate, resolve or activate is **quarantined**: it and the bundles that require what it provides are left out, with reason codes the catalog publishes, and the others keep serving. When the core or a chosen foundation provider cannot activate, the environment enters **recovery mode** instead. What must work without the core (the catalog, diagnostics, the splash and recovery, the native window and menu APIs, the platform's log) stays in the platform.

## How the composition names the core

The composition's `core` field names the core bundle; the schema refuses an empty one ([`composition.ts`](../../../packages/bundle/src/runtime/composition.ts)). The core's manifest has no special field ([`manifest.json`](../../../bundles/foundation/core/manifest.json)). The host's shipped composition sets `"core": "core"` and chooses `postgres` for both backends ([`composition.json`](../../../app/backend/doric-host/composition.json)):

```json
{
  "core": "core",
  "providers": {
    "storage.backend/v1": "postgres",
    "secrets.backend/v1": "postgres"
  }
}
```

The catalog puts the environment in recovery when the core is not installed, not enabled or quarantined while the catalog is read ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A composition that cannot be read or parsed puts the host in recovery with the reason `invalid composition: …` ([`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts)). The rest of the composition (`enabled`, `resident`, `required`, `alternatives`, overrides) is described in [Composition and distribution](composition-and-distribution.md).

### What the core may require

The core lists under `requires` only contracts that the foundation provides. The shipped core requires `storage.backend/v1@^1.0.0` and `secrets.backend/v1@^1.0.0` ([`manifest.json`](../../../bundles/foundation/core/manifest.json)). For each entry of the core's `requires`, the catalog enters recovery when no enabled bundle provides the contract in any environment, when the active provider in this environment is not a foundation bundle, or when its version does not satisfy the range ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A composition that chooses no backend therefore puts the host in recovery: a provider the composition did not choose under `providers` is not part of the foundation.

A bundle that calls `use` on a contract of the core lists it under `requires` or `optional`, as for any contract; `use` is also allowed on a contract the bundle provides itself, in any environment, and on every `doric.*` contract, which no manifest lists ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)). The core's own client part uses `menus/v1`, which the core provides in `desktopMain`, without a `requires` line for that reason ([`client/index.ts`](../../../bundles/foundation/core/src/client/index.ts)). The full rules of `requires` and `optional` are in [Manifest](manifest.md).

## Activation order: foundation, core, others

`resolveEnvironment` resolves one environment without running bundle code and returns the activation order ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

1. **Foundation.** A provider chosen under `providers` joins the foundation of an environment when it provides the contract there and the core provides or requires that contract in the same environment. Foundation bundles that provide `storage.backend/v1` or `secrets.backend/v1` come first, then the rest of the foundation.
2. **The core.**
3. **Others,** every other scheduled bundle.

Inside each group the order is topological over `requires`, with ties broken by lexical bundle id. The members of a `requires` cycle are quarantined with `dependency_cycle`, and the order is computed again until no further bundle is quarantined.

A foundation bundle that lists any contract under `requires` is quarantined with `foundation_requires`. The one exception is a replacement of `events/v1`, `settings/v1` or `models/v1`, which may require `storage.backend/v1` and `secrets.backend/v1` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)).

On the host, the kernel activates the foundation, the core, every embedded bundle and every bundle the composition lists under `resident` in the host process, and the other installed bundles in a generation process; the published order is the kernel's order followed by the generation's ([`partition.ts`](../../../packages/bundle/src/process/partition.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). The hooks provider orders handlers by this published order. Generations are described in [Process isolation](process-isolation.md).

The loader activates each bundle in order: it loads the part, calls `activate({ services })`, keeps the cleanup function `activate` returns, and records the bundle as `active` with its activation time ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). In a process whose `hooks/v1` provider activates in the same process, the platform defines `doric.app.hooks/v1` once that provider has activated and fires `onActivateHook` for each bundle activated after it; the bundles activated before it and the provider itself are not observed. With the core as the provider, the foundation and the core are not observed; when the composition chooses another provider of `hooks/v1`, that provider joins the foundation and the core is observed. In a host generation process, `hooks/v1` is the kernel's, so the contract is defined before the first bundle activates and every bundle is observed. Installed bundles register their `skills/*/SKILL.md` files through `skills/v1` on their behalf, in lexical folder order, after every bundle the process activates (the kernel, or one generation) has activated ([`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`loader/skills.ts`](../../../packages/bundle/src/loader/skills.ts)). The lifecycle hooks are described in [Hooks and the app's lifecycle](hooks.md).

## What the core provides

The core provides these contracts, each in the environments its parts register it ([`manifest.json`](../../../bundles/foundation/core/manifest.json), [`host/index.ts`](../../../bundles/foundation/core/src/host/index.ts), [`desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`client/index.ts`](../../../bundles/foundation/core/src/client/index.ts)). The full shape of each, with its methods, inputs and errors, is in the core's [README](../../../bundles/foundation/core/README.md); this document states them at the grain of the mechanism.

| Environment   | Basic contracts (from `bundle/contracts`)                                                                                                                                | The core's own contracts (from `core/contracts`)                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `host`        | `hooks/v1@1.0.0`, `log/v1@1.0.0`, `tools/v1@1.4.0`, `skills/v1@1.1.0`, `storage/v1@1.1.0`, `secrets/v1@1.2.0`, `events/v1@1.0.0`, `settings/v1@1.0.0`, `models/v1@1.4.0` | `core.event-hooks/v1@1.0.0`; the storage types `core.settings/v1@1.0.0` and `core.settings-generation/v1@1.0.0` |
| `desktopMain` | `hooks/v1@1.0.0`, `log/v1@1.0.0`, `settings/v1@1.0.0`, `commands/v1@1.0.0`, `windows/v1@1.1.0`, `menus/v1@1.0.0`                                                         | `core.hooks/v1@1.0.0`, `core.open-settings/v1@1.1.0`, `core.commands/v1@1.0.0`                                  |
| `client`      | `hooks/v1@1.0.0`, `log/v1@1.0.0`, `ui/v1@1.0.0`, `navigation/v1@1.1.0`, `regions/v1@1.0.0`, `commands/v1@1.0.0`                                                          | None                                                                                                            |

Every basic contract has cardinality `one` except `models.provider/v1`, which is `many`; the environments of each basic contract are fixed in [`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts). The core's `provide` of a `one` contract registers nothing when the catalog's active provider of that contract is another bundle, so the core then reaches the chosen provider through the same contract ([`services.ts`](../../../packages/bundle/src/runtime/services.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). Activation of the core does no I/O: storage types are declared to the backend on first use, and credentials are read at the start step below ([`host/index.ts`](../../../bundles/foundation/core/src/host/index.ts)).

### The backends of the foundation

Durable storage and stored secrets are two contracts of cardinality `one` that the foundation provides and the core requires: `storage.backend/v1` and `secrets.backend/v1`. In the shipped host `postgres` provides both ([`composition.json`](../../../app/backend/doric-host/composition.json)); the core's tests choose the in-memory foundation of `storage/memory` ([`tests/support/host.ts`](../../../bundles/foundation/core/tests/support/host.ts)). The core's `storage/v1` and `secrets/v1` are facades over them. [Storage](storage.md) describes the backends.

### Host

- **`hooks/v1`.** Handlers of a hook run in the order of the calling generation's catalog `order`, the platform (`doric`) first, and in registration order within one bundle. For `observe`, `transform` and `decide` hooks, each handler has a deadline of 10 seconds (`DEFAULT_HOOK_DEADLINE_MS`), and a handler that throws or runs late is reported to `doric.diagnostics/v1` instead of failing the owner of the hook; in `doric.window.hooks/v1`, `onCloseHook` handlers have no deadline, and the other hooks give each handler the time left before the call's deadline, with no bound when the call has none or none is left. A `sequence` hook is the owner's own work: each handler is awaited without a deadline, in reverse order when the hook declares `order: 'reverse'`, and the first failure rejects `execute` ([`shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts)). The same implementation serves the three environments. The full mechanism is in [Hooks and the app's lifecycle](hooks.md).
- **`log/v1`.** Each record names the calling bundle, its version and generation, the call's scope and trace id, and the environment, and is written through the platform's `doric.log/v1`; on the host it reaches the host's pino destinations ([`shared/log.ts`](../../../bundles/foundation/core/src/shared/log.ts), [`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts)). The host and `desktopMain` parts redact by default: every secret that `secrets/v1.view().redactions()` lists is masked as `[REDACTED]` in the message and in the string leaves of the fields, and nothing is masked when `secrets/v1` cannot be reached, as in `desktopMain`, where no secret is resolved. The client part writes records without redaction, since a window holds no resolved secret. A level never throws: a record that cannot be written is reported to `doric.diagnostics/v1` as `log_write_failed`.
- **`tools/v1`.** One registry of tools bound to the bundle that registered them. `list` answers them by the global `order` key in ascending order, tools without a key after those with one, and otherwise in registration order ([`tools.ts`](../../../bundles/foundation/core/src/host/tools.ts)). Names are unique per scope: a tool registered without a `projectId` takes its name in every scope, and a tool registered with a `projectId` collides only with an unscoped tool or a tool of the same Project. A collision is refused with `duplicate_tool`. Uniqueness holds within one generation's view (the kernel's tools plus one generation's), and `list` and `catalog` answer only the tools of the calling generation's view; they show a Project's tools only to calls whose `scope.projectId` names that Project.
- **`skills/v1`.** Skill names are unique within one generation's view (`duplicate_skill`), and `list` answers the skills of the calling generation's view and orders skills by the global `order` key, then registration order, which the loader keeps in bundle order. Every name in a skill's `allowed-tools` must be in the `tools/v1` list of the registering call, or the registration is refused with `unavailable_tool` ([`skills.ts`](../../../bundles/foundation/core/src/host/skills.ts)). Because the loader registers installed skills only after every bundle the process activates (the kernel, or one generation) has activated, `allowed-tools` resolves against every tool that process's view sees: the kernel's tools plus that generation's. A refused registration quarantines the bundle (below).
- **`settings/v1`.** Each registered space is one `core.settings/v1` document whose id is the settings id and whose revision is the space's revision; the document holds the value, the owner's contract version, the write time and the value of the global `core.settings-generation/v1` counter (document id `global`), which grows by one with every write ([`settings/facade.ts`](../../../bundles/foundation/core/src/host/settings/facade.ts), [`contracts/storage.ts`](../../../bundles/foundation/core/src/contracts/storage.ts)). A write commits both documents together. Writes of `settings/v1` and of `secrets/v1` run one at a time in one queue ([`writes.ts`](../../../bundles/foundation/core/src/shared/writes.ts)); subscribers of a space run synchronously after the commit, before the queue moves on, and a subscriber that throws is reported to diagnostics.
- **`secrets/v1`** keeps a cache over `secrets.backend/v1`. Its start step on `onHostStartHook` connects the storage backend, enters the startup stage `credential_activation` and reads the stored credentials once, so an unusable credential key fails the host at that stage ([`secrets/activation.ts`](../../../bundles/foundation/core/src/host/secrets/activation.ts)). Credential kinds besides the basic `API_TOKEN` and `USERNAME_PASSWORD` are registered by bundles with `registerKind`, as `git` and `mcp` do ([`basic/secrets.ts`](../../../packages/bundle/src/contracts/basic/secrets.ts), [`git/src/host/index.ts`](../../../bundles/features/git/src/host/index.ts), [`mcp/src/host/index.ts`](../../../bundles/features/mcp/src/host/index.ts)).
- **`storage/v1`, `events/v1` and `models/v1`.** `storage/v1` is the facade over `storage.backend/v1` with per-owner access ([`storage/facade.ts`](../../../bundles/foundation/core/src/host/storage/facade.ts)); `events/v1` appends a bundle's events to the stream of the event sink a bundle registered, and fires `core.event-hooks/v1.onEventAppendedHook` after each commit ([`events/facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts)); `models/v1` aggregates the `models.provider/v1` records that provider bundles register, without a choice in `providers` ([`models/index.ts`](../../../bundles/foundation/core/src/host/models/index.ts)). [Storage](storage.md) and [Events and nodes](events-and-nodes.md) describe the first two.

### Desktop main process

The `desktopMain` part provides hooks, log, local settings (a preferences file in the core's `doric.cache/v1` directory), `commands/v1`, the client commands bridge `core.commands/v1`, `windows/v1` and `menus/v1`; it defines `core.hooks/v1` and registers the command `core.open-settings/v1` ([`desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`desktop/settings.ts`](../../../bundles/foundation/core/src/desktop/settings.ts)). In `onAppReadyHook` it sets the menu skeleton (App, File, Edit, View, Window, Help) through `doric.menus/v1`, asks the platform through `doric.migrations/v1` to copy the layout's saved selection (`doric.selection`) from the packaged `file://` origin to `doric://app` once, and opens the primary `workspace` window at the last path that window showed, or `/`; in `onAppActivateHook` it focuses or reopens that window ([`menu.ts`](../../../bundles/foundation/core/src/desktop/menu.ts), [`migrations.ts`](../../../bundles/foundation/core/src/desktop/migrations.ts)).

`windows/v1` and `menus/v1` are the core's implementations over the native `doric.windows/v1` and `doric.menus/v1`, and most shipped bundles call them; `screen` also calls `doric.windows/v1` directly for its views ([`screen/src/desktop/index.ts`](../../../bundles/features/screen/src/desktop/index.ts)), which a `doric.*` contract allows without a manifest line. `windows/v1.open` runs `core.hooks/v1.onBeforeOpenWindowHook` and opens the window under the key `<calling bundle>:<key>` ([`windows.ts`](../../../bundles/foundation/core/src/desktop/windows.ts), [`menus.ts`](../../../bundles/foundation/core/src/desktop/menus.ts)). The details are in [Windows](windows.md) and [Menus and keybindings](menus-and-keybindings.md).

`core.open-settings/v1` (1.1.0) opens the settings window. Its input has an optional `path` and an optional `defaultPath`: with `path`, the window opens at that path, or is focused and navigated there when it is open; without `path`, an open settings window is only focused, and otherwise a new one opens at `defaultPath`; with neither and no window open, the command fails with `invalid_input` and nothing opens ([`desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts), [`contracts/commands.ts`](../../../bundles/foundation/core/src/contracts/commands.ts)). The core knows no settings route: the caller names it. Other bundles reach the command through the reference `OpenSettingsCommandV1` of `core/contracts`; its full contract is in the core's [README](../../../bundles/foundation/core/README.md).

### Window client

In each window the client part provides hooks, log, `ui/v1`, `navigation/v1`, `regions/v1` and `commands/v1`, defines the four elements `core-outlet`, `core-region`, `core-not-found` and `core-unavailable`, intercepts same-origin links, and reports the window's path as menu context through `menus/v1` ([`client/index.ts`](../../../bundles/foundation/core/src/client/index.ts)). `ui/v1.define` refuses a tag that does not start with the calling bundle's id followed by `-`, and `ui/v1.create` answers a `core-unavailable` element when no active bundle owns the tag ([`ui.ts`](../../../bundles/foundation/core/src/client/ui.ts)). A command that no part of the window registered is sent to `desktopMain` through `core.commands/v1` ([`client/commands.ts`](../../../bundles/foundation/core/src/client/commands.ts)). The core draws no screen of the product: routes, regions and their content come from other bundles. [UI composition](ui-composition.md) and [Navigation](navigation.md) describe the mechanism.

### The scope keys the core reads

The core forwards `call.scope` unchanged and reads three keys of it: `tools/v1` reads `projectId` to choose a Project's tools; `events/v1` reads the keys that the registered event sink names, refusing an append whose scope lacks one with `invalid_scope`; `hooks/v1` reads `windowKey` to run the `doric.window.hooks/v1` handlers of one window; and `menus/v1.setContext` reads `windowKey` and refuses a call without it with `invalid_input` ([`menus.ts`](../../../bundles/foundation/core/src/desktop/menus.ts), [`tools.ts`](../../../bundles/foundation/core/src/host/tools.ts), [`events/facade.ts`](../../../bundles/foundation/core/src/host/events/facade.ts), [`shared/hooks.ts`](../../../bundles/foundation/core/src/shared/hooks.ts)). A scope holds at most 16 keys, each of at most 64 characters, a letter followed by letters, digits, `_`, `.` or `-`, with values of at most 512 characters ([`call.ts`](../../../packages/bundle/src/contracts/call.ts)). [Services and channels](services-and-channels.md) describes the call.

## Replacing a contract the core provides

Any contract without the `doric.` prefix may be provided by another bundle; a manifest that lists a `doric.*` contract is invalid, and `define*` refuses a `doric.*` id ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts), [`define.ts`](../../../packages/bundle/src/contracts/define.ts)). When two enabled bundles provide one contract of cardinality `one` in an environment, the composition chooses one under `providers`:

```json
{
  "core": "core",
  "providers": {
    "hooks/v1": "myhooks",
    "storage.backend/v1": "postgres",
    "secrets.backend/v1": "postgres"
  }
}
```

The catalog resolves the active provider of a `one` contract as follows ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)):

- A choice names a bundle that is enabled and lists the contract under `provides`; otherwise the choice is ignored and recorded as an issue (`provider choice … ignored`). A choice applies in each environment where the chosen bundle provides the contract.
- With a valid choice, the chosen bundle is the active provider while it is scheduled. Every other provider except the core is quarantined with `unchosen_provider`; the core stays active with its `provide` inert.
- Without a choice, the core is the active provider when it provides the contract, and otherwise the first provider by lexical id. Every other provider except the core is quarantined with `unchosen_provider`.

A chosen provider of a contract the core provides or requires joins the foundation and activates before the core, so the core and every other bundle reach it through the contract without a change of code. A chosen provider of any other contract activates with the others, in dependency order. Contracts of cardinality `many`, such as `models.provider/v1`, need no choice. When a chosen foundation provider is quarantined, the catalog does not fall back to the core: the environment enters recovery mode.

## Quarantine

A quarantined bundle is not activated, or is deactivated: the registrations it made are disposed of, its cleanup runs, and the other bundles keep serving ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)). Its catalog entry and its diagnostics record have the state `quarantined` and every reason, each with a code, a message and, where it concerns one contract, that contract's id ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). The platform logs each quarantined bundle with its reasons under the message `Bundle quarantined` ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

| Code                         | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_manifest`           | The manifest is missing or invalid ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                                                             |
| `invalid_descriptor`         | `contracts.json` is missing or disagrees with the manifest's id, version or `provides` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                         |
| `duplicate_id`               | Another installed bundle already uses the id ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                                                   |
| `engines_unsatisfied`        | `engines.doric` does not accept the platform's version ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                                         |
| `cardinality_mismatch`       | The bundle declares a contract with another cardinality than the catalog publishes, at resolution or at `provide` ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`services.ts`](../../../packages/bundle/src/runtime/services.ts))                                                                                                                                                                                                                           |
| `unchosen_provider`          | A second provider of a `one` contract that the composition did not choose ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                      |
| `foundation_requires`        | A foundation bundle lists a contract under `requires`, outside the exception above ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                             |
| `missing_dependency`         | No enabled bundle provides a required contract, or an installed bundle has skills and no `skills/v1` provider is active ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts))                                                                                                                                                                                                               |
| `incompatible_version`       | The active provider's version does not satisfy the required range ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                              |
| `dependency_quarantined`     | The provider of a required contract is quarantined, or a bundle it depends on is not active when its turn comes ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts))                                                                                                                                                                                                                         |
| `dependency_cycle`           | The bundle is part of a `requires` cycle ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts))                                                                                                                                                                                                                                                                                                                                                                       |
| `invalid_part`               | A part cannot be loaded or its host part exports no `activate` function; a tool file the manifest lists does not default-export a tool definition (a function export included); or, on the desktop, one of its distributed files fails verification ([`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts)) |
| `activate_failed`            | The bundle's `activate` throws ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts))                                                                                                                                                                                                                                                                                                                                                                           |
| `registration_failed`        | A registration the bundle or the loader made for it is refused, such as a duplicate tool or skill, or a skill whose `allowed-tools` names an unavailable tool ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts))                                                                                                                                                                   |
| `skill_invalid`              | A `SKILL.md` file cannot be read or parsed ([`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts))                                                                                                                                                                                                                                                                                                                                                             |
| `generation_failed`          | The generation process that holds the bundle failed ([`manager.ts`](../../../packages/bundle/src/process/manager.ts))                                                                                                                                                                                                                                                                                                                                                            |
| `kernel_requires_generation` | Accepted by the schema; no code path sets it, because kernel bundles reach generation bundles through the catalog at call time ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts))                                                                                                                                                                                                              |

Quarantine cascades through `requires`: the catalog checks every bundle again until nothing changes, so a bundle whose required provider is quarantined is quarantined with `dependency_quarantined`, and so on ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)). A bundle that reaches the contract only through `whenAvailable` stays active and loses the dependent feature. A failing handler of an `observe` hook, such as `onActivateHook`, is reported to diagnostics and quarantines nobody ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts)).

On the desktop, `desktopMain` and `client` are resolved from the host's distribution with the same resolver; a bundle the host quarantined stays quarantined, and the desktop adds its own reasons ([`resolve.ts`](../../../app/desktop/doric/src/platform/catalog/resolve.ts)).

## Recovery mode

An environment enters recovery mode when ([`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts), [`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`loader/activate.ts`](../../../packages/bundle/src/loader/activate.ts)):

- the core is not installed, not enabled or quarantined;
- a contract the core requires has no enabled provider, is not provided by an active foundation bundle, or has a version outside the range;
- a chosen foundation provider is quarantined;
- the `activate` of the core or of a foundation bundle fails;
- the composition cannot be read.

The reason is recorded once, the first one met. In recovery the loader activates no further bundle and records each remaining one as `inactive`, and the platform does not fire `onHostReadyHook` ([`activation.ts`](../../../packages/bundle/src/runtime/activation.ts), [`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)).

On the host, the kernel logs `Bundle recovery mode` with the reason and every bundle's state and reasons, and starts no generation process ([`kernel.ts`](../../../packages/bundle/src/process/kernel.ts)). The host has no recovery surface of its own: `startBundles` stops the platform and throws `BundleRecoveryError`, and the boot ends in the host's fatal startup path ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)). The host also takes that path, after logging `Bundle recovery mode`, when a contract or bundle the composition lists under `required` has no active provider, at boot (`assertStructural`) or after a generation is lost (`watchStructural`, which exits the process) ([`boot.ts`](../../../app/backend/doric-host/src/lib/bundles/boot.ts), [`index.ts`](../../../app/backend/doric-host/src/index.ts)); the shipped composition requires `runtime/v2`, `executor/v1`, `sandbox/v1`, `models/v1`, `host-config/v1` and the bundle `transport` ([`composition.json`](../../../app/backend/doric-host/composition.json)).

On the desktop, the splash shows the recovery, core-failure or bundle-failure state with the reasons and waits for an action, such as disabling a bundle, returning to the default composition or using the last good core; this is described in [Splash and recovery](splash-and-recovery.md).

## `doric.catalog/v1` and `doric.diagnostics/v1`

The catalog and the diagnostics are platform contracts, provided by the platform under the principal `doric` in all three environments, and read through these contracts; the host has no HTTP route for them ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`platform-providers.ts`](../../../packages/bundle/src/runtime/platform-providers.ts)).

### `doric.catalog/v1`

| Method                  | Input                             | Output                | Where                                                        |
| ----------------------- | --------------------------------- | --------------------- | ------------------------------------------------------------ |
| `get()`                 | None                              | `CatalogSnapshot`     | Every environment                                            |
| `distribution()`        | None                              | `DistributionCatalog` | The host                                                     |
| `artifact({ sha256 })`  | `sha256`: 64 lowercase hex digits | `{ sha256, base64 }`  | The host                                                     |
| `watch(listener)`       | A stream listener                 | A `Disposable`        | The host; one item `{ generation }` per published generation |
| `disable({ bundleId })` | A non-empty bundle id             | Nothing               | The host                                                     |
| `resetComposition()`    | None                              | Nothing               | The host                                                     |

Every method of `doric.catalog/v1` is reachable from a desktop window ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). `CatalogSnapshot`, with the manifest and storage identity it carries, is:

```ts
interface CatalogSnapshot {
  generation: number;
  composition: {
    core: string;
    enabled: string[];
    providers: Record<string, string>;
  };
  bundles: {
    id: string;
    version: string;
    description?: string;
    state: 'active' | 'quarantined' | 'disabled' | 'inactive';
    phase?: 'foundation' | 'core' | 'others';
    manifest?: CatalogManifest; // the validated manifest
    reasons: { code: QuarantineCode; message: string; contract?: string }[];
  }[];
  order: string[]; // activation order of this environment
  contracts: {
    id: string;
    environment: 'host' | 'desktopMain' | 'client';
    cardinality: 'one' | 'many';
    providers: { bundleId: string; version: string; bundleVersion: string }[];
  }[];
  storage?: StorageIdentity; // once the host resolved the backend
}

interface CatalogManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  engines: { doric: string };
  provides: string[];
  requires: string[];
  optional?: string[];
  desktopScope?: Record<string, string[]>; // scope keys a window may send to each provided contract
  description?: string;
}

interface StorageIdentity {
  hostId: string; // a UUID
  storageGeneration: number; // a positive integer
}
```

`StorageIdentity` is defined in [`basic/storage.ts`](../../../packages/bundle/src/contracts/basic/storage.ts).

`distribution()` answers what the desktop needs of a host generation, and `artifact` answers one listed file by hash, its bytes in base64:

```ts
interface DistributionCatalog {
  generation: number; // the host generation; restarts at 1 with every host process
  hostBoot: string; // random per host process; with generation, names a host generation
  platformVersion: string; // the host platform version, informative
  composition: {
    core: string;
    enabled: string[];
    providers: Record<string, string>;
  };
  storage?: StorageIdentity;
  host: CatalogSnapshot; // the host environment's doric.catalog/v1.get()
  bundles: DistributionBundle[];
}

interface DistributionBundle {
  id: string;
  version: string;
  state: 'active' | 'quarantined' | 'disabled' | 'inactive'; // in the host environment
  reasons: { code: QuarantineCode; message: string; contract?: string }[]; // the host's
  manifest?: CatalogManifest;
  descriptor?: object; // the bundle's dist/contracts.json as JSON; the desktop validates it
  files: DistributionFile[]; // desktop/**, client/**, contracts/**.js, schemas/**, manifest.json, contracts.json
  parts: DistributionParts;
}

interface DistributionFile {
  path: string; // relative to the bundle's dist directory, with / separators
  sha256: string; // 64 lowercase hex digits of the file bytes
  size: number; // a non-negative integer
}

interface DistributionParts {
  // paths of the built parts among the files
  desktopMain?: string;
  client?: string;
  clientStyles?: string;
  contracts?: string;
}
```

[Composition and distribution](composition-and-distribution.md) describes how the desktop uses them.

`disable` adds the bundle to the `disabled` list of the composition overrides file and publishes a new generation; it fails with `not_found` for a bundle outside `enabled` and with `invalid_input` for the core. `resetComposition` clears the overrides and publishes. Both run one at a time; when the new generation cannot be published, they fail with `unavailable`, and the overrides they wrote apply at the next host start ([`composition-actions.ts`](../../../packages/bundle/src/process/composition-actions.ts)).

### `doric.diagnostics/v1`

| Method          | Input                                                                    | Output        |
| --------------- | ------------------------------------------------------------------------ | ------------- |
| `get()`         | None                                                                     | `Diagnostics` |
| `report(entry)` | `{ bundleId: string; kind: string; message: string; details?: unknown }` | Nothing       |

```ts
interface Diagnostics {
  generation: number;
  mode: 'normal' | 'recovery';
  recovery?: { reason: string };
  issues: string[]; // problems found while reading the catalog
  bundles: {
    id: string;
    version: string;
    state: 'active' | 'quarantined' | 'disabled' | 'inactive';
    phase?: 'foundation' | 'core' | 'others';
    reasons: { code: QuarantineCode; message: string; contract?: string }[];
    activationMs?: number;
  }[];
  errors: {
    at: string;
    bundleId: string;
    kind: string;
    message: string;
    details?: unknown;
  }[];
  consumers: Record<string, string[]>; // bundles whose manifest requires each contract
}
```

`report` is reachable from a desktop window, `get` is not ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). `report` adds an error with the time it was reported; the store keeps the 50 most recent errors of each bundle ([`diagnostics.ts`](../../../packages/bundle/src/runtime/diagnostics.ts)). [Observability](observability.md) describes where diagnostics are shown.

## What the platform keeps

The platform keeps what must work when the core fails, because recovery needs it exactly then ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)):

| Kept by the platform                                                        | Contract or place                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The catalog, quarantine and recovery                                        | `doric.catalog/v1`, [`catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts)                 |
| Diagnostics                                                                 | `doric.diagnostics/v1`                                                                              |
| The platform's own log, independent of `log/v1`                             | `doric.log/v1` and the platform log of the kernel                                                   |
| The native window and menu APIs                                             | `doric.windows/v1`, `doric.menus/v1`                                                                |
| The splash, `doric://app`, IPC and the generation processes                 | The desktop app and [`packages/bundle/src/process`](../../../packages/bundle/src/process/kernel.ts) |
| The references and types of the basic contracts (`HooksV1`, `StorageV1`, …) | `bundle/contracts` ([`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts))      |

The platform reaches hooks, settings, secrets, tools and storage only through their contracts, so a provider the composition chooses in place of the core serves it as well. The platform contracts and their environments are described in [Contracts](contracts.md).

## The minimal test core

A minimal core used only in tests provides `hooks/v1`, `ui/v1`, `navigation/v1` and `regions/v1` written against `bundle/contracts` and `doric.*` contracts alone, and defines its own outlet ([`minimal-ui-core.ts`](../../../packages/bundle/src/testing/minimal-ui-core.ts)). Its tests open a window of that core without any bundle of the default UI, and check that a core that defines no outlet, or a quarantined core, reports a core failure ([`minimal-core.test.ts`](../../../packages/desktop/tests/client/minimal-core.test.ts), [`ui-platform.test.ts`](../../../packages/bundle/tests/ui-platform.test.ts)). If they fail, the platform has come to depend on the default UI.

## Related documents

- [The core's README](../../../bundles/foundation/core/README.md): the full shape of every contract the core provides.
- [Manifest](manifest.md): `provides`, `requires` and `optional`.
- [Contracts](contracts.md): contract ids and versions, the `define*` family and the platform contracts.
- [Boundaries](boundaries.md): what a bundle may import.
- [Composition and distribution](composition-and-distribution.md): the composition and the distribution to the desktop.
- [Hooks and the app's lifecycle](hooks.md): `hooks/v1` and the lifecycle hooks.
- [Process isolation](process-isolation.md): the kernel and the generation processes.
- [Storage](storage.md): `storage/v1` and the backends.
- [Windows](windows.md) and [Menus and keybindings](menus-and-keybindings.md): `windows/v1` and `menus/v1` over the native APIs.
- [UI composition](ui-composition.md) and [Navigation](navigation.md): the client's elements, regions and routes.
- [Splash and recovery](splash-and-recovery.md): what the desktop shows in recovery.
- [Observability](observability.md): logs and diagnostics.
