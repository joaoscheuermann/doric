// `storage/v1` between `core`'s facade and the bundles that store data
// (spec `docs/designs/grpc-processes.md`, section 17, "Storage until phase
// 4"): `core` serves its facade with `serveStorage`, `runtime` and `mcp` call
// it with `storageClient`. Phase 4 deletes this file with the contract.

import { randomUUID } from 'node:crypto';

import type {
  JsonObject as WireJsonObject,
  JsonValue as WireJsonValue,
} from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import {
  type HostInstances,
  type HostRegistrations,
  type StampedCaller,
  stampedCallerOf,
} from 'bundle/host';
import {
  type Call,
  type CommitBatch,
  type ContractId,
  ContractError,
  callOf,
  type Disposable,
  defineStorageType,
  type JsonObject,
  type JsonValue,
  type Storage,
  type StorageHealth,
  type StoragePage,
  type StorageQuery,
  type StorageTypeDefinition,
  type StoredDocument,
  type StreamPage,
  type streamReadSchema,
} from 'bundle/contracts';
import type { StorageIndex as WireIndex } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import {
  memberSchema,
  type SchemaCheck,
  type SchemaValidators,
} from 'bundle/runtime';
import { z } from 'zod';

import { calling, clientFailure, connectOptionsOf } from './call.js';
import {
  blobAnswer,
  blobItemsOf,
  blobOf,
  commitBatchOf,
  commitItemsOf,
  documentAnswer,
  healthOf,
  indexesOf,
  queryAnswer,
  queryOf,
  readAnswer,
  readBlob,
  readDocument,
  readQueryPage,
  readStreamPage,
  wireHealthOf,
  wireQueryOf,
} from './wire.js';

/**
 * The provider's side of `storage/v1`: today's `Storage` methods, each with
 * the `Call` of the request that reached it, so the facade knows its caller
 * (`call.caller` `{ bundleId, version, generation }`, the router's stamp),
 * scope, trace, signal and deadline (`deadlineOf(call)`).
 *
 * `defineType` registers `definition` for `call.caller` and answers the
 * `Disposable` that removes that one registration; it does no I/O and throws
 * synchronously a `ContractError` (`not_owner`, `undeclared_provide`,
 * `invalid_input`, `registration_conflict`) when it refuses. Every other
 * method keeps today's semantics and errors (the header of `storage.proto`),
 * and rejects with a `ContractError`. `core`'s `createStorage` implements
 * it; tests implement it over the memory backend.
 */
export interface StorageFacade {
  defineType(definition: StorageTypeDefinition, call: Call): Disposable;
  get(
    key: { readonly type: string; readonly id: string },
    call: Call,
  ): Promise<StoredDocument | undefined>;
  query(query: StorageQuery, call: Call): Promise<StoragePage>;
  read(
    request: z.input<typeof streamReadSchema>,
    call: Call,
  ): Promise<StreamPage>;
  commit(batch: CommitBatch, call: Call): Promise<{ position: number }>;
  health(call: Call): Promise<StorageHealth>;
  /** Base64 bytes in, `sha256:<hex>` out. */
  putBlob(bytes: string, call: Call): Promise<{ hash: string }>;
  /** The blob's base64, `''` for the empty blob; `undefined` when unknown. */
  getBlob(hash: string, call: Call): Promise<string | undefined>;
  deleteBlob(hash: string, call: Call): Promise<void>;
}

export interface ServeStorageOptions {
  /**
   * Compiles a `DefineType`'s JSON Schema into the check the rebuilt
   * definition's schema runs (`ajvValidators()` in `core`).
   */
  readonly validators: SchemaValidators;
  /**
   * `context.instances` of the serving host part. Given: the registrations
   * of an instance `InstanceGone` names are disposed. Absent (tests): no
   * registration ends but by `Undefine`.
   */
  readonly instances?: HostInstances;
}

/**
 * The definition a `DefineType` request describes, rebuilt as the envelope
 * does: a loose object refined by the compiled JSON Schema, each issue at
 * its path. `invalid_input` when the schema does not compile or the type is
 * refused by `defineStorageType`.
 */
const definitionOf = (
  type: string,
  schema: JsonObject,
  indexes: readonly WireIndex[],
  validators: SchemaValidators,
): StorageTypeDefinition => {
  let check: SchemaCheck;

  try {
    check = validators.compile(schema);
  } catch (error) {
    throw new ContractError(
      'invalid_input',
      `The schema of storage type ${type} does not compile: ${messageOf(error)}`,
    );
  }

  const refined = z.looseObject({}).superRefine((value, context) => {
    for (const issue of check(value)) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: [...issue.path],
      });
    }
  });

  try {
    return defineStorageType({
      type: type as ContractId,
      schema: refined,
      indexes: indexesOf(indexes),
    });
  } catch (error) {
    throw new ContractError('invalid_input', messageOf(error));
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isList = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

/** `value` as the `google.protobuf.Struct` field of a request holds it. */
const structValueOf = (value: JsonValue): WireJsonValue => {
  if (isList(value)) {
    return value.map(structValueOf);
  }

  if (typeof value === 'object' && value !== null) {
    return structOf(value);
  }

  return value;
};

const structOf = (object: JsonObject): WireJsonObject =>
  Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, structValueOf(value)]),
  );

/** The `DefineType` request of `definition`. */
const defineRequestOf = (definition: StorageTypeDefinition) => ({
  type: definition.type,
  schema: structOf(memberSchema(definition.schema, 'input').schema),
  indexes: indexesOf(definition.indexes),
});

/**
 * The implementation of `doric.storage.v1.StorageService` over `facade`, for
 * the `services` entry `[StorageService, serveStorage(facade, options)]` of
 * `runBundle` or `createTestRouter().activate`.
 *
 * Every RPC calls the matching `facade` method once, with `callOf(context)`
 * as its `call`, and answers in the wire shape of section 17 (table in §2):
 * `Get` answers the document's item then its value's chunks, or no item when
 * `facade.get` answers `undefined`; `Query` and `Read` answer the page's head
 * first, then one item per document or entry, each followed by its value's
 * chunks; `GetBlob` answers `head { found }` first, then, when found, the
 * bytes in chunks; `Commit` and `PutBlob` read their whole request stream
 * and call the facade once, after the stream ended. Every chunk is non-empty
 * and at most 1 MiB; fields the facade leaves absent stay absent.
 *
 * `DefineType` rebuilds the definition as the envelope does —
 * `defineStorageType({ type, schema, indexes })` whose `schema` is a loose
 * object refined by `options.validators.compile(<the Struct as JSON>)`, each
 * issue reported at its path; `unique` absent stays absent — calls
 * `facade.defineType(definition, call)` and answers a new `registrationId`:
 * opaque, unique among this server's answers, never answered again. It keeps
 * the answered `Disposable` with the stamped caller (`stampedCallerOf`) until
 * one of:
 * - `Undefine { registrationId }` from the same bundle (`call.caller
 *   .bundleId` equal to the defining caller's, any instance of it): disposes
 *   it once and forgets the id. An unknown or forgotten id, or one another
 *   bundle defined, is a no-op answered `{}`;
 * - `InstanceGone` of the defining instance (same `bundleId`, `generation`
 *   and `incarnation`), when `options.instances` was given: disposes every
 *   registration of that instance, as `RegistrationTable.dropInstance` does.
 * The documents of a type stay stored in every case.
 *
 * Fails a call with what `facade` threw, unchanged when it is a
 * `ContractError` (code, message, details), as `internal` otherwise. Fails
 * with `invalid_input`, without calling `facade`, when: a `Commit` request
 * stream is malformed (the same rules as `serveStorageBackend`: a `chunk`
 * that follows no `put` or `event`, a `put` with no chunk, an `append` with
 * no `event`, a second `truncate`, a value that is not UTF-8 JSON text); a
 * `DefineType` schema cannot be compiled by `options.validators`; or the
 * type is refused by `defineStorageType` (a platform-reserved id). Never
 * calls `facade` for a request the router refused (protovalidate). Holds,
 * besides the registrations, no state between calls.
 */
export const serveStorage = (
  facade: StorageFacade,
  options: ServeStorageOptions,
): ServiceImpl<typeof StorageService> => {
  const registrations = new Map<
    string,
    { readonly disposable: Disposable; readonly caller: StampedCaller }
  >();

  options.instances?.onGone((instance) => {
    for (const [id, { disposable, caller }] of registrations) {
      if (
        caller.bundleId === instance.bundleId &&
        caller.generation === instance.generation &&
        caller.incarnation === instance.incarnation
      ) {
        registrations.delete(id);
        disposable.dispose();
      }
    }
  });

  return {
    defineType: ({ type, schema, indexes }, context) => {
      const definition = definitionOf(
        type,
        schema ?? {},
        indexes,
        options.validators,
      );
      const caller = stampedCallerOf(context);
      const disposable = facade.defineType(definition, callOf(context));
      const registrationId = randomUUID();

      registrations.set(registrationId, { disposable, caller });

      return { registrationId };
    },
    undefine: ({ registrationId }, context) => {
      const registration = registrations.get(registrationId);

      if (
        registration !== undefined &&
        registration.caller.bundleId === callOf(context).caller.bundleId
      ) {
        registrations.delete(registrationId);
        registration.disposable.dispose();
      }

      return {};
    },
    async *get({ type, id }, context) {
      yield* documentAnswer(await facade.get({ type, id }, callOf(context)));
    },
    async *query({ storageQuery }, context) {
      if (storageQuery === undefined) {
        throw new ContractError('invalid_input', 'storageQuery is required.');
      }

      yield* queryAnswer(
        await facade.query(queryOf(storageQuery), callOf(context)),
      );
    },
    async *read({ streamRead }, context) {
      if (streamRead === undefined) {
        throw new ContractError('invalid_input', 'streamRead is required.');
      }

      const { stream, afterSequence, limit } = streamRead;

      yield* readAnswer(
        await facade.read({ stream, afterSequence, limit }, callOf(context)),
      );
    },
    commit: async (requests, context) =>
      facade.commit(await commitBatchOf(requests), callOf(context)),
    health: async (_request, context) => ({
      storageHealth: wireHealthOf(await facade.health(callOf(context))),
    }),
    putBlob: async (requests, context) =>
      facade.putBlob(await blobOf(requests), callOf(context)),
    async *getBlob({ hash }, context) {
      yield* blobAnswer(await facade.getBlob(hash, callOf(context)));
    },
    deleteBlob: async ({ hash }, context) => {
      await facade.deleteBlob(hash, callOf(context));

      return {};
    },
  };
};

export interface StorageClientOptions {
  /**
   * `context.registrations` of the calling host part. Given: each
   * `defineType` is made with `registrations.track(StorageService, …)`, so
   * the SDK replays it to every new instance of `storage/v1`'s provider
   * (`ProviderChanged`) and the registration's id follows the replay's
   * answer. Absent (tests): `defineType` is one call through `client`.
   */
  readonly registrations?: HostRegistrations;
}

/** Today's `Storage`, with a way to learn the outcome of `defineType`. */
export interface StorageClient extends Storage {
  /**
   * Resolves once every `DefineType` and `Undefine` this client sent so far
   * has settled, when none of those `DefineType`s was refused. Rejects with
   * the first refusal (the provider's `ContractError`, unchanged) not
   * reported by an earlier `settled()`, and forgets it, as the envelope's
   * `settle` does; a host part awaits it in `activate` to fail its
   * activation on a refused type, as today.
   */
  settled(): Promise<void>;
}

/**
 * A `Storage` that calls `doric.storage.v1.StorageService` through `client`
 * (`context.services.use(StorageService)`, or `createTestRouter().client(
 * StorageService)`), so code written against `Storage` (the stores of
 * `runtime` and `mcp`) works unchanged over the router.
 *
 * `defineType(definition)` returns a `Disposable` at once and never throws:
 * it sends `DefineType { type, schema, indexes }`, `schema` the Struct of
 * `memberSchema(definition.schema, 'input').schema`, `indexes` in order with
 * `unique` only when set; a refusal is reported by `settled()`. `dispose()`
 * is idempotent: once the `DefineType` resolved (at once if it already had),
 * it stops the replay (`untrack`) and sends `Undefine` with the last
 * answered `registrationId`; after a refused `DefineType` it sends nothing.
 * An `Undefine` failure is not reported.
 *
 * Ordering: every call through the client starts after every `DefineType`
 * and `Undefine` the client sent before it has settled, so a definition is
 * in place before the first operation that names its type, and gone before
 * the first operation after `dispose()`.
 *
 * The other methods make one call each and resolve with today's shapes,
 * as `storageBackendClient` does: absent fields omitted, never `undefined`;
 * `get` answers `undefined` for a stream without item; `query` answers
 * `{ items, cursor? }`; `read` answers `{ entries, lastSequence,
 * truncations }`; `getBlob` answers `undefined` for `found: false`, else the
 * base64 of the bytes (`''` for an empty blob); `putBlob` decodes the base64
 * and sends its bytes in chunks; `commit` sends one item per batch entry in
 * the order expect, put, delete, drop_stream, truncate, append (each `put`
 * followed by its value's chunks, each `append` by one `event` per event and
 * `chunk`s for the rest) and answers `{ position }`; `deleteBlob` resolves
 * with `undefined`.
 *
 * `call`: a `Call` or `CallOptions` aborts the call when its signal aborts
 * and ends it at its deadline; inside a handler of the host SDK, scope and
 * trace follow `currentCall()`.
 *
 * Rejects with a `ContractError`: the provider's error as `fromConnectError`
 * reads it (`revision_conflict` with its details, `sequence_conflict`,
 * `unique_conflict`, `limit_exceeded`, `unknown_type`, `invalid_index_value`,
 * `invalid_stream`, `invalid_input`, `not_owner`), and the transport's
 * `unavailable`, `cancelled`, `deadline_exceeded`; `cancelled` without any
 * call for an already aborted signal; `invalid_input` without any call when
 * `putBlob`'s argument is not canonical base64 or a `put` value or event
 * cannot be `JSON.stringify`d; `invalid_output` when an answer breaks the
 * wire shape (a `chunk` before any item, a second `document` in `Get`, no
 * head first in `Query`, `Read` or `GetBlob`, chunks after `found: false`, a
 * value that is not UTF-8 JSON). Never throws synchronously. No zod
 * validation of arguments: the provider validates.
 */
export const storageClient = (
  client: Client<typeof StorageService>,
  options: StorageClientOptions = {},
): StorageClient => {
  // Settles once every `DefineType` and `Undefine` sent so far settled; never
  // rejects. Each registration call starts after the previous ones.
  let registered: Promise<void> = Promise.resolve();
  const refusals: ContractError[] = [];

  const register = (run: () => Promise<void>): void => {
    registered = registered.then(run);
  };

  /** Runs a call once the registrations sent before it settled. */
  const after = <T>(run: () => Promise<T>): Promise<T> => {
    const before = registered;

    return calling(async () => {
      await before;

      return await run();
    });
  };

  const defineType = (definition: StorageTypeDefinition): Disposable => {
    let registrationId: string | undefined;
    let untrack: (() => void) | undefined;
    let disposed = false;

    register(async () => {
      try {
        const request = defineRequestOf(definition);

        if (options.registrations === undefined) {
          ({ registrationId } = await client.defineType(request));
        } else {
          const tracked = await options.registrations.track(
            StorageService,
            (provider) => provider.defineType(request),
            {
              onReplayed: (answer) => {
                registrationId = answer.registrationId;
              },
            },
          );

          registrationId = tracked.current.registrationId;
          untrack = tracked.untrack;
        }
      } catch (error) {
        refusals.push(clientFailure(error));
      }
    });

    return {
      dispose: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        register(async () => {
          untrack?.();

          if (registrationId === undefined) {
            return;
          }

          await client
            .undefine({ registrationId })
            .then(undefined, () => undefined);
        });
      },
    };
  };

  return {
    defineType,
    settled: async () => {
      await registered;

      const refusal = refusals.shift();

      if (refusal !== undefined) {
        throw refusal;
      }
    },
    get: (key, call) =>
      after(() =>
        readDocument(
          client.get({ type: key.type, id: key.id }, connectOptionsOf(call)),
        ),
      ),
    query: (query, call) =>
      after(() =>
        readQueryPage(
          client.query(
            { storageQuery: wireQueryOf(query) },
            connectOptionsOf(call),
          ),
        ),
      ),
    read: (request, call) =>
      after(() =>
        readStreamPage(
          client.read(
            {
              streamRead: {
                stream: request.stream,
                afterSequence: request.afterSequence,
                limit: request.limit,
              },
            },
            connectOptionsOf(call),
          ),
        ),
      ),
    commit: (batch, call) =>
      after(async () => {
        const items = commitItemsOf(batch);
        const { position } = await client.commit(
          createAsyncIterable(items),
          connectOptionsOf(call),
        );

        return { position };
      }),
    health: (call) =>
      after(async () => {
        const { storageHealth } = await client.health(
          {},
          connectOptionsOf(call),
        );

        return healthOf(storageHealth);
      }),
    putBlob: (bytes, call) =>
      after(async () => {
        const items = blobItemsOf(bytes);
        const { hash } = await client.putBlob(
          createAsyncIterable(items),
          connectOptionsOf(call),
        );

        return { hash };
      }),
    getBlob: (hash, call) =>
      after(() => readBlob(client.getBlob({ hash }, connectOptionsOf(call)))),
    deleteBlob: (hash, call) =>
      after(async () => {
        await client.deleteBlob({ hash }, connectOptionsOf(call));
      }),
  };
};
