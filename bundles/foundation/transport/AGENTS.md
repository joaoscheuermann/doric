# transport

Apply these rules to `bundles/foundation/transport/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to serving the host's REST routes and Socket.IO namespaces
over other bundles' contracts, and add to it no data, storage, business rule,
client part or contract of its own: what a route answers belongs to the bundle
that owns the data, and the kernel's own namespace `/doric/bridge` belongs to
the kernel.

## Rules

- Read [`README.md`](README.md) for what each router and namespace does before
  adding to it.
- Reach data only through a contract call on `TransportServices`
  ([`src/host/services.ts`](src/host/services.ts)); never store a record,
  cache an answer or keep any state but the socket subscriptions.
- Resolve every contract at call time: add a contract to `TransportServices`
  and build its stub in `createTransport` of [`src/kernel.ts`](src/kernel.ts),
  as a `services.use` stub, a function that binds a call scope, or a `lazy`
  stub; never call a contract of another bundle during activation: register
  only through `doric.network/v1` and `HooksV1`, and reach a provider during
  activation only through `whenAvailable`.
- Declare under `requires` of [`manifest.json`](manifest.json) only a
  contract of a bundle outside `bundles/features/`, and add the same entry to
  `transportRequires` in [`src/kernel.ts`](src/kernel.ts), so the two lists
  stay equal; declare a contract of a bundle under `bundles/features/` under
  `optional` only, keep it out of `transportRequires`, and read it through
  `features()`, so that the transport activates without that bundle.
- Put a new route in the router of its resource under `src/host/routes/`,
  or in a new router there that [`src/host/app.ts`](src/host/app.ts) mounts
  before `handleHttpError`; keep the terminal router mounted first at the
  root, since its `Cache-Control: no-store` covers every route after it.
  Put the route body in an operation of `src/host/api/operations/` over
  `TransportPorts`, returning an `ApiAnswer`; the handler only calls
  `sendAnswer(response, await operations.x(routeInput(request)))`.
- Answer every refusal with `sendError` of
  [`src/host/errors.ts`](src/host/errors.ts), and use `validateId`, `missing`,
  `conflict`, `pageInput` and `nameInput` of
  [`src/host/routes/input.ts`](src/host/routes/input.ts) for Project, Thread
  and credential ids, lists and names.
- Validate every body with a strict `zod` schema, and answer an invalid one
  with `422` and an `invalid_<thing>` code; only `PUT /config` hands its body
  to its contract unchecked, because `host-config/v1` validates it.
- Answer a contract outcome's own message where the contract gives one for
  its caller, as `invalid_config`, the credential errors and `branch_refused`
  do, but never the message of a thrown error that is not a contract
  outcome: let it reach `handleHttpError`, and end a new router with
  `router.use(handleHttpError)`.
- When a route answers an outcome of a `runtime/contracts` method that
  `restErrors` tabulates, answer what the table gives, and add the case to
  [`tests/rest-errors.test.ts`](tests/rest-errors.test.ts).
- Never answer a credential's secret: answer only what `secrets/v1` describes.
- Set `Cache-Control: no-store` in every route that reads a workspace, a
  lease, a queue, events, usage, Git, resources or a terminal, even though
  the terminal router sets it.
- Put a new socket event in
  [`src/host/sockets/workspace.ts`](src/host/sockets/workspace.ts): subscribe
  a socket before its durable read, send a lifecycle notice through `notify`
  so it is buffered until the snapshot is sent, send `agent:event` only in an
  unbroken run of sequences, and never buffer terminal output.
- Add a new namespace to `socketNamespaces` of the startup log in
  [`src/kernel.ts`](src/kernel.ts).
- Read the `/threads` and `/projects` subscription only from
  `socket.handshake.auth`, never from the query.
- Open a `terminal/v1` stream only through the terminal feed of
  [`src/host/sockets/terminal-feed.ts`](src/host/sockets/terminal-feed.ts),
  one per subscribed Project.
- Test a route or a namespace through `serve` of
  [`tests/support/host.ts`](tests/support/host.ts), and add a member to
  `Fakes` and a `fakeService` entry in `serve` there for each contract a new
  route calls; put route tests in `tests/routes.test.ts` (Projects and
  Threads) or `tests/host-routes.test.ts` (configuration, credentials,
  providers, tools, VMs, terminals), socket tests in `tests/sockets.test.ts`,
  and tests of the shared HTTP behavior in `tests/http-edges.test.ts`; add
  each new optional feature contract to the list in
  [`tests/resources-contract.test.ts`](tests/resources-contract.test.ts).
- Update, in the same change, [`README.md`](README.md), the route and event
  reference of the host's
  [`README.md`](../../../app/backend/doric-host/README.md#rest-api), and the
  feature doc the route belongs to:
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
- Try a change by building and staging it with
  `npx nx run doric-host:build-bundles` and then restarting the host: the
  bundle is `resident`, so a new generation does not replace it.

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
