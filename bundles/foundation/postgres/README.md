# Postgres bundle

`postgres` keeps Doric's data in a PostgreSQL database you run: Projects,
Threads, conversation history, settings and the other documents bundles
store, plus your credentials, which are encrypted at rest.

It is the foundation bundle of the Doric host: the composition chooses it in
`providers` for `storage.backend/v1` and `secrets.backend/v1`, so it activates
before the core, which builds `storage/v1` and `secrets/v1` on top of it. See
the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

The host part provides:

- `storage.backend/v1` — the generic storage primitives (versioned documents,
  declared indexes, streams, atomic commits, the commit feed, blobs, health and
  the reserved `hostId`/`storageGeneration` identity row) on PostgreSQL tables.
- `secrets.backend/v1` — the `credential` table, with secrets sealed in the
  AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`.
- `postgres.database/v1` — provisional: `connect()` and the process's single
  Prisma client, used only by the kernel stores until their data moves to
  `storage/v1`.

## Configuration

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `DORIC_DATABASE_URL`   | The PostgreSQL connection the Prisma client uses.                |
| `DORIC_CREDENTIAL_KEY` | The base64 key that seals and opens stored credentials.          |
| `DORIC_STORAGE_PATH`   | The filesystem the health check measures (default: current dir). |

Each is read when it is first needed. `activate` performs no I/O. The Prisma
client is created and connected on first use from `DORIC_DATABASE_URL`, and the
host forces that connection at its existing startup stages (`database_client`),
so a missing URL or an unreachable database still fails the start. The health
check measures the disk without a database round trip, so a database outage is
never reported as low storage.

## Schema and client

The bundle owns the Prisma schema, the migrations and the generated client
(`prisma/`, `src/generated/prisma`). The `postgres/prisma` subpath re-exports
the generated client and `createDatabase` for the kernel, and
`postgres/testing` builds the service definitions with injected options for
tests.

## Development

```console
npx nx run bundle-postgres:prisma-generate
npx nx build bundle-postgres
npx nx typecheck bundle-postgres
DORIC_TEST_DATABASE_URL=postgresql://... npx nx test bundle-postgres
npx nx run bundle-postgres:migrate
```

The PostgreSQL suites skip without `DORIC_TEST_DATABASE_URL`; the size report
of the delta-coalescing migration also needs `DORIC_TEST_COALESCE_SIZE=1`.
`migrate` runs `prisma migrate deploy`; a migration that rewrites data, such as
`20261021000000_coalesce_thread_deltas`, has its operator steps in the
[host README](../../../app/backend/doric-host/README.md#coalescing-stored-thread-deltas). The build writes `bundles/foundation/postgres/dist`,
which `doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/postgres`; to rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
