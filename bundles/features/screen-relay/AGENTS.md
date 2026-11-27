# screen-relay

Apply these rules to `bundles/features/screen-relay/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to serving the path tree `/screen/<token>/` on its own
loopback listener, behind the gateway, and forwarding each known token's requests to its upstream,
and add to it no UI, tool, setting or other path prefix. Never start, stop,
name or choose a screen session here: the bundle that owns the sessions
publishes them through `screen.relay/v1`.

## Rules

- Read [`README.md`](README.md) for what the bundle does before changing it.
- Keep the bundle a host part only, served by its process entry
  [`src/host/main.ts`](src/host/main.ts) with `runBundle`; add no kernel entry
  `src/host/index.ts` (removed in slice S69).
- Serve only the `httpServer` of
  [`src/host/part.ts`](src/host/part.ts), which the SDK binds; never call
  `listen` yourself, and keep `host.httpPrefix: "/screen/"` in
  [`manifest.json`](manifest.json).
- Answer every request and upgrade whose token is unknown, or that is outside
  the `/screen` tree, with 404.
- Keep the WebSocket forwarding transparent: send the browser's own upgrade
  headers, `sec-websocket-key` included, return the upstream's handshake
  unchanged, and never parse or rewrite a frame.
- Keep the relay's logic in [`src/host/relay.ts`](src/host/relay.ts) and keep
  [`src/host/rpc/relay.ts`](src/host/rpc/relay.ts) an adapter that maps each
  RPC onto the relay and resolves only once the relay holds the
  change, since the caller awaits it before a window loads the path.
- Keep the token the only capability the relay checks: access control is the
  operator's network boundary.
- Never import `screen/contracts` or call a contract of the `screen` bundle:
  `screen` requires `screen.relay/v1`, and a reference back would form a
  cycle.
- Read [`manifest.json`](manifest.json) for the contracts the bundle provides
  before adding one, and before adding an exception for this bundle, search
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  for `"bundle": "screen-relay"`.
- Put a new forwarding behavior (a header rule, a path rule, a timeout, a
  failure answer) in `src/host/relay.ts`, and test it through real sockets in
  [`tests/router.test.ts`](tests/router.test.ts), with the stub upstream and
  the part's listener that file already builds.
- Add a new method of `screen.relay/v1` to
  [`relay.proto`](proto/doric/screen/relay/v1/relay.proto), implement it on
  `ScreenRelayServer` in `src/host/relay.ts`, map it in
  `src/host/rpc/relay.ts`, and test it over the router in
  [`tests/router.test.ts`](tests/router.test.ts).
- Update the feature doc [Screen](../../../docs/features/screen.md) with any
  change to what the relay answers, and
  [Host API](../../../docs/features/host-api.md) with any change to how the
  gateway reaches it.

## Verify

- `npx nx run bundle-screen-relay:typecheck`: run it after any change under
  `src/`.
- `npx nx run bundle-screen-relay:test`: run it after any change under `src/`
  or `tests/`.
- `npx nx run bundle-screen-relay:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or `src/contracts/`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
