import {
  type CommitBatch,
  isContractError,
  type Storage,
  type StorageQuery,
  type StoredDocument,
} from 'bundle/contracts';

/*
 * The write protocol of the runtime's documents (design 57 §3.3 as revised).
 * Every write is one declarative `storage/v1.commit` that expects the
 * revision the change was computed from; that expectation replaces the
 * former `SELECT … FOR UPDATE` on the row. Writes to one document run one at
 * a time in this process, from a cached `{ value, revision }` (a commit that
 * applied leaves the revision at `expected + 1`). A revision or sequence
 * conflict, raised by another store over the same storage (another runtime
 * during a handover, a test's second client), drops the cache, reads the
 * document again and computes the change again, up to eight times. A
 * sequence conflict alone is the stream moving under the document: other
 * bundles append to a Thread's stream through `events/v1` without touching
 * the Thread document, so those retries draw on their own, larger budget and
 * an external append never exhausts the one revision conflicts share.
 */

/** Conflicts a change is recomputed for. */
const conflictCodes = new Set(['revision_conflict', 'sequence_conflict']);

const attempts = 8;

/** Retries after a stream moved by appends outside this store. */
const sequenceAttempts = 64;

export interface Cached<Value> {
  readonly value: Value;
  readonly revision: number;
}

/** What a change computed from the current document commits. */
export interface Change<Value, Result> {
  /** The document's next value; absent leaves it as it is. */
  readonly value?: Value;
  /** Further batch members committed with it, in the same commit. */
  readonly batch?: Omit<CommitBatch, 'put'> & {
    readonly put?: CommitBatch['put'];
  };
  /** Documents of other keys this change writes, whose cache must go. */
  readonly touches?: readonly string[];
  /** The answer, computed once the commit applied (or with nothing to commit). */
  readonly done: () => Result | Promise<Result>;
}

export interface Documents<Value> {
  readonly type: string;
  /** A fresh read, never from the cache. */
  get(id: string): Promise<Cached<Value> | undefined>;
  /**
   * Runs `change` against the current document (undefined when it does not
   * exist) and commits what it returns, in this document's write order.
   */
  mutate<Result>(
    id: string,
    change: (
      current: Cached<Value> | undefined,
      attempt: number,
    ) => Change<Value, Result> | Promise<Change<Value, Result>>,
  ): Promise<Result>;
  /**
   * Like `mutate`, for a change that runs inside another mutation of the
   * same document (it does not wait for the write order it already holds).
   */
  mutateNow<Result>(
    id: string,
    change: (
      current: Cached<Value> | undefined,
      attempt: number,
    ) => Change<Value, Result> | Promise<Change<Value, Result>>,
  ): Promise<Result>;
  /** Forgets the cached document of `id`. */
  forget(id: string): void;
}

export const isConflict = (error: unknown): boolean =>
  isContractError(error) && conflictCodes.has(error.code);

const merge = (
  type: string,
  id: string,
  revision: number,
  value: unknown,
  extra: Change<unknown, unknown>['batch'],
): CommitBatch => {
  const put = [
    ...(value === undefined ? [] : [{ type, id, value }]),
    ...(extra?.put ?? []),
  ];
  return {
    ...extra,
    expect: [{ type, id, revision }, ...(extra?.expect ?? [])],
    ...(put.length === 0 ? {} : { put }),
  };
};

/** The registry shared by every document family of one store set. */
export interface DocumentSet {
  readonly storage: Storage;
  /** Drops the cached document of `type`/`id` in whichever family holds it. */
  forget(type: string, id: string): void;
  documents<Value>(type: string): Documents<Value>;
}

export const createDocumentSet = (storage: Storage): DocumentSet => {
  const families = new Map<string, Documents<unknown>>();

  const set: DocumentSet = {
    storage,
    forget: (type, id) => families.get(type)?.forget(id),
    documents: <Value>(type: string): Documents<Value> => {
      const existing = families.get(type);
      if (existing !== undefined) return existing as Documents<Value>;
      const created = createDocuments<Value>(set, type);
      families.set(type, created as Documents<unknown>);
      return created;
    },
  };

  return set;
};

const createDocuments = <Value>(
  set: DocumentSet,
  type: string,
): Documents<Value> => {
  const { storage } = set;
  const cache = new Map<string, Cached<Value>>();
  const queues = new Map<string, Promise<unknown>>();

  const get = async (id: string): Promise<Cached<Value> | undefined> => {
    const stored = await storage.get({ type, id });
    return stored === undefined
      ? undefined
      : { value: stored.value as Value, revision: stored.revision };
  };

  const run = async <Result>(
    id: string,
    change: (
      current: Cached<Value> | undefined,
      attempt: number,
    ) => Change<Value, Result> | Promise<Change<Value, Result>>,
  ): Promise<Result> => {
    let failure: unknown;
    let revisionRetries = 0;
    let sequenceRetries = 0;
    for (
      let attempt = 0;
      revisionRetries < attempts && sequenceRetries < sequenceAttempts;
      attempt += 1
    ) {
      const current =
        (attempt === 0 ? cache.get(id) : undefined) ?? (await get(id));
      if (current === undefined) cache.delete(id);
      else cache.set(id, current);
      const planned = await change(current, attempt);
      if (planned.value === undefined && planned.batch === undefined)
        return planned.done();
      const revision = current?.revision ?? 0;
      try {
        await storage.commit(
          merge(type, id, revision, planned.value, planned.batch),
        );
      } catch (error) {
        cache.delete(id);
        if (!isConflict(error)) throw error;
        failure = error;
        if (isContractError(error) && error.code === 'sequence_conflict')
          sequenceRetries += 1;
        else revisionRetries += 1;
        continue;
      }
      if (planned.value === undefined) {
        // The document itself was only expected; its revision did not move.
        if (
          planned.batch?.delete?.some(
            (key) => key.type === type && key.id === id,
          )
        )
          cache.delete(id);
      } else cache.set(id, { value: planned.value, revision: revision + 1 });
      for (const touched of planned.touches ?? []) set.forget(type, touched);
      for (const removed of planned.batch?.delete ?? [])
        set.forget(removed.type, removed.id);
      return planned.done();
    }
    throw failure;
  };

  return {
    type,
    get,
    mutate: (id, change) => {
      const previous = queues.get(id) ?? Promise.resolve();
      const next = previous.then(
        () => run(id, change),
        () => run(id, change),
      );
      const settled = next.then(
        () => undefined,
        () => undefined,
      );
      queues.set(id, settled);
      void settled.then(() => {
        if (queues.get(id) === settled) queues.delete(id);
      });
      return next;
    },
    mutateNow: run,
    forget: (id) => {
      cache.delete(id);
    },
  };
};

/**
 * Every document of a query, page after page. `count` stops early once that
 * many are read (the page sizes stay within the protocol's 1000).
 */
export const queryAll = async (
  storage: Storage,
  query: Omit<StorageQuery, 'limit' | 'cursor'>,
  count = Number.POSITIVE_INFINITY,
): Promise<StoredDocument[]> => {
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.query({
      ...query,
      limit: Math.max(1, Math.min(1000, count - items.length)),
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined && items.length < count);
  return items;
};
