# runtime

Apply these rules to `bundles/runtime/runtime/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the Project and Thread model: storing Projects and Threads,
queueing their prompts and running them through `executor/v1`, leasing each
Project's sandbox through `sandbox/v1`, delegation between Threads, archive,
recovery and generation handover, and the window's records mirror of Projects
and Threads. Its only work on files and Git is this: the working-directory
checks and the repository-hint probe (`.git` marker and `origin`) it runs in
the sandbox, the Git credentials it writes into the sandbox, and the
`exec`, `readFile`, `readFileBytes` and `writeFile` that `runtime.lease/v1`
passes through to the leased sandbox. Add to it no other file or Git work, no
tool, no drawing, no model call, and no read of resources or terminals: a
feature that works on a Project's sandbox or a Thread's directory belongs to
the bundle that owns that feature, which reaches the runtime through its
contracts and hooks.

## Rules

- Read [`README.md`](README.md) for what the bundle does, its contracts and its
  data before you change it.
- Never support running an older runtime against data a newer one wrote, and
  never add code that serves one: the document schemas of
  [`src/contracts/storage.ts`](src/contracts/storage.ts) are strict and
  `storage/v1` validates every write
  ([`facade.ts`](../../foundation/core/src/host/storage/facade.ts));
  `src/host/store/` writes each change to a Project or Thread document over
  the stored document, so a field a newer runtime writes there makes every
  write of an older one to that document fail; it writes each history
  document whole, so an older one drops the field; and `read` of
  [`src/host/store/attachments.ts`](src/host/store/attachments.ts) parses each
  attachment document, so an older one answers it as missing.
- Add a field to a document schema of `src/contracts/storage.ts` only as an
  optional field, because stored documents lack it: the next write of a stored
  Project or Thread document is validated without it, and `read` of
  `src/host/store/attachments.ts` answers as missing an attachment document
  the schema rejects. Handle its absence wherever `src/host/store/` reads it,
  as `toThread` of [`src/host/store/threads.ts`](src/host/store/threads.ts)
  does, and raise the minor of that storage type's `provides` entry and of
  the `version` of [`manifest.json`](manifest.json) in the same change.
- Put a new method in the contract of its subject: `runtime/v2`
  ([`src/contracts/runtime.ts`](src/contracts/runtime.ts)) for Projects,
  recovery and notices, `runtime.threads/v1`
  ([`src/contracts/threads.ts`](src/contracts/threads.ts)) for Threads, their
  queue and their prompt controls, and `runtime.workspace/v1`
  ([`src/contracts/workspace.ts`](src/contracts/workspace.ts)) for a Thread's
  working directory.
- Declare each contract method in its file of `src/contracts/` with its input
  and output schemas in that file's `*Methods` object, and serve it in the
  handler file of [`src/host/rpc/`](src/host/rpc/) named for the contract
  (`runtime.ts` for `runtime/v2`; `threads.ts`, `workspace.ts`, `lease.ts`,
  `usage.ts`, `attachments.ts` and `session.ts` for the others), over the
  domain of [`src/host/core.ts`](src/host/core.ts). Serve a new service in
  [`src/host/main.ts`](src/host/main.ts) over its implementation in
  [`src/host/service.ts`](src/host/service.ts). The envelope services of
  `src/host/services/` (`runtime`, `threads`, `workspace`, `lease`,
  `attachments`), `handover.ts`' `installHandover`, `lifecycle.ts`'
  `installStartStop` and `ports.ts`' `createPorts` have only test importers:
  they are the envelope provision of the domain harness
  (`tests/domain/support/provide-runtime.ts`) until phase 6 deletes the
  envelope; add no production behavior there.
- Add `expose: 'desktop'` only to a method a window calls. When a window calls
  a new contract with a Project, Thread or prompt in scope, add its id with
  those keys (`projectId`, `threadId`, `promptId`) to `desktopScope` of
  [`manifest.json`](manifest.json): the platform refuses every scope key a
  contract has no `desktopScope` entry for
  ([`manifest.ts`](../../../packages/bundle/src/runtime/manifest.ts)).
- Provide no other contract this bundle declares in `src/host/rpc/`:
  - `runtime.records/v1` is provided by the client part, through
    `runtimeRecordsService` of
    [`src/contracts/records.ts`](src/contracts/records.ts) over
    [`src/client/records.ts`](src/client/records.ts); declare a records method
    in `runtimeRecordsMethods` of that file.
  - Two further exceptions: `executor/v1` and `sandbox/v1` are declared in
    [`src/contracts/executor.ts`](src/contracts/executor.ts) and
    [`src/contracts/sandbox.ts`](src/contracts/sandbox.ts) and provided by
    other bundles (the executor bundle and the sandbox bundles): change their
    schemas there, never provide them in `src/host/rpc/`, call them only
    through [`src/host/routed-executor.ts`](src/host/routed-executor.ts) and
    [`src/host/routed-sandbox.ts`](src/host/routed-sandbox.ts), and when you add a
    member, raise the minor of each provider's `provides` entry and raise this
    bundle's `requires` range to that minor.
- Answer every expected outcome of a host method as a value of its result
  union, and reject only for a broken call, a closed binding or a failure; when
  you add an outcome that a transport route answers, add its REST error to
  `restErrors` in [`src/contracts/rest-errors.ts`](src/contracts/rest-errors.ts).
- Resolve a prompt-scoped method only through `bindings.bound(call)` of
  [`src/host/domain/bindings.ts`](src/host/domain/bindings.ts), so that it acts
  only for the prompt its scope names and only while that prompt runs; never
  widen the scope from a value the model or the caller supplies.
- Keep `src/host/rpc/` a mapping of RPCs to the domain: put the logic of a
  watch stream (subscribe, buffer, deduplicate, replay) in
  [`src/host/services/watches.ts`](src/host/services/watches.ts), which
  `core.ts` builds, and the resolution of the Project a lease call's scope
  names in [`src/host/rpc/lease.ts`](src/host/rpc/lease.ts). Keep other
  behavior in `src/host/domain/`, keep every read and write of `storage/v1` in
  `src/host/store/`, and read `context.services` for the domain only in
  [`src/host/routed.ts`](src/host/routed.ts).
- Observe a hook of another bundle by registering its handler with
  `hooks.register` in `activate` of [`src/host/service.ts`](src/host/service.ts),
  as the `onEventAppendedHook` handler is registered over the generated input
  schema of `core.event-hooks/v1`.
- Take the Project lock (`exclusive(projectId, …)`, defined in
  `createWorkspaceService` of
  [`src/host/domain/service.ts`](src/host/domain/service.ts) and passed to the
  runner) only for queue and state mutations; never hold it across
  `executor.run`, an awaited hook or a sandbox command, and fire the awaited
  hooks of `runtime.hooks/v1` outside it. The only two exceptions: `setCwd` of
  [`src/host/domain/runner.ts`](src/host/domain/runner.ts) runs its path checks
  and hint probe under the lock, and `withThread` with `exclusive: true` runs
  the caller's task under it.
- Create or resume a Project's runtime only under `exclusive('creation', …)`,
  and take it, when needed, inside the Project lock, never the reverse.
- Commit before you publish: append an event or write a document first, then
  call the publisher. Route every executor event and history write of a run
  through the `PromptSession` of
  [`src/host/domain/session.ts`](src/host/domain/session.ts).
- Add a durable Thread event type in these steps:
  - Write an event the executor emits through `record` of its `PromptSession`.
  - Write a prompt-lifecycle, queue or state event through `publish` (or
    `store.appendEvent` followed by `publisher.event`) of
    [`src/host/domain/runner.ts`](src/host/domain/runner.ts). Write it under
    the Project lock when it goes with a queue or state mutation, as
    `prompt.started` and `queue.updated` do. Write it outside the lock when it
    follows the executor's settlement, as `prompt.paused` and `agent.cancelled`
    do.
  - Add the type to `progressTypes` of
    [`src/host/store/progress.ts`](src/host/store/progress.ts) only when it
    changes `pending`, and fold it there.
  - Never rename a stored type and never rewrite a stored event. Give a type
    that other bundles read through `events/v1` a qualified alias in
    [`src/contracts/events.ts`](src/contracts/events.ts), registered in
    `activate`, as `runtime.prompt-finished/v1` is for `prompt.finished`.
- Redact every text the runtime stores or delivers with the list of
  [`src/host/domain/redactor.ts`](src/host/domain/redactor.ts): `current()`,
  or `latest()` in a synchronous stream. Pass every secret the runtime writes
  into a sandbox to `register(secret)`.
- Never put a Thread's agent instructions in the public `Thread`, an event or a
  log line: they live only in the Thread document and reach only the executor.
- Never let a hook handler, a credential write, a sandbox discard, a notice
  listener or a repository-hint probe fail the operation that triggered it:
  catch its failure and continue. Log the failure of a credential write, a
  sandbox discard or a notice listener, as
  [`git-credentials.ts`](src/host/domain/git-credentials.ts),
  `service.ts` and [`notices.ts`](src/host/domain/notices.ts) do; fire a hook
  of `runtime.hooks/v1` through `routedRuntimeHooks` of `src/host/routed.ts`, which catches its
  rejection without a log. The only exception: in `setCwd`, a sandbox command
  that throws (the hint probe included) rejects the move, while a probe that
  does not finish stores no hint.
- Keep the rules other bundles share — `src/contracts/execution.ts`,
  `fences.ts`, `deltas.ts` and
  [`src/contracts/attachments.ts`](src/contracts/attachments.ts) — pure,
  browser-safe and free of I/O.
- Keep the client part's reads synchronous and answered from memory, and put
  the host's answer into the mirror before a write resolves. Place a client
  change by layer: a host call in [`src/client/api/`](src/client/api/)
  (`workspace-api.ts`, `project-watch.ts` or `thread-views.ts`, over the
  contract subsets of `host.ts`), a pure mirror update in
  [`src/client/domain/tree.ts`](src/client/domain/tree.ts), the mirror's state
  in [`src/client/stores/records.ts`](src/client/stores/records.ts), a Project
  subscription in [`src/client/follow.ts`](src/client/follow.ts), and their
  composition into `runtime.records/v1` in
  [`src/client/records.ts`](src/client/records.ts).
- Change `createRecordsApi` of [`src/testing.ts`](src/testing.ts) in the same
  change as any change to `runtime.records/v1`.
- Put a new host feature's contract in `src/contracts/`, its methods in
  `src/host/rpc/`, its Project and Thread guards in
  `src/host/domain/service.ts`, its queue and run behavior in
  `src/host/domain/runner.ts` or a new file of `src/host/domain/`, and its
  storage in `src/host/store/`. Wire a new storage type and a new store:
  - add the type to `runtimeStorageTypes` of
    [`src/host/store/index.ts`](src/host/store/index.ts), which `activate`
    defines on `storage/v1`;
  - build the store in `createRuntimeStores` of that file and add it to
    `RuntimeStores`, which `runtimeStores` of `src/host/core.ts` builds.
- Let another bundle react to the runtime only through a hook of
  `runtime.hooks/v1` in [`src/contracts/hooks.ts`](src/contracts/hooks.ts) or a
  notice, and let it work on a Project's sandbox or a Thread's directory only
  through `runtime.lease/v1` ([`src/contracts/lease.ts`](src/contracts/lease.ts):
  `describe`, `exec`, `readFile`, `readFileBytes`, `writeFile`, `withLease`)
  or `runtime.workspace/v1.withThread`; never add another bundle's operation
  to `runtime.lease/v1` or `runtime.workspace/v1`.
- Add a feature's tests where its layer is tested: domain behavior in
  `tests/domain/` over `tests/domain/support/harness.ts`, storage in
  `tests/store/` over `tests/store/support.ts`, contract schemas and service
  mapping in `tests/contracts/`, host hooks in `tests/host/`, the records
  mirror in `tests/client/` over `tests/client/support/hosts.ts`, and tests of
  the whole bundle at the top of `tests/`: the built descriptor
  (`descriptor.test.ts`),
  call scope (`scope.test.ts`), the exported contracts
  (`runtime-contracts.test.ts`), the tool-host types against the contracts
  (`host-parity.test.ts`), Project activity (`activity.test.ts`), the adapter
  transcript (`adapter-capture.test.ts`) and `runtime/testing`
  (`testing.test.ts`). Use the shared fakes of `tests/support/`
  (`executor.ts`, `sandbox.ts`, `credentials.ts`, `execution.ts`) rather than
  new ones.
- Change [`tests/store/progress.property.test.ts`](tests/store/progress.property.test.ts)
  in the same change as any change to the `pending` fold of
  `src/host/store/progress.ts`.
- Never edit [`tests/fixtures/adapter-parity/transcript.json`](tests/fixtures/adapter-parity/transcript.json)
  by hand: no command regenerates it, because
  `tests/support/capture-adapter.ts` loads `app/backend/doric-host` modules
  that do not exist. When a change adds a field to the `Thread` record, add it
  to `newerThreadFields` of
  [`tests/contracts/adapter-parity.test.ts`](tests/contracts/adapter-parity.test.ts).
  Never narrow an output schema of `runtime.threads/v1`, `runtime.workspace/v1`
  or `runtime.lease/v1`, and add an output field there only as optional:
  [`tests/adapter-capture.test.ts`](tests/adapter-capture.test.ts) parses
  every recorded answer with it.
- Never edit [`tests/store/fixtures/baseline-logs.json`](tests/store/fixtures/baseline-logs.json)
  by hand: the source it names, `e2e/snapshots/baseline`, does not exist, so
  no command regenerates it.
- Update [`README.md`](README.md) and the feature doc the change belongs to —
  [Projects and Threads](../../../docs/features/projects-and-threads.md),
  [per-Thread model](../../../docs/features/per-thread-model.md),
  [Thread archive](../../../docs/features/thread-archive.md),
  [`cwd` tool](../../../docs/features/cwd-tool.md),
  [delegation](../../../docs/features/delegation.md),
  [attachments](../../../docs/features/attachments.md),
  [usage](../../../docs/features/usage.md),
  [prompt control](../../../docs/features/prompt-control.md) or
  [context compaction](../../../docs/features/context-compaction.md) — in the
  same change.
- Declare every contract you use in [`manifest.json`](manifest.json).
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "runtime"`.

## Verify

- `npx nx run bundle-runtime:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-runtime:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the bundle
  first.
- `DORIC_TEST_DATABASE_URL=<url> npx nx run bundle-runtime:test`, where
  `<url>` is the connection string of a PostgreSQL test database in which the
  tests create and drop their own schemas:
  run it after a change under `src/host/store/` or to
  `src/contracts/storage.ts`, or to the restart behavior that
  `tests/domain/workspace-restart.test.ts` covers. Without the variable, the
  PostgreSQL cases of the store tests and of that test are skipped.
- `npx nx run bundle-runtime:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None.
