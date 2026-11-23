// The bundle's two backends as plain objects, for the host part's process
// (`./main.ts`), where `serveStorageBackend` and `serveSecretsBackend` take a
// `StorageBackend` and a `SecretsBackend` instead of envelope definitions.
// Same tables, same SQL, same client handle as `createPostgres` (`./postgres.ts`),
// which the kernel keeps using until slice S62.

import {
  ContractError,
  type Log,
  type SecretsBackend,
  type StorageBackend,
  secretsBackendMethods,
  storageBackendMethods,
} from 'bundle/contracts';

import { createDatabaseHandle } from './database.js';
import type { PostgresOptions } from './options.js';
import { secretsOperations } from './secrets/backend.js';
import { storageOperations } from './storage/backend.js';

export interface PostgresBackendsOptions extends PostgresOptions {
  /**
   * Where `storage.connect` writes its two startup lines, at `info` with
   * empty fields: `Initializing PostgreSQL client` before connecting and
   * `PostgreSQL client initialized` after the connection and the legacy-row
   * check succeeded. Absent: nothing is written. It is never awaited, and a
   * throw from it is not caught (the host SDK's `Log` never throws).
   */
  readonly log?: Pick<Log, 'info'>;
}

/** The bundle's two backends over one lazily created Prisma client. */
export interface PostgresBackends {
  /**
   * `storage.backend/v1` on PostgreSQL. Every method behaves as the method of
   * the same name in `createPostgres(options).storage`, reached through the
   * dispatcher today:
   * - it checks its argument with the contract's zod input schema
   *   (`storageBackendMethods[method].input`) and works on the parsed value;
   *   an argument the schema refuses fails with `ContractError`
   *   `invalid_input`, details `{ contract: 'storage.backend/v1', method,
   *   issues }`, before any SQL;
   * - it answers today's values and raises today's errors
   *   (`revision_conflict`, `sequence_conflict`, `unique_conflict`,
   *   `limit_exceeded`, `unknown_type`, `invalid_index_value`,
   *   `invalid_stream`, …) unchanged;
   * - every method but `health` and `capabilities` creates the client on
   *   first use: a missing or blank `DORIC_DATABASE_URL` rejects with
   *   `Error('DORIC_DATABASE_URL is required.')` and keeps nothing, so the
   *   next call reads the variable again; a database it cannot reach rejects
   *   with Prisma's error. Neither is a `ContractError`, so both cross the
   *   router as `internal` with their message;
   * - `identity()` answers the reserved record, creating it on the first call
   *   (`{ hostId: <random uuid>, storageGeneration: 1 }`), and the same value
   *   for every later call and every instance over the same database; it does
   *   not need `connect()` first;
   * - `health()` measures `DORIC_STORAGE_PATH` (or the current directory)
   *   with `statfs` and needs no database;
   * - `connect()` writes the first `log` line, connects the client, then
   *   refuses a database holding rows in the legacy `project`, `thread` or
   *   `thread_event` tables with `Error(unmigratedReason)`, then writes the
   *   second line. It records no startup stage (the host's boot records
   *   `database_client` around its first storage call).
   *
   * `call` is accepted and ignored, as today: no method is cancelled by its
   * signal.
   */
  readonly storage: StorageBackend;
  /**
   * `secrets.backend/v1` over the `credential` table: each method behaves as
   * `createPostgres(options).secrets` through the dispatcher, with the same
   * input check (`secretsBackendMethods[method].input`, `invalid_input`
   * details `{ contract: 'secrets.backend/v1', method, issues }`) and the same
   * key rules and errors:
   * - `credential_key_required` on a read while a stored secret exists and
   *   no key is set;
   * - `credential_storage_unavailable` on a write of a secret without a key;
   * - `credential_unreadable` for a row it cannot decrypt;
   * - `credential_name_taken`.
   *
   * Secrets cross in plaintext and are sealed with `DORIC_CREDENTIAL_KEY`
   * inside. A row neither written nor deleted stays as it was.
   */
  readonly secrets: SecretsBackend;
  /**
   * Disconnects the client when this object created it from the URL. It
   * resolves at once when no client was created, or when `options.database`
   * supplied the client (the caller closes that one). Safe to call more than
   * once.
   */
  close(): Promise<void>;
}

/**
 * Builds the two backends. Reads nothing and opens nothing: the environment
 * (`options.environment`, default `process.env`), the client and the cipher
 * are read on first use, as `createPostgres` does. Never throws.
 */
export const createPostgresBackends = (
  options: PostgresBackendsOptions = {},
): PostgresBackends => {
  const environment = options.environment ?? process.env;
  const handle = createDatabaseHandle({
    environment,
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const storage = storageOperations(handle.client, {
    environment,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.statfs === undefined ? {} : { statfs: options.statfs }),
  });
  const secrets = secretsOperations(handle.client, environment);
  const storageInput = <T>(
    method: keyof typeof storageBackendMethods,
    value: unknown,
    schema: InputSchema<T>,
  ) => checkInput('storage.backend/v1', method, schema, value);
  const secretsInput = <T>(
    method: keyof typeof secretsBackendMethods,
    value: unknown,
    schema: InputSchema<T>,
  ) => checkInput('secrets.backend/v1', method, schema, value);
  const store = storageBackendMethods;
  const secret = secretsBackendMethods;

  return {
    storage: {
      declareType: (declaration) =>
        storageInput('declareType', declaration, store.declareType.input).then(storage.declareType),
      get: (key) => storageInput('get', key, store.get.input).then(storage.get),
      query: (request) => storageInput('query', request, store.query.input).then(storage.query),
      read: (request) => storageInput('read', request, store.read.input).then(storage.read),
      commit: (batch) => storageInput('commit', batch, store.commit.input).then(storage.commit),
      feed: (request) => storageInput('feed', request, store.feed.input).then(storage.feed),
      putBlob: (bytes) => storageInput('putBlob', bytes, store.putBlob.input).then(storage.putBlob),
      getBlob: (hash) => storageInput('getBlob', hash, store.getBlob.input).then(storage.getBlob),
      deleteBlob: (hash) =>
        storageInput('deleteBlob', hash, store.deleteBlob.input).then(storage.deleteBlob),
      capabilities: () => storage.capabilities(),
      health: () => storage.health(),
      identity: () => storage.identity(),
      connect: async () => {
        options.log?.info('Initializing PostgreSQL client', {});
        await handle.connect();
        options.log?.info('PostgreSQL client initialized', {});
      },
    },
    secrets: {
      get: (id) => secretsInput('get', id, secret.get.input).then(secrets.get),
      list: () => secrets.list(),
      put: (record) => secretsInput('put', record, secret.put.input).then(secrets.put),
      delete: (id) => secretsInput('delete', id, secret.delete.input).then(secrets.delete),
    },
    close: handle.close,
  };
};

/** The part of a zod schema the input check needs. */
interface InputSchema<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly code: string;
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

/**
 * The dispatcher's input check: the argument parsed with the method's input
 * schema, or a rejection with `invalid_input` and the dispatcher's details.
 */
const checkInput = <T>(
  contract: string,
  method: string,
  schema: InputSchema<T>,
  value: unknown,
): Promise<T> =>
  Promise.resolve().then(() => {
    const parsed = schema.safeParse(value);

    if (parsed.success) {
      return parsed.data;
    }

    const issues = parsed.error.issues.map(({ code, path, message }) => ({
      code,
      path: path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
      message,
    }));
    const described = issues
      .map(
        (issue) =>
          `${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`,
      )
      .join('; ');

    throw new ContractError(
      'invalid_input',
      `Invalid input for ${contract} ${method}: ${described}`,
      { contract, method, issues },
    );
  });
