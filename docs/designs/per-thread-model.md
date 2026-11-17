# Spec: per-thread model

- Ticket: none given.
- Status: version 6 (2026-11-15), `accepted`. See [Revisions](#revisions).
- Requirements: U1–U15, the user's decisions (jao.scheuermann, 2026-11-15). They are binding and not reopened here.
- Builds on: commit `ecfc5a0e` (branch `feat/sidebar-alignment`). Every line reference names the file as it is at that commit. Every path is written in full from the repository root; a bare `:line` refers to the last full path named in the same sentence or table cell.
- Bundles touched: `runtime` 2.6.0 → 2.7.0, `default` 2.4.0 → 2.5.0, `threads` 2.0.0 → 2.0.1, `transport` (version kept, range raised), `settings` 1.5.0 → 1.6.0. See [Contracts and versions](#contracts-and-versions).
- Feature docs: none exists for model selection. The docs step creates [docs/features/per-thread-model.md](../features/per-thread-model.md) from this spec and revises [docs/features/ui-redesign.md](../features/ui-redesign.md), whose conversation footer holds the picker ([Docs to update](#docs-to-update)).
- Identifiers: U1–U15 requirements; G1–G7 goals; D1–D14 design decisions; AC1–AC14 acceptance criteria; T-1 … T-41 tests; R1–R9 risks. No question is open. Review findings are named in [Revisions](#revisions) only.

## Contents

- [Terms](#terms)
- [Problem](#problem)
- [Goals](#goals)
- [Non-goals](#non-goals)
- [Requirements](#requirements)
- [Design decisions](#design-decisions)
- [Design](#design)
- [Flows](#flows)
- [Contracts and versions](#contracts-and-versions)
- [Persisted data](#persisted-data)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Phases](#phases)
- [Files to change](#files-to-change)
- [Acceptance criteria](#acceptance-criteria)
- [Test plan](#test-plan)
- [Docs to update](#docs-to-update)
- [Questions](#questions)
- [Revisions](#revisions)

## Terms

Background reading: [docs/architecture/bundles.md](../architecture/bundles.md) (the bundle architecture), [docs/architecture/bundles/contracts.md](../architecture/bundles/contracts.md), [docs/architecture/bundles/manifest.md](../architecture/bundles/manifest.md), [docs/architecture/bundles/storage.md](../architecture/bundles/storage.md) and [docs/architecture/bundles/versioning.md](../architecture/bundles/versioning.md). The platform terms this spec relies on:

| Term                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project, Thread          | A Project is a workspace with a sandbox; a Thread is one conversation in it, with a record (`Thread`, `bundles/runtime/runtime/src/contracts/model.ts:160-194`) and an event log. A Thread may have a parent Thread.                                                                                                                                                                                             |
| Reader                   | The person using the app.                                                                                                                                                                                                                                                                                                                                                                                        |
| Bundle                   | A unit of the app with a manifest (`manifest.json`) that `provides` and `requires` contracts. A bundle has a host part (the backend process), a client part (each app window), or both.                                                                                                                                                                                                                          |
| Contract, range          | A versioned service interface, named `name/vN@x.y.z` in `provides`; a consumer asks for a range such as `runtime.threads/v1@^1.7.0`. A loose zod object (`z.looseObject`) keeps keys it does not declare, so an older reader passes a new field through.                                                                                                                                                         |
| Quarantine               | A bundle whose required range no active provider meets is not activated, and the loader records why (`docs/architecture/bundles/manifest.md:52`, `docs/architecture/bundles/versioning.md:7`).                                                                                                                                                                                                                   |
| Desktop-exposed          | A host method declared with `expose: 'desktop'`; only such methods are callable from a window through the bridge (`docs/architecture/bundles/implementation-decisions.md:1131,1145`).                                                                                                                                                                                                                            |
| Import map               | The table each window loads before any module, which resolves shared specifiers, `<bundle>/contracts` among them, to files (`docs/architecture/bundles/platform-packages.md:35-50`; `packages/bundle/src/build/parts.ts:60-63`).                                                                                                                                                                                 |
| Runtime, runner, service | The `runtime` bundle owns Projects and Threads. Its service (`bundles/runtime/runtime/src/host/domain/service.ts`) answers the `runtime.threads/v1` methods; its runner (`bundles/runtime/runtime/src/host/domain/runner.ts`) creates Threads and runs their prompts. For an open Project the runner holds each Thread's live record (`ThreadRuntime`, `bundles/runtime/runtime/src/host/domain/runtime.ts:28`). |
| Publisher                | `WorkspacePublisher` (`bundles/runtime/runtime/src/host/domain/types.ts:55-66`): `threadUpdated(record)` pushes a Thread record to every window that watches its Project.                                                                                                                                                                                                                                        |
| Executor                 | The `default` bundle's `executor/v1`: runs one prompt and one manual compaction for the runner (`bundles/runtime/default/src/host/executor.ts`, `bundles/runtime/default/src/host/compact.ts`).                                                                                                                                                                                                                  |
| Layout, layout tree      | The `layout` bundle draws the window frame and keeps an in-memory tree of Projects and Threads, updated from the publisher's records (`bundles/desktop/layout/src/client/domain/project-tree.ts:230-233`) and offered to other client bundles as `layout.workspace/v1`.                                                                                                                                          |
| Chat                     | The `chat` bundle draws a Thread's conversation.                                                                                                                                                                                                                                                                                                                                                                 |

This spec's own terms:

| Term                     | Meaning                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution                | The triple a model call runs on: a provider id, a model name, and an optional reasoning effort.                                                                                                                                                                                                                   |
| `ModelExecution`         | The settings client's type for an execution (`bundles/desktop/settings/src/client/domain/config.ts:290-298`).                                                                                                                                                                                                     |
| Workspace default        | `models.execution` of the host configuration (`bundles/foundation/host-config/src/contracts/index.ts:68-76`), edited in Settings (`bundles/desktop/settings/src/client/components/organisms/settings-execution.tsx:65,79,90,102`).                                                                                |
| Stored execution         | The `providerId`, `model` and `effort` on a Thread record. A Thread has one when its record carries `providerId`. Every Thread created after this change has one.                                                                                                                                                 |
| Legacy Thread            | A Thread created before this change: its record has no `providerId`. Some carry `model` and `effort` (children spawned under `runtime.thread/v1` 1.1.0, `bundles/runtime/runtime/src/host/store/threads.ts:681-682`).                                                                                             |
| Available                | A stored execution whose provider id names a configured provider and, when that provider lists at least one model, whose model is one of them ([§1](#1-the-resolution-rule)).                                                                                                                                     |
| Resolved execution       | What a run and a manual compaction use: a stored execution that is available, or, for a legacy Thread, the workspace default with the Thread's own `model` and `effort` over it. A stored execution that is not available resolves to nothing, and the run fails ([§5](#5-executor-and-compaction-default)).      |
| Start effort             | The effort a model starts at when it is chosen: `modelStartEffort` ([§1](#1-the-resolution-rule)), the rule the picker applies today as `modelThinkingEffort` (`bundles/desktop/settings/src/client/domain/config.ts:1565-1584`, over `modelDefaultEffort`, `:1551-1563`), moved to `runtime/contracts`.          |
| Reader-opened sub-thread | A Thread the reader creates under another, through `runtime.threads/v1.createThread` with `parentThreadId` (`bundles/desktop/layout/src/client/hooks/use-workspace.ts:422-426`).                                                                                                                                  |
| The picker               | `<settings-execution-picker>`, the item (order 20) the `settings` bundle adds to the conversation footer's `layout.footer` region (`bundles/desktop/settings/src/client/index.ts:48,68-72`), drawn by `ExecutionPicker` (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:27-109`). |
| The alert span           | The picker's `<span role="alert">` that shows a configuration error (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:64-68`).                                                                                                                                                      |
| The selected Thread      | `layout.workspace/v1.selectedThread()` (`bundles/desktop/layout/src/client/services/layout-workspace.ts:45-48`), the Thread the workspace window shows.                                                                                                                                                           |
| Probe bundle             | A bundle a client test defines to play another bundle's part, here the layout's footer and selection (`docs/designs/model-icons.md:950`).                                                                                                                                                                         |

## Problem

The host keeps one execution, `models.execution` (`bundles/foundation/host-config/src/contracts/index.ts:70-76`), and every Thread runs on it unless its record carries a model:

- The executor runs `thread.model ?? execution.model` and `thread.effort ?? execution.effort`, always on `execution.providerId` (`bundles/runtime/default/src/host/executor.ts:342-358`), and records that provider on `response.started` (`bundles/runtime/default/src/host/executor.ts:556-559`).
- A top-level Thread is created without a model (`bundles/runtime/runtime/src/host/domain/runner.ts:675-721`; the store writes `model` and `effort` only when given, `bundles/runtime/runtime/src/host/store/threads.ts:681-682`), so it follows `models.execution`.
- The picker reads and writes `models.execution` through the settings draft: `useConfig(true, …)` (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:29`), `selectModelChoice` (`:76`), `setExecutionEffort` (`:59`), `updateModel` (`:92`); the draft autosaves after 500 ms (`bundles/desktop/settings/src/client/hooks/use-config.ts:179-186`).

So choosing a model in one Thread's footer changes the model of every Thread that has none of its own. Three more defects are in scope:

1. Manual compaction ignores the Thread: `summarizerFor` resolves `execution.providerId` and `execution.model` (`bundles/runtime/default/src/host/compact.ts:92-110`), though `executor/v1.compact` already receives the Thread (`bundles/runtime/runtime/src/contracts/executor.ts:237-246`).
2. The Thread record has no provider field (`bundles/runtime/runtime/src/contracts/model.ts:188-193`), so one Thread cannot run a model of another configured provider.
3. Mounting the picker can write `models.execution` with no reader action, because `useConfig` seeds its draft with `enableExecutionReasoning(load.data.configuration)` (`bundles/desktop/settings/src/client/hooks/use-config.ts:121`), which changes a stored `none` or absent effort on a model that offers reasoning (`bundles/desktop/settings/src/client/domain/config.ts:1586-1596`); the changed draft is dirty and autosaves (`bundles/desktop/settings/src/client/hooks/use-config.ts:169-186`).

## Goals

- **G1.** The Thread record carries a provider id next to its model and effort, and every new Thread — top-level, reader-opened sub-thread, or spawned child — stores an execution at creation (U1–U3, U11).
- **G2.** One resolution rule, exported from `runtime/contracts`, decides what a run and a manual compaction use; the executor, the compaction and the picker read it (U1, U6–U8).
- **G3.** `runtime.threads/v1` 1.7.0 gains `setThreadExecution`, desktop-exposed, which validates the triple like a spawn, writes it and publishes the record; `PATCH /threads/:id` answers the same outcomes (U1, U7, U10, U13).
- **G4.** The runtime validates and completes a spawned child's execution; `thread-spawn` no longer reads the configuration or the parent (U3, U12).
- **G5.** The picker shows and changes the selected Thread's execution through `setThreadExecution`, and with no Thread selected shows the default read-only (U4, U5).
- **G6.** The picker never writes the host configuration, not even on mount (U5).
- **G7.** A Thread whose stored execution is not available fails each run before any model request, with the message of [§5](#5-executor-and-compaction-default) and the code `thread_execution_unavailable`, keeps its record, and is repaired by one footer choice (U8, U9).

## Non-goals

- No migration or backfill of legacy Threads (U7).
- No choice of execution in the new-thread draft, the empty state or the project-creation flow (U4). `createThread`'s input does not change (`bundles/runtime/runtime/src/contracts/threads.ts:340-347`).
- No `provider` input on `thread-spawn`, and no `providerId` in `SpawnOptions` (U3).
- No fallback to the default for a Thread with a stored execution, and no notice, icon or warning in the picker (U8, U9).
- Settings does not rewrite Threads when a provider is renamed or removed (`updateProvider` and `removeProvider` move only `models.execution`, `bundles/desktop/settings/src/client/domain/config.ts:1291-1328`). Such a Thread fails its runs until a footer choice (U8, R1).
- No run-time repair of a stored effort the model no longer lists: the effort is sent as stored, as the default's effort is today (`bundles/runtime/default/src/host/executor.ts:345-350`). See R3.
- No provider on agent definitions and no inference of a provider from an agent's model: definitions keep `model` and `effort` only (`bundles/runtime/default/src/contracts/index.ts:71-77`), and a child always runs on its parent's provider (U14).
- No check of a model name against a provider's live catalog (`models/v1.catalog`): on a provider that lists no models, a typed name is stored as given (U15).
- No change to the summarizer's effort: manual compaction keeps resolving without an effort (`bundles/runtime/default/src/host/compact.ts:100-103`).
- No new compaction failure code: the closed `'summarizer_failed' | 'unsafe_boundary'` (`bundles/runtime/runtime/src/contracts/model.ts:296,754`, `bundles/runtime/runtime/src/contracts/executor.ts:118`) is kept (D9).
- No downgrade path for the `runtime` bundle below 2.7.0 once it has written a Thread (R2).

## Requirements

The user's decisions, restated:

- **U1.** Provider, model and effort are per Thread.
- **U2.** A new top-level Thread starts with the workspace default, captured at creation: its provider, model and effort are written to the Thread record.
- **U3.** A child Thread inherits its parent's provider, model and effort. `thread-spawn` may override only the model and the effort, validated against the parent's provider; it has no provider input.
- **U4.** No choice before a Thread exists. With no Thread selected, the footer picker chooses nothing for a future Thread; the Thread is created with the default, and its model is changed after it exists.
- **U5.** The workspace default changes only in Settings. The footer picker never writes `models.execution`.
- **U6.** Changing the default in Settings does not change a Thread that has stored values.
- **U7.** A legacy Thread keeps following the default until someone changes its model; that first change writes all three values to the Thread. No migration and no backfill.
- **U8.** A Thread whose stored provider or model is no longer available does not fall back. Its run fails with an error that tells the reader to choose another model in the footer picker, until a valid one is chosen.
- **U9.** No fallback notice in the UI. The failure shows through the run's error and the log; the picker stays usable to choose a valid model for such a Thread.
- **U10.** REST `PATCH /threads/:id` can also change the provider, model and effort, with the validation and results of `setThreadExecution`.
- **U11.** When the configuration cannot be read at creation, the creation fails; every new Thread stores its execution.
- **U12.** A spawn that changes only the model gets the new model's start effort, not the parent's effort.
- **U13.** `setThreadExecution`, from the picker and from REST, validates exactly like a spawn — the configuration check and `models/v1.resolve` — and refuses an invalid value at once with a clear message.
- **U14.** A spawn as an agent whose definition names a model the parent's provider does not list fails with a clear error naming the agent, the model and the provider. Agent definitions gain no provider field, and no provider is inferred; children always stay on the parent's provider.
- **U15.** On a provider that lists no models, a typed model name is accepted as is, by `setThreadExecution` and by a spawn; a typo surfaces on the Thread's first run with the provider's own message. No live catalog check.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The Thread record and its stored document gain an optional `providerId`. With `providerId`, the Thread has a stored execution; its `effort` absent means no effort, never the default's. Without `providerId`, `model` and `effort` keep their 1.1.0 meaning.                                                                                                                                                       |
| D2  | `runtime/contracts` exports the pure rules `resolveThreadExecution`, `modelEfforts`, `modelDefaultEffort` and `modelStartEffort`; the settings client deletes its own copies. Core's `executionProfile`, which fills the stored workspace default, is a different rule and stays ([§1](#1-the-resolution-rule)). The validator `checkThreadExecution` is exported from its module but not from the contracts index. |
| D3  | Every creation stores an execution: the workspace default for a top-level Thread; for a child of either origin, the parent's stored execution, or a legacy parent's resolved one. A spawn's own model and effort complete it as [§4](#4-runner-and-service) says.                                                                                                                                                   |
| D4  | One validator, built by the service from `checkThreadExecution` and `models/v1.resolve` and handed to the runner, serves a spawn that names a model or an effort and every `setThreadExecution` (U13).                                                                                                                                                                                                              |
| D5  | Only the calls that may reach `models/v1.resolve` — a spawn and `setThreadExecution` — validate before the Project's lock and write inside it; `createThread` computes its execution inside the lock, as `create` runs today.                                                                                                                                                                                       |
| D6  | A creation whose configuration read rejects fails with that error (U11).                                                                                                                                                                                                                                                                                                                                            |
| D7  | `setThreadExecution` writes all three fields in one document write (removing `effort` when absent) and publishes the record, on any stored Thread, in any state, in an inactive Project too.                                                                                                                                                                                                                        |
| D8  | A change applies from the Thread's next run and next manual compaction. A running prompt keeps the execution it resolved at its start (`bundles/runtime/default/src/host/executor.ts:342-358` resolves once per run).                                                                                                                                                                                               |
| D9  | A run of a Thread whose stored execution is not available rejects before any model request. A manual compaction of such a Thread fails through the existing `summarizer_failed` path.                                                                                                                                                                                                                               |
| D10 | `PATCH /threads/:id` accepts `providerId` and `model` together, with an optional `effort`; it calls `setThreadExecution`, and the route and the picker turn its outcomes into one error table in `runtime/contracts` (`restErrors`).                                                                                                                                                                                |
| D11 | The picker reads the configuration through a read-only query of its own, never through `useConfig`, and has no code path that writes the configuration. With no Thread selected it shows the default with disabled triggers.                                                                                                                                                                                        |
| D12 | The picker imports `resolveThreadExecution`, `modelEfforts`, `modelDefaultEffort`, `modelStartEffort` and `restErrors` from `runtime/contracts` as values, as the chat client already imports values from it (`bundles/desktop/chat/src/client/api/thread-watch.ts:23`, `bundles/desktop/chat/src/client/components/molecules/tool-item.tsx:1`).                                                                    |
| D13 | The runtime refuses an unlisted model with one message naming the model and the parent's provider; `thread-spawn` adds the agent when the model came from the agent's definition ([§6](#6-thread-spawn-threads)), so the reader sees the agent, the model and the provider (U14).                                                                                                                                   |
| D14 | Validation checks a model name only against the provider's configured list; a provider without one accepts any name, and `models/v1.resolve` does not read the model (U15).                                                                                                                                                                                                                                         |

## Design

### 1. The resolution rule

New file `bundles/runtime/runtime/src/contracts/execution.ts`. It imports only `ReasoningEffort` and `reasoningEfforts` from `bundles/runtime/runtime/src/contracts/model.ts`; the configuration is typed structurally so `default`, `settings` and the runtime pass their own configuration types.

Exported from `bundles/runtime/runtime/src/contracts/index.ts`:

```ts
/** The configuration parts the rules read (host-config/v1 ConfigurationValue). */
export interface ExecutionConfiguration {
  readonly providers: readonly {
    readonly id: string;
    readonly models?: readonly {
      readonly name: string;
      readonly reasonings?: readonly string[];
      readonly defaultEffort?: string;
    }[];
  }[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    };
  };
}

/** A provider, a model and an optional effort, as a Thread stores them. */
export interface ThreadExecution {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

/** Why an execution is refused or unavailable. */
export const threadExecutionIssues = ['provider', 'model', 'effort'] as const;
export type ThreadExecutionIssue = (typeof threadExecutionIssues)[number];

export type ResolvedThreadExecution =
  | {
      readonly status: 'resolved';
      /** `thread`: the stored execution; `default`: a legacy Thread. */
      readonly source: 'thread' | 'default';
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    }
  | {
      /** The stored execution names a provider or model the configuration lacks. */
      readonly status: 'unavailable';
      readonly issue: 'provider' | 'model';
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    };

export const resolveThreadExecution: (
  thread: {
    readonly providerId?: string;
    readonly model?: string;
    readonly effort?: string;
  },
  configuration: ExecutionConfiguration,
) => ResolvedThreadExecution;

/** The efforts the model's entry lists, in `reasoningEfforts`, in its order; [] when it lists none or is not listed. */
export const modelEfforts: (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
) => readonly ReasoningEffort[];

/** The entry's `defaultEffort` when it is one of `modelEfforts`; else undefined. */
export const modelDefaultEffort: (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
) => ReasoningEffort | undefined;

/** The effort `model` starts at on `providerId`; undefined when it lists none. */
export const modelStartEffort: (
  configuration: ExecutionConfiguration,
  providerId: string,
  model: string,
) => ReasoningEffort | undefined;
```

Exported from `bundles/runtime/runtime/src/contracts/execution.ts` but not from the contracts index, for the `runtime` host only:

```ts
export const checkThreadExecution: (
  configuration: ExecutionConfiguration,
  execution: ThreadExecution,
) => ThreadExecutionIssue | undefined;
```

The contracts index (`bundles/runtime/runtime/src/contracts/index.ts:5-23`) re-exports each module with `export *`. For this module it uses a named re-export instead, so `checkThreadExecution` stays out of the public surface:

```ts
export {
  type ExecutionConfiguration,
  modelDefaultEffort,
  modelEfforts,
  modelStartEffort,
  type ResolvedThreadExecution,
  resolveThreadExecution,
  type ThreadExecution,
  type ThreadExecutionIssue,
  threadExecutionIssues,
} from './execution.js';
```

The `runtime` host imports `checkThreadExecution` from `bundles/runtime/runtime/src/contracts/execution.ts` directly.

`d` below is `configuration.models.execution`, with its `effort` key omitted when absent. A provider _lists_ models when its `models` has at least one entry; an absent or empty list means models typed by hand (`bundles/foundation/host-config/src/host/config/schema.ts:37-41`).

- `checkThreadExecution` answers, in order: `'provider'` when no provider has the id; `'model'` when the provider lists models and none is named `model`; `'effort'` when `effort` is given, the model's entry exists, its `reasonings` is defined and does not include `effort` (an empty `reasonings` refuses every effort); else `undefined`.
- `modelEfforts`, `modelDefaultEffort` and `modelStartEffort` are the settings client's `modelEfforts` (`bundles/desktop/settings/src/client/domain/config.ts:1447-1455`), `modelDefaultEffort` (`:1551-1563`) and `modelThinkingEffort` (`:1565-1584`), moved here unchanged in behavior; the settings client keeps no copy ([§8](#8-the-picker-settings)). `modelStartEffort`: `modelEfforts` empty → `undefined`; else `modelDefaultEffort` when it is not `none`; else the first effort that is not `none`; else the first.
- `modelStartEffort` is not core's `executionProfile` (`bundles/foundation/core/src/host/models/catalog.ts:126-149`), which fills `models.execution`'s effort when the operator names none, each time the host reads the catalog into the configuration (`bundles/foundation/core/src/host/models/catalog.ts:51-68`). They differ on one case, a model whose catalog default is `none`: `executionProfile` keeps `none` (`bundles/foundation/core/src/host/models/catalog.ts:142-146`), so the stored default starts with reasoning off; `modelStartEffort` skips it (`bundles/desktop/settings/src/client/domain/config.ts:1579-1583`), so a model chosen in the picker or named alone by a spawn starts with reasoning on. Both behaviors exist today and this change keeps both. `executionProfile` decides the stored workspace default, which a new top-level Thread copies as stored (D3); `modelStartEffort` decides the effort of a model chosen for an existing Thread or a spawned child (U12). The change moves only the second.
- `resolveThreadExecution`:
  1. `thread.providerId === undefined` (legacy): `resolved`, `source: 'default'`, `{ providerId: d.providerId, model: thread.model ?? d.model, effort: thread.effort ?? d.effort }`. Nothing is checked, so a legacy Thread runs exactly as today (`bundles/runtime/default/tests/executor.test.ts:276-294`).
  2. `thread.providerId !== undefined` and `thread.model === undefined`: `unavailable`, `issue: 'model'`, `model: ''`.
  3. `thread.providerId !== undefined` and `checkThreadExecution` on `{ providerId, model }` (no effort) answers `'provider'` or `'model'`: `unavailable` with that issue and the stored values.
  4. Otherwise `resolved`, `source: 'thread'`, the stored values, the `effort` key omitted when the Thread stores none. The default's effort is never used here (D1).
- No rule reads `effort` for availability (R3).

### 2. Contracts in `runtime`

**Thread record.** Added to `interface Thread` (`bundles/runtime/runtime/src/contracts/model.ts:160-194`), after `effort`:

```ts
  /**
   * The provider the Thread runs on (runtime.threads/v1 1.7.0). Present: the
   * Thread has a stored execution — `model` is present too, and `effort`
   * absent means no effort; a run fails while it is not available. Absent: a
   * Thread created before 1.7.0; it follows the workspace default, with its
   * own `model` / `effort` over it when set. See `resolveThreadExecution`.
   */
  readonly providerId?: string;
```

`threadSchema` (`bundles/runtime/runtime/src/contracts/model.ts:658-689`) gains `providerId: z.string().optional()` after `effort` (`:687-688`). The comments on `model` and `effort` (`:188-193`) become: "The model the Thread runs on (1.1.0): written at creation from the parent or the workspace default (1.7.0), and by `setThreadExecution`. See `providerId`." and "The reasoning effort (1.1.0), written like `model`; absent with `providerId` present means no effort."

**`SpawnOptions`** (`bundles/runtime/runtime/src/contracts/threads.ts:207-235`). Type and schema unchanged. The comment becomes: "1.7.0: the child runs on its parent's provider; `model` and `effort` complete the parent's execution as the runtime's spawn rules say. When either is given, the runtime validates the result against the configuration and `models/v1`, and rejects the spawn, creating nothing, with a `ContractError` coded `invalid_execution` or with `models/v1`'s own rejection."

**`RuntimeThreadControls.spawn`** (`bundles/runtime/runtime/src/contracts/threads.ts:287-294`). The doc comment, which says a child without options runs "on its parent's model and effort", becomes: "Names the child `title`, or the start of `prompt` without one. 1.6.0: `options` spawns it as an agent and/or on a model and effort (see `SpawnOptions`). 1.7.0: the child runs on its parent's provider, and on its parent's model and effort unless `options` names its own; a model or effort the configuration refuses rejects with a `ContractError` coded `invalid_execution` whose `details.issue` names it, and a provider `models/v1` cannot resolve rejects with that error. Returns the child and its first prompt. Rejects on an empty prompt or title, a closed binding, or a Project that cannot take a Thread, as before. No rejection creates a Thread."

**`setThreadExecution`.** Added to `interface RuntimeThreads` (`bundles/runtime/runtime/src/contracts/threads.ts:339-…`), after `setThreadCwd` (`:367-370`):

```ts
  /**
   * 1.7.0: sets the Thread's provider, model and effort together. Validated
   * like a spawn's model: against the configuration in force, then
   * `models/v1.resolve`. Written in one document write — an absent `effort`
   * removes the stored one — and published as a Thread update. Applies from
   * the Thread's next run.
   */
  setThreadExecution(
    input: {
      readonly id: string;
      readonly providerId: string;
      readonly model: string;
      readonly effort?: ReasoningEffort;
    },
    call?: CallArg,
  ): Promise<ThreadExecutionResult>;
```

New exported type and schema in `bundles/runtime/runtime/src/contracts/threads.ts`:

```ts
export type ThreadExecutionResult =
  | { readonly status: 'updated'; readonly thread: Thread }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: ThreadExecutionIssue }
  /** `models/v1.resolve` refused the provider; `message` is its error's. */
  | { readonly status: 'unresolvable'; readonly message: string };
```

`threadExecutionResultSchema` is a union of loose objects on `status`, like `restartResultSchema` (`bundles/runtime/runtime/src/contracts/threads.ts:258-270`): `updated` with `thread: threadSchema`, `missing`, `invalid` with `reason: z.enum(threadExecutionIssues)`, and `unresolvable` with `message: z.string()`. In `runtimeThreadsMethods`, after `setThreadCwd` (`:590-593`), the input is the strict object `{ id: z.string(), providerId: z.string().trim().min(1).max(128), model: z.string().trim().min(1).max(512), effort: z.enum(reasoningEfforts).optional() }`; the bounds are the configuration's own (`bundles/foundation/host-config/src/host/config/schema.ts:10-11`).

**`restErrors`** (`bundles/runtime/runtime/src/contracts/rest-errors.ts:107-…`), after `setThreadCwd` (`:129-140`), gains `setThreadExecution(result: ThreadExecutionResult): RestError | undefined`: `updated` → `undefined`; `missing` → `notFoundError('thread')`; `invalid` → status 422, code `invalid_execution`, the message the new export `threadExecutionMessages: Readonly<Record<ThreadExecutionIssue, string>>` holds for the result's `reason`; `unresolvable` → status 422, code `invalid_execution`, the result's `message`.

| Reason     | Message                                        |
| ---------- | ---------------------------------------------- |
| `provider` | `The provider is not configured.`              |
| `model`    | `The model is not available on this provider.` |
| `effort`   | `This model does not support that effort.`     |

**`executor/v1`** (`bundles/runtime/runtime/src/contracts/executor.ts:14-21,31-38`). The schema changes only by the Thread's new field, which `executorThreadSchema` carries (`:196-210`). The comments become: "1.4.0: `run` and `compact` resolve the Thread's execution with `resolveThreadExecution`; a run of a Thread whose stored execution is unavailable rejects before any model request."

### 3. Store

- The Thread document schema (`bundles/runtime/runtime/src/contracts/storage.ts:78-142`) gains, after `effort` (`:138-139`), `providerId: z.string().optional()`, commented "absent on documents written before runtime.thread/v1 1.2.0".
- `toThread` (`bundles/runtime/runtime/src/host/store/threads.ts:104-155`) copies `providerId` when present, as the record's last key, after `effort` (`:154`). A Thread created by 1.7.0 without an effort thus has the keys `…, updatedAt, model, providerId`; with an effort, `…, updatedAt, model, effort, providerId`.
- `ThreadStore.create` (`bundles/runtime/runtime/src/host/store/types.ts:157-164`) takes the execution as its third parameter, required and before the optional ones, and the agent as its last; `options?: SpawnOptions` and its import (`:20`) are removed:

```ts
  create(
    projectId: string,
    name: string,
    execution: ThreadExecution,
    parentThreadId?: string,
    inherit?: { readonly cwd: string; readonly cwdRepo?: CwdRepo },
    origin?: ThreadOrigin,
    agent?: SpawnAgent,
  ): Promise<ThreadRecord>;
```

It writes `providerId`, `model` and, when present, `effort` from `execution`, and `agent` when given, in place of the three spreads of `options` (`bundles/runtime/runtime/src/host/store/threads.ts:680-682`). It still writes given values and never resolves or defaults (`bundles/runtime/runtime/src/host/store/types.ts:150-156`). Its one source caller, `runner.create` (`bundles/runtime/runtime/src/host/domain/runner.ts:704-711`), always has an execution (U11) and passes `options.agent` last.

- Test callers of `ThreadStore.create` each gain the third argument. A new file `bundles/runtime/runtime/tests/support/execution.ts` exports `testExecution: ThreadExecution = { providerId: 'test-provider', model: 'test-model' }`, and every call below passes it unless its case is about the execution. Calls on `WorkspaceService.threads.create` (`bundles/runtime/runtime/src/host/domain/types.ts:129-133`) do not change.
  - `bundles/runtime/runtime/tests/store/store.conformance.test.ts`: all 54 calls, on `threads`, `second.threads`, `threadStore` (`:511`, `:591`) and `setup` (`:657`). The call at `:1660-1671` passes `{ providerId: 'p-1', model: 'm-1', effort: 'high' }` third, `parent.id`, `undefined`, `'agent'` and the agent last.
  - `bundles/runtime/runtime/tests/store/attachments.test.ts:74,113,206,248`, `bundles/runtime/runtime/tests/store/append-cost.test.ts:48`, `bundles/runtime/runtime/tests/store/storage-persistence.test.ts:24`, `bundles/runtime/runtime/tests/store/progress.property.test.ts:180`.
  - `bundles/runtime/runtime/tests/contracts/runtime-services.test.ts:63`, `bundles/runtime/runtime/tests/domain/workspace-resume.test.ts:61,128`, and the 18 `host.threads.create` calls of `bundles/runtime/runtime/tests/domain/workspace-restart.test.ts` (`:38,128,185,250,298,367,408,550,551,625,626,632,793,855,987` and the parents at `:127,249,407`), where `host.threads` is the store (`:498`).
- `ThreadStore` gains, after `setCwd` (`bundles/runtime/runtime/src/host/store/types.ts:175-180`):

```ts
  /** Writes provider, model and effort in one write; no effort removes the stored one. */
  setExecution(id: string, execution: ThreadExecution): Promise<Thread | undefined>;
```

It answers `undefined` for a missing id and bumps `updatedAt` like the other single-field updates (`bundles/runtime/runtime/src/host/store/threads.ts:489-494,746-752`).

### 4. Runner and service

**Validation module.** New file `bundles/runtime/runtime/src/host/domain/execution.ts`, internal to the `runtime` bundle:

```ts
/** Why the validator refuses an execution. */
export type ExecutionRefusal =
  /** `checkThreadExecution`'s issue. */
  | { readonly kind: 'invalid'; readonly issue: ThreadExecutionIssue }
  /** `models/v1.resolve` rejected; `error` is its rejection, unchanged. */
  | {
      readonly kind: 'unresolvable';
      readonly error: unknown;
      readonly message: string;
    };

/** Which keys of the execution the caller chose, so only those can be refused. */
export interface ExecutionChoice {
  readonly model: boolean;
  readonly effort: boolean;
}

/**
 * `checkThreadExecution` (its issues `model` and `effort` counted only when
 * `choice` says the caller chose that key; `provider` always), then
 * `models/v1.resolve` through `resolve`. Answers the first refusal, or
 * undefined.
 */
export const createExecutionValidator: (
  resolve: (providerId: string, model: string) => Promise<unknown>,
) => (
  configuration: ExecutionConfiguration,
  execution: ThreadExecution,
  choice: ExecutionChoice,
) => Promise<ExecutionRefusal | undefined>;
```

`resolve` is the existing port `RuntimePorts.catalogSource(providerId, model)` (`bundles/runtime/runtime/src/host/ports.ts:127-129`), which calls `models/v1.resolve` and rejects with its error; the validator ignores its value. No port is added. `models/v1.resolve` ignores the effort for building the model (`bundles/foundation/core/src/host/models/index.ts:103-111`), so none is passed. `message` is the rejection's `message` when it is an `Error`, else `String(error)`.

**Ownership.** The service owns the ports (`bundles/runtime/runtime/src/host/domain/service.ts:81-84`) and builds one validator from `ports.catalogSource`. It uses it for `setThreadExecution`, and hands the runner what `spawn`, a runner closure (`bundles/runtime/runtime/src/host/domain/runner.ts:1471-1500`), needs through two new `RunnerContext` members, wired next to `compactionPolicy` (`bundles/runtime/runtime/src/host/domain/runner.ts:95-99`; `bundles/runtime/runtime/src/host/domain/service.ts:186-200`):

```ts
  /** host-config/v1: the configuration in force, unwrapped from its `DoricConfiguration`. */
  readonly executionConfiguration: () => Promise<ExecutionConfiguration>;
  /** The service's validator (`createExecutionValidator(ports.catalogSource)`). */
  readonly validateExecution: (
    configuration: ExecutionConfiguration,
    execution: ThreadExecution,
    choice: ExecutionChoice,
  ) => Promise<ExecutionRefusal | undefined>;
```

The service wires `executionConfiguration: async () => (await ports.configuration()).configuration`: `ports.configuration()` answers the `DoricConfiguration` wrapper (`bundles/runtime/runtime/src/host/ports.ts:38-39`), and `compactionPolicy` unwraps it the same way (`bundles/runtime/runtime/src/host/domain/service.ts:189`).

The runtime already requires `models/v1` and `host-config/v1` (`bundles/runtime/runtime/manifest.json:32-33`). Both reads are cached after their first call: the configuration by host-config (`bundles/foundation/host-config/src/host/config/service.ts:90-106`), the language model by provider in core (`bundles/foundation/core/src/host/models/index.ts:103-111`).

**Creation of a Thread.** `runner.create` (`bundles/runtime/runtime/src/host/domain/runner.ts:675-721`) takes `options?: { readonly agent?: SpawnAgent; readonly execution?: ThreadExecution }` and always passes an execution to the store:

| Caller                                                                                                             | Where the execution comes from                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.threads.create` without `parentThreadId` (`bundles/runtime/runtime/src/host/domain/service.ts:1047-1058`) | `create` computes it inside the Project's lock: `models.execution`'s provider and model, and its effort when it is one of `reasoningEfforts`.                                                                                                                                                                                 |
| `service.threads.create` with `parentThreadId` (a reader-opened sub-thread)                                        | `create` computes it inside the lock from the parent's live record, which it already looks up there (`bundles/runtime/runtime/src/host/domain/runner.ts:686-695`): the parent's stored execution, available or not; for a legacy parent, its resolved execution (§1 rule 1), effort kept only when one of `reasoningEfforts`. |
| `spawn`                                                                                                            | `spawn` computes it before the lock (below) and passes it in `options.execution`; `create` stores it as given.                                                                                                                                                                                                                |

Only `spawn` works outside the lock, because only it may call `models/v1.resolve`; the other creations read the cached configuration inside the lock, as `create` runs today. When `executionConfiguration()` rejects, the creation rejects with its error and creates nothing (D6, U11). A missing or closing parent is still refused inside the lock, as today.

**Spawn.** `spawn` reads the parent's live record once, before the lock: it is the calling prompt's own Thread (`bundles/runtime/runtime/src/host/domain/runner.ts:1450-1470`). A `setThreadExecution` on the parent that lands between that read and the lock is not seen: the child takes the parent's execution as of the spawn call. With the parent's execution `{ providerId, model, effort }` as the base (its stored execution, or a legacy parent's resolved one), and the spawn's `options.model` / `options.effort` (which `thread-spawn` fills from the agent's definition when its input names none, `bundles/features/threads/src/host/tools/thread-spawn.ts:113-114`):

| The spawn names         | Child execution                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------ |
| neither                 | the base                                                                             |
| model and effort        | base provider, its model, its effort                                                 |
| model only, same model  | the base                                                                             |
| model only, other model | base provider, its model, `modelStartEffort(configuration, providerId, model)` (U12) |
| effort only             | base provider and model, its effort                                                  |

**Order in `spawn`.** Today every step of `spawn` runs inside the lock (`bundles/runtime/runtime/src/host/domain/runner.ts:1471-1500`). The new order: before the lock, `allowed()`, the empty-prompt and empty-title checks (`:1474-1478`), the read of the parent's record, `executionConfiguration()`, the child's execution (table above) and, when needed, the validation (below); then, inside the lock, `allowed()` again, because the calling prompt may have ended while the validation waited, and `create` with `{ agent: options?.agent, execution: child }`, which replaces today's spread of `options` with the parent's model and effort (`:1481-1491`). A spawn from an ended prompt, or with an empty prompt or title, is refused before any configuration read.

When the spawn names a model or an effort, `spawn` calls `context.validateExecution(configuration, child, { model: options.model !== undefined, effort: options.effort !== undefined })` before the lock, so an effort alone is checked against the inherited model, as `thread-spawn` checks today (`bundles/features/threads/tests/threads.test.ts:396-432`). A refusal rejects the spawn and creates nothing:

| Refusal               | Rejection                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`, `model`    | `ContractError('invalid_execution', 'Model "<model>" is not available on provider "<provider>". Available models: <a>, <b>.', { issue: 'model' })` |
| `invalid`, `effort`   | `ContractError('invalid_execution', 'Effort "<effort>" is not supported by model "<model>". Supported efforts: <a>, <b>.', { issue: 'effort' })`   |
| `invalid`, `provider` | `ContractError('invalid_execution', 'Provider "<provider>" is not configured.', { issue: 'provider' })`                                            |
| `unresolvable`        | the refusal's `error`, unchanged, as `thread-spawn` rethrows it today (`bundles/features/threads/src/host/tools/thread-spawn.ts:78-85`)            |

`<provider>` is always the parent's provider. The first two messages are `thread-spawn`'s today (`bundles/features/threads/src/host/tools/thread-spawn.ts:63-76`). `ContractError` is the platform's error with a code and details (`packages/bundle/src/contracts/error.ts:58-76`); a host call between bundles rethrows a provider's rejection unchanged (`packages/bundle/src/runtime/dispatch.ts:220-233`). The runtime does not know where `options.model` came from, so its message never names an agent; [§6](#6-thread-spawn-threads) adds the agent (U14, D13). On a provider that lists no models, any model name passes the configuration check (U15, D14).

**`setThreadExecution`.** `service.threads.setExecution(id, execution): Promise<ThreadExecutionResult>`, declared in `bundles/runtime/runtime/src/host/domain/types.ts:129-143` next to `rename` (`bundles/runtime/runtime/src/host/domain/service.ts:1077-1089`). Data flow: read the record (none → `missing`); read the configuration and run the validator with `{ model: true, effort: true }` (`invalid` → `{ status: 'invalid', reason: issue }`; `unresolvable` → `{ status: 'unresolvable', message }`); then, under the Project's lock, `store.setExecution` (none → `missing`), replace the live record when the Project is open, publish it, and answer `updated` with it. A rejected configuration read rejects the call. Validation and write are not atomic: a configuration saved between them leaves a Thread whose execution fails its runs (U8) until the next choice, and two concurrent calls on one Thread end with the later write (R6).

`bundles/runtime/runtime/src/host/services/threads.ts` defines `setThreadExecution` after `setThreadCwd` (`:101-105`), `expose: 'desktop'`, executing `service.threads.setExecution`. Exposing it changes what a desktop window can reach, so the reviewed snapshot `app/backend/doric-host/tests/bridge-exposure.snapshot.json` gains `"setThreadExecution"` in the `runtime.threads/v1` list, between `"setThreadCwd"` (`:83`) and `"steer"` (`app/backend/doric-host/tests/bridge-exposure.test.ts:1-5` requires the update in review).

### 5. Executor and compaction (`default`)

`runPrompt` (`bundles/runtime/default/src/host/executor.ts:342-358`) calls `resolveThreadExecution(thread, configuration)`:

- `resolved`: `ModelsV1.resolve` and `inputModalities` use its `providerId`, `model` and `effort`; `response.started` carries its `providerId` (`bundles/runtime/default/src/host/executor.ts:556-559`). Automatic compaction already uses the run's provider and model (`bundles/runtime/default/src/host/executor.ts:469-482`).
- `unavailable`: the run calls `services.use(LogV1).warn('Thread execution unavailable', { threadId: thread.id, providerId, model, issue }, call)` — `LogV1` from `bundle/contracts` (`packages/bundle/src/contracts/basic/log.ts:13-20`), which the bundle already requires (`bundles/runtime/default/manifest.json:18`) — and rejects before any model request with an `Error` whose message is `The model "<model>" on provider "<provider>" is not available for this thread. Choose another model in the conversation footer.` and whose own `code` property is `thread_execution_unavailable`. The runner records it as `agent.failed` (`bundles/runtime/runtime/src/host/domain/runner.ts:580-589`), keeping own properties such as `code` (`bundles/runtime/runtime/src/host/domain/serialization.ts:121-131`), and the chat shows its message (`bundles/desktop/chat/src/client/domain/prompt-lifecycle.ts:140-154`). The Thread returns to `ready` (`bundles/runtime/runtime/src/host/domain/runner.ts:611-618`), so every later prompt fails the same way until the execution changes (U8).

The doc comment at `bundles/runtime/default/src/host/executor.ts:276-279` is rewritten to say this.

`compactThread`'s input type (`bundles/runtime/default/src/host/compact.ts:118-131`), today `{ session, policy }`, becomes `ExecutorCompactionInput` (`bundles/runtime/runtime/src/contracts/executor.ts:122-127`), destructured as `{ thread, session, policy }`; its caller already passes the whole input (`bundles/runtime/default/src/host/index.ts:63`). `summarizerFor` (`bundles/runtime/default/src/host/compact.ts:92-110`) becomes `summarizerFor(thread: ExecutorThread, configuration: ConfigurationValue, call, services, summaryMaxChars)`: it takes the configuration `compactThread` already read (`:132`) instead of reading it again, and resolves the Thread with `resolveThreadExecution`: `resolved` → its provider and model (still no effort); `unavailable` → it throws inside the existing `try` (`bundles/runtime/default/src/host/compact.ts:147-201`), so the compaction records `compaction.failed` with `summarizer_failed` and answers `{ status: 'failed', code: 'summarizer_failed' }`, as for any summarizer failure (D9).

### 6. `thread-spawn` (`threads`)

In `bundles/features/threads/src/host/tools/thread-spawn.ts`, `checkModel` (`:45-86`) and its call in `execute` (`:108-143`) are removed, with the imports of `ConfigurationV1` and `ModelsV1`. `execute` resolves the agent as today and passes `{ agent?, model?, effort? }` to `spawn`; a rejection reaches the model as the tool's error, with one exception (U14, D13): when the model came from the agent's definition (`input.model` undefined and `agent.model` defined) and `spawn` rejects with a `ContractError` whose `code` is `invalid_execution` and whose `details.issue` is `model`, the tool throws `Error('Agent "<agent>" names model "<model>", which its parent thread\'s provider does not list. ' + error.message)`, so the reader reads the agent, the model, and — in the runtime's message — the provider and its models. `thread-spawn` already reads a `ContractError`'s `code` and `details` this way for `default.agents/v1` (`bundles/features/threads/src/host/tools/thread-spawn.ts:25-43`). The input and the description do not change. `bundles/features/threads/manifest.json` drops `models/v1@^1.0.0` and `host-config/v1@^1.1.0` from `requires` (no other source in the bundle uses them) and raises `runtime.threads/v1` to `^1.7.0`.

### 7. REST (`transport`)

`PATCH /threads/:id` (`bundles/foundation/transport/src/host/routes/threads.ts:202-252`). `threadInput` (`:25-28`) becomes the strict object `{ name?, cwd?, providerId?, model?, effort? }` with the contract's bounds (§2), refined so that `providerId` and `model` are both present or both absent, `effort` appears only with them, and at least one of `name`, `cwd`, `providerId` is present. A refused body answers 422 `invalid_thread` with `A Thread name, a working directory, an execution (providerId and model, with an optional effort), or a combination is required.` The route applies `name`, then `cwd`, then the execution through `setThreadExecution`; an execution outcome other than `updated` answers `restErrors.setThreadExecution(result)` and stops, earlier changes kept, as a `cwd` refusal does today after a rename (`bundles/foundation/transport/src/host/routes/threads.ts:215-243`). The answer is the last updated record. `bundles/foundation/transport/manifest.json` raises `runtime.threads/v1` to `^1.7.0`; its `version` stays `0.0.1`. `transportRequires` (`bundles/foundation/transport/src/kernel.ts:76-86`), which the kernel-embedded transport declares as its `requires` (`:105`), raises `runtime.threads/v1@^1.0.0` to `^1.7.0` in the same commit, so both declarations agree.

### 8. The picker (`settings`)

**Manifest and package.** `bundles/desktop/settings/manifest.json`: `version` 1.6.0; `requires` adds `runtime.threads/v1@^1.7.0`; `optional` adds `layout.workspace/v1`. `bundles/desktop/settings/package.json` moves `runtime` from `devDependencies` to `dependencies`, as the chat lists it (`bundles/desktop/chat/package.json:35`). `runtime/contracts` resolves through each window's import map (`packages/bundle/src/build/parts.ts:60-63,177-183`), as `layout/contracts` already does for this bundle (`bundles/desktop/settings/src/client/index.ts:13`).

**Activation.** In `bundles/desktop/settings/src/client/index.ts`, next to the dashboard's `whenAvailable` (`:92-95`), `services.whenAvailable(LayoutWorkspaceV1, () => { setWorkspaceAvailable(true); return () => setWorkspaceAvailable(false); })`. `setWorkspaceAvailable` is new in `bundles/desktop/settings/src/client/api/settings-api.ts`, next to `setDashboardAvailable` (`:1273-1283`); unlike it, it also notifies the workspace subscribers (Adapter, below). `LayoutWorkspaceV1` comes from `layout/contracts`.

**Adapter.** Added to `interface SettingsApi` (`bundles/desktop/settings/src/client/api/settings-api.ts:1104-1113`):

```ts
  /** The workspace window's selected Thread (`layout.workspace/v1`, optional). */
  readonly workspace: {
    selectedThread(): Thread | undefined;
    /** Also called when the provider appears or goes. */
    subscribe(listener: () => void): Disposable;
  };
  readonly threads: {
    setExecution(input: {
      readonly id: string;
      readonly providerId: string;
      readonly model: string;
      readonly effort?: ReasoningEffort;
    }): Promise<ThreadExecutionResult>;
  };
```

`threads` calls `runtime.threads/v1.setThreadExecution` through a reference built from the contract id, as the layout does (`bundles/desktop/layout/src/client/api/host.ts:13`).

`setDashboardAvailable` only sets a flag that later calls read (`bundles/desktop/settings/src/client/api/settings-api.ts:1256-1266,1278-1283`), so a listener subscribed while the flag is off would never hear from a provider that appears later. The workspace adapter therefore notifies on availability itself:

- Module state, next to `dashboardAvailable`: `let workspaceAvailable = false` and `const workspaceRefreshes = new Set<() => void>()`.
- `setWorkspaceAvailable(available: boolean): void` sets the flag, then runs every function in `workspaceRefreshes`.
- `workspace.subscribe(listener)` holds one inner subscription, `services.use(LayoutWorkspaceV1).subscribe(listener)`, attached at once when the flag is on. It adds to `workspaceRefreshes` a function that disposes the inner subscription (ignoring an error, since the provider may already be gone), attaches a new one when the flag is on, and calls `listener()` once. The returned `Disposable` removes that function and disposes the inner subscription.
- `workspace.selectedThread()` answers `services.use(LayoutWorkspaceV1).selectedThread()` while the flag is on, else `undefined`.

So `useSelectedThread` re-renders when the provider appears, changes its selection, or goes, with no other signal.

The comment on `HostConfigurationV1` (`bundles/desktop/settings/src/client/api/settings-api.ts:67-71`) says `runtime/contracts` is not in a window's import map. That is stale: the window's import map holds the contracts part of every retained bundle (`app/desktop/doric/src/platform/app.ts:589-605`), and this bundle now imports `runtime/contracts` values. The comment becomes: "`host-config/v1` (the `/config` pipeline), referenced by id with the runtime's `HostConfiguration` type."

**Domain.** In `bundles/desktop/settings/src/client/domain/config.ts`, `modelEfforts` (`:1447-1455`), its helper `modelEntry` (`:1457-1464`), `modelDefaultEffort` (`:1551-1563`) and `modelThinkingEffort` (`:1565-1584`) are deleted. The module re-exports `modelEfforts` and `modelDefaultEffort` from `runtime/contracts`, so their importers (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:7-8`, `bundles/desktop/settings/src/client/components/organisms/settings-execution.tsx:12`) and the module's own callers (`config.ts:563,1632`) keep their names; `enableExecutionReasoning` (`:1592`) and `modelProfile` (`:1608`) call `modelStartEffort` directly. The settings `Configuration` is passed as the runtime's structural `ExecutionConfiguration` (its `ProviderModel`, `:146-160`, carries `name`, `reasonings` and `defaultEffort`). One function is added next to `modelChoiceKey` (`:1668`):

```ts
/** The configuration with `models.execution` replaced, so the picker rules read a Thread's execution. */
export const withExecution: (
  configuration: Configuration,
  execution: ModelExecution,
) => Configuration;
```

It answers `{ ...configuration, models: { ...configuration.models, execution } }`. `bundles/desktop/settings/tests/config.test.ts:174-177` already defines a local `withExecution(base, patch)` with this meaning, called ten times between `:411` and `:1412`; the test deletes it and imports the export, and those calls keep their shape. The private `withExecutionProvider` (`bundles/desktop/settings/src/client/domain/config.ts:1259-1267`), which moves only the provider id, is unrelated and stays.

The picker calls its existing rules on `withExecution(configuration, shown)` (the _view configuration_): `modelGroups` (`:1479-1528`), `modelEfforts` (`:1447-1455`), `modelDefaultEffort` (`:1551-1563`), `selectModelChoice` (`:1672-1683`), `setExecutionEffort` (`:1650-1662`), `updateModel` (`:1622-1643`) and `modelIconRequests` (`bundles/desktop/settings/src/client/domain/model-icons.ts:51-70`). Each reads the shown execution from the view's `models.execution`, and the picker takes the next execution from the result's `models.execution`. Only that `ModelExecution` reaches `setThreadExecution`; no view configuration is passed to `api().config.update` or any other host call.

**Hooks.**

- `bundles/desktop/settings/src/client/hooks/use-config-snapshot.ts` (new): a `useQuery` on a new key `queryKeys.configSnapshot = ['config', 'snapshot']` (`bundles/desktop/settings/src/client/queries/keys.ts:9-30`) reading `api().config.get()`, refetched on window focus, answering the configuration or the error's message. No draft and no mutation (D11). `useConfig`'s refetches by the `['config']` prefix (`bundles/desktop/settings/src/client/hooks/use-config.ts:97,109`) refetch it too. After a successful save, `useConfig` (`:124-147`) invalidates exactly `configSnapshot`, so a provider saved from the dashboard's provider page in the same window (`bundles/desktop/settings/src/client/index.ts:79-82`) reaches the picker.
- `bundles/desktop/settings/src/client/hooks/use-selected-thread.ts` (new): `useSyncExternalStore` over `api().workspace.subscribe` with a version counter as its snapshot, bumped on every notification, reading `selectedThread()` during render. A record read through the service is a fresh copy on every call (`bundles/desktop/chat/src/client/hooks/use-workspace.ts:87-90`), so it cannot be the snapshot itself; this is the chat's pattern (`bundles/desktop/chat/src/client/hooks/use-workspace.ts:69-73`).

**Component.** `ExecutionPicker` (`bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:27-109`) reads `useConfigSnapshot` and `useSelectedThread`, and no longer `useConfig`. What it shows:

| Case                                            | Shown                                                        | Triggers      | Writes    |
| ----------------------------------------------- | ------------------------------------------------------------ | ------------- | --------- |
| Configuration not loaded                        | nothing; a read error in the alert span                      | none          | none      |
| No Thread selected, or no `layout.workspace/v1` | `models.execution` as stored                                 | both disabled | none      |
| Legacy Thread                                   | its resolved execution (§1 rule 1)                           | enabled       | on choice |
| Thread with a stored execution                  | its stored `providerId`, `model`, `effort`, available or not | enabled       | on choice |
| A write in flight for the selected Thread       | the execution being written                                  | both disabled | —         |

The disabled triggers carry `title="New threads start on the workspace default. Change it in Settings."` (U4, U5). A stored execution that is not available needs no special case: `modelGroups` already lists a current model its provider does not list, first in its group or alone when the provider is gone (`bundles/desktop/settings/src/client/domain/config.ts:1511-1521`), and every listed model stays choosable (U9). The effort is shown as stored; the picker never applies `enableExecutionReasoning`.

A choice computes the next execution from the view configuration: a model with `selectModelChoice` (whose effort is the model's start effort), an effort with `setExecutionEffort`, a typed model with `updateModel`. The typed-model field (drawn when no provider lists a model, `bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx:85-94`) keeps a local value and commits on blur or Enter a trimmed, non-empty value that differs from the shown model, on the shown provider when it is configured, else on the default's; it no longer writes per keystroke. When the next execution equals the shown one, nothing is written. Otherwise the picker calls `api().threads.setExecution({ id, ...next })` and, for any answer but `updated`, shows `restErrors.setThreadExecution(result).message` in the alert span; a rejection shows its message. The shown execution then follows the layout's record of the Thread, which `setThreadExecution` publishes.

**Picker state.** Besides the two hooks, the picker keeps three pieces of React state: `writes`, a map from Thread id to the `ModelExecution` being written; `answered`, a map from Thread id to the record of that Thread's last `updated` answer; and `alert`, `{ threadId, message }` or none. For the selected Thread, the shown execution is:

1. its entry in `writes`, while a write is in flight;
2. else its `answered` record, when that record's `updatedAt` is later than the layout record's — the answer can arrive before the layout publishes the update;
3. else the layout's record.

An `answered` entry is dropped once the layout's record of that Thread has an `updatedAt` at least as late. The triggers are disabled only while the selected Thread has a write in flight. When the selection changes, a write in flight goes on, and its answer updates `writes`, `answered` or `alert` for its own Thread only, so it never changes what another Thread shows. The alert span shows `alert.message` only while `alert.threadId` is the selected Thread; the next choice on that Thread clears it.

`ModelPickerProps` (`bundles/desktop/settings/src/client/components/molecules/model-picker.tsx:25-41`) gains `disabled?: boolean` and `title?: string` for its trigger. `EffortPicker` already has `disabled` (`bundles/desktop/settings/src/client/components/molecules/effort-picker.tsx:16,33,43`) and gains `title?: string`.

## Flows

**New top-level Thread.** Layout → `createThread({ projectId, name })` (`bundles/desktop/layout/src/client/hooks/use-workspace.ts:380-383,422-426`) → service reads the configuration → runner stores `models.execution` under the lock → `threadUpdated` → layout tree → picker.

**Reader-opened sub-thread.** `createThread({ projectId, name, parentThreadId })` → service reads the parent record and the configuration → runner stores the parent's execution.

**Spawned child.** Agent → `thread-spawn` (agent resolution only) → `spawn(prompt, title, { agent?, model?, effort? })` → runner reads the parent's live record and the configuration, computes the child execution and, when the spawn names a model or an effort, calls the service's validator, all outside the lock → stores it under the lock. A model refusal of an agent-definition model is rewrapped by `thread-spawn` with the agent's name.

**Choice in the footer.** Picker → `setThreadExecution` → validation (configuration, then `models/v1.resolve`) → one document write under the lock → `threadUpdated` → layout tree → `layout.workspace/v1.subscribe` → picker re-reads. Neither another Thread nor `models.execution` is written.

**REST.** `PATCH /threads/:id { providerId, model, effort? }` → `setThreadExecution` → 200 with the record, or the `restErrors` answer.

**Run.** Runner → `executor/v1.run({ thread, … })` → `resolveThreadExecution` → resolved: model calls on its provider; unavailable: `agent.failed` with the message of §5, no model call.

**Manual compaction.** Runner → `executor/v1.compact({ thread, … })` → resolved: summarized by the Thread's provider and model; unavailable: `compaction.failed` with `summarizer_failed`.

**Default changed in Settings.** Threads with a stored execution keep theirs; legacy Threads run on the new default; later Threads store the new default.

**Provider removed or renamed in Settings.** Threads stored on it fail each run with the message of §5; one footer choice repairs each.

## Contracts and versions

| Contract / bundle    | From → to     | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.thread/v1`  | 1.1.0 → 1.2.0 | Optional document field `providerId` (minor: new optional field, `docs/architecture/bundles/versioning.md:48`).                                                                                                                                                                                                                                                                                             |
| `runtime.threads/v1` | 1.6.0 → 1.7.0 | New method `setThreadExecution` and optional record field `providerId` (minor, `docs/architecture/bundles/versioning.md:48`). Creation stores an execution. `spawn` now rejects a model or effort the configuration refuses, with a `ContractError` coded `invalid_execution`; `thread-spawn`, its only caller, refused the same inputs before (§4). Records without `providerId` keep their 1.6.0 meaning. |
| `executor/v1`        | 1.3.0 → 1.4.0 | `run` and `compact` resolve with `resolveThreadExecution`; a run of an unavailable stored execution rejects.                                                                                                                                                                                                                                                                                                |
| `runtime` bundle     | 2.6.0 → 2.7.0 | Provides the two contracts above; `requires` `executor/v1@^1.4.0` (from `^1.0.0`), so an older executor that ignores a Thread's provider puts the composition in quarantine instead of running.                                                                                                                                                                                                             |
| `default` bundle     | 2.4.0 → 2.5.0 | Provides `executor/v1@1.4.0`.                                                                                                                                                                                                                                                                                                                                                                               |
| `threads` bundle     | 2.0.0 → 2.0.1 | No contract or contribution changes (`docs/architecture/bundles/versioning.md:57`); `requires` `runtime.threads/v1@^1.7.0` and drops `models/v1` and `host-config/v1`; its manifest test expects 2.0.1.                                                                                                                                                                                                     |
| `transport` bundle   | 0.0.1 (kept)  | `PATCH /threads/:id` gains the execution fields; `requires` `runtime.threads/v1@^1.7.0` in `manifest.json` and in `transportRequires` (§7).                                                                                                                                                                                                                                                                 |
| `settings` bundle    | 1.5.0 → 1.6.0 | Picker per Thread; `requires` `runtime.threads/v1@^1.7.0`; `optional` `layout.workspace/v1`. `settings.config/v1` unchanged.                                                                                                                                                                                                                                                                                |

The other consumers of `runtime.threads/v1` — `chat`, `layout`, `comments`, `openui`, `papercraft`, `terminal`, `usage` (their `manifest.json` `requires`) — keep their ranges: they read the Thread record as a loose object and pass the new field through (`bundles/desktop/layout/src/client/domain/project-tree.ts:230-233`).

## Persisted data

- Thread documents (`runtime.thread/v1`): new optional `providerId`. Documents without it stay valid and are not rewritten (U7). `setThreadExecution` rewrites `providerId`, `model` and `effort` of one document.
- The host configuration is unchanged; nothing in this change writes it.

## Alternatives considered

| Alternative                                                                    | Why rejected                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-thread model and effort only, provider always the workspace's.             | U1.                                                                                                                                                                                                                                                                                                                                                          |
| Write nothing at creation; a Thread follows the default until changed.         | U2; a Settings change would move every Thread nobody touched (U6).                                                                                                                                                                                                                                                                                           |
| Run an unavailable stored execution on the default.                            | U8.                                                                                                                                                                                                                                                                                                                                                          |
| Create a Thread in the legacy shape when the configuration cannot be read.     | U11.                                                                                                                                                                                                                                                                                                                                                         |
| A spawn that changes the model keeps the parent's effort.                      | U12; the parent's effort may not be one the new model lists.                                                                                                                                                                                                                                                                                                 |
| A `provider` input on `thread-spawn`.                                          | U3.                                                                                                                                                                                                                                                                                                                                                          |
| Validate a spawn's model in `thread-spawn` (version 1).                        | The tool and the runner read the configuration and the parent at different moments; the runner already reaches the configuration and `models/v1` and creates the child.                                                                                                                                                                                      |
| Read the configuration and call `models/v1.resolve` inside the Project's lock. | `resolve` may read a credential (`bundles/foundation/core/src/host/models/index.ts:20-30`), and the lock serializes every queue and state change of the Project (`bundles/runtime/runtime/src/host/domain/runner.ts:128`).                                                                                                                                   |
| A copy of the resolution rule in the `settings` client (version 1).            | The window resolves `runtime/contracts` values: the chat imports them (`bundles/desktop/chat/src/client/api/thread-watch.ts:23`; `bundles/desktop/chat/dist/client/index.js:11` keeps the import external).                                                                                                                                                  |
| A new compaction failure code for an unavailable execution.                    | It would widen closed unions in three contracts and the chat projector (`bundles/runtime/runtime/src/contracts/model.ts:296,754`, `bundles/runtime/runtime/src/contracts/executor.ts:118`, `bundles/desktop/chat/src/client/domain/projector.ts:210`); the run's error states the cause (D9).                                                                |
| Settings rewrites the Threads on a provider rename.                            | Settings owns the configuration, not Threads; it would need a bulk write over every Project's Threads. One footer choice repairs a Thread (R1).                                                                                                                                                                                                              |
| Keep `useConfig` in the picker and stop calling `setDraft`.                    | `useConfig` itself seeds a changed draft and autosaves it (`bundles/desktop/settings/src/client/hooks/use-config.ts:121,179-186`), so the picker would still write `models.execution` (U5).                                                                                                                                                                  |
| One start-effort rule for the stored default and for a Thread's choice.        | It changes either what the host fills into `models.execution` (`executionProfile` keeps a catalog default of `none`, `bundles/foundation/core/src/host/models/catalog.ts:142-146`) or what a model chosen in the footer starts at (the picker skips `none` today, `bundles/desktop/settings/src/client/domain/config.ts:1579-1583`); U1–U15 ask for neither. |
| Snapshot and inherit in the store.                                             | The store writes given values and never resolves or defaults (`bundles/runtime/runtime/src/host/store/types.ts:150-156`).                                                                                                                                                                                                                                    |

## Risks

| #   | Risk                                                                                                                                                                                                                                                                                                                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | A provider renamed or removed in Settings leaves Threads on a missing id (`bundles/desktop/settings/src/client/domain/config.ts:1291-1328` moves only `models.execution`); their runs fail.                                                                                                                                                                                                                     | U8 by design: the error names the footer picker; one choice repairs each Thread. Tests T-16, T-30.                                                                                                                                                                                                                                                     |
| R2  | No rollback. The Thread document schema is strict (`bundles/runtime/runtime/src/contracts/storage.ts:78-142`), storage validates every put (`bundles/foundation/core/src/host/storage/facade.ts:237-249`), and updates write the whole document (`bundles/runtime/runtime/src/host/store/threads.ts:489-494`). After a downgrade to `runtime` 2.6.0, every write to a Thread created or changed by 2.7.0 fails. | Accepted, as for `model` and `effort` in `runtime.thread/v1` 1.1.0, added the same way (`docs/architecture/bundles/implementation-decisions.md:1187`). The implementation decision record ([Docs to update](#docs-to-update)) states that `runtime` cannot go back below 2.7.0 once 2.7.0 has written a Thread; the repository keeps no release notes. |
| R3  | A stored effort the model no longer lists is sent as stored, and the provider may reject it.                                                                                                                                                                                                                                                                                                                    | Same as the default's effort today (`bundles/runtime/default/src/host/executor.ts:345-350`). A footer choice writes a valid effort.                                                                                                                                                                                                                    |
| R4  | A workspace agent definition naming a model that the parent's provider does not list makes every spawn as that agent fail under such a parent (U14).                                                                                                                                                                                                                                                            | By design: `thread-spawn`'s error (§6) names the agent and the model, and carries the runtime's message, which names the provider and its models, so the author can change the definition or the parent's model. Built-in agents name no model (`bundles/runtime/default/src/host/agents/*.md` frontmatter).                                           |
| R5  | A model name typed for a provider that lists no models cannot be checked: `checkThreadExecution` accepts any name there, and `models/v1.resolve` builds the provider without reading the model (`bundles/foundation/core/src/host/models/index.ts:103-111`). A typo is stored, and the Thread's first run fails with the provider's own error message.                                                          | Accepted (U15): the first run's `agent.failed` shows the provider's message, and one footer choice repairs the Thread. The picker offers listed models wherever a provider lists any; only a provider without a list takes a typed name.                                                                                                               |
| R6  | `setThreadExecution` validates, then writes; a configuration saved in between, or a concurrent call, is not seen.                                                                                                                                                                                                                                                                                               | The first case leaves a Thread whose runs fail with the §5 message until the next choice; the second ends with the later write; both publish the record each window shows.                                                                                                                                                                             |
| R7  | `setThreadExecution` and the REST field let any window or REST client change any Thread's execution.                                                                                                                                                                                                                                                                                                            | Same trust as `renameThread` and `setThreadCwd` (`bundles/runtime/runtime/src/host/services/threads.ts:96-105`). Input bounded and validated; a provider id is not a secret.                                                                                                                                                                           |
| R8  | A queued backlog on an unavailable Thread fails prompt by prompt.                                                                                                                                                                                                                                                                                                                                               | Each fails before any model request, with the §5 message; after a footer choice the reader resends with `runtime.threads/v1.retry`.                                                                                                                                                                                                                    |
| R9  | `runtime/contracts` must resolve in every window that loads the `settings` client, the settings window included.                                                                                                                                                                                                                                                                                                | The import map serves `layout/contracts` to this bundle today (`bundles/desktop/settings/src/client/index.ts:13`); T-36 opens the settings window with the new import.                                                                                                                                                                                 |

Each creation adds one configuration read (cached after the first load, `bundles/foundation/host-config/src/host/config/service.ts:90-106`); a spawn that names a model or an effort and each `setThreadExecution` add one `models/v1.resolve`, cached per provider (`bundles/foundation/core/src/host/models/index.ts:103-111`) and run outside the Project's lock (D5).

## Phases

Phases 1–3 ship together, in one release (the user's decision, 2026-11-15); the phases are only the order of implementation. Each phase is one commit that leaves every affected project's `typecheck`, `test` and `build` passing; no phase is released alone.

1. **Host (`runtime` 2.7.0, `default` 2.5.0, `threads` 2.0.1), one commit.** §1–§6. Shipping the store, the runner and the executor together keeps runs correct: no commit stores a provider the executor ignores. `thread-spawn` loses its own check in the same commit, so only the runtime's check exists. `setThreadExecution` has no caller until phase 2 (REST). Tests T-1 … T-21 and T-37, and the changed tests and harnesses of phase 1 ([Test plan](#test-plan)).
2. **REST (`transport`).** §7. Adds a caller. Tests T-22 … T-24.
3. **Picker (`settings` 1.6.0).** §8. Adds a caller. Tests T-25 … T-36 and T-38 … T-41.

## Files to change

| File                                                                                                                                                                                                                                                     | Phase | Change                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundles/runtime/runtime/src/contracts/execution.ts` (new)                                                                                                                                                                                               | 1     | §1.                                                                                                                                                                                                                                          |
| `bundles/runtime/runtime/src/contracts/index.ts`                                                                                                                                                                                                         | 1     | Export §1's public names, `ThreadExecutionResult` and its schema.                                                                                                                                                                            |
| `bundles/runtime/runtime/src/contracts/model.ts`                                                                                                                                                                                                         | 1     | `Thread.providerId`, `threadSchema`, comments.                                                                                                                                                                                               |
| `bundles/runtime/runtime/src/contracts/threads.ts`                                                                                                                                                                                                       | 1     | `setThreadExecution`, result type and schema, comments.                                                                                                                                                                                      |
| `bundles/runtime/runtime/src/contracts/rest-errors.ts`                                                                                                                                                                                                   | 1     | `setThreadExecution`, `threadExecutionMessages`.                                                                                                                                                                                             |
| `bundles/runtime/runtime/src/contracts/storage.ts`                                                                                                                                                                                                       | 1     | Document `providerId`.                                                                                                                                                                                                                       |
| `bundles/runtime/runtime/src/contracts/executor.ts`                                                                                                                                                                                                      | 1     | Comments for 1.4.0.                                                                                                                                                                                                                          |
| `bundles/runtime/runtime/src/host/store/threads.ts`, `bundles/runtime/runtime/src/host/store/types.ts`                                                                                                                                                   | 1     | §3.                                                                                                                                                                                                                                          |
| `bundles/runtime/runtime/src/host/domain/execution.ts` (new)                                                                                                                                                                                             | 1     | The validator (§4).                                                                                                                                                                                                                          |
| `bundles/runtime/runtime/src/host/domain/runner.ts`, `bundles/runtime/runtime/src/host/domain/service.ts`, `bundles/runtime/runtime/src/host/domain/types.ts`                                                                                            | 1     | §4.                                                                                                                                                                                                                                          |
| `bundles/runtime/runtime/src/host/services/threads.ts`                                                                                                                                                                                                   | 1     | `setThreadExecution` method.                                                                                                                                                                                                                 |
| `bundles/runtime/runtime/manifest.json`                                                                                                                                                                                                                  | 1     | 2.7.0, contract versions, `executor/v1@^1.4.0`.                                                                                                                                                                                              |
| `bundles/runtime/runtime/tests/contracts/thread-execution.test.ts` (new)                                                                                                                                                                                 | 1     | T-1 … T-3.                                                                                                                                                                                                                                   |
| `bundles/runtime/runtime/tests/domain/thread-agent.test.ts`                                                                                                                                                                                              | 1     | T-4 … T-8; revise `:48-53`, `:95-117`, `:393-447` ([Test plan](#test-plan)).                                                                                                                                                                 |
| `bundles/runtime/runtime/tests/domain/workspace-service.test.ts`                                                                                                                                                                                         | 1     | T-9 … T-13, T-37.                                                                                                                                                                                                                            |
| `bundles/runtime/runtime/tests/store/store.conformance.test.ts`, `bundles/runtime/runtime/tests/runtime-contracts.test.ts`                                                                                                                               | 1     | T-14; the 54 `create` calls (§3); revise `:417-427`, `:1594-1652`, `:1655-1695`.                                                                                                                                                             |
| `bundles/runtime/default/src/host/executor.ts`, `bundles/runtime/default/src/host/compact.ts`, `bundles/runtime/default/manifest.json`                                                                                                                   | 1     | §5; 2.5.0, `executor/v1@1.4.0`.                                                                                                                                                                                                              |
| `bundles/runtime/default/tests/executor.test.ts`, `bundles/runtime/default/tests/executor-compaction.test.ts`                                                                                                                                            | 1     | T-15 … T-20.                                                                                                                                                                                                                                 |
| `bundles/features/threads/src/host/tools/thread-spawn.ts`, `bundles/features/threads/manifest.json`                                                                                                                                                      | 1     | §6.                                                                                                                                                                                                                                          |
| `bundles/features/threads/tests/threads.test.ts`                                                                                                                                                                                                         | 1     | T-21; delete `:336-432` and `resolved` (`:232-235`); revise `:65-82`, `:434-469`.                                                                                                                                                            |
| `bundles/foundation/transport/src/host/routes/threads.ts`, `bundles/foundation/transport/manifest.json`                                                                                                                                                  | 2     | §7.                                                                                                                                                                                                                                          |
| `bundles/foundation/transport/tests/routes.test.ts`, `bundles/foundation/transport/tests/rest-errors.test.ts`                                                                                                                                            | 2     | T-22 … T-24.                                                                                                                                                                                                                                 |
| `bundles/desktop/settings/manifest.json`, `bundles/desktop/settings/package.json`                                                                                                                                                                        | 3     | §8.                                                                                                                                                                                                                                          |
| `bundles/desktop/settings/src/client/index.ts`, `bundles/desktop/settings/src/client/api/settings-api.ts`                                                                                                                                                | 3     | §8.                                                                                                                                                                                                                                          |
| `bundles/desktop/settings/src/client/domain/config.ts`, `bundles/desktop/settings/src/client/queries/keys.ts`                                                                                                                                            | 3     | `withExecution`, `modelThinkingEffort` → `modelStartEffort`, `configSnapshot`.                                                                                                                                                               |
| `bundles/desktop/settings/src/client/hooks/use-config.ts`                                                                                                                                                                                                | 3     | Invalidate `configSnapshot` after a save.                                                                                                                                                                                                    |
| `bundles/desktop/settings/src/client/hooks/use-config-snapshot.ts` (new), `bundles/desktop/settings/src/client/hooks/use-selected-thread.ts` (new)                                                                                                       | 3     | §8.                                                                                                                                                                                                                                          |
| `bundles/desktop/settings/src/client/components/organisms/execution-picker.tsx`                                                                                                                                                                          | 3     | §8.                                                                                                                                                                                                                                          |
| `bundles/desktop/settings/src/client/components/molecules/model-picker.tsx`, `bundles/desktop/settings/src/client/components/molecules/effort-picker.tsx`                                                                                                | 3     | `disabled`, `title`.                                                                                                                                                                                                                         |
| `bundles/desktop/settings/tests/client/execution-picker.test.ts`                                                                                                                                                                                         | 3     | T-25 … T-33, T-39, T-41; revise the tests at `:186-359`.                                                                                                                                                                                     |
| `bundles/desktop/settings/tests/config.test.ts`                                                                                                                                                                                                          | 3     | T-34, T-35; delete the local `withExecution` (`:174-177`) and import the export.                                                                                                                                                             |
| `bundles/desktop/settings/tests/client/settings-window.test.ts`                                                                                                                                                                                          | 3     | T-36.                                                                                                                                                                                                                                        |
| `bundles/runtime/runtime/tests/support/execution.ts` (new)                                                                                                                                                                                               | 1     | `testExecution` (§3).                                                                                                                                                                                                                        |
| `bundles/runtime/runtime/tests/store/attachments.test.ts`, `bundles/runtime/runtime/tests/store/append-cost.test.ts`, `bundles/runtime/runtime/tests/store/storage-persistence.test.ts`, `bundles/runtime/runtime/tests/store/progress.property.test.ts` | 1     | `create` calls (§3).                                                                                                                                                                                                                         |
| `bundles/runtime/runtime/tests/contracts/runtime-services.test.ts`, `bundles/runtime/runtime/tests/domain/workspace-resume.test.ts`, `bundles/runtime/runtime/tests/domain/workspace-restart.test.ts`                                                    | 1     | `create` calls (§3).                                                                                                                                                                                                                         |
| `bundles/runtime/runtime/tests/domain/support/harness.ts`                                                                                                                                                                                                | 1     | `threads.setExecution` in the `WorkspaceService` (`:425-…`).                                                                                                                                                                                 |
| `bundles/runtime/runtime/tests/activation.test.ts`                                                                                                                                                                                                       | 1     | `executor/v1@1.4.0` at `:112,171`.                                                                                                                                                                                                           |
| `bundles/runtime/default/tests/support/harness.ts`                                                                                                                                                                                                       | 1     | `log/v1` fake and `logs`.                                                                                                                                                                                                                    |
| `bundles/features/threads/tests/support/services.ts`                                                                                                                                                                                                     | 1     | Remove the `parent` and `configuration` options, `defaultConfiguration`, and the `host-config/v1` and `models/v1` fakes (`:47-60,64-…,104-140`); only the deleted tests (`bundles/features/threads/tests/threads.test.ts:336-432`) use them. |
| `bundles/features/threads/tests/client/support/window.ts`                                                                                                                                                                                                | 1     | `runtime.threads/v1` 1.7.0 at `:83,97`.                                                                                                                                                                                                      |
| `app/backend/doric-host/tests/bridge-exposure.snapshot.json`                                                                                                                                                                                             | 1     | `setThreadExecution` (§4).                                                                                                                                                                                                                   |
| `bundles/foundation/transport/src/kernel.ts`                                                                                                                                                                                                             | 2     | `transportRequires` (§7).                                                                                                                                                                                                                    |
| `bundles/desktop/settings/tests/client/support/window.ts`                                                                                                                                                                                                | 3     | `runtime.threads/v1` in the host candidate ([Test plan](#test-plan)).                                                                                                                                                                        |
| `bundles/desktop/settings/tests/support/host.ts`                                                                                                                                                                                                         | 3     | `layout.workspace/v1` and `runtime.threads/v1` fakes.                                                                                                                                                                                        |
| `bundles/desktop/settings/tests/workspace-adapter.test.ts` (new)                                                                                                                                                                                         | 3     | T-38.                                                                                                                                                                                                                                        |
| `bundles/desktop/settings/tests/client/dashboard-providers.test.ts`                                                                                                                                                                                      | 3     | T-40.                                                                                                                                                                                                                                        |

## Acceptance criteria

- **AC1.** Choosing a model or an effort in Thread A's footer changes Thread A's record only; Thread B's record and `models.execution` are unchanged (U1, U5).
- **AC2.** A new top-level Thread's record carries `providerId`, `model` and, when the default has one, `effort` equal to `models.execution` at creation (U2).
- **AC3.** A reader-opened sub-thread and a spawned child carry the parent's provider; a spawn that changes only the model carries the new model's start effort (U3, U12).
- **AC4.** A spawn naming a model the parent's provider does not list, or an effort the model does not support, is rejected with the `invalid_execution` messages of [§4](#4-runner-and-service), naming the parent's provider, and creates nothing; when the model came from an agent's definition, `thread-spawn`'s error also names the agent ([§6](#6-thread-spawn-threads)) (U3, U14).
- **AC5.** When the configuration cannot be read, `createThread` and `spawn` reject and create nothing (U11).
- **AC6.** With no Thread selected, the picker shows `models.execution` with disabled triggers and no host write follows any interaction (U4).
- **AC7.** Mounting the picker, focusing the window and selecting Threads never call `host-config/v1.replace`, including with a stored default effort of `none` on a model that offers reasoning (U5).
- **AC8.** After `models.execution` changes, a Thread with a stored execution runs on its own; a legacy Thread runs on the new default (U6, U7).
- **AC9.** The first footer choice on a legacy Thread writes all three fields; until then its record has no `providerId` (U7).
- **AC10.** A Thread whose stored provider is gone, or whose model its provider no longer lists, fails each prompt with the §5 message and no model request, keeps its record, and runs again after a footer choice (U8, U9).
- **AC11.** A run resolves, reads modalities from, and records on `response.started` the Thread's provider; a manual compaction summarizes with the Thread's provider and model.
- **AC12.** `setThreadExecution` and `PATCH /threads/:id` with `providerId`, `model` and an optional `effort` answer the updated record, or, for an unlisted model, an unsupported effort, an unconfigured provider or a provider `models/v1.resolve` refuses, the `restErrors` answer, writing nothing (U10, U13). On a provider that lists no models, any model name is accepted (U15).
- **AC13.** A footer choice made while a prompt runs applies from the next prompt.
- **AC14.** A Thread stored with a typed model name the provider does not know fails its first run with the provider's message, through `agent.failed` (U15).

## Test plan

Load `.agents/skills/behavioral-testing/SKILL.md` before writing these. Each test goes through the public surface named.

**`runtime`**

- T-1 (`bundles/runtime/runtime/tests/contracts/thread-execution.test.ts`). `resolveThreadExecution`: stored and available → `resolved`/`thread`; stored without effort → no effort though the default has one; stored provider missing → `unavailable`/`provider`; model not listed by a provider that lists models → `unavailable`/`model`; provider with `models` absent or `[]` → `resolved`; `providerId` without `model` → `unavailable`/`model`; legacy without values → the default; legacy with `model`/`effort` → default provider with them, unchecked.
- T-2 (same file). `checkThreadExecution`: each issue, empty `reasonings` with an effort, undefined `reasonings`, provider without models.
- T-3 (same file). `modelEfforts`, `modelDefaultEffort` and `modelStartEffort`: catalog default; catalog default `none`; no default; only `none`; no `reasonings`; model not listed; the cases of the settings test they replace (`bundles/desktop/settings/tests/config.test.ts:1326-1388`).
- T-4 (`bundles/runtime/runtime/tests/domain/thread-agent.test.ts`, after the test at `:95-117`). A top-level `createThread` stores `models.execution`'s three values. With a default effort outside `reasoningEfforts` — `host-config/v1` types it as any string (`bundles/foundation/host-config/src/contracts/index.ts:74,140`), and the harness answers what its `configuration` option returns (`bundles/runtime/runtime/tests/domain/support/harness.ts:168,214-215`) — the Thread stores the provider and model and no effort.
- T-5 (same file). A reader-opened sub-thread stores its parent's stored execution, also when unavailable; under a legacy parent, the parent's resolved execution with a `providerId`, and no effort when the parent has none and the default's is outside `reasoningEfforts`. The legacy parent is a document without `providerId` committed through the harness's backend, as `bundles/runtime/runtime/tests/store/store.conformance.test.ts:1600-1633` commits one, and loaded by a host restart over that backend, as `bundles/runtime/runtime/tests/domain/workspace-restart.test.ts:469-…` restarts one.
- T-6 (same file). A spawn without options stores the parent's three values; with model and effort, both; with the parent's model alone, the parent's effort; with another model alone, its start effort; with effort alone, checked against the parent's model.
- T-7 (same file). A spawn with an unlisted model, an unsupported effort, or a model `models/v1` cannot resolve rejects with the §4 rejection (`ContractError` `invalid_execution` with `details.issue`, or the resolve error unchanged), naming the parent's provider, and creates no Thread; a provider whose `models` is `[]` accepts any model.
- T-8 (same file). A configuration read that rejects makes `createThread` and `spawn` reject and create no Thread.
- T-9 (`bundles/runtime/runtime/tests/domain/workspace-service.test.ts`). `setThreadExecution` answers `updated`, publishes a Thread update, and a later `thread(id)` reads the three values.
- T-10 (same file). `setThreadExecution` without `effort` removes a stored effort.
- T-11 (same file). `setThreadExecution` answers `missing` for an unknown id, `invalid` with each reason, and `unresolvable` with the message when `models/v1.resolve` rejects, writing nothing; on a provider that lists no models it answers `updated` for any model name.
- T-12 (same file). `setThreadExecution` on a Thread of an inactive Project updates its record.
- T-13 (same file). A Project mutation queued while `setThreadExecution` or a spawn waits on `models/v1.resolve` is not blocked by it (D5).
- T-14 (`bundles/runtime/runtime/tests/store/store.conformance.test.ts`, next to `:1677`; `bundles/runtime/runtime/tests/runtime-contracts.test.ts`). `create` takes a required execution and writes and reads `providerId` as the record's last key; `setExecution` round-trips; a document without `providerId` reads without it; the method list has `setThreadExecution`.

**`default`**

- T-15 (`bundles/runtime/default/tests/executor.test.ts`). A Thread stored on a second configured provider resolves `ModelsV1.resolve` and `inputModalities` on it, and `response.started` carries its id.
- T-16 (same file). A Thread stored on a missing provider, and one whose model the provider no longer lists, reject the run with the §5 message and `code` `thread_execution_unavailable`, make no provider request, and leave one `warn` entry in the harness's `logs` with the message `Thread execution unavailable` and the fields `threadId`, `providerId`, `model` and `issue`.
- T-17 (same file). A Thread stored with no effort resolves without one though the default names one.
- T-18 (same file). A legacy Thread keeps today's requests; the tests at `bundles/runtime/default/tests/executor.test.ts:276-294` stay green unchanged.
- T-19 (`bundles/runtime/default/tests/executor-compaction.test.ts`). The on-demand compact of a Thread stored on another provider and model summarizes with them, next to the test of a Thread with its own model (`:552`).
- T-20 (same file). The on-demand compact of an unavailable Thread answers `failed` with `summarizer_failed` and calls no model.

**`threads`**

- T-21 (`bundles/features/threads/tests/threads.test.ts`). `thread-spawn` with `model`, `effort` or an agent's values passes them to `spawn`; the harness provides neither `host-config/v1` nor `models/v1`, so a read of either would fail the call. A rejection of `spawn` is the tool's error: `spawnHarness` (`:203-221`) gains a second parameter, `rejection?: unknown`, which `control.spawn` throws after recording the spawn. With an agent whose definition names the model and an `invalid_execution` `model` rejection, the tool's error names the agent and keeps the runtime's message; with the same rejection when the input names the model, the error is the runtime's message alone. The tests at `:336-432` are deleted; T-6 and T-7 cover their cases.

**`transport`**

- T-22 (`bundles/foundation/transport/tests/routes.test.ts`). `PATCH /threads/:id` with `providerId`, `model` and `effort` answers the updated record; with `name` and an execution, both apply. With `name`, `cwd` and an execution that `setThreadExecution` answers `invalid`, the route answers the `restErrors` answer, and a later read shows the new name and working directory and the old execution.
- T-23 (same file). A body with `model` without `providerId`, `effort` alone, or nothing answers 422 `invalid_thread`.
- T-24 (`bundles/foundation/transport/tests/rest-errors.test.ts`). Every `setThreadExecution` outcome answers `restErrors.setThreadExecution` (the file drives every route with every outcome, `bundles/runtime/runtime/src/contracts/rest-errors.ts:23-26`).

**`settings`** (the window harness changes are under [Harness changes](#harness-changes))

- T-25 (`bundles/desktop/settings/tests/client/execution-picker.test.ts`). No Thread selected: the triggers show the default, are disabled and carry the title; clicks make no host call.
- T-26 (same file). A Thread with a stored execution: the triggers show it; choosing another model calls `setThreadExecution` with that provider, model and the model's start effort, and no `replace` reaches the configuration host.
- T-27 (same file). Choosing the shown model calls nothing.
- T-28 (same file). A legacy Thread shows the default; the first choice sends all three values.
- T-29 (same file). With a stored default effort `none` on a reasoning model, mounting, focusing the window and selecting another Thread make no `replace` call (AC7).
- T-30 (same file). A Thread stored on a removed provider shows its stored model; choosing a listed model sends it.
- T-31 (same file). While `setThreadExecution` is pending both triggers are disabled; `invalid` and `unresolvable` answers show their `restErrors` message in the alert span.
- T-32 (same file). A record update through `layout.workspace/v1.subscribe` re-renders the shown execution.
- T-33 (same file). Without a model list, a typed model is sent once on blur and once on Enter, never per keystroke; a blank value or the shown model sends nothing; on a Thread whose stored provider is no longer configured, the typed model is sent on the default's provider.
- T-34 (`bundles/desktop/settings/tests/config.test.ts`). `withExecution` replaces only `models.execution`.
- T-35 (same file). The test of `modelThinkingEffort` (`bundles/desktop/settings/tests/config.test.ts:1326-1388`) is deleted (T-3 runs its cases); the tests that reach `modelEfforts`, `modelDefaultEffort`, `updateModel` and `enableExecutionReasoning` stay green unchanged.
- T-36 (`bundles/desktop/settings/tests/client/settings-window.test.ts`). The settings window opens with the client importing `runtime/contracts`.

**Added in version 6**

- T-37 (`bundles/runtime/runtime/tests/domain/workspace-service.test.ts`). While a prompt runs — the harness's `execute` waits on a deferred — `setThreadExecution` answers `updated`; that run's `thread` keeps the old execution, and the next prompt's run gets the new one (D8, AC13).
- T-38 (`bundles/desktop/settings/tests/workspace-adapter.test.ts`, new, through `settingsOver`, `bundles/desktop/settings/tests/support/host.ts:97-137`). With the workspace unavailable, `workspace.selectedThread()` answers `undefined` and `subscribe` attaches nothing; `setWorkspaceAvailable(true)` calls the listener once, after which `selectedThread()` answers the fake's selection and the fake's notifications reach the listener; `setWorkspaceAvailable(false)` calls the listener once and disposes the inner subscription; after the `Disposable` is disposed, availability changes call nothing. `threads.setExecution(input)` calls `runtime.threads/v1.setThreadExecution` with that input and answers its result.
- T-39 (`bundles/desktop/settings/tests/client/execution-picker.test.ts`). With a footer probe that provides no `layout.workspace/v1`, the picker shows `models.execution` with both triggers disabled and titled, and clicks make no host call.
- T-40 (`bundles/desktop/settings/tests/client/dashboard-providers.test.ts`, next to `:409`). With the picker mounted next to the dashboard's provider page and no Thread selected, a change the provider page saves (a model added to the provider) reaches the picker's list without a window focus, through the `configSnapshot` invalidation.
- T-41 (`bundles/desktop/settings/tests/client/execution-picker.test.ts`). An `updated` answer that arrives before the layout publishes the record: the picker shows the answer's execution, and the layout's older record does not replace it. A write in flight on Thread A while the reader selects Thread B: B's triggers are enabled and show B; A's `invalid` answer shows no alert while B is selected; selecting A again shows it.

### Existing tests that change

- `bundles/runtime/runtime/tests/domain/thread-agent.test.ts`: `assertBare` (`:48-53`) becomes `assertDefaultExecution(thread, what)`: no `agent`, and `providerId`, `model` and `effort` equal to the harness default, `openrouter`, `deepseek/deepseek-v4-flash-0731` and `low` (`bundles/runtime/runtime/tests/domain/support/harness.ts:101-122`). The test at `:95-117` is renamed "a child spawned without options runs and reads with its parent's provider, model and effort and no agent" and asserts it on the run and the public record. In `:393-447`, child `a` keeps `m-1` and `low`; child `b`, spawned with `{ model: 'm-2' }`, has no effort, because the harness provider lists no models (`bundles/runtime/runtime/tests/domain/support/harness.ts:102-112`) and `modelStartEffort` answers `undefined` (U12); both carry `providerId: 'openrouter'`, and the title says the child of a model-only spawn starts at that model's start effort. The other spawn tests (`:120-313`) pass unchanged: a provider without a model list accepts any model and effort (D14), and the harness's `models/v1.resolve` fake (`bundles/runtime/runtime/tests/domain/support/harness.ts:281-303`) answers for `openrouter`.
- `bundles/runtime/runtime/tests/store/store.conformance.test.ts`: the key list at `:417-427` ends `'updatedAt', 'model', 'providerId'` (`testExecution` has no effort, §3). The legacy-document test (`:1594-1652`) is unchanged but for asserting that `providerId` is absent. The test at `:1655-1695` is titled "writes a spawned agent and execution as given and keeps them through a reopen" and also asserts `providerId: 'p-1'`.
- `bundles/runtime/runtime/tests/activation.test.ts:112,171`: the `default` candidate provides `executor/v1@1.4.0`; with `1.0.0`, `runtime`'s new `executor/v1@^1.4.0` puts it in quarantine and `:149` fails.
- `bundles/features/threads/tests/threads.test.ts`: the manifest test (`:65-82`) expects version `2.0.1`; the test at `:434-469` keeps its `spawns` assertion and loses its `resolved(calls)` assertion (`:465-468`); the tests at `:336-432` and the helper `resolved` (`:232-235`) are deleted.

### Harness changes

- `bundles/runtime/runtime/tests/support/execution.ts` (new): `testExecution` (§3).
- `bundles/runtime/runtime/tests/domain/support/harness.ts`: the `WorkspaceService` it builds (`:425-…`) gains, after `setCwd` (`:484`), `setExecution: (id, execution) => threadsApi.setThreadExecution({ id, ...execution })`; `WorkspaceService.threads` gains `setExecution` (§4), so without it the harness does not typecheck.
- `bundles/runtime/default/tests/support/harness.ts`: the services (`:494-…`) gain a `log/v1` fake defined with `logMethods`, as the runtime harness defines one (`bundles/runtime/runtime/tests/domain/support/harness.ts:245-255,306-311`), that pushes `{ level, message, fields }` to a `logs` array; the harness returns `logs` next to `resolved` and `calls` (`:601-…`). The default executor reads `log/v1` only on an unavailable execution, so other tests are unaffected.
- `bundles/features/threads/tests/support/services.ts`: the `parent` and `configuration` options, `defaultConfiguration` and the `host-config/v1` and `models/v1` fakes are removed (Files to change).
- `bundles/features/threads/tests/client/support/window.ts:83,97`: the host candidate provides `runtime.threads/v1` at `1.7.0`; at `1.6.0` the `threads` bundle, which now requires `^1.7.0`, is quarantined.
- `bundles/desktop/settings/tests/client/support/window.ts`: today the host candidate lacks `runtime.threads/v1` (`:69-109`), so a `settings` bundle that requires it is quarantined in every client test, and a probe declares only client contracts (`:341-352`). `hostContracts` (`:47-55`) gains `'runtime.threads/v1': { setThreadExecution: null }`; `hostContractVersions` (`:58-63`) gains `'runtime.threads/v1': '1.7.0'`; `hostCandidateWithout` adds `runtime.threads/v1@1.7.0` to `provides` and `runtime.threads/v1` to the descriptor's list; `hostRemote` gives it `bundleId: 'host'`, as `host-config/v1` has (`:163`). A test that makes a choice answers `'runtime.threads/v1.setThreadExecution'` in `host`; an unanswered call answers `undefined` (`:405-407`).
- `bundles/desktop/settings/tests/client/execution-picker.test.ts`: `footerProbe` (`:125-138`) provides `layout.workspace/v1@1.1.0` through `context.services.provide(defineService(LayoutWorkspaceV1, …))`, as `bundles/desktop/settings/tests/client/dashboard-providers.test.ts:206-215` provides `layout.dashboard/v1`, with a selection the test sets and listeners it notifies; T-39 uses a probe without it.
- `bundles/desktop/settings/tests/support/host.ts`: `FakeHost` gains `selectedThread?` and `setThreadExecution?`, and `settingsOver` (`:97-137`) provides `layout.workspace/v1` (`layoutWorkspaceMethods`) and `runtime.threads/v1` (`runtimeThreadsMethods`) fakes from them.

### Validation

Validation per phase: `npx nx run-many -t typecheck,test,build -p <touched projects>`, then `npm run format:check` and `npm run lint`.

## Docs to update

- `docs/features/per-thread-model.md` (new feature doc, status `implemented` after phase 3): the problem, U1–U15, the resolution rule, `setThreadExecution` and the REST field, the failure of an unavailable execution, the picker's states, and an evolution entry linking this spec.
- `GROUNDING.md:597-604, 631-642`: the execution model is chosen per Thread in the conversation footer and defaults from Settings; `:2142-2147`: `models.execution` is the default new Threads store; `:680`: `PATCH /threads/:id` also sets the execution. The sections that describe Thread records gain `providerId` (AGENTS.md: runtime behavior and session persistence changes update `GROUNDING.md`).
- `app/backend/doric-host/README.md:332` (route table: "Rename a Thread, move its working directory, or set its provider, model and effort.") and `:520` (the `PATCH /threads/:id` notes: the execution fields, their pairing rule and the `invalid_execution` answers).
- `docs/architecture/bundles/implementation-decisions.md`: a new dated record, in Portuguese like its neighbours, "Execução por thread (2026-11-15)", covering D1–D10, the versions and R2 (no downgrade below `runtime` 2.7.0); the records at `:1186-1188` (inheritance: the provider is inherited too, the runtime validates, a model-only spawn takes the start effort) and `:1262-1265` (`thread-spawn`: validation moved to the runtime, `models/v1` and `host-config/v1` dropped) gain a line pointing to it.
- `docs/features/ui-redesign.md`: the conversation footer's execution picker (`:202`) edits the selected Thread's execution; an evolution entry.
- `bundles/features/threads/README.md:33-42` (the `thread-spawn` item: the child runs on its parent's provider; the runtime, not the tool, checks a model or effort and rejects with `invalid_execution`; an agent-definition model the provider does not list names the agent) and `:57-60` (the bundle requires `runtime.threads/v1@^1.7.0` and no longer `models/v1` or `host-config/v1`).
- `bundles/desktop/settings/README.md:17-18`: `<settings-execution-picker>` edits the selected Thread's provider, model and effort and shows the default read-only with no Thread; the bundle requires `runtime.threads/v1` and reads `layout.workspace/v1` optionally.

## Questions

None. The user answered version 3's Q1 (agent models on another provider, now U14 and D13) and Q2 (typed model names, now U15 and D14).

## Revisions

Review findings are named by the review that raised them (Scope, Critique, Comprehension, Structural, Style) and their number in it.

- Version 1 (2026-11-15): first version.
- Version 2 (2026-11-15): the user's answers to version 1's four questions and the Scope review. No fallback for an unavailable stored execution (U8, U9); no `provider` input on `thread-spawn` (U3); REST `PATCH /threads/:id` sets the execution (U10). Spawn validation moved from `thread-spawn` to the runtime (Scope M1, M2); the settings copy of the rule replaced by imports from `runtime/contracts` (Scope M3); helpers no longer exported, picker warning UI, selected-thread memo and `written` state removed, code bodies replaced by interfaces (Scope N1–N4).
- Version 3 (2026-11-15): the user's answers U11–U13 and the stage-2 reviews.
  - U11: creation fails when the configuration cannot be read; the legacy-shape fallback is removed (D6).
  - U12: a model-only spawn takes the new model's start effort; `modelStartEffort` moves from the settings client to `runtime/contracts` (§1, §4).
  - U13: `setThreadExecution` also calls `models/v1.resolve`; new outcome `unresolvable` (§2, §4).
  - Critique 1: phases 1–3 of version 2 merge into one host commit, so no commit stores a provider the executor ignores and only one spawn check exists.
  - Critique 2: R2 names the missing rollback and accepts it with its precedent.
  - Critique 3: R4 and Q1.
  - Critique 7: the configuration read and `models/v1.resolve` move before the Project's lock (D5, T-13).
  - Critique nits: R6 states the check-then-write race; the `versioning.md:55` citation is removed and the spawn rejection is described as a plain `Error`.
  - Comprehension: platform terms defined and linked; Legacy Thread, Resolved execution, start effort, reader, reader-opened sub-thread, `ModelExecution`, the alert span, loose object, probe bundle and the compaction test defined or replaced.
  - Structural: test files added to Files to change; REST docs located (`app/backend/doric-host/README.md`, `GROUNDING.md:680`); the feature doc is named without a link; partial code blocks name their interface; Goals and Non-goals precede Requirements.
  - Style: every path written in full; the false "the two checks agree" claim removed with the phase merge; the other wording nits applied.
- Version 4 (2026-11-15): the user's answers to version 3's two questions.
  - Q1 → U14, D13: a spawn as an agent whose model the parent's provider does not list fails with a new agent message naming the agent, the model and the provider; no provider field on agents and no inference (§4, AC4, T-7). R4 states the behavior as intended.
  - Q2 → U15, D14: on a provider without a model list, a typed name is accepted as is and a typo surfaces on the first run with the provider's message; no live catalog check (AC12, AC14, T-11). R5 states it as accepted.
  - Questions emptied.
- Version 5 (2026-11-15): the stage-3 Scope review. User decisions U1–U15 unchanged.
  - M1: the runtime keeps one model message naming the parent's provider and rejects with `ContractError('invalid_execution', …, { issue })`; `thread-spawn` adds the agent's name only when the model came from the agent's definition (§4, §6, D13, AC4, T-7, T-21).
  - M2: the validator lives in a new runtime module (`createExecutionValidator`), built by the service, which owns the ports, and handed to the runner's `spawn` through two `RunnerContext` members with their signatures (§4).
  - N1: only a spawn and `setThreadExecution` work outside the lock; `createThread` computes its execution inside it; the spawn's single parent read is stated (D5, §4).
  - N2: no `resolveModel` port; the validator uses `RuntimePorts.catalogSource` (§4).
  - N3: `modelEfforts`, `modelDefaultEffort` and `modelStartEffort` live once, in `runtime/contracts`; the settings client deletes its copies and `modelThinkingEffort`, and re-exports the first two (§1, §8, T-3, T-35).
  - N4: `ThreadStore.create` takes a required execution (§3, T-14).
  - N5: the validator answers `ExecutionRefusal` (`invalid` with an issue, or `unresolvable` with the raw error and its message), which `spawn` turns into its rejection and `setThreadExecution` into `invalid` or `unresolvable` (§4).
- Version 6 (2026-11-15): the stage-4 Readiness and Codebase reviews, and the user's decision that phases 1–3 ship in one release. User decisions U1–U15 unchanged.
  - Phases: one release; each phase still leaves typecheck, tests and build passing; "can ship alone" removed; phase 1's first caller is phase 2 (REST).
  - Readiness M1 / Codebase M1: `ThreadStore.create` takes the execution third and the agent last (§3), with every test caller listed and a shared `testExecution`.
  - Readiness M2 / Codebase M5, Readiness M3, Codebase M6, M7: the runtime activation test, both client test windows, the bridge-exposure snapshot and `transportRequires` are in §3, §4, §7, Files to change and [Harness changes](#harness-changes).
  - Readiness M4: the warning goes through `LogV1.warn`; the `default` harness gains a `log/v1` fake and `logs` (§5, T-16).
  - Readiness M6: T-37 covers D8 / AC13.
  - Readiness M7: the workspace adapter re-attaches its subscriptions when `layout.workspace/v1` comes or goes (§8, T-38, T-39).
  - Codebase M2, M3, M4: the domain harness's `WorkspaceService`, the thread-agent, store-conformance and `thread-spawn` tests that the change contradicts, and `providerId`'s key position ([Existing tests that change](#existing-tests-that-change), §3).
  - Codebase M8: core's `executionProfile` and `modelStartEffort` differ on a catalog default of `none`; both stay, each authoritative for its own case (§1, D2, Alternatives).
  - Codebase M10: `withExecution` keeps its name; the settings test's local helper of the same meaning is deleted in favor of the export (§8).
  - Codebase M11: the `threads` README is in Docs to update.
  - Nits: line references corrected; `executionConfiguration` unwraps `DoricConfiguration`; `compactThread` takes `ExecutorCompactionInput` and passes its configuration to `summarizerFor`; the `RuntimeThreadControls.spawn` comment rewritten; the stale import-map comment in `settings-api.ts` rewritten; the contracts index re-exports `execution.ts` by name; `threadExecutionMessages` and the `invalid` schema typed; spawn check order stated; picker state for answers that precede the layout's record and for writes in flight across selections; R2 no longer names a release note; T-22, T-4, T-5, T-29, T-33, T-40, T-41 cover the listed gaps.
