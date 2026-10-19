import { createHash, randomUUID } from 'node:crypto';

import {
  type CommitBatch,
  ContractError,
  defineMethod,
  defineService,
  type FeedPage,
  StorageBackendV1,
  type StorageCapabilities,
  type StorageDeclaration,
  type StorageHealth,
  type StoragePage,
  type StorageQuery,
  type StoredDocument,
  type StreamPage,
  type StreamRead,
  storageBackendMethods,
} from 'bundle/contracts';

import { checkBatchLimits, defaultStorageCapabilities } from '../batch.js';
import { decodeCursor, encodeCursor } from '../cursor.js';
import {
  revisionConflict,
  sequenceConflict,
  uniqueConflict,
} from '../errors.js';
import {
  compareBytes,
  compareIds,
  encodeIndexKey,
  indexValues,
  keyBounds,
} from '../keys.js';
import { later } from './later.js';
import type {
  MemoryCommit,
  MemoryDocument,
  MemoryIndex,
  MemoryStore,
  MemoryStream,
} from './store.js';

export interface MemoryStorageOptions {
  /** Overrides of the default capabilities (`defaultStorageCapabilities`). */
  readonly limits?: Partial<StorageCapabilities>;
  /** What `health()` reports; `{ status: 'ok', writable: true }` by default. */
  readonly health?: () => StorageHealth;
}

/** A JSON copy, as a database would store it; `undefined` is stored as `null`. */
const json = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value) ?? 'null') as T;

const childOf = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
  let child = map.get(key);

  if (child === undefined) {
    child = create();
    map.set(key, child);
  }

  return child;
};

const sameKey = (left: Uint8Array, right: Uint8Array): boolean =>
  compareBytes(left, right) === 0;

/** One key per declared index of the type; `invalid_index_value` on a bad field. */
const keysOf = (
  indexes: readonly MemoryIndex[],
  value: unknown,
): Map<string, Uint8Array> =>
  new Map(
    indexes.map((index) => [
      index.name,
      encodeIndexKey(indexValues(value, index.fields)),
    ]),
  );

/** Throws `unique_conflict` when another document holds one of these unique keys. */
const checkUnique = (
  type: string,
  id: string,
  indexes: readonly MemoryIndex[],
  keys: ReadonlyMap<string, Uint8Array>,
  entries: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>> | undefined,
): void => {
  for (const index of indexes) {
    const key = keys.get(index.name);

    if (!index.unique || key === undefined) {
      continue;
    }

    for (const [other, otherKey] of entries?.get(index.name) ?? []) {
      if (other !== id && sameKey(key, otherKey)) {
        throw uniqueConflict(type, index.name);
      }
    }
  }
};

/**
 * Applies one batch to the store with an undo log: every mutation records its
 * inverse, and a failure anywhere replays them in reverse, so a batch applies
 * whole or leaves no trace. The work is synchronous, so no other call
 * interleaves with it.
 */
class Transaction {
  readonly #store: MemoryStore;
  readonly #undo: (() => void)[] = [];
  readonly #touched = new Map<string, MemoryStream>();

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  document(type: string, id: string): MemoryDocument | undefined {
    return this.#store.documents.get(type)?.get(id);
  }

  setDocument(
    type: string,
    id: string,
    document: MemoryDocument | undefined,
  ): void {
    const documents = childOf(this.#store.documents, type, () => new Map());
    const previous = documents.get(id);

    this.#undo.push(() => {
      if (previous === undefined) {
        documents.delete(id);
      } else {
        documents.set(id, previous);
      }
    });

    if (document === undefined) {
      documents.delete(id);
    } else {
      documents.set(id, document);
    }
  }

  /** Replaces every index entry of one document. */
  setEntries(type: string, id: string, keys: ReadonlyMap<string, Uint8Array>) {
    const byIndex = childOf(this.#store.indexEntries, type, () => new Map());

    for (const entries of byIndex.values()) {
      const previous = entries.get(id);

      if (previous !== undefined) {
        entries.delete(id);
        this.#undo.push(() => entries.set(id, previous));
      }
    }

    for (const [name, key] of keys) {
      const entries = childOf(byIndex, name, () => new Map());

      entries.set(id, key);
      this.#undo.push(() => entries.delete(id));
    }
  }

  entries(type: string) {
    return this.#store.indexEntries.get(type);
  }

  /** The stream for writing, created at sequence 0 when absent. */
  stream(name: string): MemoryStream {
    const touched = this.#touched.get(name);

    if (touched !== undefined) {
      return touched;
    }

    const previous = this.#store.streams.get(name);
    const next: MemoryStream =
      previous === undefined
        ? { lastSequence: 0, entries: [], truncations: [] }
        : {
            lastSequence: previous.lastSequence,
            entries: [...previous.entries],
            truncations: [...previous.truncations],
          };

    this.#store.streams.set(name, next);
    this.#touched.set(name, next);
    this.#undo.push(() => {
      if (previous === undefined) {
        this.#store.streams.delete(name);
      } else {
        this.#store.streams.set(name, previous);
      }
    });

    return next;
  }

  dropStream(name: string): void {
    const previous = this.#store.streams.get(name);

    this.#touched.delete(name);

    if (previous !== undefined) {
      this.#store.streams.delete(name);
      this.#undo.push(() => this.#store.streams.set(name, previous));
    }
  }

  rollback(): void {
    for (const undo of this.#undo.reverse()) {
      undo();
    }
  }
}

const unique = <T>(values: readonly T[], keyOf: (value: T) => string): T[] => {
  const seen = new Set<string>();

  return values.filter((value) => {
    const key = keyOf(value);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
};

const documentKeyOf = ({ type, id }: { type: string; id: string }) =>
  `${type}\u0000${id}`;

const commit = (
  store: MemoryStore,
  batch: CommitBatch,
  limits: StorageCapabilities,
): { position: number } => {
  checkBatchLimits(batch, limits);

  const transaction = new Transaction(store);
  const now = new Date().toISOString();
  const marks: { stream: string; afterSequence: number }[] = [];

  try {
    for (const expected of batch.expect ?? []) {
      const actual = transaction.document(expected.type, expected.id);

      if ((actual?.revision ?? 0) !== expected.revision) {
        throw revisionConflict(
          expected,
          expected.revision,
          actual?.revision ?? 0,
        );
      }
    }

    for (const { type, id } of batch.delete ?? []) {
      if (transaction.document(type, id) !== undefined) {
        transaction.setDocument(type, id, undefined);
        transaction.setEntries(type, id, new Map());
      }
    }

    for (const { type, id, value } of batch.put ?? []) {
      const stored = json(value);
      const indexes = store.types.get(type) ?? [];
      const keys = keysOf(indexes, stored);
      const revision = (transaction.document(type, id)?.revision ?? 0) + 1;

      transaction.setDocument(type, id, {
        revision,
        value: stored,
        updatedAt: now,
      });
      transaction.setEntries(type, id, keys);
      checkUnique(type, id, indexes, keys, transaction.entries(type));
    }

    for (const stream of batch.dropStreams ?? []) {
      transaction.dropStream(stream);
    }

    if (batch.truncate !== undefined) {
      const { stream: name, afterSequence } = batch.truncate;
      const stream = transaction.stream(name);

      if (afterSequence > stream.lastSequence) {
        throw new ContractError(
          'invalid_input',
          `Stream ${name} cannot be truncated after ${afterSequence}: its last sequence is ${stream.lastSequence}.`,
          { stream: name, afterSequence, lastSequence: stream.lastSequence },
        );
      }

      stream.entries = stream.entries.filter(
        (entry) => entry.sequence <= afterSequence,
      );
      marks.push({ stream: name, afterSequence });
    }

    for (const append of batch.append ?? []) {
      const stream = transaction.stream(append.stream);

      if (
        append.expectedSequence !== undefined &&
        append.expectedSequence !== stream.lastSequence
      ) {
        throw sequenceConflict(
          append.stream,
          append.expectedSequence,
          stream.lastSequence,
        );
      }

      for (const event of append.events) {
        stream.lastSequence += 1;
        stream.entries.push({
          sequence: stream.lastSequence,
          value: json(event),
          createdAt: now,
        });
      }
    }
  } catch (error) {
    transaction.rollback();
    throw error;
  }

  // Nothing below can fail: the position is taken only by a batch that applied.
  const position = (store.commits.at(-1)?.position ?? 0) + 1;

  for (const { stream, afterSequence } of marks) {
    const target = transaction.stream(stream);

    // The counter after the whole batch, appends of the same batch included.
    target.truncations.push({
      afterSequence,
      atSequence: target.lastSequence,
      position,
    });
  }

  const record: MemoryCommit = {
    position,
    documents: unique(
      [...(batch.delete ?? []), ...(batch.put ?? [])].map(({ type, id }) => ({
        type,
        id,
      })),
      documentKeyOf,
    ),
    streams: unique(
      (batch.append ?? []).map(({ stream }) => stream),
      (stream) => stream,
    ),
    truncated: batch.truncate === undefined ? [] : [batch.truncate.stream],
    dropped: unique(batch.dropStreams ?? [], (stream) => stream),
  };

  store.commits.push(record);

  return { position };
};

const declare = (store: MemoryStore, declaration: StorageDeclaration): void => {
  const indexes: MemoryIndex[] = declaration.indexes.map((index) => ({
    name: index.name,
    fields: [...index.fields],
    unique: index.unique === true,
  }));
  const names = new Set(indexes.map(({ name }) => name));

  if (names.size !== indexes.length) {
    throw new ContractError(
      'invalid_input',
      `Type ${declaration.type} declares an index name twice.`,
    );
  }

  const current = store.types.get(declaration.type);

  if (
    current !== undefined &&
    JSON.stringify(current) === JSON.stringify(indexes)
  ) {
    return;
  }

  // Build every entry first: a bad value or a unique violation leaves the
  // previous declaration and its entries untouched.
  const rebuilt = new Map<string, Map<string, Uint8Array>>(
    indexes.map(({ name }) => [name, new Map()]),
  );

  for (const [id, document] of store.documents.get(declaration.type) ?? []) {
    const keys = keysOf(indexes, document.value);

    checkUnique(declaration.type, id, indexes, keys, rebuilt);

    for (const [name, key] of keys) {
      rebuilt.get(name)?.set(id, key);
    }
  }

  store.types.set(declaration.type, indexes);
  store.indexEntries.set(declaration.type, rebuilt);
};

const toStored = (
  type: string,
  id: string,
  document: MemoryDocument,
): StoredDocument => ({
  type,
  id,
  revision: document.revision,
  value: json(document.value),
});

const query = (store: MemoryStore, request: StorageQuery): StoragePage => {
  const index = store.types
    .get(request.type)
    ?.find(({ name }) => name === request.index);

  if (index === undefined) {
    throw new ContractError(
      'invalid_input',
      `Type ${request.type} has no declared index "${request.index}".`,
    );
  }

  if (
    request.equals.length > index.fields.length ||
    (request.range !== undefined &&
      request.equals.length >= index.fields.length)
  ) {
    throw new ContractError(
      'invalid_input',
      `The index "${index.name}" of ${request.type} has ${index.fields.length} fields: equality takes the leading ones and a range the next one.`,
    );
  }

  const { lower, upper } = keyBounds(request);
  const after =
    request.cursor === undefined ? undefined : decodeCursor(request.cursor);
  const descending = request.order === 'desc';
  const compare = (
    left: { key: Uint8Array; id: string },
    right: { key: Uint8Array; id: string },
  ) => compareBytes(left.key, right.key) || compareIds(left.id, right.id);
  const selected = [
    ...(store.indexEntries.get(request.type)?.get(index.name) ?? []),
  ]
    .map(([id, key]) => ({ id, key }))
    .filter(
      (entry) =>
        compareBytes(entry.key, lower) >= 0 &&
        compareBytes(entry.key, upper) < 0 &&
        (after === undefined ||
          (descending ? compare(entry, after) < 0 : compare(entry, after) > 0)),
    )
    .sort((left, right) =>
      descending ? compare(right, left) : compare(left, right),
    );
  const page = selected.slice(0, request.limit);
  const last = page.at(-1);
  const documents = store.documents.get(request.type);

  return {
    items: page.map(({ id }) =>
      toStored(request.type, id, documents?.get(id) as MemoryDocument),
    ),
    ...(selected.length > request.limit && last !== undefined
      ? { cursor: encodeCursor(last) }
      : {}),
  };
};

const read = (store: MemoryStore, request: StreamRead): StreamPage => {
  const stream = store.streams.get(request.stream);
  const lastSequence = stream?.lastSequence ?? 0;

  if (request.afterSequence > lastSequence) {
    throw new ContractError(
      'invalid_input',
      `Stream ${request.stream} cannot be read after ${request.afterSequence}: its last sequence is ${lastSequence}.`,
      {
        stream: request.stream,
        afterSequence: request.afterSequence,
        lastSequence,
      },
    );
  }

  return {
    entries: (stream?.entries ?? [])
      .filter(({ sequence }) => sequence > request.afterSequence)
      .slice(0, request.limit)
      .map((entry) => ({
        sequence: entry.sequence,
        value: json(entry.value),
        createdAt: entry.createdAt,
      })),
    lastSequence,
    truncations: (stream?.truncations ?? [])
      .filter(
        (mark) =>
          mark.afterSequence < request.afterSequence &&
          request.afterSequence <= mark.atSequence,
      )
      .map(({ afterSequence, atSequence }) => ({ afterSequence, atSequence })),
  };
};

const feed = (
  store: MemoryStore,
  request: { after: number; limit: number },
): FeedPage => ({
  commits: store.commits
    .filter(({ position }) => position > request.after)
    .slice(0, request.limit)
    .map((entry) => ({
      position: entry.position,
      documents: entry.documents.map(({ type, id }) => ({ type, id })),
      streams: [...entry.streams],
      truncated: [...entry.truncated],
      dropped: [...entry.dropped],
    })),
});

/**
 * Canonical base64: whole four-character groups, padding only at the end. A
 * single character-class scan, since a repeated group overflows the regex
 * engine's stack on a blob of a few megabytes.
 */
const base64 = {
  test: (value: string): boolean =>
    value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value),
};

const putBlob = (store: MemoryStore, encoded: string): { hash: string } => {
  if (!base64.test(encoded)) {
    throw new ContractError('invalid_input', 'A blob must be base64 bytes.');
  }

  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  const digest = createHash('sha256').update(bytes).digest('hex');

  if (!store.blobs.has(digest)) {
    store.blobs.set(digest, bytes);
  }

  return { hash: `sha256:${digest}` };
};

const getBlob = (store: MemoryStore, hash: string): string | undefined => {
  const match = /^sha256:([0-9a-f]{64})$/.exec(hash);
  const bytes = match === null ? undefined : store.blobs.get(match[1] ?? '');

  return bytes === undefined
    ? undefined
    : Buffer.from(bytes).toString('base64');
};

const deleteBlob = (store: MemoryStore, hash: string): void => {
  const match = /^sha256:([0-9a-f]{64})$/.exec(hash);
  if (match !== null) store.blobs.delete(match[1] ?? '');
};

/**
 * `storage.backend/v1` over a `MemoryStore`: the executable reference of the
 * protocol that the conformance kit runs against, and the foundation of core
 * and kernel unit tests. Never part of a shipped composition.
 */
export const memoryStorageBackend = (
  store: MemoryStore,
  options: MemoryStorageOptions = {},
) => {
  const limits: StorageCapabilities = {
    ...defaultStorageCapabilities,
    ...options.limits,
  };
  const methods = storageBackendMethods;

  return defineService(StorageBackendV1, {
    declareType: defineMethod({
      ...methods.declareType,
      execute: (declaration) =>
        later(() => {
          declare(store, declaration);
        }),
    }),
    get: defineMethod({
      ...methods.get,
      execute: ({ type, id }) =>
        later(() => {
          const document = store.documents.get(type)?.get(id);

          return document === undefined
            ? undefined
            : toStored(type, id, document);
        }),
    }),
    query: defineMethod({
      ...methods.query,
      execute: (request) => later(() => query(store, request)),
    }),
    read: defineMethod({
      ...methods.read,
      execute: (request) => later(() => read(store, request)),
    }),
    commit: defineMethod({
      ...methods.commit,
      execute: (batch) => later(() => commit(store, batch, limits)),
    }),
    feed: defineMethod({
      ...methods.feed,
      execute: (request) => later(() => feed(store, request)),
    }),
    putBlob: defineMethod({
      ...methods.putBlob,
      execute: (encoded) => later(() => putBlob(store, encoded)),
    }),
    getBlob: defineMethod({
      ...methods.getBlob,
      execute: (hash) => later(() => getBlob(store, hash)),
    }),
    deleteBlob: defineMethod({
      ...methods.deleteBlob,
      execute: (hash) =>
        later(() => {
          deleteBlob(store, hash);
        }),
    }),
    capabilities: defineMethod({
      ...methods.capabilities,
      execute: () => later(() => ({ ...limits })),
    }),
    health: defineMethod({
      ...methods.health,
      execute: () =>
        later(
          () => options.health?.() ?? { status: 'ok' as const, writable: true },
        ),
    }),
    identity: defineMethod({
      ...methods.identity,
      execute: () =>
        later(() => {
          store.identity ??= { hostId: randomUUID(), storageGeneration: 1 };

          return { ...store.identity };
        }),
    }),
    // Nothing to open: the store lives in this process.
    connect: defineMethod({
      ...methods.connect,
      execute: () => later(() => undefined),
    }),
  });
};
