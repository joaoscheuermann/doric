/**
 * Helpers the `storage/v2` conformance cases share. Defined here rather
 * than taken from the v1 kit's `../support.ts`, which S85a and S85b delete.
 */
import assert from 'node:assert/strict';

import {
  clone,
  create,
  createFileRegistry,
  type DescFile,
  getExtension,
  hasExtension,
  setExtension,
} from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  FileDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import { ContractError, isContractError } from 'bundle/contracts';
import {
  StorageIndexSchema,
  StorageTypeOptionSchema,
  storage_type,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import {
  RangeRequestSchema,
  type RangeResponse,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import type { Storage, StoragePage, StorageQuery } from '../../client/types.js';
import { decodeIndexKey, encodeIndexKey } from '../../keys.js';
import { type Kv, kvLimits } from '../../kv.js';

/**
 * An `assert.rejects` matcher: answers `true` for a `ContractError` of
 * `code`, with `details` deep-equal to `details` when it is given, and
 * throws an `AssertionError` naming the expected code otherwise (a
 * `ConnectError` of a raw client included).
 */
export const isCode =
  (code: string, details?: unknown) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);

    if (details !== undefined) {
      assert.deepEqual(error.details, details);
    }

    return true;
  };

/**
 * `ok` for a fulfilled result, the `ContractError` code of a rejection, or
 * the rejection's `String()` otherwise.
 */
export const codeOf = (result: PromiseSettledResult<unknown>): string =>
  result.status === 'fulfilled'
    ? 'ok'
    : isContractError(result.reason)
      ? result.reason.code
      : String(result.reason);

/** How many of `results` carry each `codeOf`; codes no result has are absent. */
export const tally = (
  results: readonly PromiseSettledResult<unknown>[],
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const result of results) {
    const code = codeOf(result);

    counts[code] = (counts[code] ?? 0) + 1;
  }

  return counts;
};

/** The document ids of `page`, in page order. */
export const ids = (page: StoragePage): string[] =>
  page.items.map(({ id }) => id);

/**
 * Every page of `query`, in order: the first read with `query` as given
 * (its `cursor` included), each next one with the previous page's
 * `nextCursor`, until a page answers `nextCursor: null`, which is the last
 * element. Rejects with the first refusal of `storage.query`, and with an
 * `AssertionError` when a page holds more than `query.limit` documents.
 */
export const walk = async (
  storage: Storage,
  query: StorageQuery,
): Promise<StoragePage[]> => {
  const pages: StoragePage[] = [];
  let next: StorageQuery = query;

  for (;;) {
    const page = await storage.query(next);

    assert.ok(
      page.items.length <= query.limit,
      `a page holds at most ${query.limit} documents, not ${page.items.length}`,
    );
    pages.push(page);

    if (page.nextCursor === null) {
      return pages;
    }

    next = { ...query, cursor: page.nextCursor };
  }
};

const encoder = new TextEncoder();

/** `parts`, one after the other. */
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/**
 * Every entry from `start` to `end`, in key order, read as `doric` one
 * `kv.range` of `rangeLimit` entries at a time.
 */
const rangeAll = async (
  kv: Kv,
  start: Uint8Array,
  end: Uint8Array,
  keysOnly: boolean,
): Promise<RangeResponse[]> => {
  const out: RangeResponse[] = [];
  let from = start;

  for (;;) {
    const page: RangeResponse[] = [];

    for await (const entry of kv.range(
      create(RangeRequestSchema, {
        start: from,
        end,
        limit: kvLimits.rangeLimit,
        keysOnly,
      }),
    )) {
      page.push(entry);
    }

    out.push(...page);

    const last = page.at(-1);

    if (page.length < kvLimits.rangeLimit || last === undefined) {
      return out;
    }

    from = concat(last.key, Uint8Array.of(0));
  }
};

/** One index entry as the engine stored it (the layout's `"idx"` rows). */
interface IndexEntry {
  /** The whole key, its `<bundleId>/` prefix included. */
  readonly key: Uint8Array;
  /** The storage type of the entry, the tuple's second element. */
  readonly type: string;
  /** The index's name, the tuple's third element. */
  readonly index: string;
  /**
   * The tuple's bytes after `("idx", type, index)`: the index values, and
   * the document id for a non-unique index, as `encodeIndexKey` encodes
   * them.
   */
  readonly values: Uint8Array;
  /** The stored value: the document id in UTF-8 for a unique index, else empty. */
  readonly value: Uint8Array;
}

/**
 * Every index entry under `<bundleId>/`, of `type` only when it is given,
 * in key order, read as `doric` through `kv.range` page by page. `kv` must
 * be the engine's `kv('doric')`. Rejects with `kv`'s refusal, and with
 * `invalid_input` for a key under the prefix that is not a tuple.
 */
export const indexKeys = async (
  kv: Kv,
  bundleId: string,
  type?: string,
): Promise<IndexEntry[]> => {
  const bundle = encoder.encode(`${bundleId}/`);
  const start = concat(
    bundle,
    encodeIndexKey(type === undefined ? ['idx'] : ['idx', type]),
  );
  const entries = await rangeAll(
    kv,
    start,
    concat(start, Uint8Array.of(0xff)),
    false,
  );

  return entries.map(({ key, value }) => {
    const tuple = key.subarray(bundle.length);
    const [, entryType, index] = decodeIndexKey(tuple);

    if (typeof entryType !== 'string' || typeof index !== 'string') {
      throw new ContractError(
        'invalid_input',
        'An index key holds a type and an index name after "idx".',
      );
    }

    return {
      key,
      type: entryType,
      index,
      values: tuple.slice(encodeIndexKey(['idx', entryType, index]).length),
      value,
    };
  });
};

/**
 * Every key of the store, of every caller and the platform's own, in key
 * order, read as `doric` through `kv.range` page by page; for T4.3's check
 * that every key a bundle's calls wrote starts with its prefix. Rejects
 * with `kv`'s refusal.
 */
export const storedKeys = async (kv: Kv): Promise<Uint8Array[]> =>
  (await rangeAll(kv, new Uint8Array(), Uint8Array.of(0xff), true)).map(
    ({ key }) => key,
  );

/** One index of a storage type's declaration (`doric.platform.v1.StorageIndex`). */
export interface IndexDeclaration {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique?: boolean;
}

/**
 * A copy of `file` in which the message `message` (its full name, e.g.
 * `doric.storage.conformance.v1.Thread`) declares `indexes` in place of its
 * storage type's indexes, its type id and everything else unchanged; the
 * variants the rebuild and registration cases register (Q10, T4.24).
 * `file` itself is unchanged. Throws an `Error` naming `message` when
 * `file` declares no such message or the message declares no storage
 * type.
 */
export const withIndexes = (
  file: DescFile,
  message: string,
  indexes: readonly IndexDeclaration[],
): DescFile => {
  const proto = clone(FileDescriptorProtoSchema, file.proto);
  const prefix = proto.package === '' ? '' : `${proto.package}.`;
  const find = (
    messages: readonly DescriptorProto[],
    scope: string,
  ): DescriptorProto | undefined => {
    for (const each of messages) {
      const name = `${scope}${each.name}`;

      if (name === message) {
        return each;
      }

      const nested = find(each.nestedType, `${name}.`);

      if (nested !== undefined) {
        return nested;
      }
    }

    return undefined;
  };
  const found = find(proto.messageType, prefix);

  if (
    found?.options === undefined ||
    !hasExtension(found.options, storage_type)
  ) {
    throw new Error(
      `${file.proto.name} declares no storage type on the message ${message}`,
    );
  }

  const option = clone(
    StorageTypeOptionSchema,
    getExtension(found.options, storage_type),
  );

  option.indexes = indexes.map((index) =>
    create(StorageIndexSchema, {
      name: index.name,
      fields: [...index.fields],
      ...(index.unique === undefined ? {} : { unique: index.unique }),
    }),
  );
  setExtension(found.options, storage_type, option);

  const imports = new Map<string, DescFile>();
  const visit = (current: DescFile): void => {
    for (const imported of current.dependencies) {
      if (!imports.has(imported.proto.name)) {
        imports.set(imported.proto.name, imported);
        visit(imported);
      }
    }
  };

  visit(file);

  const copy = createFileRegistry(proto, (name) => imports.get(name)).getFile(
    file.proto.name,
  );

  if (copy === undefined) {
    throw new Error(`the registry holds no ${file.proto.name}`);
  }

  return copy;
};
