# Feature: per-thread model

- Status: `implemented`
- Brief: none
- Specs: [docs/designs/per-thread-model.md](../designs/per-thread-model.md)
- Decisions: [Execução por thread (2026-11-15)](../architecture/bundles/implementation-decisions.md#execução-por-thread-2026-11-15)

## Problem

The execution provider, model and effort were one workspace setting: changing the model in a conversation's footer changed it for every Thread, and a child spawned with a model was checked against the configured provider rather than its parent's.

## Decisions

- Each Thread stores its own `providerId`, `model` and `effort`; the workspace default (`models.execution`) is only what a new top-level Thread copies at creation.
- A child inherits its parent's execution; a spawn may override `model` and `effort`, always on the parent's provider. A model-only override naming another model takes that model's start effort; one naming the parent's own model keeps the parent's effort.
- A Thread stored without `providerId` (created before `runtime` 2.7.0) runs on the workspace default's provider, with its own stored `model` and `effort` over the default's when set, until its execution is first changed. No migration.
- The runtime validates every execution, at spawn and through `setThreadExecution`: first against the configuration (the provider must be configured; a provider that lists models accepts only those, one that lists none accepts any), then through `models/v1.resolve`. Validation and `models/v1.resolve` run outside the Project lock; only the write runs inside it. The `thread-spawn` tool no longer reads configuration or models.
- Creating a Thread fails, creating nothing, when the configuration cannot be read.
- A change applies from the Thread's next run; a running prompt keeps the execution it started with.
- The footer picker edits only the selected Thread and never writes `models.execution`; the default changes only in Settings.
- No rollback below `runtime` 2.7.0 once a Thread stores `providerId` (accepted risk, R2 in the spec).

## Current behavior and contracts

- `runtime.threads/v1` 1.7.0 `setThreadExecution({ id, providerId, model, effort? })` answers `updated` (with the Thread), `missing`, `invalid` (with the reason) or `unresolvable` (with the message); it rejects only when the configuration cannot be read.
- `createThread` and `POST /threads` fail, creating nothing, when the configuration cannot be read.
- `PATCH /threads/:id` accepts `providerId` and `model` together, and `effort` only with them; a mispaired body answers `422 invalid_thread`. A refused execution answers `422 invalid_execution` with `The provider is not configured.`, `The model is not available on this provider.` or `This model does not support that effort.`; an unresolvable one carries `models/v1`'s message. The name and working directory are applied before the execution and kept when it is refused.
- A spawn whose execution is refused fails before any child is created with a `ContractError` `invalid_execution` (`details.issue`: `provider`, `model` or `effort`) whose message the runner writes, naming the value and the provider's models or the model's efforts; an unresolvable provider rejects with `models/v1`'s own error. When the model comes from an agent definition, `thread-spawn` answers `Agent "<name>" names model "<model>", which its parent thread's provider does not list.` followed by the runner's message.
- A change made while a prompt runs applies from the next run; the running prompt keeps its execution.
- A Thread whose stored provider or model is no longer available fails each run, before any model request, with code `thread_execution_unavailable` and the message `The model "<model>" on provider "<provider>" is not available for this thread. Choose another model in the conversation footer.`, after one `LogV1` warning. Its manual compaction fails as `summarizer_failed`.
- `<chat-execution-picker>` (`chat` 1.9.0; `<settings-execution-picker>` of `settings` 1.6.0 to 1.10.0) shows and edits the selected Thread's execution through `setThreadExecution`. With no Thread selected it shows the workspace default read-only, titled `New threads start on the workspace default. Change it in Settings.` A typed model commits on blur or Enter; a refused write shows its reason in an announced inline `ErrorNotice` with Retry. Since bundle isolation step 6(c) the chat draws it from `settings.models/v1`, only while that contract is available, and without `workspace.selection/v1` it shows the default, locked.
- Versions: `runtime` 2.7.0 (`runtime.threads/v1` 1.7.0, `runtime.thread/v1` 1.1.0 → 1.2.0, requires `executor/v1@^1.4.0` because an older executor would ignore the Thread's provider), `default` 2.5.0 (`executor/v1` 1.4.0), `threads` 2.0.1 (requires `runtime.threads/v1@^1.7.0`), `transport` requires `runtime.threads/v1@^1.7.0`, `settings` 1.6.0.

## Evolution

- 2026-11-15: implemented ([spec](../designs/per-thread-model.md)). Execution stored per Thread, `setThreadExecution` and the `PATCH /threads/:id` execution fields, runtime-side spawn validation, the footer picker edits the selected Thread only.
- 2026-11-18: bundle isolation, step 6(c) ([feature](bundle-isolation.md), [spec](../designs/bundle-isolation.md)). The footer picker moves from `settings` to `chat` 1.9.0 as `chat-execution-picker`, same item id, order and behavior; `settings` 1.11.0 tells it what to offer through `settings.models/v1` and no longer requires `runtime.threads/v1`.
