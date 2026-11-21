# screen-relay

Apply these rules to `bundles/features/screen-relay/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to serving the path tree `/screen/<token>/` on the host's
shared listeners and forwarding each known token's requests to its upstream,
and add to it no UI, tool, setting or other path prefix. Never start, stop,
name or choose a screen session here: the bundle that owns the sessions
publishes them through `screen.relay/v1`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before changing it.
- Keep the bundle a host part only, and keep `screen-relay` under `resident`
  in [`composition.json`](../../../app/backend/doric-host/composition.json):
  `doric.network/v1` hands its router and `http.Server` only to code in the
  host's own process, so the relay must never run in a generation.
- Mount the relay only through `doric.network/v1.register`, never call
  `listen` or open a port of its own, and release the registration and the
  relay in the cleanup `activate` returns.
- Keep every request and upgrade outside the `/screen` tree untouched: call
  `next()` for such a request and return from the `upgrade` listener without
  writing, so that the host's routes and Socket.IO keep working.
- Answer every request and upgrade inside the `/screen` tree whose token is
  unknown with 404, and never pass it to the host's other routes.
- Keep the WebSocket forwarding transparent: send the browser's own upgrade
  headers, `sec-websocket-key` included, return the upstream's handshake
  unchanged, and never parse or rewrite a frame.
- Keep the relay's logic in [`src/host/relay.ts`](src/host/relay.ts) and keep
  [`src/host/service.ts`](src/host/service.ts) an adapter that maps each
  contract method onto the relay and resolves only once the relay holds the
  change, since the caller awaits it before a window loads the path.
- Keep the token the only capability the relay checks: access control is the
  operator's network boundary, as for every route of the host.
- Never import `screen/contracts` or call a contract of the `screen` bundle:
  `screen` requires `screen.relay/v1`, and a reference back would form a
  cycle.
- Read [`manifest.json`](manifest.json) for the contracts the bundle provides
  before adding one, and before adding an exception for this bundle, search
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  for `"bundle": "screen-relay"`.
- Put a new forwarding behavior (a header rule, a path rule, a timeout, a
  failure answer) in `src/host/relay.ts`, and test it through real sockets in
  [`tests/relay.test.ts`](tests/relay.test.ts), with the stub upstream and the
  host listener that file already builds.
- Add a new method of `screen.relay/v1` to `ScreenRelay` and
  `screenRelayMethods` in [`src/contracts/index.ts`](src/contracts/index.ts),
  as a strict `zod` input of plain data, implement it on `ScreenRelayServer`
  in `src/host/relay.ts`, map it in `src/host/service.ts`, and test it
  through the provided definition in [`tests/host.test.ts`](tests/host.test.ts).
- Test the host part with the hand-made services object of
  `tests/host.test.ts`, not with `createTestServices`: a test cannot provide
  `doric.network/v1`, which only the platform defines.
- Update the feature doc [Screen](../../../docs/features/screen.md) with any
  change to what the relay answers, and
  [Host API](../../../docs/features/host-api.md) with any change to how it
  uses the host's shared listeners.

## Verify

- `npx nx run bundle-screen-relay:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-screen-relay:test`: run it after any change under `src/`
  or `tests/`.
- `npx nx run bundle-screen-relay:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
