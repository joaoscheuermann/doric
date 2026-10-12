// `postgres/testing` (Node): the bundle's services with injected options,
// and the bundle as an embedded foundation.
export type {
  DiskMeasurement,
  PostgresOptions,
} from './host/options.js';
export {
  createPostgres,
  type Postgres,
  postgresEmbedded,
} from './host/postgres.js';
