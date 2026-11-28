// The seeded random sequence (QC): 2,000 operations as the caller `doric`, every
// answer checked against a model of the store kept by the case (T4.2).

import assert from 'node:assert/strict';

import type { CommitRequest } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import type { Kv } from '../../kv.js';
import {
  bytes,
  clearRange,
  compareBytes,
  concat,
  condition,
  del,
  getAll,
  hex,
  type KvCase,
  positionedPut,
  put,
  rangeAll,
  refusal,
  seeded,
  u64be,
} from './support.js';

/** The seed of the sequence: `DORIC_KV_SEED` when it is set, else 20261127. */
const seedOf = (): number => {
  const configured = process.env.DORIC_KV_SEED;

  if (configured === undefined || configured === '') {
    return 20261127;
  }

  const seed = Number(configured);

  assert.ok(Number.isSafeInteger(seed), `DORIC_KV_SEED is not an integer: ${configured}`);

  return seed;
};

const operations = 2000;

/** The bytes a key may hold after `a/`. */
const alphabet = [0x00, 0x01, 0x41, 0x7f, 0x80, 0xfe, 0xff] as const;

interface Stored {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
  readonly version: number;
}

/** What the store holds, by key hex, and the position the next commit gets. */
interface Model {
  readonly entries: Map<string, Stored>;
  next: number | undefined;
}

/** One generated item, with what the model needs to judge it. */
type Item =
  | { readonly kind: 'put'; readonly key: Uint8Array; readonly value: Uint8Array }
  | { readonly kind: 'delete'; readonly key: Uint8Array }
  | { readonly kind: 'clear'; readonly start: Uint8Array; readonly end: Uint8Array }
  | { readonly kind: 'positioned'; readonly prefix: Uint8Array; readonly value: Uint8Array }
  | { readonly kind: 'condition'; readonly key: Uint8Array; readonly version: number };

const message = (item: Item): CommitRequest => {
  switch (item.kind) {
    case 'put':
      return put(item.key, item.value);
    case 'delete':
      return del(item.key);
    case 'clear':
      return clearRange(item.start, item.end);
    case 'positioned':
      return positionedPut(item.prefix, item.value);
    case 'condition':
      return condition(item.key, item.version);
  }
};

const describeItem = (item: Item): string => {
  switch (item.kind) {
    case 'put':
      return `put ${hex(item.key)}=${hex(item.value)}`;
    case 'delete':
      return `delete ${hex(item.key)}`;
    case 'clear':
      return `clear [${hex(item.start)}, ${hex(item.end)})`;
    case 'positioned':
      return `positioned ${hex(item.prefix)}=${hex(item.value)}`;
    case 'condition':
      return `condition ${hex(item.key)}@${item.version}`;
  }
};

/** The generator of operations over the key space of the case. */
const generator = (seed: number) => {
  const next = seeded(seed);
  const below = (bound: number): number => Math.floor(next() * bound);
  const chance = (probability: number): boolean => next() < probability;

  const key = (): Uint8Array =>
    bytes(
      'a/',
      ...Array.from({ length: 1 + below(3) }, () => alphabet[below(alphabet.length)] as number),
    );
  const value = (): Uint8Array =>
    Uint8Array.from({ length: below(33) }, () => below(256));

  /** A key of the model half of the time, when it holds any; else a new one. */
  const someKey = (model: Model): Uint8Array => {
    const stored = [...model.entries.values()];

    return stored.length > 0 && chance(0.5)
      ? (stored[below(stored.length)] as Stored).key
      : key();
  };

  /** Two keys in order, or, with `reversed`, the larger first. */
  const bounds = (reversed: boolean): [Uint8Array, Uint8Array] => {
    const pair = [key(), key()].sort(compareBytes) as [Uint8Array, Uint8Array];

    if (chance(0.1)) {
      pair[0] = bytes('a/');
    }

    if (chance(0.1)) {
      pair[1] = bytes('a/', 0xff, 0xff, 0xff, 0xff);
    }

    return reversed ? [pair[1], pair[0]] : pair;
  };

  const item = (model: Model): Item => {
    const roll = next();

    if (roll < 0.3) {
      return { kind: 'put', key: someKey(model), value: value() };
    }

    if (roll < 0.45) {
      return { kind: 'delete', key: someKey(model) };
    }

    if (roll < 0.55) {
      const [start, end] = bounds(chance(0.1));

      return { kind: 'clear', start, end };
    }

    if (roll < 0.65) {
      return {
        kind: 'positioned',
        prefix: bytes('a/', alphabet[below(alphabet.length)] as number),
        value: value(),
      };
    }

    const target = someKey(model);
    const current = model.entries.get(hex(target))?.version ?? 0;
    const holds = chance(0.7);

    return {
      kind: 'condition',
      key: target,
      version: holds ? current : current === 0 ? 1 + below(1000) : chance(0.5) ? 0 : current + 1,
    };
  };

  return { next, below, chance, someKey, bounds, item };
};

/** The entries of `[start, end)` in key order, or reverse, at most `limit`. */
const modelRange = (
  model: Model,
  start: Uint8Array,
  end: Uint8Array,
  limit: number,
  reverse: boolean,
): Stored[] => {
  const inside = [...model.entries.values()]
    .filter((entry) => compareBytes(start, entry.key) <= 0 && compareBytes(entry.key, end) < 0)
    .sort((left, right) => compareBytes(left.key, right.key));

  return (reverse ? inside.reverse() : inside).slice(0, limit);
};

/** The refusal the model expects of a commit, or `undefined` when it applies. */
const commitRefusal = (
  model: Model,
  items: readonly Item[],
): { code: string; key?: string } | undefined => {
  if (items.some((item) => item.kind === 'clear' && compareBytes(item.start, item.end) > 0)) {
    return { code: 'invalid_input' };
  }

  if (items.every((item) => item.kind === 'condition')) {
    return { code: 'invalid_input' };
  }

  for (const item of items) {
    if (item.kind === 'condition') {
      const version = model.entries.get(hex(item.key))?.version ?? 0;

      if (version !== item.version) {
        return { code: 'condition_failed', key: hex(item.key) };
      }
    }
  }

  return undefined;
};

const apply = (model: Model, items: readonly Item[], position: number): void => {
  for (const item of items) {
    switch (item.kind) {
      case 'put':
        model.entries.set(hex(item.key), { key: item.key, value: item.value, version: position });
        break;
      case 'delete':
        model.entries.delete(hex(item.key));
        break;
      case 'clear':
        for (const entry of modelRange(model, item.start, item.end, Infinity, false)) {
          model.entries.delete(hex(entry.key));
        }
        break;
      case 'positioned': {
        const key = concat(item.prefix, u64be(position));

        model.entries.set(hex(key), { key, value: item.value, version: position });
        break;
      }
      case 'condition':
        break;
    }
  }

  model.next = position + 1;
};

/** Runs one operation and checks its answer; answers what it did, for the failure. */
const step = async (
  kv: Kv,
  model: Model,
  generate: ReturnType<typeof generator>,
  record: (description: string) => void,
): Promise<void> => {
  const roll = generate.next();

  if (roll < 0.5) {
    const items = Array.from({ length: 1 + generate.below(4) }, () => generate.item(model));

    record(`commit ${items.map(describeItem).join(', ')}`);

    const expected = commitRefusal(model, items);

    if (expected !== undefined) {
      await assert.rejects(
        kv.commit(items.map(message)),
        refusal(expected.code, expected.key === undefined ? undefined : { key: expected.key }),
      );

      return;
    }

    const { position } = await kv.commit(items.map(message));

    if (model.next === undefined) {
      assert.ok(Number.isSafeInteger(position) && position > 0 && position < 2 ** 53, `position ${position}`);
    } else {
      assert.equal(position, model.next, 'the position follows the last one');
    }

    apply(model, items, position);

    return;
  }

  if (roll < 0.7) {
    const keys = Array.from({ length: 1 + generate.below(5) }, () => generate.someKey(model));

    record(`get ${keys.map(hex).join(', ')}`);

    const answer = await getAll(kv, keys);

    assert.deepEqual(
      answer.map((item) => ({
        key: hex(item.key),
        value: item.value === undefined ? undefined : hex(item.value),
        version: item.version,
      })),
      keys.map((key) => {
        const stored = model.entries.get(hex(key));

        return {
          key: hex(key),
          value: stored === undefined ? undefined : hex(stored.value),
          version: stored?.version ?? 0,
        };
      }),
    );

    return;
  }

  const reversedBounds = generate.chance(0.05);
  const [start, end] = generate.bounds(reversedBounds);
  const limit = 1 + generate.below(8);
  const reverse = generate.chance(0.5);
  const keysOnly = generate.chance(0.25);

  record(
    `range [${hex(start)}, ${hex(end)}) limit ${limit}${reverse ? ' reverse' : ''}${keysOnly ? ' keysOnly' : ''}`,
  );

  if (compareBytes(start, end) > 0) {
    await assert.rejects(rangeAll(kv, { start, end, limit, reverse, keysOnly }), refusal('invalid_input'));

    return;
  }

  const answer = await rangeAll(kv, { start, end, limit, reverse, keysOnly });

  assert.deepEqual(
    answer.map((entry) => ({ key: hex(entry.key), value: hex(entry.value), version: entry.version })),
    modelRange(model, start, end, limit, reverse).map((entry) => ({
      key: hex(entry.key),
      value: keysOnly ? '' : hex(entry.value),
      version: entry.version,
    })),
  );
};

export const randomCases: readonly KvCase[] = [
  {
    name: 'random: 2,000 seeded operations answer as the model does',
    timeout: 300_000,
    async run(target) {
      const seed = seedOf();
      const generate = generator(seed);
      const model: Model = { entries: new Map(), next: undefined };
      const kv = target.kv('doric');

      for (let index = 0; index < operations; index += 1) {
        let description = '';

        try {
          await step(kv, model, generate, (text) => {
            description = text;
          });
        } catch (error) {
          throw new Error(
            `KV random sequence, seed ${seed}: operation ${index} differs from the model (${description}): ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        }
      }
    },
  },
];
