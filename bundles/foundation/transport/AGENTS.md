# transport

Apply these rules to `bundles/foundation/transport/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to serving the `doric.api.*` services over other bundles'
contracts, and add to it no data, storage, business rule, client part or
contract of its own: what an RPC answers belongs to the bundle that owns the
data. Its REST routes, Socket.IO namespaces and kernel entry were deleted in
slice S69; add none back.

## Rules

- Read [`README.md`](README.md) for what each service and operation does before
  adding to it.
- Reach data only through `TransportPorts`
  ([`src/host/api/ports.ts`](src/host/api/ports.ts)), which
  `routedTransportPorts` builds over the router
  ([`src/host/process/routed.ts`](src/host/process/routed.ts)); never store a
  record or cache an answer.
- Put an RPC body in an operation of
  [`src/host/api/operations/`](src/host/api/operations) over `TransportPorts`,
  returning an `ApiAnswer` ([`src/host/api/answer.ts`](src/host/api/answer.ts)),
  and use `pageInput`, `nameInput`, `ok` and `refused` of
  [`src/host/api/input.ts`](src/host/api/input.ts) for lists, names and
  answers. `src/host/api/**` imports no `express`
  ([`tests/host-build.test.ts`](tests/host-build.test.ts)).
- Never answer the message of a thrown error that is not a contract outcome:
  `apiFailure` turns it into `internal_error`.
- When an operation answers an outcome of a `runtime/contracts` method that
  `restErrors` tabulates, answer what the table gives.
- Never answer a credential's secret: answer only what `secrets/v1` describes.
- Put a new stream item in the `Watch` streams of
  [`src/host/process/watch.ts`](src/host/process/watch.ts).
- Test an RPC through the router suites (`tests/router-*.test.ts`) over the
  fakes of [`tests/support/router-fakes.ts`](tests/support/router-fakes.ts);
  state the answer a removed route gave with
  [`tests/support/route-answers.ts`](tests/support/route-answers.ts), and test
  an operation in [`tests/api-operations.test.ts`](tests/api-operations.test.ts).
- Update, in the same change, [`README.md`](README.md) and the feature doc the
  RPC belongs to:
  [projects and threads](../../../docs/features/projects-and-threads.md),
  [credentials](../../../docs/features/credentials.md),
  [terminal](../../../docs/features/terminal.md),
  [git](../../../docs/features/git.md),
  [files](../../../docs/features/files.md),
  [cwd tool](../../../docs/features/cwd-tool.md) or
  [per-thread model](../../../docs/features/per-thread-model.md).
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "transport"`.

## Verify

- `npx nx run bundle-transport:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-transport:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which compiles them
  into `dist-tests/` first.
- `npx nx run bundle-transport:build`: run it after a change to
  `manifest.json`, `package.json` or a `tsconfig*.json` file.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
