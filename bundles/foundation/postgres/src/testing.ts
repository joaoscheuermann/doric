// `postgres/testing` (Node): the bundle's services with injected options and
// the Prisma client for tests that read or seed the database directly.

export {
  createPostgresBackends,
  type PostgresBackends,
  type PostgresBackendsOptions,
} from './host/backends.js';
export type {
  DiskMeasurement,
  PostgresOptions,
} from './host/options.js';
export { createPostgres, type Postgres } from './host/postgres.js';
export type { Database } from './prisma.js';
export { PrismaClient } from './prisma.js';
