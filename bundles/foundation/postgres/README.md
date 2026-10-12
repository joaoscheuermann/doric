# Postgres bundle

`postgres` is the foundation bundle of the Direct host: the composition
chooses it in `providers` for `storage.backend/v1` and `secrets.backend/v1`,
so it activates before the core. Its build writes `bundles/foundation/postgres/dist`,
which `doric:build-bundles` stages into `agents/doric/dist/bundles/postgres`.

## Services

The host part provides:

- `storage.backend/v1` — the generic storage primitives (versioned documents,
  declared indexes, streams, atomic commits, the commit feed, blobs, health and
  the reserved `hostId`/`storageGeneration` identity row) on PostgreSQL tables.
- `secrets.backend/v1` — the `credential` table, with secrets sealed in the
  AES-256-GCM envelope under `DORIC_CREDENTIAL_KEY`.
- `postgres.database/v1` — provisional: `connect()` and the process's single
  Prisma client, used only by the kernel stores until their data moves to
  `storage/v1`.

`activate` performs no I/O. The Prisma client is created and connected on
first use from `DORIC_DATABASE_URL`, and the host forces that connection at
its existing startup stages.

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

The PostgreSQL suites skip without `DORIC_TEST_DATABASE_URL`.
