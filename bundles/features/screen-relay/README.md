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
[Host API](../../../docs/features/host-api.md) (the gateway that forwards the
`/screen/` prefix).

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

The bundle has one part, the host part ([`src/host/part.ts`](src/host/part.ts)),
and a contracts module ([`src/contracts/index.ts`](src/contracts/index.ts)),
which [`package.json`](package.json) exports as `screen-relay/contracts`. It
has no desktop part, no client part, no tool, no skill and no UI.

The manifest declares `host.httpPrefix: "/screen/"`: the host part serves the
relay on its own loopback listener and the gateway forwards every
`/screen/<token>/…` request and upgrade to it with its path unchanged. Since
slice S69 the bundle has no kernel entry and does not run in the host's
process.

## Contract provided: `screen.relay/v1`

Version `1.1.0`. The host part serves it as the generated `RelayService` of
[`proto/doric/screen/relay/v1/relay.proto`](proto/doric/screen/relay/v1/relay.proto)
([`src/host/main.ts`](src/host/main.ts),
[`src/host/rpc/relay.ts`](src/host/rpc/relay.ts)).
[`src/contracts/index.ts`](src/contracts/index.ts) still exports the reference
`ScreenRelayV1` over the interface `ScreenRelay`, with the method table
`screenRelayMethods` and the schemas below; no bundle imports them.

```ts
interface ScreenRelay {
  expose(input: ScreenRelayExpose, call?: CallArg): Promise<void>;
  forget(input: ScreenRelayForget, call?: CallArg): Promise<void>;
}
```

The exported input schemas are strict `zod` objects (an unknown field is
refused):

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
  ([`src/host/part.ts`](src/host/part.ts),
  [`src/host/relay.ts`](src/host/relay.ts)).
- **`forget({ token })`** drops the token. From then on, its requests and
  upgrades answer 404. Forgetting an unknown token does nothing. It does not
  close a WebSocket that is already relayed for that token
  ([`src/host/relay.ts`](src/host/relay.ts)).

Both methods answer `{}` once the change is made; the relay's own state
changes synchronously, and neither handler throws. Their only errors are the
router's: a request that breaks `relay.proto`'s protovalidate rules (an empty
`token` or `host`, or a `port` outside 1–65535) fails with `invalid_input`
before the handler runs, and a call with no active provider answers
`unavailable` ([`src/host/rpc/relay.ts`](src/host/rpc/relay.ts),
[Over the router](#over-the-router)).

The build lists the contract in `dist/contracts.json` as a host-provides entry
(`local: false`); it writes no `dist/schemas/`
([`packages/bundle/src/build/cli.ts`](../../../packages/bundle/src/build/cli.ts)).

## Contracts used

The bundle uses no contract. Its only caller is the
[`screen`](../screen/README.md) bundle, which requires `screen.relay/v1` and
calls `expose` and `forget`; when and with what token it calls them is
described in its README and in [Screen](../../../docs/features/screen.md).

## Host part

### The part

`createScreenRelayPart()` ([`src/host/part.ts`](src/host/part.ts)) builds,
with no I/O:

1. one relay with `createScreenRelay()`
   ([`src/host/relay.ts`](src/host/relay.ts));
2. a new `http.Server`, not listening, that `relay.serve` already serves: the
   `httpServer` that [`src/host/main.ts`](src/host/main.ts) gives `runBundle`,
   which binds it to `127.0.0.1:0` and reports the port to the platform;
3. the `RelayService` implementation over the relay
   ([`src/host/rpc/relay.ts`](src/host/rpc/relay.ts)), which `main.ts` lists
   statically;
4. `deactivate`, which detaches `serve` and disposes the relay.

`ScreenRelayServer.serve(server)` makes the relay the only handler of that
listener. Slice S69 removed the kernel path: `src/host/{index,service}.ts`,
and from `relay.ts` `mount`, `mounted`, `handleRequest`, `handleUpgrade`,
`screenPath`, `ScreenRelayRouter` and `ScreenRelayResources`.

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

The request handler ([`src/host/relay.ts`](src/host/relay.ts)):

- **Known token:** forwards the request with Node's `http.request` to the
  upstream `host:port`, with the same method, the upstream path, and the
  request body streamed through. The request headers are copied with their
  names lower-cased (a repeated header keeps its last value), the hop-by-hop
  headers are dropped and `host` is set to `<host>:<port>` of the upstream.
  The upstream's answer is returned with its status (502 when it has none),
  its headers minus the hop-by-hop ones, and its body streamed through.
- **Unknown token, a path in the tree with no token** (`/screen`,
  `/screen/`), **or any other path:** answers 404 with
  `content-type: text/plain` and the body `No such screen.`, without reaching
  any upstream.

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
- **Unknown token, a path in the tree with no token, or any other path:**
  writes `HTTP/1.1 404 Not Found` with `connection: close` and
  `content-length: 0`, then destroys the socket.

### Deactivation

`dispose()` destroys every socket of a relayed upgrade still open, the
browser's and the upstream's. It does not end HTTP requests in flight and does
not clear the token table ([`src/host/relay.ts`](src/host/relay.ts)). The
part's `deactivate` detaches `serve` first; the SDK closes `httpServer`
afterwards ([`src/host/part.ts`](src/host/part.ts)).

### Over the router

- `Expose` and `Forget` are served over the router. A replayed `Expose` of the
  same token and upstream is idempotent; `screen` re-publishes its tokens
  through `registrations.track` (S49b), so a restarted relay gets them back.
- `Expose` with an empty token or host, or a bad port, answers
  `invalid_input`; after stop, every RPC answers `unavailable`.
- Open: when an old `screen` generation shuts down after the new one
  re-exposed a token, its `Forget` can drop that token.

## Errors and failure behavior

All in [`src/host/relay.ts`](src/host/relay.ts):

| Case                                                                    | Result                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| HTTP upstream fails before answering                                    | 502, `content-type: text/plain`, body `The screen upstream is unavailable.`                          |
| HTTP upstream fails after its headers were sent                         | the response is ended with the body `The screen upstream is unavailable.` appended                   |
| HTTP upstream request idle for 30 seconds                               | the upstream request is destroyed, which answers as an upstream failure (502 when nothing was sent)  |
| Upgrade upstream errors before its answer (refused, reset, unreachable) | `HTTP/1.1 502 Bad Gateway` with `connection: close` and `content-length: 0`; the socket is destroyed |
| Upgrade upstream closes without an error before its answer              | the browser's socket is destroyed with nothing written                                               |
| Upgrade upstream fails or closes after its answer                       | the browser's socket is destroyed                                                                    |
| Browser's socket closes or fails during an upgrade                      | the upstream socket is destroyed                                                                     |
| Unknown token (HTTP / upgrade)                                          | 404 `No such screen.` / `HTTP/1.1 404 Not Found`                                                     |

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

- [`tests/relay.test.ts`](tests/relay.test.ts) checks `relayTarget`'s path
  mapping.
- [`tests/router.test.ts`](tests/router.test.ts) (A1–A12 and the replayed
  `Expose`) builds the part, binds its `httpServer`, and drives `Expose` and
  `Forget` over the router against a stub xpra upstream: HTTP forwarding, the
  WebSocket handshake and byte piping, the 404s and 502s, `invalid_input`, and
  stopping the part.
- [`tests/host-build.test.ts`](tests/host-build.test.ts) (A13, A14) builds the
  bundle: `dist/host/main.mjs` runs, `dist/host/index.js` does not exist, and
  `main.ts` lists `RelayService` statically.

`npx nx run doric-host:build-bundles` builds every bundle and stages it for the
host ([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
