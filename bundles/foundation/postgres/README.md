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

## Configuration

| Variable               | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `DORIC_DATABASE_URL`   | The PostgreSQL connection the Prisma client uses.                |
| `DORIC_CREDENTIAL_KEY` | The base64 key that seals and opens stored credentials.          |
| `DORIC_STORAGE_PATH`   | The filesystem the health check measures (default: current dir). |

Each is read when it is first needed. `activate` performs no I/O. The Prisma
client is created and connected on first use from `DORIC_DATABASE_URL`, and the
host forces that connection at its existing startup stages (`database_client`),
so a missing URL or an unreachable database still fails the start. A database
whose three legacy tables (`project`, `thread`, `thread_event`) all exist and
one of them holds a row fails the start at `database_client` too, with or
without the stage-7 marker. The health
check measures the disk without a database round trip, so a database outage is
never reported as low storage.

## Schema and client

The bundle owns the Prisma schema, the migrations and the generated client
(`prisma/`, `src/generated/prisma`). The client is internal: only the two
backends use it, and no other bundle or the host receives it. For tests,
`postgres/testing` builds the service definitions with injected options and
exports `PrismaClient` and the type `Database`, so a test can seed or read the
database directly.

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
`migrate` runs `prisma migrate deploy`. A migration that rewrites or drops data
has its operator steps in the host README:

- `20261021000000_coalesce_thread_deltas`:
  [Coalescing stored Thread deltas](../../../app/backend/doric-host/README.md#coalescing-stored-thread-deltas);
- `20261117000000_drop_legacy_runtime_tables`, which drops the legacy
  `project`, `thread` and `thread_event` tables and cannot be reversed:
  [Legacy rows at the drop migration](../../../app/backend/doric-host/README.md#legacy-rows-at-the-drop-migration).

The build writes `bundles/foundation/postgres/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/postgres`; to rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
