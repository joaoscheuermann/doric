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
- Declare each contract method in its file of `src/contracts/` with its input
  and output schemas in that file's `*Methods` object, and provide it in
  `src/host/services/<contract>.ts` by spreading that entry into `defineMethod`;
  add `expose: 'desktop'` only to a method a window calls. The one exception
  is `runtime.records/v1`, which the client part provides through
  `runtimeRecordsService` of [`src/contracts/records.ts`](src/contracts/records.ts)
  over [`src/client/records.ts`](src/client/records.ts).
- Answer every expected outcome of a host method as a value of its result
  union, and reject only for a broken call, a closed binding or a failure; when
  you add an outcome that a transport route answers, add its REST error to
  `restErrors` in [`src/contracts/rest-errors.ts`](src/contracts/rest-errors.ts).
- Resolve a prompt-scoped method only through `bindings.bound(call)` of
  [`src/host/domain/bindings.ts`](src/host/domain/bindings.ts), so that it acts
  only for the prompt its scope names and only while that prompt runs; never
  widen the scope from a value the model or the caller supplies.
- Keep `src/host/services/` a mapping of contract methods to the domain, keep
  behavior in `src/host/domain/`, keep every read and write of `storage/v1` in
  `src/host/store/`, and read `services` for the domain only in
  [`src/host/ports.ts`](src/host/ports.ts).
- Take the Project lock (`exclusive(projectId, …)`) only for queue and state
  mutations; never hold it across `executor.run`, an awaited hook or a sandbox
  command, and fire the awaited hooks of `runtime.hooks/v1` outside it. The
  only two exceptions: `setCwd` of `src/host/domain/runner.ts` runs its path
  checks and hint probe under the lock, and `withThread` with
  `exclusive: true` runs the caller's task under it.
- Commit before you publish: append an event or write a document first, then
  call the publisher, and route every history and event write of a run through
  the `PromptSession` of [`src/host/domain/session.ts`](src/host/domain/session.ts).
- Redact every text the runtime stores or delivers with the redactor's current
  list, and add to the redaction list every secret the runtime writes into a
  sandbox.
- Never put a Thread's agent instructions in the public `Thread`, an event or a
  log line: they live only in the Thread document and reach only the executor.
- Never let a hook handler, a credential write, a sandbox discard, a notice
  listener or a repository-hint probe fail the operation that triggered it: log
  the failure and continue. The only exception: in `setCwd`, a sandbox command
  that throws (the hint probe included) rejects the move, while a probe that
  does not finish stores no hint.
- Keep the rules other bundles share — `src/contracts/execution.ts`,
  `fences.ts`, `deltas.ts` and the attachment helpers — pure, browser-safe and
  free of I/O.
- Keep the client part's reads synchronous and answered from memory, and put
  the host's answer into the mirror before a write resolves.
- Change `createRecordsApi` of [`src/testing.ts`](src/testing.ts) in the same
  change as any change to `runtime.records/v1`.
- Put a new host feature's contract in `src/contracts/` (exported from
  `src/contracts/index.ts`), its methods in `src/host/services/`, its Project
  and Thread guards in `src/host/domain/service.ts`, its queue and run behavior
  in `src/host/domain/runner.ts` or a new file of `src/host/domain/`, and its
  storage in `src/host/store/`; put a window feature of the mirror in
  `src/client/`.
- Let another bundle react to the runtime only through a hook of
  `runtime.hooks/v1` in [`src/contracts/hooks.ts`](src/contracts/hooks.ts) or a
  notice, and let it work on a Project's sandbox or a Thread's directory only
  through `runtime.lease/v1.withLease` or `runtime.workspace/v1.withThread`;
  never add another bundle's operation to `runtime.lease/v1` or
  `runtime.workspace/v1`.
- Add a feature's tests where its layer is tested: domain behavior in
  `tests/domain/` over `tests/domain/support/harness.ts`, storage in
  `tests/store/`, contract schemas and service mapping in `tests/contracts/`,
  host hooks in `tests/host/`, the records mirror in `tests/client/`, and
  tests of the whole bundle — activation, call scope, the exported contracts
  and `runtime/testing` — at the top of `tests/` (`activation.test.ts`,
  `scope.test.ts`, `runtime-contracts.test.ts`, `testing.test.ts`).
- Change [`tests/store/progress.property.test.ts`](tests/store/progress.property.test.ts)
  in the same change as any change to the `pending` fold of
  `src/host/store/progress.ts`.
- Never edit [`tests/fixtures/adapter-parity/transcript.json`](tests/fixtures/adapter-parity/transcript.json)
  by hand: no command regenerates it, because
  `tests/support/capture-adapter.ts` loads `app/backend/doric-host` modules
  that do not exist; treat a failure of `tests/contracts/adapter-parity.test.ts`
  or `tests/runtime-contracts.test.ts` against it as a change to the
  contracts' call surface.
- Update [`README.md`](README.md) and the feature doc the change belongs to —
  [Projects and Threads](../../../docs/features/projects-and-threads.md),
  [per-Thread model](../../../docs/features/per-thread-model.md),
  [Thread archive](../../../docs/features/thread-archive.md) or
  [`cwd` tool](../../../docs/features/cwd-tool.md) — in the same change.
- Declare every contract you use in [`manifest.json`](manifest.json).
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "runtime"`.

## Verify

- `npx nx run bundle-runtime:typecheck`: run it after any change under `src/`.
- `npx nx run bundle-runtime:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the bundle
  first.
- `DORIC_TEST_DATABASE_URL=<url> npx nx run bundle-runtime:test`: run it after
  a change under `src/host/store/` or to `src/contracts/storage.ts`, so that
  the store tests also run against PostgreSQL.
- `npx nx run bundle-runtime:build`: run it after a change to `manifest.json`,
  `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None.
