# Screen relay bundle

`screen-relay` serves the screen of each Project sandbox on the origin the
Doric host already exposes. It answers the path tree `/screen/<token>/` and
forwards each request of a known token, plain HTTP and WebSocket alike, to the
xpra server inside that Project's sandbox, so a window reaches the screen on
the same origin it reaches the host on, whether the host runs on the same
machine or behind a tunnel or reverse proxy. It is the serving side of the
[`screen`](../screen/README.md) bundle, which starts the sessions and
publishes each one here.

Feature docs: [Screen](../../../docs/features/screen.md) (the flow from a
window's request to the live screen) and
[Host API](../../../docs/features/host-api.md) (the host's shared listeners
the relay mounts on).

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                      |
| `id`              | `screen-relay`                                                                                           |
| `version`         | `1.0.0`                                                                                                  |
| `engines`         | `{ "doric": "^1.0.0" }`                                                                                  |
| `description`     | The screen relay: the token tree of every Project screen, served on the origin the host already exposes. |
| `provides`        | `screen.relay/v1@1.1.0`                                                                                  |
| `requires`        | none                                                                                                     |
| `optional`        | `log/v1`, `secrets/v1`                                                                                   |

The bundle has one part, the host part ([`src/host/index.ts`](src/host/index.ts)),
and a contracts module ([`src/contracts/index.ts`](src/contracts/index.ts)),
which [`package.json`](package.json) exports as `screen-relay/contracts`. It
has no desktop part, no client part, no tool, no skill and no UI.

The host's composition enables the bundle and lists it under `resident`, so
its host part runs in the host's own process and not in a generation
([`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json)).
It must run there: `doric.network/v1` hands the host's native listeners only
to code in that process
([`packages/bundle/src/contracts/network.ts`](../../../packages/bundle/src/contracts/network.ts),
[`packages/bundle/src/process/network.ts`](../../../packages/bundle/src/process/network.ts),
[process isolation](../../../docs/architecture/bundles/process-isolation.md)).

## Contract provided: `screen.relay/v1`

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as the reference
`ScreenRelayV1` over the interface `ScreenRelay`, with the method table
`screenRelayMethods`, and provided by the host part through
[`src/host/service.ts`](src/host/service.ts). Version `1.0.0`.

```ts
interface ScreenRelay {
  expose(input: ScreenRelayExpose, call?: CallArg): Promise<void>;
  forget(input: ScreenRelayForget, call?: CallArg): Promise<void>;
}
```

The input schemas are strict `zod` objects (an unknown field is refused):

| Schema                    | Type                | Shape                                                                    |
| ------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `screenRelayExposeSchema` | `ScreenRelayExpose` | `{ token: string (min 1), host: string (min 1), port: integer 1–65535 }` |
| `screenRelayForgetSchema` | `ScreenRelayForget` | `{ token: string (min 1) }`                                              |
| `screenRelayTargetSchema` | `ScreenRelayTarget` | `{ host: string (min 1), port: integer 1–65535 }`                        |

`ScreenRelayTarget` is the upstream of one token: the address of a session's
xpra server as the host process reaches it. The module exports it with the
other two; the contract's methods do not take it directly.

- **`expose({ token, host, port })`** registers the upstream of `token`, or
  replaces it when the token is already registered. From then on, requests
  under `/screen/<token>/` are forwarded to `host:port`. It resolves with no
  value once the relay holds the token
  ([`src/host/service.ts`](src/host/service.ts),
  [`src/host/relay.ts`](src/host/relay.ts)).
- **`forget({ token })`** drops the token. From then on, its requests and
  upgrades answer 404. Forgetting an unknown token does nothing. It does not
  close a WebSocket that is already relayed for that token
  ([`src/host/relay.ts`](src/host/relay.ts)).

Both methods resolve once the change is made; the relay's own state changes
synchronously. Both always resolve: neither method throws. Their only errors
are the platform's: the platform refuses a call whose input fails the method's
schema with the `ContractError` code `invalid_input` before the method runs,
in the caller's process and again in the host's, and refuses a call with no
active provider with `unavailable`
([`packages/bundle/src/runtime/dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts),
[`packages/bundle/src/runtime/envelope/link.ts`](../../../packages/bundle/src/runtime/envelope/link.ts)).

The build writes the contract's JSON schema to `dist/schemas/screen.relay/v1.json`
and its list to `dist/contracts.json`
([`packages/bundle/src/build/cli.ts`](../../../packages/bundle/src/build/cli.ts)).

## Contracts used

- **`doric.network/v1`** (platform; needs no manifest entry). The host part
  calls `register` once during activation and receives the host's shared
  request router (`http`, Express-style) and its `http.Server` (`server`). It
  does not use `sockets`. It keeps the returned `Disposable` and disposes it on
  deactivation ([`src/host/index.ts`](src/host/index.ts),
  [`packages/bundle/src/contracts/network.ts`](../../../packages/bundle/src/contracts/network.ts)).

The bundle uses no other contract. Its only caller is the
[`screen`](../screen/README.md) bundle, which requires `screen.relay/v1` and
calls `expose` and `forget`; when and with what token it calls them is
described in its README and in [Screen](../../../docs/features/screen.md).

## Host part

### Activation

`activate` ([`src/host/index.ts`](src/host/index.ts)):

1. Creates one relay with `createScreenRelay()`
   ([`src/host/relay.ts`](src/host/relay.ts)).
2. Calls `doric.network/v1.register` with a listener that mounts the relay on
   the `http` router and the `server` it receives.
3. Provides `screen.relay/v1` over that relay
   ([`src/host/service.ts`](src/host/service.ts)).
4. Returns a cleanup that disposes the registration, which runs the
   listener's cleanup and so unmounts the relay, and then disposes the relay
   ([`packages/bundle/src/process/network.ts`](../../../packages/bundle/src/process/network.ts)).

The relay binds no port and never calls `listen`: the host owns the address
([`src/host/relay.ts`](src/host/relay.ts)).

### Mounting

`mount({ http, server })` ([`src/host/relay.ts`](src/host/relay.ts)):

- calls `http.use(handler)` once, adding a request middleware to the host's
  router, after the routes registered before it;
- adds an `upgrade` listener to `server`, next to any other one (Socket.IO's);
- returns an unmount function that removes the `upgrade` listener and turns
  the middleware into a pass-through, since a router middleware cannot be
  removed. A pass-through middleware calls `next()` for every request.

The kernel activates its resident bundles one at a time in the catalog's
order, and that order puts `screen-relay` before `transport`: neither
provides a contract the core uses, `screen-relay` depends on no bundle, and
bundles ready at the same time are taken by id. So the relay's middleware runs
before the root `express.json()` that `transport` adds to the same router, and
a request under `/screen/` reaches the relay with its body unread
([`packages/bundle/src/runtime/catalog.ts`](../../../packages/bundle/src/runtime/catalog.ts),
[`packages/bundle/src/process/partition.ts`](../../../packages/bundle/src/process/partition.ts),
[`packages/bundle/src/runtime/activation.ts`](../../../packages/bundle/src/runtime/activation.ts),
[`transport/src/host/app.ts`](../../foundation/transport/src/host/app.ts)).

### Token table

The relay holds one in-memory `Map` from token to `ScreenRelayTarget`. It is
not persisted, is empty after each activation, and is shared by the HTTP and
the upgrade paths ([`src/host/relay.ts`](src/host/relay.ts)).

### Path mapping

For a request URL, the relay ([`src/host/relay.ts`](src/host/relay.ts),
`relayTarget`):

- parses the URL with the WHATWG `URL` parser, so dot segments are resolved
  (`/screen/t1/../t2/x` has the token `t2`) and the pathname stays
  percent-encoded;
- takes as the token the first path segment after the prefix `/screen/`, not
  decoded;
- looks the token up in the table;
- builds the upstream path as the rest of the pathname after the token, or `/`
  when nothing follows the token, followed by the original query string.

| Request URL            | Token | Upstream path |
| ---------------------- | ----- | ------------- |
| `/screen/t1/hello?q=1` | `t1`  | `/hello?q=1`  |
| `/screen/t1/`          | `t1`  | `/`           |
| `/screen/t1`           | `t1`  | `/`           |
| `/screen/t1/a/b`       | `t1`  | `/a/b`        |

A path belongs to the relay's tree when its pathname is `/screen` or starts
with `/screen/`.

### HTTP requests

The middleware ([`src/host/relay.ts`](src/host/relay.ts)):

- **Known token:** forwards the request with Node's `http.request` to the
  upstream `host:port`, with the same method, the upstream path, and the
  request body streamed through. The request headers are copied with their
  names lower-cased (a repeated header keeps its last value), the hop-by-hop
  headers are dropped and `host` is set to `<host>:<port>` of the upstream.
  The upstream's answer is returned with its status (502 when it has none),
  its headers minus the hop-by-hop ones, and its body streamed through.
- **Unknown token, or a path in the tree with no token** (`/screen`,
  `/screen/`): answers 404 with `content-type: text/plain` and the body
  `No such screen.`, without reaching any upstream.
- **Any other path:** calls `next()`, so the host's other routes answer it.

The hop-by-hop headers are `connection`, `keep-alive`, `proxy-authenticate`,
`proxy-authorization`, `te`, `trailer`, `transfer-encoding` and `upgrade`.

### WebSocket upgrades

The `upgrade` listener ([`src/host/relay.ts`](src/host/relay.ts)):

- **Known token:** opens a TCP connection to the upstream `host:port` with no
  idle timeout. Once connected, it writes the request line
  `GET <upstream path> HTTP/1.1` followed by every header of the browser's
  upgrade request, with its name lower-cased, a repeated header reduced to its
  last value and `host` set to the upstream, hop-by-hop headers and
  `sec-websocket-key` included, then any bytes the server had already read
  past the handshake. It reads the upstream's answer up to the end of its
  header block (`\r\n\r\n`), writes that answer and any bytes after it to the
  browser unchanged, and then pipes raw bytes in both directions. It parses
  and rewrites no frame, so the upstream's handshake answer, accept hash
  included, and every frame reach the other side as they were sent.
- **Unknown token, or a path in the tree with no token:** writes
  `HTTP/1.1 404 Not Found` with `connection: close` and `content-length: 0`,
  then destroys the socket.
- **Any other path:** does nothing, leaving the upgrade to the server's other
  listeners, such as Socket.IO.

The host's Socket.IO server is created with `destroyUpgrade: false`, so it
does not end an upgrade outside its own path while the relay waits for xpra
([`app/backend/doric-host/src/index.ts`](../../../app/backend/doric-host/src/index.ts)).

### Deactivation

`dispose()` turns the middleware and the `upgrade` listener into pass-throughs
and destroys every socket of a relayed upgrade still open, the browser's and
the upstream's. It does not end HTTP requests in flight and does not clear the token table
([`src/host/relay.ts`](src/host/relay.ts)). The cleanup of `activate` runs the
unmount first, which removes the `upgrade` listener
([`src/host/index.ts`](src/host/index.ts)).

### Process entry (S49a)

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
built to `dist/host/main.mjs`, for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It calls
`runBundle` with `RelayService` (`screen.relay/v1`) listed statically and sets
`BundleDefinition.httpServer`. The kernel entry stays until S62;
since S62c1 the manifest has `host.httpPrefix: "/screen/"`. In this entry:

- The relay serves its own loopback listener (`127.0.0.1:0`, the port reported
  to the platform); the gateway forwards every `/screen/<token>/…` request and
  upgrade with its path unchanged.
- `ScreenRelayServer.serve(server)` makes the relay the only handler of that
  listener: a known token is proxied as `mount` proxies it (an unreachable
  upstream answers 502); anything else answers 404 `No such screen.`, and any
  other upgrade gets a 404 and its socket is closed.
- `Expose` and `Forget` are served over the router. A replayed `Expose` of the
  same token and upstream is idempotent; `screen` re-publishes its tokens
  through `registrations.track` (S49b), so a restarted relay gets them back.
- `Expose` with an empty token or host, or a bad port, answers
  `invalid_input`; after stop, every RPC answers `unavailable`.
- Open: when an old `screen` generation shuts down after the new one
  re-exposed a token, its `Forget` can drop that token (as with the kernel
  entry today).

## Errors and failure behavior

All in [`src/host/relay.ts`](src/host/relay.ts):

| Case                                                                      | Result                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP upstream fails before answering                                      | 502, `content-type: text/plain`, body `The screen upstream is unavailable.`                                                                                                                                       |
| HTTP upstream fails after its headers were sent                           | the response is ended with the body `The screen upstream is unavailable.` appended                                                                                                                                |
| HTTP upstream request idle for 30 seconds                                 | the upstream request is destroyed, which answers as an upstream failure (502 when nothing was sent)                                                                                                               |
| Upgrade upstream errors before its answer (refused, reset, unreachable)   | `HTTP/1.1 502 Bad Gateway` with `connection: close` and `content-length: 0`; the socket is destroyed                                                                                                              |
| Upgrade upstream closes without an error before its answer                | the browser's socket is destroyed with nothing written                                                                                                                                                            |
| Upgrade upstream fails or closes after its answer                         | the browser's socket is destroyed                                                                                                                                                                                 |
| Browser's socket closes or fails during an upgrade                        | the upstream socket is destroyed                                                                                                                                                                                  |
| Unknown token (HTTP / upgrade)                                            | 404 `No such screen.` / `HTTP/1.1 404 Not Found`                                                                                                                                                                  |
| Request URL the URL parser rejects (for example `http://[`) while mounted | HTTP: the middleware throws `ERR_INVALID_URL` to the router, whose error handlers answer it. Upgrade: the `upgrade` listener throws `ERR_INVALID_URL` out of the server's `upgrade` event, and nothing catches it |

The relay does not retry, log or report a failure to the `screen` bundle.

## Configuration and limits

- No setting, environment variable or file: the prefix `/screen/`, the
  hop-by-hop list and the 30-second HTTP timeout are constants
  ([`src/host/relay.ts`](src/host/relay.ts)).
- The relay does not limit the number of tokens. `expose` accepts any
  non-empty token, but a token that contains `/` never matches a path, since
  the path mapping ends the token at the first `/`; a token holding a
  character the parser percent-encodes (a space, a non-ASCII character) never
  matches either.
- A relayed WebSocket has no timeout and stays open until either side closes,
  `dispose` runs, or the host stops.

## Security

The relay is served on whatever origin the operator exposes the host on, not
only on loopback, and checks no credential. Whoever reaches that origin and
holds a session token can watch and drive that screen: the token is the
capability, and the operator's network boundary (tunnel, reverse proxy or VPN)
is the access control, as for every other route of the host
([`src/host/relay.ts`](src/host/relay.ts),
[transport README](../../foundation/transport/README.md#common-rules)).

## Build and test

Run from the repository root:

```console
npx nx run bundle-screen-relay:typecheck
npx nx run bundle-screen-relay:test
npx nx run bundle-screen-relay:build
```

`build` compiles `src/` to `dist/` and runs the bundle build, which writes
`dist/manifest.json`, `dist/contracts.json` and the contract's schema
([`project.json`](project.json)). `test` compiles `src/` and `tests/` to
`dist-tests/` and runs them with `node --test`:

- [`tests/relay.test.ts`](tests/relay.test.ts) drives `createScreenRelay` and
  `relayTarget` through real sockets: a host listener with a minimal router, a
  stub xpra upstream that echoes what it receives, path mapping, HTTP
  forwarding, the WebSocket handshake and byte piping, the 404s, the
  pass-through of other routes, a relayed upgrade that survives a second
  `upgrade` listener with an Engine.IO-style destroy timer, `forget` and
  unmounting.
- [`tests/host.test.ts`](tests/host.test.ts) drives `activate` with a
  services object that supplies `use(DoricNetworkV1)` and `provide`, checks the
  single registration and the provided `screen.relay/v1`, and calls its
  methods over a real listener.

`npx nx run doric-host:build-bundles` builds every bundle and stages it for the
host ([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
