# Transport bundle

`transport` is the Doric host's network API: the REST routes and Socket.IO
namespaces that clients use to create Projects and Threads, send prompts, read
files and diffs, drive terminals, edit the configuration and credentials, and
follow a Thread's events live. It stores nothing itself; every route calls the
contract of the bundle that owns the data.

It is a host-only bundle that the shipped
[`composition.json`](../../../app/backend/doric-host/composition.json) lists as
`resident`: it activates in the native host (kernel) process instead of in a
generation process, because the native HTTP and Socket.IO handles it registers
on are only handed to resident bundles. A resident bundle is part of the kernel
partition, so publishing a new generation does not replace it; changing it
needs a host restart. The composition's `required` block names `transport`, so
the host refuses to boot without it. See the [main README](../../../README.md)
for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.
The full route and event reference is in the
[host README](../../../app/backend/doric-host/README.md#rest-api).

## What it provides

- **REST routes** on the host's Express app: `/config`, `/credentials`,
  `/providers`, `/tools`, `/resources`, `/vms`, `/projects`, `/threads` and
  the terminal routes.
- **Socket.IO namespaces:** `/status`, `/projects` and `/threads`.
- **Startup:** an `onHostStartHook` that logs `Network interfaces configured`
  with the namespaces before the host binds.

The bundle provides no contract. The kernel owns the listener and the generic
desktop bridge `/doric/bridge`; `app/backend/doric-host` keeps no product
route.

## How it registers

On activation the host part calls `doric.network/v1.register(listener)`. The
kernel hands the listener its native Express app and Socket.IO server, locally
and never serialized, and the transport mounts its routers and namespaces on
them. The registration is disposed when the bundle deactivates.

Every contract is resolved when a request arrives, not at activation, so a
route reaches the generation that is active at that moment. The workspace
sockets follow `runtime/v1` and `terminal/v1` through `whenAvailable`, so they
watch each new provider after a generation change.

## Contracts it calls

| Contract             | Used by                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `host-config/v1`     | `GET /config`, `PUT /config`                                        |
| `secrets/v1`         | `/credentials`                                                      |
| `models/v1`          | `/providers/kinds`, `/providers/models`                             |
| `tools/v1`           | `GET /tools`                                                        |
| `sandbox/v1`         | `/vms`                                                              |
| `runtime/v1`         | `/projects`, `/vms/:id/ssh`, the `/projects` and `/threads` sockets |
| `runtime.threads/v1` | `/threads`, Project Thread lists, the workspace sockets             |
| `runtime.lease/v1`   | `GET /projects/:id/ssh`                                             |
| `files/v1`           | Project files, tree and file content                                |
| `git.commands/v1`    | Project diff and changes, Thread Git status and branches            |
| `resources/v1`       | `GET /resources`, `GET /projects/:id/resources`                     |
| `usage/v1`           | `GET /threads/:id/usage`                                            |
| `terminal/v1`        | The terminal routes and the `/projects` terminal events             |

The first eight, with `hooks/v1`, are in `requires`. `files/v1`,
`git.commands/v1`, `usage/v1`, `resources/v1` and `terminal/v1` are only in
`optional`, so the transport activates without those feature bundles and a
disabled or quarantined one does not take it down.

## HTTP behavior

- Errors use `{ error: { code, message } }`. Each router validates its own IDs
  (400), bodies (422), missing resources (404) and conflicts (409).
- An unexpected failure, including a malformed JSON body, answers
  `500 internal_error` without the underlying message.
- The terminal router is mounted first at the root and sets
  `Cache-Control: no-store` on every request that passes through it, so the
  routes after it answer without caching.
- Credentials are answered without their secrets, and `PUT /config` maps the
  `host-config/v1` results to `200`, `422 invalid_config` or
  `503 configuration_rejected`.

## Workspace sockets

`/threads` takes `{ threadId, afterSequence }` and `/projects` takes
`{ projectId }` in the handshake `auth`; invalid IDs and query-only
subscriptions are refused. For each subscription the transport:

1. subscribes to live notices first, then reads the durable snapshot;
2. sends `thread:snapshot` or `project:snapshot` (plus `terminal:snapshot`);
3. delivers buffered and live `agent:event` envelopes in strict sequence
   order, dropping duplicates of the replayed history;
4. flushes the lifecycle notices it buffered while the snapshot loaded.

Terminal output is never buffered; a reconnecting client reads the terminal
snapshot instead. One `terminal/v1` stream is opened per subscribed Project and
closed with its last socket. A failed replay emits `workspace:error`
(`replay_failed`) and disconnects. `/status` accepts any connection and only
confirms the host is reachable.

## Entrypoints

The host part (`src/host`) is the installed entry. `transport/kernel` exports
`createTransport`, the same bundle as an embedded definition over a given
Express app and Socket.IO server (with an optional `features` services source
for the feature routes), plus `transportRequires` and the
`TransportServices` types.

## Development

```console
npx nx build bundle-transport
npx nx typecheck bundle-transport
npx nx test bundle-transport
```

The build writes `bundles/foundation/transport/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/transport`. To rebuild and stage every
bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
