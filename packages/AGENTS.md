# Packages Instructions

These instructions apply to workflow packages under `packages/`.

# Rules

- Only packages can be written in this folder.
- Tools should be written under `tools/` folder.
- A package holds a generic primitive or a platform responsibility. A concept a
  bundle owns (Project, Thread, prompt, Git, settings, credential semantics, a
  feature's UI) belongs in `bundles/`. The platform packages (`bundle`,
  `storage`, `desktop`) import no bundle's
  `contracts` entrypoint and no bundle source.
- `packages/host` no longer exists: the `Host` facade types live in
  `bundles/runtime/runtime/src/contracts/tool-host`.

# Reuse before reimplementing

Shared behavior belongs to one package and reaches consumers through that
package's public entrypoint. Check these before writing a second version:

- `tool`: JSON predicates — `isRecord`, `isJsonValue`, `asJsonObject`.
- `sandbox`: shell quoting (`quote`) and process plumbing
  (`captureProcessOutput`, `processTerminationScript`).
- `llms`: the reasoning-effort vocabulary — `reasoningEfforts`,
  `ReasoningEffort`, `isReasoningEffort`.
- `bundle`: the call-scope bounds — `callScopeSchema`, `scopeKeyPattern`,
  `SCOPE_MAX_KEYS`, `SCOPE_MAX_VALUE`; a contract that carries a scope uses
  them rather than its own limits.

# Tolerated duplication

These are the exceptions, kept on purpose, to revisit only under the stated
condition:

- `config` keeps its own `isRecord`, and `oauth` its own `asRecord`,
  `stringField` and `numberField`: neither depends on `tool`, so sharing would
  be an architectural change rather than a cleanup.
- `llms` and `oauth` each own a `createFetchTransport`. They are nearly
  identical and about fifteen lines, but `oauth` depends on nothing beyond
  `tslib`, so sharing would cost a new package or a cross-package dependency.
  Extract only when a third consumer appears.
- `excerpt` (`tool`, 300 characters, `...`) and `diagnosticExcerpt` (`llms`
  2048, `oauth` 500, both `...[truncated]`) differ in limit and marker.
- `packages/config` and the apps mirror the host's `reasoningEffort` union and
  its credential kinds rather than importing them: the main process and the
  renderer depend on no workspace package, and the IPC boundary stays
  deliberately independent.
