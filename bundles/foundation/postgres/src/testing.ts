// `postgres/testing` (Node): the bundle's services with injected options,
// the bundle as an embedded foundation, and the Prisma client for tests that
// read or seed the database directly.
export type {
  DiskMeasurement,
  PostgresOptions,
} from './host/options.js';
export {
  createPostgres,
  type Postgres,
  postgresEmbedded,
} from './host/postgres.js';
export {
  createPostgresBackends,
  type PostgresBackends,
  type PostgresBackendsOptions,
} from './host/backends.js';
export type { Database } from './prisma.js';
export { PrismaClient } from './prisma.js';
