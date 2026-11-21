# core

Apply these rules to `bundles/foundation/core/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to providing the default implementation of the basic
contracts of `bundle/contracts`, and the `core.*` contracts that
implementation needs, the same for every bundle that calls them. Do not add to
it a tool, a skill, a route, a drawing other than its four structural
elements, a settings space, an event type or sink, a stream, a credential kind
or a model kind: each belongs to the bundle whose feature it is, which
registers it through the core's contracts. Do not name in it another bundle, a
contract of another bundle, or another bundle's stream, scope key, settings id
or route: the core serves whichever bundle calls it.

## Rules

- Read [`README.md`](README.md) for what the core does, and the full shape of
  each contract it provides, before changing or adding to it; read
  [Hooks and the app's lifecycle](../../../docs/architecture/bundles/hooks.md)
  before changing `hooks/v1`, and
  [Native menus and keybindings](../../../docs/architecture/bundles/menus-and-keybindings.md)
  before changing `menus/v1`.
- Change the shape of a basic contract (an id without a `core.` prefix) only in
  its file under `packages/bundle/src/contracts/basic/`, then implement the
  change here; never declare a basic contract's types in `src/`.
- Declare a contract the core itself owns (a `core.*` id: a hooks contract, a
  command, a bridge service or a storage type) in `src/contracts/`, export it
  from `src/contracts/index.ts`, and add it to `provides` of
  [`manifest.json`](manifest.json).
- Raise the `provides` version of a contract in
  [`manifest.json`](manifest.json) in the change that implements a new minor of
  it, and update the versions that `tests/manifest.test.ts` pins in the same
  change.
- Provide a method that a basic contract lists as `optional` only when the
  app's method specification has it, as `createNavigation` does for
  `forward` and `history`, so that the core runs on an app with an earlier
  minor of the contract.
- Reach a provider bundle (a storage or secrets backend, a model provider)
  only through its basic contract, with `services.use` or
  `services.whenAvailable`, never by importing it.
- List under `requires` of [`manifest.json`](manifest.json) only a contract
  that the composition's `providers` gives to a foundation bundle, such as
  `storage.backend/v1` and `secrets.backend/v1`. An entry that no enabled
  bundle provides in any environment puts the environment into recovery mode;
  so does an entry whose active provider in that environment is not a
  foundation bundle or has a version outside the range; an entry provided only
  in another environment does not. Read
  [What the core may require](../../../docs/architecture/bundles/core.md#what-the-core-may-require)
  before changing the core's `requires`.
- Leave the other basic contracts the core uses unlisted: the runtime and the
  boundary test let the core use a basic contract it imports as a symbol from
  `bundle/contracts`. Never write a basic contract id as a string literal in
  `src/`: the boundary test still counts a literal as a use the manifest must
  declare; use the reference (`ToolsV1`, `SettingsV1`, …) or its `.id`.
- Put each part's code in its folder: a host provider in `src/host/` (a
  folder per contract that needs more than one file, such as
  `src/host/storage/` or `src/host/models/`), a main process provider in
  `src/desktop/`, and a window provider or element in `src/client/`
  (elements in `src/client/elements/`).
- Keep `src/host/models/catalog.ts` free of Node built-ins and of imports
  other than types from `bundle/contracts`: `src/contracts/index.ts`
  re-exports its catalog fill, and a window loads `core/contracts` through
  its import map.
- Put code that more than one part runs in `src/shared/`, and keep it free of
  Node and DOM APIs: the client part imports `hooks.ts`, `log.ts` and
  `issues.ts` from it.
- Keep every host registry partitioned by generation through
  `src/shared/partition.ts`: register with `collidesIn`, read with `seenBy`,
  so that two generations of one bundle never collide.
- Check a definition's owner with `assertDefinitionOwner` of
  `src/shared/state.ts` (namespace, then `provides`), and let the principal
  `doric` pass every ownership check.
- Keep activation free of I/O: read the catalog, the backends and the
  credentials on the first call that needs them, cache the pending read, and
  drop a failed one so the next call retries it.
- Use another provider of a contract the core provides only through
  `services.use`, never through the core's own instance, so that a provider
  the composition chooses instead is the one the core uses.
- Run every write that touches settings or credentials in the write queue of
  `src/shared/state.ts` (`state.writes.run`).
- Refuse with a `ContractError` and a code, and build every `invalid_input`
  message of a schema failure with `describeIssues` of `src/shared/issues.ts`.
- Report a failure that must not fail the caller (a handler, a listener, a log
  write) to `doric.diagnostics/v1`, and never let the report itself throw.
- Never log a secret and never put one in an error; redact log fields and
  event bodies with `src/shared/redact.ts` and the list of
  `secrets/v1.redactions()`.
- Add the tests of a host contract as `tests/<contract>.test.ts`, booting a host
  with the memory backends through `tests/support/host.ts`; of the main process
  part in `tests/desktop/`, through `tests/support/desktop.ts`; and of the
  client part in `tests/client/`, through `tests/client/support/window.ts`.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "core"`.
- Update [`README.md`](README.md) in every change to a contract the core
  provides, its behavior, its limits or its errors, and update the feature doc
  the change belongs to in the same change:
  [credentials](../../../docs/features/credentials.md) for `secrets/v1` and
  for the redaction of `log/v1` and `events/v1`;
  [settings](../../../docs/features/settings.md) for `settings/v1` and
  `core.open-settings/v1`;
  [default agent](../../../docs/features/default-agent.md) for how `hooks/v1`
  runs `transform` handlers;
  [UI redesign](../../../docs/features/ui-redesign.md) for the Back and
  Forward history of `navigation/v1`.

## Verify

- `npx nx run bundle-core:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-core:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the core
  and the bundles its tests load first, because the tests read them from
  `dist/`.
- `npx nx run bundle-core:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
