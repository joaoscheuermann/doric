# The development fake host

The fake host lets you open the real Doric desktop app against a workspace in
seconds, with no PostgreSQL, no Docker sandbox and no model provider. It serves
the repository's own staged bundles from memory, seeds two Projects and a
scripted conversation, and records what you do in the app, so you can work on
a bundle's UI and see it in a real window. Read this if you develop desktop or
feature bundles.

It is **development only**: nothing in this directory is imported by the host,
the packaged app or a test. For running Doric for real, see the
[main README](../../README.md) and the
[host README](../../app/backend/doric-host/README.md).

## Run it

```sh
npm run doric:fake-host
```

It prints the URL it listens on (`http://127.0.0.1:3000` by default) and the
single line the desktop needs:

```sh
DORIC_HOST_URL=http://127.0.0.1:3000 DISPLAY=:100 npm run doric:dev
```

`npm run doric:dev` is the repository's own `doric-renderer` dev server plus the
Electron app (`serve.mjs`, which adds `--no-sandbox` when running as root).
When the port is taken, the fake host says so and suggests another one, for
example `DORIC_FAKE_PORT=3010 npm run doric:fake-host`.

## What it serves

| Surface                                                                                       | Where it comes from                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doric.catalog/v1.distribution`, `.artifact`, `.watch`                                        | the staged bundles the host build produces (`app/backend/doric-host/dist/bundles`), hashed and resolved with `bundle`'s own `buildCatalog`/`distributionFor` |
| `runtime/v1`, `runtime.threads/v1`, `terminal/v1.watchProject`, `doric.diagnostics/v1.report` | `workspace.mjs` and `contracts.mjs`, in memory                                                                                                               |
| `runtime.threads/v1.watchThread`, `.prompt`                                                   | `thread-log.mjs`: a real in-memory event log, seeded with one scripted conversation and streaming every event the features append while the app runs         |
| `artifacts/v1`, `comments/v1`, `papercraft.previews/v1`                                       | `artifacts.mjs` and `comments.mjs`, over `/workspace/.doric/artifacts/`                                                                                      |
| `artifact.kind/v1.list`                                                                       | `contracts.mjs`: the one kind it seeds, papercraft's `preview`, whose body is `<papercraft-preview>`                                                         |
| `doric.catalog/v1.disable`, `.resetComposition`                                               | accepted as no-ops: boot a composition without the bundle instead                                                                                            |
| `GET /status`, `GET /projects`, `GET /projects/:id`, `GET /threads?projectId=`                | `server.mjs`; every other method answers `405`, because the fake host's REST is read-only                                                                    |
| `GET /reload`                                                                                 | rebuilds the catalog from the staged files and publishes a new generation to every `doric.catalog/v1.watch` subscriber                                       |

`artifacts/v1`, `comments/v1` and `papercraft.previews/v1` read the scope each
bridge call carries, as the real host does: a call without a `projectId` is
refused (`invalid_input`, the lease's refusal), and a write without a
`threadId` too, because its event belongs to a Thread log. Nothing falls back
to the seeded Project, so a window that forgets to scope a call fails here as it
would against the real host.

Two Projects ("Doric", "Sandbox") with one Thread each, from fixed UUIDs, are
enough for the sidebar, the project tabs and the dashboard.

## The seeded conversation and the preview artifact

The `Doric` project's Thread boots with a scripted history — one prompt, its
run, one `papercraft_preview` tool call — and the `preview` artifact that call
published, `checkout-preview` at revision 1. `runtime.threads/v1.watchThread`
replays that log, and `curl http://127.0.0.1:3000/reload` does not drop it:
the log lives beside the catalog, not inside it.

The artifact's markup is **built**, not written here: the fake host imports the
papercraft bundle's built host part
(`bundles/features/papercraft/dist/host/index.js`) and calls its
`snapshotPreview` over a `files/v1` that reads the workspace from disk — or,
for an older host part, its own `deriveMarkup`/`builtFiles` — over the fixture
checked in at `scripts/fake-host/fixtures/checkout.html`. The artifact's `path`
is that fixture's Project-relative path, exactly as the host part names the
source it reads through `files/v1`. Nothing about the preview is authored by the fake
host: if the host part is not built, the history still lands, the log says the
preview has no markup, and the boot prints the command that builds it.

Sending a prompt is accepted and appends its own durable events
(`prompt.accepted`, `prompt.started`, `prompt.finished`). The fake host runs no
agent, so the turn completes with no answer text — which is what happened, and
the log says so.

Both feature surfaces write their durable events into that same log, so what the
app does shows up in the conversation: a comment on a preview lands beside the
turn it comments on, and a new revision produces a second node.

## Environment

| Variable                        | Default                                   | Meaning                                                                                            |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `DORIC_FAKE_PORT`, `DORIC_PORT` | `3000`                                    | the port to listen on                                                                              |
| `DORIC_FAKE_HOST`               | `127.0.0.1`                               | the address to bind                                                                                |
| `DORIC_FAKE_BUNDLES`            | `app/backend/doric-host/dist/bundles`     | the staged bundles root; when absent the fake host stages them itself into `tmp/fake-host/bundles` |
| `DORIC_FAKE_COMPOSITION`        | `app/backend/doric-host/composition.json` | the composition the catalog resolves                                                               |
| `DORIC_FAKE_WORKSPACE`          | `/workspace`                              | the Project workspace: where `.doric/artifacts/` lives and where a preview's source path resolves  |
| `DORIC_FAKE_REVIEW_POLICY`      | `proceed`                                 | what `artifacts/v1.policy` answers: `proceed` or `request`                                         |
| `DORIC_FAKE_PAPERCRAFT`         | —                                         | the papercraft host part to import, instead of `bundles/features/papercraft/dist/host/index.js`    |
| `DORIC_FAKE_QUIET`              | unset                                     | `1` prints only lifecycle and REST lines                                                           |

`--port`, `--host`, `--bundles`, `--composition`, `--workspace`,
`--review-policy`, `--papercraft` and `--quiet` do the same from the command
line.

`DORIC_FAKE_REVIEW_POLICY=request npm run doric:fake-host` is how the canvas
bar's `Autorizar` is reached: under `request` an approval also moves the
revision to `approved`, and under `proceed` the gesture records its event and
leaves the state alone, as the `artifacts` bundle describes.

## What it does not serve

Every call it cannot answer is refused with `unavailable` and logged as
`?? UNKNOWN <contract> <method>`; those lines are the list of what the desktop
asks for next. As of this writing the desktop also polls `resources/v1.host`,
`resources/v1.project`, `usage/v1.thread`, `git.commands/v1.status`/`changes`,
`files/v1.tree`, `runtime.threads/v1.queue`, `models/v1.kinds` and
`host-config/v1.current`, which show up in the UI as unavailable surfaces.

The fake host activates no host parts, so it does not invent a kernel for the
feature surfaces. `artifact.kind/v1` answers only `list`, with the one
`preview` kind it seeds, because the real kind is registered by the papercraft
bundle's own host part. `settings/v1` is refused (`artifacts/v1.policy`
answers the review policy from `DORIC_FAKE_REVIEW_POLICY` instead). `files/v1`
is not served over the bridge either, so the preview strings the artifact's
source path rather than asking for a read the fake host cannot answer.

It opens only the `/doric/bridge` Socket.IO namespace, not the host's
`/status`, `/projects` or `/threads` namespaces.

The catalog's bundles are staged build output, not live code: rebuild them
(`npx nx run doric-host:build-bundles`) and `GET /reload` after changing a
bundle.
