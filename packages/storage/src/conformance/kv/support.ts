// What the cases of the KV kit share: the byte helpers, the messages of
// `doric.storage.kv.v1` built from plain values, the readers of a whole
// answer, the refusal matcher and a small seeded generator.

import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { isContractError } from 'bundle/contracts';
import {
  type CommitRequest,
  CommitRequestSchema,
  type GetRequest,
  GetRequestSchema,
  type GetResponse,
  type RangeRequest,
  RangeRequestSchema,
  type RangeResponse,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import type { Kv } from '../../kv.js';
import type { KvTarget } from './index.js';

/** One case of the kit: a name, its body over the shared target. */
export interface KvCase {
  readonly name: string;
  /** A timeout of its own, for the cases that send the largest calls. */
  readonly timeout?: number;
  /**
   * Whether the case streams a commit of more than `commitItems` items:
   * minutes on a real engine, so `runKvConformance` runs it only when asked
   * with `{ heavy: true }`.
   */
  readonly heavy?: boolean;
  run(target: KvTarget): Promise<void>;
}

const encoder = new TextEncoder();

/** The UTF-8 bytes of `text`, followed by `tail`. */
export const bytes = (text: string, ...tail: readonly number[]): Uint8Array =>
  concat(encoder.encode(text), Uint8Array.from(tail));

/** `parts`, one after the other. */
export const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** `text` followed by filler bytes, `length` bytes in all. */
export const sized = (text: string, length: number): Uint8Array => {
  const out = new Uint8Array(length).fill(0x61);

  out.set(encoder.encode(text).subarray(0, length));

  return out;
};

/** `bytes` in lowercase hexadecimal, two digits per byte. */
export const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Unsigned bytewise comparison: negative, zero or positive. */
export const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
};

/** `position` as 8 bytes, big-endian. */
export const u64be = (position: number): Uint8Array => {
  const out = new Uint8Array(8);

  new DataView(out.buffer).setBigUint64(0, BigInt(position));

  return out;
};

export const put = (key: Uint8Array, value: Uint8Array): CommitRequest =>
  create(CommitRequestSchema, { item: { case: 'put', value: { key, value } } });

export const del = (key: Uint8Array): CommitRequest =>
  create(CommitRequestSchema, { item: { case: 'delete', value: key } });

export const clearRange = (start: Uint8Array, end: Uint8Array): CommitRequest =>
  create(CommitRequestSchema, {
    item: { case: 'clearRange', value: { start, end } },
  });

export const condition = (key: Uint8Array, version: number): CommitRequest =>
  create(CommitRequestSchema, {
    item: { case: 'condition', value: { key, version } },
  });

export const positionedPut = (
  keyPrefix: Uint8Array,
  value: Uint8Array,
): CommitRequest =>
  create(CommitRequestSchema, {
    item: { case: 'positionedPut', value: { keyPrefix, value } },
  });

/** A commit item with no case set. */
export const emptyItem = (): CommitRequest => create(CommitRequestSchema);

export const getRequest = (keys: readonly Uint8Array[]): GetRequest =>
  create(GetRequestSchema, { keys: [...keys] });

export const rangeRequest = (options: {
  readonly start: Uint8Array;
  readonly end: Uint8Array;
  readonly limit: number;
  readonly reverse?: boolean;
  readonly keysOnly?: boolean;
}): RangeRequest =>
  create(RangeRequestSchema, {
    start: options.start,
    end: options.end,
    limit: options.limit,
    reverse: options.reverse ?? false,
    keysOnly: options.keysOnly ?? false,
  });

/** Every item of an answer. */
export const collect = async <T>(answer: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];

  for await (const item of answer) {
    out.push(item);
  }

  return out;
};

export const getAll = (kv: Kv, keys: readonly Uint8Array[]): Promise<GetResponse[]> =>
  collect(kv.get(getRequest(keys)));

export const rangeAll = (
  kv: Kv,
  options: Parameters<typeof rangeRequest>[0],
): Promise<RangeResponse[]> => collect(kv.range(rangeRequest(options)));

/** The empty key and the one byte `0xff`: every key of every caller lies between. */
export const everything = { start: new Uint8Array(), end: Uint8Array.of(0xff) };

/** One stored entry, as the kit compares them. */
export interface Entry {
  readonly key: string;
  readonly value: string;
  readonly version: number;
}

/** Every entry of the store, read as `doric` page by page, keys and values in hex. */
export const dump = async (target: KvTarget): Promise<Entry[]> => {
  const kv = target.kv('doric');
  const out: Entry[] = [];
  let start: Uint8Array = everything.start;

  for (;;) {
    const page = await rangeAll(kv, { start, end: everything.end, limit: 1000 });

    for (const entry of page) {
      out.push({ key: hex(entry.key), value: hex(entry.value), version: entry.version });
    }

    const last = page.at(-1);

    if (page.length < 1000 || last === undefined) {
      return out;
    }

    start = concat(last.key, Uint8Array.of(0));
  }
};

/**
 * An `assert.rejects` matcher: a `ContractError` of `code` whose details hold
 * `details`, field by field (hexadecimal compared without regard to case).
 */
export const refusal =
  (code: string, details?: Readonly<Record<string, string>>) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);

    for (const [name, expected] of Object.entries(details ?? {})) {
      const actual: unknown = (error.details as Record<string, unknown> | undefined)?.[name];

      assert.equal(
        typeof actual === 'string' && name === 'key' ? actual.toLowerCase() : actual,
        expected,
        `details.${name} of ${code}`,
      );
    }

    return true;
  };

/** A seeded generator (mulberry32) in [0, 1), so the random case reproduces. */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let value = state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};
