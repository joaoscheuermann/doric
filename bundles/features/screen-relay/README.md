# Screen relay bundle

`screen-relay` makes a Project sandbox's screen reachable on the same origin
the app already uses to reach the Doric host. It forwards `/screen/<token>/` to
the xpra server inside the sandbox, so the screen works whether the host runs
on your laptop or on a remote server behind a tunnel or reverse proxy.

It is a feature bundle with a host part only, which the composition runs
resident in the host's native process, loaded by the `bundle` platform. It
serves the [`screen`](../screen/README.md) bundle, which starts the sessions
and publishes them here. See the [main README](../../../README.md) for Doric as
a whole and [`packages/bundle`](../../../packages/bundle/README.md) for how
bundles work.

## What it provides

- **Contract:** `screen.relay/v1` (host):
  - `expose({ token, host, port })` registers or replaces the upstream of one
    session token;
  - `forget({ token })` drops a token; its requests answer 404 afterwards.

The bundle provides no tool, skill or UI.

## Why it is a separate bundle

Mounting on the host's shared request router and `http.Server` takes native
handles, and `doric.network/v1` hands those only to a bundle the composition
runs resident. The `screen` bundle runs in a generation, where
`runtime.lease/v1.withLease` can hand it a sandbox, so the work is split:

| Bundle         | Runs in                     | Does                                         |
| -------------- | --------------------------- | -------------------------------------------- |
| `screen`       | a host generation           | starts xpra in the sandbox, publishes tokens |
| `screen-relay` | the host process (resident) | answers `/screen/<token>/` on the host       |

`app/backend/doric-host/composition.json` enables `screen-relay` and lists it
in `resident`.

## How it works

The relay binds no server of its own. On activation it registers with
`doric.network/v1`, adds a middleware to the host's router and a second
`upgrade` listener to its `http.Server`.

- **HTTP:** a request under a known token is forwarded to the upstream with
  the token prefix removed and the query kept. Hop-by-hop headers are dropped
  and `Host` is rewritten to the upstream. An upstream error answers 502, and
  an upstream request times out after 30 seconds.
- **WebSocket:** the relay connects to xpra and replays the browser's own
  upgrade request, `Sec-WebSocket-Key` included, then returns xpra's handshake
  unchanged and pipes raw bytes both ways. Subprotocols, extensions and frames
  reach xpra exactly as the browser sent them.
- **Unknown paths:** a `/screen/...` request or upgrade with an unknown token
  answers 404. Anything outside `/screen` passes on to the host's other
  routes, and other upgrades, such as Socket.IO, are left alone.
- **Shutdown:** deactivation unmounts the relay, which then passes every
  request through, and closes the sockets it opened.

## Security

The relay is served on whatever origin the operator exposes, not only on
loopback. Whoever can reach that origin and holds a session token can watch and
drive that screen. The token is the capability; the operator's network
boundary (tunnel, reverse proxy or VPN) is the access control, consistent with
the host's unauthenticated HTTP surface.

## Development

```console
npx nx build bundle-screen-relay
npx nx typecheck bundle-screen-relay
npx nx test bundle-screen-relay
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
