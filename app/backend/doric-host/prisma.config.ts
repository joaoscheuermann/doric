import { defineConfig } from 'prisma/config';

// The Prisma schema and migrations belong to the `postgres` bundle. This
// config keeps every `--config app/backend/doric-host/prisma.config.ts` command (the
// Compose and image `migrate` steps, `nx run doric-host:migrate`) pointing at them.
export default defineConfig({
  schema: '../../../bundles/foundation/postgres/prisma/schema.prisma',
  migrations: {
    path: '../../../bundles/foundation/postgres/prisma/migrations',
  },
  datasource: {
    url:
      process.env.DORIC_DATABASE_URL ??
      'postgresql://doric:doric@127.0.0.1:5432/doric',
  },
});
