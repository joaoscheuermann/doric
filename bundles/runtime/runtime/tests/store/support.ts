import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { PrismaPg } from '@prisma/adapter-pg';
import { createTestServices } from 'bundle';
import {
  ContractError,
  type Disposable,
  type Storage,
  type StorageBackend,
  StorageBackendV1,
  type StorageCapabilities,
  type StorageTypeDefinition,
} from 'bundle/contracts';
import pg from 'pg';
import { PrismaClient } from 'postgres/prisma';
import { createPostgres } from 'postgres/testing';
import { createMemoryStore, memoryStorageBackend } from 'storage/memory';

import type { DoricConfiguration } from '../../src/contracts/configuration.js';
import type {
  HistoryPatch,
  HistoryReader,
} from '../../src/contracts/executor.js';
import {
  createRuntimeStores,
  type RuntimeStores,
  runtimeStorageTypes,
} from '../../src/host/store/index.js';

/** The PostgreSQL the database cases run against; they skip without it. */
export const connectionString = process.env.DORIC_TEST_DATABASE_URL;

/**
 * `storage/v1` over a backend, as the core facade serves it to the runtime:
 * a type is declared to the backend before its first operation, and every
 * put is validated against the defined type's schema. (Ownership is the
 * facade's own concern and is tested in `bundles/foundation/core`.)
 */
export const storageOver = (backend: StorageBackend): Storage => {
  const types = new Map<string, StorageTypeDefinition>();
  const declared = new Map<string, Promise<void>>();

  const ready = (type: string): Promise<void> => {
    const definition = types.get(type);
    if (definition === undefined)
      throw new ContractError(
        'unknown_type',
        `Storage type ${type} is not defined.`,
      );
    let pending = declared.get(type);
    if (pending === undefined) {
      pending = backend.declareType({
        type,
        indexes: definition.indexes.map(({ name, fields, unique }) => ({
          name,
          fields: [...fields],
          ...(unique === undefined ? {} : { unique }),
        })),
      });
      declared.set(type, pending);
    }
    return pending;
  };

  return {
    defineType(definition): Disposable {
      types.set(definition.type, definition);
      return { dispose: () => undefined };
    },
    async get(key) {
      await ready(key.type);
      return backend.get(key);
    },
    async query(query) {
      await ready(query.type);
      return backend.query(query);
    },
    read: (request) => backend.read(request),
    async commit(batch) {
      for (const key of [
        ...(batch.expect ?? []),
        ...(batch.put ?? []),
        ...(batch.delete ?? []),
      ])
        await ready(key.type);
      for (const put of batch.put ?? []) {
        const parsed = types.get(put.type)?.schema.safeParse(put.value);
        if (parsed?.success === false)
          throw new ContractError(
            'invalid_input',
            `Invalid ${put.type} document: ${parsed.error.message}`,
          );
      }
      return backend.commit(batch);
    },
    health: () => backend.health(),
  };
};

/** One storage under test, with the runtime's types defined. */
export interface Backend {
  readonly name: string;
  readonly storage: Storage;
  /** A second storage client over the same data (another process). */
  second(): Storage;
  /** Counts of backend calls by method, for the cost assertions. */
  readonly calls: Map<string, number>;
  close(): Promise<void>;
}

const counted = (
  backend: StorageBackend,
  calls: Map<string, number>,
): StorageBackend =>
  new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(property);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return (value as (...input: unknown[]) => unknown).apply(target, args);
      };
    },
  });

const defined = (storage: Storage): Storage => {
  for (const type of runtimeStorageTypes) storage.defineType(type);
  return storage;
};

export const memoryBackend = (
  limits?: Partial<StorageCapabilities>,
): Backend => {
  const store = createMemoryStore();
  const services = createTestServices({
    bundle: { id: 'runtime' },
    provide: [
      memoryStorageBackend(store, limits === undefined ? {} : { limits }),
    ],
  });
  const backend = services.services.use(StorageBackendV1);
  const calls = new Map<string, number>();
  return {
    name: 'memory',
    storage: defined(storageOver(counted(backend, calls))),
    second: () => defined(storageOver(backend)),
    calls,
    close: () => services.dispose(),
  };
};

const migrations = 'bundles/foundation/postgres/prisma/migrations';

/** A fresh PostgreSQL schema with every migration, dropped by `close`. */
export const postgresBackend = async (): Promise<Backend> => {
  if (connectionString === undefined)
    throw new Error('DORIC_TEST_DATABASE_URL is not set.');
  const releases: (() => Promise<unknown>)[] = [];
  const close = async () => {
    for (const release of releases.splice(0).reverse()) await release();
  };
  const schema = `runtime_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  releases.push(() => admin.end());
  await admin.query(`CREATE SCHEMA "${schema}"`);
  releases.push(() => admin.query(`DROP SCHEMA "${schema}" CASCADE`));
  const address = new URL(connectionString);
  address.searchParams.set('options', `-c search_path=${schema}`);
  const url = address.toString();
  const sql = new pg.Client({ connectionString: url });
  await sql.connect();
  releases.push(() => sql.end());
  for (const name of (await readdir(migrations))
    .filter((entry) => entry !== 'migration_lock.toml')
    .sort())
    await sql.query(
      await readFile(`${migrations}/${name}/migration.sql`, 'utf8'),
    );
  const open = (): StorageBackend => {
    const database = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }, { schema }),
    });
    const postgres = createPostgres({
      environment: {},
      database: () => database,
    });
    const services = createTestServices({
      bundle: { id: 'runtime' },
      provide: [postgres.storage],
    });
    releases.push(async () => {
      await services.dispose();
      await database.$disconnect();
    });
    return services.services.use(StorageBackendV1);
  };
  const calls = new Map<string, number>();
  return {
    name: 'postgres',
    storage: defined(storageOver(counted(open(), calls))),
    second: () => defined(storageOver(open())),
    calls,
    close,
  };
};

/** The backends every store case runs on: memory, and PostgreSQL when set. */
export const backends: readonly {
  readonly name: string;
  readonly open: () => Promise<Backend>;
  readonly skip: string | false;
}[] = [
  { name: 'memory', open: async () => memoryBackend(), skip: false },
  {
    name: 'postgres',
    open: postgresBackend,
    skip:
      connectionString === undefined
        ? 'DORIC_TEST_DATABASE_URL is not set'
        : false,
  },
];

/**
 * A scripted executor history, standing in for Direct's: `messages` is the
 * provider history and `meta.checkpoints` the length each turn began at.
 * Its checkpoint and rewind follow the former store's rules (an existing
 * boundary wins; a rewind slices the messages and forgets removed turns).
 */
export const testFormat = 'test.history/v1';

interface Meta {
  readonly checkpoints: Readonly<Record<string, number>>;
}

export const testExecutor = {
  async checkpoint(input: {
    readonly history: HistoryReader;
    readonly promptId: string;
  }): Promise<HistoryPatch> {
    const meta = ((await input.history.read('meta')) as Meta | undefined) ?? {
      checkpoints: {},
    };
    const messages =
      ((await input.history.read('messages')) as unknown[] | undefined) ?? [];
    return {
      format: testFormat,
      parts: {
        meta: {
          checkpoints: {
            [input.promptId]: messages.length,
            ...meta.checkpoints,
          },
        },
      },
    };
  },
  async rewind(input: {
    readonly history: HistoryReader;
    readonly promptId: string;
    readonly removedPromptIds: readonly string[];
  }): Promise<HistoryPatch | undefined> {
    const meta = (await input.history.read('meta')) as Meta | undefined;
    const checkpoint = meta?.checkpoints[input.promptId];
    if (checkpoint === undefined) return undefined;
    const messages =
      ((await input.history.read('messages')) as unknown[] | undefined) ?? [];
    const removed = new Set(input.removedPromptIds);
    return {
      format: testFormat,
      parts: {
        messages: messages.slice(0, checkpoint),
        meta: {
          checkpoints: Object.fromEntries(
            Object.entries(meta?.checkpoints ?? {}).filter(
              ([id]) => !removed.has(id),
            ),
          ),
        },
      },
    };
  },
};

export const stores = (storage: Storage): RuntimeStores =>
  createRuntimeStores(storage, { executor: testExecutor });

/** A configuration snapshot as `host-config/v1` answers it. */
export const snapshot = (model = 'test-model'): DoricConfiguration =>
  ({
    configuration: { models: { execution: { model } } },
    revision: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as DoricConfiguration;

/** Saves the next messages through the store, as a run records them. */
export const saveMessages = (
  threads: RuntimeStores['threads'],
  id: string,
  messages: readonly unknown[],
) =>
  threads.saveHistory(id, {
    format: testFormat,
    parts: { messages },
  });

/** The checkpoint a dispatch writes before `prompt.started`. */
export const saveCheckpoint = async (
  threads: RuntimeStores['threads'],
  id: string,
  promptId: string,
) =>
  threads.saveCheckpoint(
    id,
    await testExecutor.checkpoint({
      history: await threads.history(id),
      promptId,
    }),
  );
