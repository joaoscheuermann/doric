import {
  type Call,
  type CommitBatch,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
  type StorageBackend,
  StorageBackendV1,
  type StorageCapabilities,
  type StorageTypeDefinition,
  StorageV1,
  storageMethods,
} from 'bundle/contracts';
import { checkBatchLimits, parseStreamId } from 'storage';
import type { StorageFacade } from 'storage/rpc';

import { describeIssues } from '../../shared/issues.js';
import { routedViewOf, type View, viewOf } from '../../shared/partition.js';
import {
  assertDefinitionOwner,
  assertDefinitionOwnerIn,
  type CatalogLookup,
  type CoreState,
  PLATFORM,
} from '../../shared/state.js';
import type { CoreBinding } from '../binding.js';
import { createTypeRegistry, type TypeEntry } from './registry.js';
import { assertIndexes, fingerprintOf } from './validate.js';

type TypeRegistry = ReturnType<typeof createTypeRegistry>;

/** The registered type, or `unknown_type`. */
const registered = (
  types: TypeRegistry,
  type: string,
  view: View,
): TypeEntry => {
  const entry = types.get(type, view);

  if (entry === undefined) {
    throw new ContractError(
      'unknown_type',
      `Storage type ${type} is not defined.`,
      { type },
    );
  }

  return entry;
};

const assertTypeOwner = (entry: TypeEntry, call: Call): void => {
  const caller = call.caller.bundleId;

  if (caller !== PLATFORM && caller !== entry.owner) {
    throw new ContractError(
      'not_owner',
      `Bundle "${caller}" cannot use storage type ${entry.definition.type}, owned by "${entry.owner}".`,
      { type: entry.definition.type, owner: entry.owner },
    );
  }
};

/** The deferred declaration; a failure is not kept, so the next call retries. */
const declared = async (
  entry: TypeEntry,
  backend: StorageBackend,
  call: Call,
): Promise<void> => {
  if (entry.declared === undefined) {
    const pending = backend.declareType(
      {
        type: entry.definition.type,
        indexes: entry.definition.indexes.map(({ name, fields, unique }) => ({
          name,
          fields: [...fields],
          ...(unique === undefined ? {} : { unique }),
        })),
      },
      call,
    );

    entry.declared = pending;
    void pending.catch(() => {
      if (entry.declared === pending) {
        entry.declared = undefined;
      }
    });
  }

  await entry.declared;
};

/** The type a read of `call` uses, or `undefined` for a raw platform read. */
const readable = async (
  types: TypeRegistry,
  type: string,
  view: View,
  backend: () => StorageBackend,
  call: Call,
): Promise<TypeEntry | undefined> => {
  const entry = types.get(type, view);

  // The platform reads raw, even a type nobody defines now.
  if (entry === undefined && call.caller.bundleId === PLATFORM) {
    return undefined;
  }

  const known = registered(types, type, view);

  assertTypeOwner(known, call);
  await declared(known, backend(), call);

  return known;
};

/** A stream the caller may read: its own, or any for the platform. */
const assertStreamReader = (stream: string, call: Call): void => {
  const { owner } = parseStreamId(stream);
  const caller = call.caller.bundleId;

  if (caller !== PLATFORM && caller !== owner) {
    throw new ContractError(
      'not_owner',
      `Bundle "${caller}" cannot read stream ${stream}, owned by "${owner}".`,
      { stream, owner },
    );
  }
};

/** A stream the caller may write: its own, or any for the active events/v1 provider. */
const assertStreamWriter = async (
  stream: string,
  call: Call,
  catalog: () => CatalogLookup | Promise<CatalogLookup>,
): Promise<void> => {
  const { owner } = parseStreamId(stream);
  const caller = call.caller.bundleId;

  if (
    caller === PLATFORM ||
    caller === owner ||
    (await catalog()).activeProvider(EventsV1.id) === caller
  ) {
    return;
  }

  throw new ContractError(
    'not_owner',
    `Bundle "${caller}" cannot write stream ${stream}, owned by "${owner}".`,
    { stream, owner },
  );
};

/** The backend's limits, asked once; a failure is not kept, so the next call retries. */
const createLimits = () => {
  let limits: Promise<StorageCapabilities> | undefined;

  return async (
    backend: StorageBackend,
    call: Call,
  ): Promise<StorageCapabilities> => {
    if (limits === undefined) {
      const pending = backend.capabilities(call);

      limits = pending;
      void pending.catch(() => {
        if (limits === pending) {
          limits = undefined;
        }
      });
    }

    return await limits;
  };
};

/** Checks and sends a batch: ownership, schemas, limits, then the deferred declarations. */
const commitTo = async (
  types: TypeRegistry,
  capabilities: ReturnType<typeof createLimits>,
  batch: CommitBatch,
  view: View,
  catalog: () => CatalogLookup | Promise<CatalogLookup>,
  backend: () => StorageBackend,
  call: Call,
) => {
  const touched = new Map<string, TypeEntry>();
  const use = (type: string): TypeEntry => {
    const entry = registered(types, type, view);

    assertTypeOwner(entry, call);
    touched.set(type, entry);

    return entry;
  };

  for (const key of batch.expect ?? []) {
    use(key.type);
  }

  for (const key of batch.delete ?? []) {
    use(key.type);
  }

  const put = (batch.put ?? []).map((document) => {
    const entry = use(document.type);
    const parsed = entry.definition.schema.safeParse(document.value);

    if (!parsed.success) {
      throw new ContractError(
        'invalid_input',
        `Invalid ${document.type} document ${document.id}: ${describeIssues(parsed.error)}`,
        { type: document.type, id: document.id },
      );
    }

    return { ...document, value: parsed.data as unknown };
  });

  for (const stream of batch.dropStreams ?? []) {
    await assertStreamWriter(stream, call, catalog);
  }

  if (batch.truncate !== undefined) {
    await assertStreamWriter(batch.truncate.stream, call, catalog);
  }

  for (const append of batch.append ?? []) {
    await assertStreamWriter(append.stream, call, catalog);
  }

  const checked: CommitBatch = {
    ...batch,
    ...(batch.put === undefined ? {} : { put }),
  };

  checkBatchLimits(checked, await capabilities(backend(), call));

  for (const entry of touched.values()) {
    await declared(entry, backend(), call);
  }

  return await backend().commit(checked, call);
};

/**
 * The core's `storage/v1`: a facade over the chosen `storage.backend/v1` that
 * enforces ownership (types by namespace and `provides`, streams by their
 * first segment), validates every written value with the type's schema,
 * refuses a batch over the backend's limits before sending it, and declares
 * a type to the backend only when the first operation on it runs. Defining a
 * type does no I/O, so activation never reaches the database.
 */
export const createStorage = (state: CoreState) => {
  const types = createTypeRegistry();
  const capabilities = createLimits();

  const backendOf = (services: Services) => services.use(StorageBackendV1);

  return defineService(StorageV1, {
    defineType: defineMethod({
      ...storageMethods.defineType,
      execute: (definition: StorageTypeDefinition, call, services) => {
        assertDefinitionOwner(
          state,
          call,
          services,
          definition.type,
          'storage type',
        );
        assertIndexes(definition);

        return types.register(
          definition,
          call.caller.bundleId,
          fingerprintOf(definition),
          viewOf(call, services),
        );
      },
    }),
    get: defineMethod({
      ...storageMethods.get,
      execute: async (key, call, services) => {
        const backend = () => backendOf(services);

        await readable(types, key.type, viewOf(call, services), backend, call);

        return await backend().get(key, call);
      },
    }),
    query: defineMethod({
      ...storageMethods.query,
      execute: async (query, call, services) => {
        const backend = () => backendOf(services);

        await readable(
          types,
          query.type,
          viewOf(call, services),
          backend,
          call,
        );

        return await backend().query(query, call);
      },
    }),
    read: defineMethod({
      ...storageMethods.read,
      execute: async (request, call, services) => {
        assertStreamReader(request.stream, call);

        return await backendOf(services).read(request, call);
      },
    }),
    commit: defineMethod({
      ...storageMethods.commit,
      execute: async (batch, call, services) =>
        await commitTo(
          types,
          capabilities,
          batch,
          viewOf(call, services),
          () => state.catalog(call, services),
          () => backendOf(services),
          call,
        ),
    }),
    health: defineMethod({
      ...storageMethods.health,
      execute: async (_input, call, services) =>
        await backendOf(services).health(call),
    }),
    putBlob: defineMethod({
      ...storageMethods.putBlob,
      execute: async (bytes, call, services) =>
        await backendOf(services).putBlob(bytes, call),
    }),
    getBlob: defineMethod({
      ...storageMethods.getBlob,
      execute: async (hash, call, services) =>
        await backendOf(services).getBlob(hash, call),
    }),
    deleteBlob: defineMethod({
      ...storageMethods.deleteBlob,
      execute: async (hash, call, services) => {
        await backendOf(services).deleteBlob(hash, call);
      },
    }),
  });
};

/**
 * The core's `storage/v1` over the router, for `serveStorage`: the rules of
 * {@link createStorage} with the router's stamp for the generation view
 * (`routedViewOf`), the catalog of `doric.catalog/v1` read asynchronously,
 * and the backend `activate` bound. `defineType` settles once its ownership
 * check read the catalog. Every method fails with `unavailable` until
 * `activate` ran.
 */
export const createStorageFacade = (
  bind: () => CoreBinding,
): StorageFacade => {
  const types = createTypeRegistry();
  const capabilities = createLimits();

  const backend = (): StorageBackend => bind().storageBackend;

  const viewFor = async (call: Call): Promise<View> =>
    routedViewOf(call, await bind().catalog(call));

  return {
    defineType: async (definition, call) => {
      const catalog = await bind().catalog(call);

      assertDefinitionOwnerIn(catalog, call, definition.type, 'storage type');
      assertIndexes(definition);

      return types.register(
        definition,
        call.caller.bundleId,
        fingerprintOf(definition),
        routedViewOf(call, catalog),
      );
    },
    get: async (key, call) => {
      await readable(types, key.type, await viewFor(call), backend, call);

      return await backend().get(key, call);
    },
    query: async (query, call) => {
      await readable(types, query.type, await viewFor(call), backend, call);

      return await backend().query(query, call);
    },
    read: async (request, call) => {
      assertStreamReader(request.stream, call);

      return await backend().read(request, call);
    },
    commit: async (batch, call) =>
      await commitTo(
        types,
        capabilities,
        batch,
        await viewFor(call),
        async () => await bind().catalog(call),
        backend,
        call,
      ),
    health: async (call) => await backend().health(call),
    putBlob: async (bytes, call) => await backend().putBlob(bytes, call),
    getBlob: async (hash, call) => await backend().getBlob(hash, call),
    deleteBlob: async (hash, call) => {
      await backend().deleteBlob(hash, call);
    },
  };
};
