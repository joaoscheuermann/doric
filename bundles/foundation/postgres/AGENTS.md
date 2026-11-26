# postgres

Apply these rules to `bundles/foundation/postgres/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to the PostgreSQL implementations of `storage.backend/v1` and
`secrets.backend/v1`, and add to it no contract, slot, route, tool, setting or
record type of its own: what a stored document or stream means belongs to the
bundle that writes it, the low-storage policy belongs to the caller of
`health`, and credential kinds, fields and references belong to `secrets/v1`
of the core.

## Rules

- Read [`README.md`](README.md) for what each method does, the schema and the
  failure behavior before changing the bundle, and keep every change
  equivalent to it or update it in the same change.
- Change the shape of `storage.backend/v1` or `secrets.backend/v1` only in
  `packages/bundle/src/contracts/basic/`, never in this bundle.
- Declare the `version` and the `provides` versions only in
  [`manifest.json`](manifest.json); no source declares them.
- Keep `requires` of `manifest.json` an empty list and add no `optional`: a
  foundation bundle activates before the core and may use only `doric.*`
  contracts.
- Read every environment value through the `environment` of `PostgresOptions`
  (`src/host/options.ts`); only `createPostgres` in `src/host/postgres.ts`
  falls back to `process.env`.
- Never open the database during `activate` or at module load: take the
  client only through the `DatabaseHandle` of `src/host/database.ts`, inside
  the method that needs it, so that the build's dry activation and a host
  start without `DORIC_DATABASE_URL` still activate the bundle.
- Create a Prisma client only through `createDatabase` in `src/prisma.ts`,
  and never pass the client, a transaction or a connection out of a method;
  only `src/testing.ts` may export `PrismaClient` and `Database`, for tests.
- Import Prisma only from `src/prisma.ts` or `src/generated/prisma/client.js`;
  never import `@prisma/client` from a tracked file.
- Keep `@prisma/client` in the `dependencies` of [`package.json`](package.json)
  and keep its entry whose `bundle` is `'postgres'` and `package` is
  `'@prisma/client'` in `dependencyExceptions` of
  [`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs):
  only the generated client, which is not tracked, imports that package, so
  the boundary check sees no import of it, and the entry keeps the check from
  reporting it as unused while the generated client needs it at run time.
  Never remove that entry and never widen it to another package or bundle; for
  any other dependency, import it from a tracked file, or remove it.
- Keep `health` and `capabilities` free of database calls, so a database
  outage is never reported as low storage.
- Write the storage tables only with raw SQL in `src/host/storage/`, and run
  every write of a commit or a declaration inside one `$transaction` with
  `transactionOptions` of `src/host/storage/sql.ts`.
- In a commit, take every lock through `lock()` before the first read, and
  take `lockPosition()` last, right before the position is computed; never
  give `storage_commit` a sequence or any other way to take a position, since
  a position taken outside that lock leaves gaps in the feed.
- Raise every contract failure as a `ContractError` with a code the contract
  defines, and use the error helpers of `storage` (`revisionConflict`,
  `sequenceConflict`, `uniqueConflict`, `checkBatchLimits`) where one exists.
- Never return an empty secret for a stored secret that cannot be decrypted,
  and keep reading every envelope version the bundle has written: add a new
  version prefix in `src/host/secrets/envelope.ts` instead of changing `v1`.
- Change the schema only by adding a migration directory under
  `prisma/migrations/`, named with a timestamp later than every existing one,
  together with the matching change to `prisma/schema.prisma`; never edit a
  migration that exists.
- Write in the migration SQL what Prisma cannot express, keep `COLLATE "C"` on
  every text key column of `storage_type`, `storage_document`,
  `storage_index_entry`, `storage_stream`, `storage_stream_entry` and
  `storage_truncation`, and never schema-qualify a table
  name, because the tests apply each `migration.sql` inside a schema of their
  own through `search_path`.
- Run `npx nx run bundle-postgres:prisma-generate` after a change to
  `prisma/schema.prisma`; the `build` and `typecheck` targets also run it
  first. Never edit or track `src/generated/prisma/`, which that target
  writes.
- Put a storage feature in a file of `src/host/storage/`, and wire its method
  in `src/host/storage/backend.ts`; put a secrets feature in
  `src/host/secrets/`, and wire it in `src/host/secrets/backend.ts`.
- Test a storage behavior in the `tests/storage-*.test.ts` file of its area,
  with `storageTest` of `tests/support/storage.ts`, and keep
  `tests/conformance.test.ts` running the whole kit of `storage/conformance`;
  add a case that every storage backend must pass to that kit in
  `packages/storage`, not here.
- Test a secrets behavior in `tests/secrets.test.ts`, and test a new migration
  in a test file that builds its database with
  `createTestDatabase({ until: '<new directory>' })` of
  `tests/support/database.ts`, seeds it through `query`, then applies the new
  migration with `migrate('<new directory>')` and checks the data it must
  keep.
- Keep `tests/health.test.ts` free of PostgreSQL, and skip every other suite
  without `DORIC_TEST_DATABASE_URL` through `skipWithoutDatabase`.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "postgres"`.
- Update [`README.md`](README.md) in the same change as any change to a
  method's behavior, the schema, the configuration or the errors; update the
  feature doc [credentials](../../../docs/features/credentials.md) when the
  change touches the `credential` table, the envelope, `DORIC_CREDENTIAL_KEY`
  or a `secrets.backend/v1` error, and
  [projects and threads](../../../docs/features/projects-and-threads.md) when
  it touches the storage health measure.

## Verify

- `npx nx run bundle-postgres:typecheck`: run it after any change under
  `src/` or to `prisma/schema.prisma`.
- `npx nx run bundle-postgres:test`: run it after any change under `src/`,
  `tests/` or `prisma/`, with `DORIC_TEST_DATABASE_URL` set to a PostgreSQL
  you may create schemas in, since the suites that need PostgreSQL skip
  without it; run the tests only through this target, which builds the bundle
  first.
- `npx nx run bundle-postgres:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file or
  `prisma/schema.prisma`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
