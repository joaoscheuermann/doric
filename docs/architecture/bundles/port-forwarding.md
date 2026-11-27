# Port forwarding: reaching the sandbox ports

**Status:** proposal. Nothing here describes behavior already implemented; the documentation remains the contract of the current implementation. The paths cited as evidence exist in the repository today.

## Summary

The feature reaches, from outside the sandbox, a TCP port that a process of the Project listens on inside it — an `npm run dev`, an API server, a `docker run` of the image the Project describes. The port is served on the **very origin the host already exposes**, at `/ports/<token>/`, with transparent WebSocket, and the reader opens that URL in a window of the sandbox desktop, or copies the same URL out of it.

The direct precedent is the `screen`/`screen-relay` pair, which already serves the Project's xpra HTML5 client at `/screen/<token>/`. Port forwarding is the generalization of that path to any port, with a control plane that discovers, lists and exposes the ports of each Project.

What the feature is **not**:

- it does not publish Docker ports (`-p`) nor change the sandbox network policy: egress, SSH and DNS stay as `SandboxNetworkPolicy` defines them;
- it does not widen the sandbox's outbound access nor the host's authority over the network;
- it does not replace SSH, which remains an operator's inspection channel (`DORIC_SANDBOX_SSH`).

## What exists today (evidence)

The host already reaches a port the sandbox listens on, and already serves it on its origin, but only for the screen:

- `bundles/features/screen/src/host/session.ts:271-288`: `hostOf` runs `hostname -I` in the sandbox, picks the first routable IPv4 (`screenHost`, lines 152-160, which discards `127.*`) and the relay dials `<endereço>:<porta>` — the xpra ports come from `SCREEN_PORT_CANDIDATES = [14500, 14501, 14502]` (line 31) and xpra is started with `--bind-tcp=0.0.0.0:<porta>` (line 139).
- `bundles/features/screen-relay/src/host/relay.ts:1-15`: the relay mounts the token tree on the shared router and on the host's `http.Server`, and the comment records why it does not open a listener of its own: a loopback URL that only the host machine answers breaks the product when the host runs on a remote server and the app runs on a laptop.
- `bundles/features/screen-relay/src/host/relay.ts:82`: the served prefix is `/screen/`; `screenPath` (line 140) reserves that prefix and answers `404` to an unknown token, without falling through to the other routes.
- `bundles/features/screen-relay/src/host/relay.ts:17-20` and `263`: the upgrade is forwarded transparently, with the browser's own `Sec-WebSocket-Key` and headers, and the raw bytes are piped in both directions.
- `docs/architecture/bundles/feature-split.md:57`: `screen-relay` exists because `doric.network/v1.register` is local to the process: the bundle that serves a protocol on the native listeners runs resident, while the sessions that need the sandbox run in the generation, where `runtime.lease/v1.withLease` delivers the sandbox.
- `packages/bundle/src/contracts/network.ts:17-33`: `NetworkResources` delivers `http`, `server` (for the `upgrade` listener) and `sockets`; the kernel owns the address, the bind and the close.

- The Docker provider publishes only port 22, and only when SSH is enabled: `packages/docker-sandbox/src/lib/provider.ts:331` uses `NetworkMode: 'none' | 'bridge'`, `:343-351` builds `PortBindings` only for `22/tcp` (with `HostPort: ''`, an ephemeral port chosen by the daemon), and `packages/docker-sandbox/src/lib/host.ts:352-358` reads the bind back from the inspect and does `net.createConnection` on it — proof that the host dials IP:port. The Docker firewall (`host.ts:422-456`) governs egress only; nothing filters host → container.
- The Firecracker provider gives the sandbox a private `/30` and its own nftables rules (`packages/firecracker-sandbox/src/lib/network.ts:33-68`), with the host keeping an address on the TAP (`:55-59`); the preflight requires `ip_forward` and `CAP_NET_ADMIN` (`packages/firecracker-sandbox/src/lib/preflight.ts:140-145`). The rules filter only `iifname "<tap>"` (traffic originated in the guest), so the host → guest connection is not filtered by them.
- The only host → sandbox port forwarding that exists is SSH: `exposeUserSsh` (`packages/firecracker-sandbox/src/lib/ssh.ts:199-261`) opens a `net.Server` listener on the host and pipes each connection to `guest:22` — the same shape a port forwarding would need. It is provider-owned, tied to port 22 and exists only with `DORIC_SANDBOX_SSH`.
- On Docker Desktop (darwin/win32), the container's bridge IP is **not** reachable from the host, and the portable path is port publishing (`packages/docker-sandbox/README.md:44-46`, `host.ts:217-229`). Any design that only dials the container IP holds on Linux and does not hold there.
- A feature's window **only** loads a path under the host origin: `path: z.string().startsWith('/')` (`packages/bundle/src/contracts/basic/windows.ts:56-64`), resolved with `new URL(path, hostUrl)` (`app/desktop/doric/src/platform/windows/view.ts:13-14`), with navigation tied to the window's own origin and `windowOpen` always denied (`app/desktop/doric/src/platform/windows/navigation-guard.ts:31-40`). The packaged CSP (`default-src 'none'`, `connect-src 'none'`, no `frame-src`, `app/desktop/doric/src/platform/protocol/csp.ts:9-30`) applies to the pages of the `doric://` scheme (`app/desktop/doric/src/platform/protocol/handler.ts:210-216`); the page the host serves inside the view window does not receive that CSP (`app/desktop/doric/src/platform/windows/native-windows.ts:507-517`), and it is the navigation guard that keeps it on the origin.

What does **not** exist today:

- No contract or method exposes an arbitrary port: `Sandbox` and `SandboxRuntime` (`packages/sandbox/src/lib/types/sandbox.ts`) have `exec`, `start`, `stats`, `readFile`, `putFile`, `getFile`, `diff`, `cloneRepo` and `ssh`, and no equivalent of `openPort`/`forwardPort`. There is no port allocator on the host: the only published port is the ephemeral SSH one, chosen by the daemon.
- There is no discovery of listening ports: nothing reads `/proc/net/tcp` nor runs `ss` in the sandbox. `ss` and `netstat` are not among the packages the sandbox image installs (`app/backend/doric-host/.sandbox.Dockerfile:75-120`).
- There is no way for a window or a bundle to open an external URL: `shell.openExternal` does not exist in the code, no surface loads an origin outside the host origin (the view window's navigation is tied to it) and the CSP of the `doric://` scheme allows neither frames nor connections to another origin.
- Nor is there an SSH tunnel as a shortcut: the guest's Dropbear runs with forwarding disabled (`-g -j -k`) in both providers (`packages/docker-sandbox/src/lib/host.ts:336-344`; `app/backend/doric-host/firecracker/guest-start:22-25`), so `ssh -L`/`-R` is not a mechanism available today — the forwarding has to be done by the host.

## Architecture decisions

- **D-1 — The port is served on the host origin, at `/ports/<token>/`.** It is the same choice as the screen relay and holds for both kinds of deployment (local host and remote host). A listener on `127.0.0.1` remains an explicit option (D-7), not the default.
- **D-2 — Two bundles, as for screens: `ports` in the generation and `ports-relay` resident.** `doric.network/v1.register` is local to the process (`docs/architecture/bundles/feature-split.md:57`), and the `withLease` that delivers the sandbox exists only in the generation. `ports` publishes each session's upstream through `ports.relay/v1`; `ports-relay` answers the token tree.
- **D-3 — The `token` is the capability.** As for screens, the host's HTTP surface is unauthenticated by design; whoever reaches the origin and has the token reaches the port. The operational boundary (tunnel, reverse proxy, VPN) remains the control of whoever operates the host.
- **D-4 — The relay dials only the address of the Project's sandbox.** The upstream is recorded per session from the address read from the sandbox itself, and the relay refuses to expose an arbitrary host target. This prevents the proxy from becoming an outbound door to the host's internal network (SSRF).
- **D-5 — Discovery through `/proc/net/tcp` and `/proc/net/tcp6`.** Reading both files through `exec` and filtering sockets in `LISTEN` (state `0A`) depends on no package in the image, unlike `ss`/`netstat`. The port is still chosen by the reader or by the model: discovery only feeds the list and the UI.
- **D-6 — Declared path fidelity.** The prefixed path is not transparent to applications that use absolute paths. The relay injects `<base href="/ports/<token>/">` into HTML responses that do not declare a `<base>`, rewrites `Location` to the token prefix and rewrites the `Path` of `Set-Cookie`. What this does not cover is a documented and known limitation, preferable to a loopback listener that does not work with a remote host.
- **D-7 — Optional local listener, off by default.** `DORIC_PORT_FORWARD_BIND=127.0.0.1` can open a local port per session, for whoever runs host and app on the same machine and needs full path fidelity. It is not the default and requires an explicit decision by the operator, because it reintroduces the remote-host breakage.
- **D-8 — One session per (Project, port) pair.** The sandbox belongs to the Project and is shared by the Threads; two readings of the same port are two windows over the same session, as two screens of the same Project are two windows over a single session.
- **D-9 — Reachability is resolved by the provider, not by the bundle.** The way to reach a sandbox port varies by provider and by platform (the container IP on Docker on Linux, a published port on Docker Desktop, the Firecracker `/30` with `exposeUserSsh` as the precedent for a listener on the host). The ports bundle asks for an already resolved target, next to `stats?()` or from a public helper of `packages/sandbox`, and never derives it from `hostname -I`. That way a new provider chooses its own path without changing the bundle.

## Components

| Layer                | Where                                         | What it does                                                                                                                                           |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sandbox reachability | `packages/sandbox`                            | Resolves how the host reaches a sandbox port, instead of each feature reparsing `hostname -I` (`bundles/features/screen/src/host/session.ts:271-288`). |
| Sessions             | `bundles/features/ports` (host)               | Discovers ports listening in the Project's sandbox, keeps one session per (Project, port) pair on the lease, and publishes the upstream to the relay.  |
| Contracts            | `bundles/features/ports/contracts`            | `ports.sessions/v1` and `ports.views/v1`; `ports.relay/v1` lives in the resident bundle.                                                               |
| Relay                | `bundles/features/ports-relay` (resident)     | Serves `/ports/<token>/` on the host's router and `http.Server`, with transparent upgrade.                                                             |
| Tool                 | `bundles/features/ports` (host)               | `ports.forward_port`, for the agent to expose a port and return the URL to the reader.                                                                 |
| UI                   | `bundles/features/ports` (client and desktop) | A group in the sidebar, a window of its own per session and the copy-URL action.                                                                       |
| Configuration        | `bundles/features/ports` (host and client)    | `ports.settings/v1` on the host, with forbidden ports and an allowed range; section and route through `settings.sections`/`navigation`, like `git`.    |
| Composition          | `app/backend/doric-host/composition.json`     | `ports` in `enabled`, `ports-relay` in `enabled` and `resident`.                                                                                       |

### Port reachability (`packages/sandbox`)

“How the host reaches the port” is a detail of the provider, not of each feature, and today it varies like this:

| Provider        | Path                                                                                                                                                                  | Evidence                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker on Linux | the host dials the container's bridge IP                                                                                                                              | `screen` does exactly that (`bundles/features/screen/src/host/session.ts:271-288`); nothing in the Docker firewall filters host → container (`packages/docker-sandbox/src/lib/host.ts:422-456`) |
| Docker Desktop  | the bridge IP is not reachable; the port has to be published on the host                                                                                              | `packages/docker-sandbox/README.md:44-46`, `host.ts:217-229`                                                                                                                                    |
| Firecracker     | the host keeps an address on the TAP of the `/30` (`packages/firecracker-sandbox/src/lib/network.ts:55-59`) and the rules filter only traffic originated in the guest | `network.ts:130-170`; the precedent for a listener on the host is `exposeUserSsh` (`packages/firecracker-sandbox/src/lib/ssh.ts:199-261`)                                                       |

Proposed design: a method on the sandbox boundary that answers the already resolved target — for example `reach(port): Promise<{ host: string; port: number } | undefined>`, next to `stats?()` in `SandboxRuntime` and in `Sandbox` (`packages/sandbox/src/lib/types/sandbox.ts:77-95, 161-187`). A provider that cannot answer leaves it absent, as it does with measurement, and on Docker Desktop it can resolve by publishing the port before answering — but a publication added after creation is not seen by the reuse path, which compares `exposedPorts`, `networkMode` and `portBindings` of the existing container (`packages/docker-sandbox/src/lib/reuse.ts:39-52`), so that provider has to decide whether the publication goes into `create` from the start (`packages/docker-sandbox/src/lib/mapping.ts:30-36`) or whether reuse starts taking it into account.

Smaller alternative, if the sandbox interface should not grow: extract `hostOf`/`screenHost` from `bundles/features/screen/src/host/session.ts` into a public helper of `packages/sandbox`, without touching the interface. It solves Linux and Firecracker and leaves Docker Desktop without an answer, so it is the option that would fall short.

The choice stays open, but the point of D-9 stands: the ports bundle must not guess the path.

### `ports` (host, generation)

- `list({ projectId })` answers the ports listening in the Project's sandbox, with the lease state (`pending`, `unavailable`, `ready`) mapped as the screens do in `bundles/features/screen/src/host/provider.ts:58-80`, without failing the call when only the sandbox is missing.
- `list`, `forward` and `forget` carry `expose: 'desktop'` (`packages/bundle/src/contracts/expose.ts:4-5`), because it is the window that calls them through the bridge, as `screen.sessions/v2` does (`bundles/features/screen/src/host/provider.ts:152`).
- `forward({ projectId, port, label? })` resolves the lease through `runtime.lease/v1.withLease` (which never acquires, like the `runtime.lease/v1` `Stats` read of `bundles/features/resources/src/host/rpc/resources.ts`), asks the sandbox for the resolved target for that port (D-9), confirms it is listening and publishes the upstream to the relay, answering the path `/ports/<token>/`.
- `forget({ token })` and `dispose()` forget this generation's tokens in the relay, in the same design as `screen.sessions/v2.attach`/`dispose` in `bundles/features/screen/src/host/provider.ts`.
- The session keeps what the window needs: token, sandbox port, label, protocol and state. The protocol is HTTP with WebSocket upgrade, which is what the `doric.network/v1` seam offers (`NetworkResources.http` and the `upgrade` listener, `packages/bundle/src/contracts/network.ts:17-33`); raw TCP would require a new seam in the platform, and stays out of this proposal.

### `ports-relay` (resident)

Mirrors `bundles/features/screen-relay` line by line, with the differences generality requires:

- prefix `/ports/`, with `portsPath` reserving the prefix and answering `404` to an unknown token, without falling through to the router's other routes (`relay.ts:114-140`);
- the same hop-by-hop filters (`relay.ts:85-95`) and transparent upgrade (`relay.ts:263`);
- injection of `<base>` and rewriting of `Location` and `Set-Cookie` (D-6), which the screen relay does not need because the xpra client already serves its assets through relative paths;
- mounting and unmounting through `doric.network/v1.register`, with the cleanup returned on deactivation (`bundles/features/screen-relay/src/host/index.ts:11-25`).

### UI

The UI is split like that of the screens: the **client** part is the only one with a bridge to the host and makes the calls of `ports.sessions/v1`; the **desktopMain** part calls no host contract at all, and it is the one that owns the window.

- A group in the sidebar, through a `layout.stack/v2` pane (`stack.register({ id: 'ports-sidebar', tag: PORTS_SIDEBAR_TAG, order: …, title: 'Ports' })`, without sizes — v2 does not accept them —, like the screens pane in `bundles/features/screen/src/client/index.ts`), below the Threads tree — the same stack, and therefore the same panel design, in which the screens register theirs (`docs/features/screen.md`) —, with one row per session and its state, fed by the same dial design as the screens (`bundles/features/screen/src/client/index.ts:56-91`).
- Each row opens (or focuses) a window of its own, through `doric.windows/v1`, with the path `/ports/<token>/`, its own partition and a native title bar, without preload — the exact request `screen` builds in `bundles/features/screen/src/desktop/windows.ts:14-46`.
- The window loads the path under the host origin and nothing else; the "copy URL" action builds the same URL from `DORIC_HOST_URL`/the known origin. "Open in the machine's browser" is **not** possible today: `shell.openExternal` does not exist, no surface loads an origin outside the host origin — the view window is tied to it — and the CSP of the `doric://` scheme allows neither frames nor connections to another origin. It remains an explicit request for a new platform surface, listed in the open decisions.
- The window is reopened and re-pointed when the session changes token, as the screens' heal loop does with `focus`/`navigate`.
- The settings section uses the seams `git` already uses: an item in `settings.sections` and a route registered with `navigation.register({ path, parent: '/settings', create })` (`bundles/features/git/src/client/index.ts:61-90`). The `settings.config/v1` that appears on that path is the single autosave draft of the settings window, provided by the `settings` bundle (`bundles/desktop/settings/src/client/services/settings-config.ts:36`), not a space per feature — that is why the ports policy needs a configuration space of its own on the host.

### Tool

`ports.forward_port`, registered in `tools/v1` like the others (`bundles/features/resources/manifest.json` shows the minimal manifest format), receives `{ port, label? }` and returns the served path. That way the model can expose the server it started itself and deliver the URL in the conversation, without the reader having to discover the port.

## Contracts (sketch)

In the format of the existing contracts, with `defineService` and `defineMethod` from `bundle/contracts`:

```ts
// ports, host/sessions.ts
export const portsSessions = defineService('ports.sessions/v1', {
  list: defineMethod({
    input: z.object({ projectId: z.string() }).strict(),
    output: portListSchema,
    execute: async ({ projectId }, call, services) => /* lease + /proc/net/tcp */,
  }),
  forward: defineMethod({
    input: z
      .object({
        projectId: z.string(),
        port: z.number().int().positive().max(65_535),
        label: z.string().min(1).optional(),
      })
      .strict(),
    output: forwardedPortSchema,
    execute: async (input, call, services) => /* lease + expose + path */,
  }),
  forget: defineMethod({
    input: z.object({ token: z.string().min(1) }).strict(),
    output: z.void(),
    execute: async ({ token }) => /* relay.forget + sessão */,
  }),
});

// ports-relay, host/service.ts
export const portsRelayMethods = {
  expose: { input: portsRelayExposeSchema, output: z.void() },
  forget: { input: portsRelayForgetSchema, output: z.void() },
} as const;
```

`portsRelayExposeSchema` repeats `screenRelayExposeSchema` (`bundles/features/screen-relay/src/contracts/index.ts:26-32`, over `screenRelayTargetSchema`, `:16-21`) with the sandbox port required to be inside the sandbox of the Project that is exposing it; `forget` repeats `screenRelayForgetSchema` (`:37-39`).

On the name: `ports` does not collide with `bundles/runtime/runtime/src/host/ports.ts`, which is `RuntimePorts` — the hexagonal layer of the domain (`configuration`, `sandbox`, `executor`…), unrelated to TCP ports. Even so, it is worth settling in the implementation that one is a "host port" and the other a "domain port", so the vocabulary does not get mixed up.

The `ports` manifest follows `bundles/features/screen/manifest.json`:

```json
{
  "manifestVersion": 1,
  "id": "ports",
  "version": "1.0.0",
  "engines": { "doric": "^1.0.0" },
  "description": "Forwarded ports of a Project's sandbox.",
  "provides": ["ports.sessions/v1@1.0.0", "ports.views/v1@1.0.0"],
  "requires": [
    "log/v1@^1.0.0",
    "tools/v1@^1.2.0",
    "settings/v1@^1.0.0",
    "runtime.lease/v1@^1.1.0",
    "ui/v1@^1.0.0",
    "regions/v1@^1.0.0",
    "navigation/v1@^1.0.0",
    "layout.stack/v2@^2.0.0",
    "ports.relay/v1@^1.0.0"
  ],
  "desktopScope": {
    "ports.sessions/v1": ["projectId", "threadId", "promptId"]
  }
}
```

`ports-relay` declares only `ports.relay/v1` in `provides`, like `screen-relay`.

## Flows

1. **Expose.** The reader asks in a row of the UI, or the model calls `ports.forward_port`. The call reaches the `ports` host, which resolves the Project's lease, asks the sandbox for the resolved target (D-9), confirms the port is listening (`connect` with a short deadline, like `portOpen` in `screen`), generates the token and publishes the upstream through `ports.relay/v1.expose`.
2. **Open.** The desktop opens the window at `/ports/<token>/` on the path of the host origin; the relay answers by forwarding to the sandbox's `host:port`.
3. **WebSocket.** The upgrade is terminated on both sides with the browser's handshake and the raw bytes pass through; no frame is interpreted.
4. **Restart.** A restarted host loses the tokens, as it loses those of the screens. The desktop re-attaches the sessions it knows and re-points the window to the new path, instead of losing what was open.
5. **Close.** Ending the Thread does not close the session (the sandbox belongs to the Project); ending the Project, releasing the lease or deactivating the bundle forgets the tokens and drops the open connections (`dispose`), as the screen relay does today.

## Security and limits

- The token is the only credential, as for screens; the host origin remains unauthenticated by design.
- The relay refuses any upstream that is not the address of the Project's own sandbox (D-4), and `expose` validates the shape of the target.
- Nothing changes in `SandboxNetworkPolicy`: the feature only serves what is already listening inside the sandbox, and gives it no new outbound access. This agrees with HC-007: no network, sandbox or session boundary is weakened.
- Forwarded bodies do not go into the operational log; the log records token, port and state, not the payload.

## Files to create or change

> **Outdated.** The `project.json` row below no longer matches the
> code. Since step 11(a) of bundle isolation, `doric-host:build-bundles`
> has no list of bundles: it builds the Nx projects with the `type:bundle` tag and
> stages each `bundles/<grupo>/<id>` directory that has a `manifest.json`. A
> new bundle needs the tag, the manifest in that location, `npm install`,
> `nx sync` and an `enabled` line. The current behavior is in
> [docs/designs/bundle-isolation-concept.md](../../designs/bundle-isolation-concept.md#current-behavior-and-contracts).

| File                                                         | Change                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundles/features/ports/**`                                  | New bundle: `manifest.json`, `contracts/`, `host/`, `client/`, `desktop/`, `tests/`, `project.json`, `package.json`, `tsconfig*.json`, following `bundles/features/screen`. |
| `bundles/features/ports-relay/**`                            | New resident bundle: a mirror of `bundles/features/screen-relay`, with the `/ports/` prefix and the rewrites of D-6.                                                        |
| `app/backend/doric-host/composition.json`                    | `"ports"` and `"ports-relay"` in `enabled`; `"ports-relay"` in `resident`.                                                                                                  |
| `app/backend/doric-host/project.json`                        | `bundle-ports` and `bundle-ports-relay` in `build-bundles` (staging list and `dependsOn`), like `bundle-screen` and `bundle-screen-relay`.                                  |
| `tsconfig.json` and `package.json` at the root               | Workspace `paths`/references and the npm workspaces entry (`npx nx sync`, `npm install`).                                                                                   |
| `packages/sandbox`                                           | Sandbox reachability (D-9), through the interface (`reach(port)`) or through the public helper.                                                                             |
| `app/backend/doric-host/tests/bridge-exposure.snapshot.json` | The frozen snapshot of what a window can call has to gain `ports.sessions/v1` (and `ports.views/v1`, if the desktop consumes it), through `bridge-exposure.test.ts`.        |
| `docs/architecture/bundles.md`                               | A link to this document in the map.                                                                                                                                         |
| The documentation                                            | Only in the implementation (see below).                                                                                                                                     |

## Tests

- `ports-relay`: token and path resolution, reserved prefix with `404`, hop-by-hop, `<base>` injection, rewriting of `Location` and `Set-Cookie`, transparent upgrade, `mount`/unmounting with pass-through — the same shape as `bundles/features/screen-relay/tests/{relay,host}.test.ts`, which already starts an HTTP upstream with an `upgrade` listener, mounts on a shared router and `http.Server` and checks `GET /screen/t1/hello?q=1` through the host's ephemeral port.
- `ports`: parser of `/proc/net/tcp` (`LISTEN` included, IPv6, ports in hexadecimal), session manager with an injectable `portOpen` (as `ScreenSessionsOptions` does in `bundles/features/screen/src/host/session.ts:162-170`), idempotence per (Project, port), mapping of the lease state, lease scope (`assert.deepEqual(lease.scopes, ['p-1'])` is the model in `bundles/features/resources/tests/resources.test.ts:164`) and `forget` on dispose. `bundles/features/screen/tests/provider.test.ts:96` pins the case that matters here: a forming lease answers `pending` and opens no handle in the relay.
- Client: the list store, the state of the rows, the decision to open/focus/re-point the window and the window request itself (`bundles/features/screen/tests/views.test.ts:259, 306-317` and the `applyWindowAction` of `bundles/features/screen/src/desktop/windows.ts:50-90` are the models).
- Integration: in `app/backend/doric-host-e2e`, provision a Project, start an HTTP server inside the sandbox and fetch the response through the host origin, including a WebSocket upgrade.
- Formatting and lint: `npx biome format --write <arquivos>`, `npm run format:check` and `npm run lint`, as `AGENTS.md` requires.

## Delivery in stages

1. **Relay and contract.** `ports-relay` serving an upstream published by hand, proven by an integration test through the host origin.
2. **Sessions.** `ports.sessions/v1` over `runtime.lease/v1.withLease`, with discovery through `/proc/net/tcp`.
3. **UI.** A group in the sidebar, a window of its own and the copy-URL action.
4. **Tool and configuration.** `ports.forward_port` and `ports.settings/v1` — the configuration space lives on the host, like `host-config.configuration/v1` (`bundles/foundation/host-config/src/host/configuration.ts:34, 73-77, 190-191`), because the configuration is single, with no per-Project variant, and today no feature bundle has a configuration space of its own: `git` already registers a settings section and route, but keeps the text in the window's single autosave draft (`settings.config/v1`), not in a space of its own — and `defineSettings` appears in production code only in `host-config` itself (`bundles/foundation/host-config/src/host/configuration.ts:74`), with zero occurrences in `bundles/features/**`.
5. **Parity and options.** Firecracker exercised in the same test, and the decisions on the local listener (D-7) and on reachability (D-9).

## Open decisions (human gates)

- Bundle name: `ports` (the closest to the minimal names of `docs/architecture/bundles/feature-split.md`) or something like `forwarding`.
- Whether the optional local listener comes into scope or stays out until there is a concrete request.
- Whether the model gets the tool, and whether autoforward (exposing every newly detected port) fits or only the explicit request.
- Whether the session list is process-only (like the screens' tokens) or becomes a durable document per Project.
- Whether the screen relay and the ports relay converge into one generic relay with two prefixes, which today would mean touching the existing `screen-relay`.
- Whether the platform gains a way to open a URL in the system browser (today `shell.openExternal` does not exist, navigation is tied to the origin and the CSP allows neither frames nor another origin), which is what would allow "open in the machine's browser".
- Whether reachability becomes a method of the sandbox boundary (`reach(port)`) or a public helper of `packages/sandbox` (D-9), and whether Docker Desktop comes into the first slice.
- Whether the ports policy is a global settings space (the path with a precedent) or a list per Project, which today has nowhere to live: the configuration is single, the Project's `configSnapshot` is explicitly "never read for execution" (`bundles/runtime/runtime/src/contracts/storage.ts:20-30`) and `SandboxNetworkPolicy.allowPrivate[].ports` are outbound rules, not host bindings.
- Whether raw TCP comes into scope: today the `doric.network/v1` seam offers HTTP and `upgrade`, not raw sockets, and serving a non-HTTP protocol would require a new surface.

## What changes in the documentation when it is implemented

`AGENTS.md` asks to update the contract when the task changes product behavior. In the implementation, and not in this proposal, these go there: the `ports` and `ports-relay` bundles in `alternatives`/composition, the contracts `ports.sessions/v1`, `ports.views/v1` and `ports.relay/v1`, the `/ports/<token>/` prefix on the host origin, sandbox reachability in `packages/sandbox`, the tool and the settings section. None of this holds until this proposal becomes a verifiable delivery.

## Relations

- [Bundle architecture](../bundles.md): places the two new bundles in the target design.
- [Split of the current features](./feature-split.md): the resident `screen-relay` and its reason to exist (`:55-57`), the pattern `ports-relay` repeats.
- [Services between bundles and message channels](./services-and-channels.md): `defineService`, `defineMethod`, `ref`, the `provide`/`use` and the bridges the `ports` UI uses.
- [doric:// protocol](./doric-protocol.md): the app origin and the CSP that prevent the bundle window from loading an arbitrary origin — which is why the port is served on the host origin.
- [Windows opened by the core](./windows.md): `windows/v1`, the window keys and the path the window loads.
- [Process isolation](./process-isolation.md): the kernel and the resident bundles, which explains why the relay cannot live in the generation.
