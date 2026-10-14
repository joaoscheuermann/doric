# The development fake host

A **dev-only** Doric host that runs inside this repository, in memory: no
Postgres, no Docker sandbox, no agent runtime. It exists so the desktop app can
boot here and show a workspace while you work on a bundle.

Nothing in this directory is imported by the host, the packaged app or a test.

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

## What it serves

| Surface                                                                                       | Where it comes from                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doric.catalog/v1.distribution`, `.artifact`, `.watch`                                        | the staged bundles the host build produces (`app/backend/doric-host/dist/bundles`), hashed and resolved with `bundle`'s own `buildCatalog`/`distributionFor` |
| `runtime/v1`, `runtime.threads/v1`, `terminal/v1.watchProject`, `doric.diagnostics/v1.report` | `workspace.mjs` and `contracts.mjs`, in memory                                                                                                               |
| `GET /status`, `GET /projects`, `GET /threads`                                                | `server.mjs`                                                                                                                                                 |
| `GET /reload`                                                                                 | rebuilds the catalog from the staged files and publishes a new generation to every `doric.catalog/v1.watch` subscriber                                       |

Two Projects ("Doric", "Sandbox") with one Thread each, from fixed UUIDs, are
enough for the sidebar, the project tabs and the dashboard.

## Environment

| Variable                        | Default                                   | Meaning                                                                                            |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `DORIC_FAKE_PORT`, `DORIC_PORT` | `3000`                                    | the port to listen on                                                                              |
| `DORIC_FAKE_HOST`               | `127.0.0.1`                               | the address to bind                                                                                |
| `DORIC_FAKE_BUNDLES`            | `app/backend/doric-host/dist/bundles`     | the staged bundles root; when absent the fake host stages them itself into `tmp/fake-host/bundles` |
| `DORIC_FAKE_COMPOSITION`        | `app/backend/doric-host/composition.json` | the composition the catalog resolves                                                               |
| `DORIC_FAKE_QUIET`              | unset                                     | print only lifecycle and REST lines                                                                |

`--port`, `--bundles`, `--composition` and `--quiet` do the same from the
command line.

## What it does not serve

Every call it cannot answer is refused with `unavailable` and logged as
`?? UNKNOWN <contract> <method>`; those lines are the list of what the desktop
asks for next. As of this writing the desktop also polls `resources/v1.host`,
`resources/v1.project`, `usage/v1.thread`, `git.commands/v1.status`/`changes`,
`files/v1.tree`, `runtime.threads/v1.queue`, `models/v1.kinds` and
`host-config/v1.current`, which show up in the UI as unavailable surfaces.

The catalog's bundles are staged build output, not live code: rebuild them
(`npx nx run doric-host:build-bundles`) and `GET /reload` after changing a
bundle.
