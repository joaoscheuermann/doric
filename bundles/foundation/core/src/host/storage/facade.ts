import {
  type Call,
  type CommitBatch,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
  StorageBackendV1,
  type StorageCapabilities,
  type StorageTypeDefinition,
  StorageV1,
  storageMethods,
} from 'bundle/contracts';
import { checkBatchLimits, parseStreamId } from 'storage';

import { describeIssues } from '../../shared/issues.js';
import { type View, viewOf } from '../../shared/partition.js';
import {
  assertDefinitionOwner,
  type CoreState,
  PLATFORM,
} from '../../shared/state.js';
import { createTypeRegistry, type TypeEntry } from './registry.js';
import { assertIndexes, fingerprintOf } from './validate.js';

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
  let limits: Promise<StorageCapabilities> | undefined;

  const backendOf = (services: Services) => services.use(StorageBackendV1);

  /** The registered type, or `unknown_type`. */
  const registered = (type: string, view: View): TypeEntry => {
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
    services: Services,
    call: Call,
  ): Promise<void> => {
    if (entry.declared === undefined) {
      const pending = backendOf(services).declareType(
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

  /** A stream the caller may write: its own, or any for the active events/v1 provider. */
  const assertStreamWriter = (
    stream: string,
    call: Call,
    services: Services,
  ): void => {
    const { owner } = parseStreamId(stream);
    const caller = call.caller.bundleId;

    if (
      caller === PLATFORM ||
      caller === owner ||
      state.catalog(call, services).activeProvider(EventsV1.id) === caller
    ) {
      return;
    }

    throw new ContractError(
      'not_owner',
      `Bundle "${caller}" cannot write stream ${stream}, owned by "${owner}".`,
      { stream, owner },
    );
  };

  const capabilities = async (
    services: Services,
    call: Call,
  ): Promise<StorageCapabilities> => {
    if (limits === undefined) {
      const pending = backendOf(services).capabilities(call);

      limits = pending;
      void pending.catch(() => {
        if (limits === pending) {
          limits = undefined;
        }
      });
    }

    return await limits;
  };

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
        const view = viewOf(call, services);
        const entry = types.get(key.type, view);

        // The platform reads raw, even a type nobody defines now.
        if (entry === undefined && call.caller.bundleId === PLATFORM) {
          return await backendOf(services).get(key, call);
        }

        const known = registered(key.type, view);

        assertTypeOwner(known, call);
        await declared(known, services, call);

        return await backendOf(services).get(key, call);
      },
    }),
    query: defineMethod({
      ...storageMethods.query,
      execute: async (query, call, services) => {
        const view = viewOf(call, services);
        const entry = types.get(query.type, view);

        if (entry === undefined && call.caller.bundleId === PLATFORM) {
          return await backendOf(services).query(query, call);
        }

        const known = registered(query.type, view);

        assertTypeOwner(known, call);
        await declared(known, services, call);

        return await backendOf(services).query(query, call);
      },
    }),
    read: defineMethod({
      ...storageMethods.read,
      execute: async (request, call, services) => {
        const { owner } = parseStreamId(request.stream);
        const caller = call.caller.bundleId;

        if (caller !== PLATFORM && caller !== owner) {
          throw new ContractError(
            'not_owner',
            `Bundle "${caller}" cannot read stream ${request.stream}, owned by "${owner}".`,
            { stream: request.stream, owner },
          );
        }

        return await backendOf(services).read(request, call);
      },
    }),
    commit: defineMethod({
      ...storageMethods.commit,
      execute: async (batch, call, services) => {
        const touched = new Map<string, TypeEntry>();
        const view = viewOf(call, services);
        const use = (type: string): TypeEntry => {
          const entry = registered(type, view);

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
          assertStreamWriter(stream, call, services);
        }

        if (batch.truncate !== undefined) {
          assertStreamWriter(batch.truncate.stream, call, services);
        }

        for (const append of batch.append ?? []) {
          assertStreamWriter(append.stream, call, services);
        }

        const checked: CommitBatch = {
          ...batch,
          ...(batch.put === undefined ? {} : { put }),
        };

        checkBatchLimits(checked, await capabilities(services, call));

        for (const entry of touched.values()) {
          await declared(entry, services, call);
        }

        return await backendOf(services).commit(checked, call);
      },
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
