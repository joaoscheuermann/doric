// Guarantee 1 (order) and the shape of the read answers: bytewise and
// reverse order, a prefix first, `limit` and continuation, `keys_only`, and
// `Get` in request order (T4.2).

import assert from 'node:assert/strict';

import type { Kv } from '../../kv.js';
import {
  bytes,
  concat,
  getAll,
  hex,
  type KvCase,
  put,
  rangeAll,
} from './support.js';

/** The keys of the order cases, in bytewise order. */
const ordered = [
  bytes('a/', 0x00),
  bytes('a/', 0x01),
  bytes('a/', 0x41),
  bytes('a/', 0x7f),
  bytes('a/', 0x80),
  bytes('a/', 0x80, 0x00),
  bytes('a/', 0xfe),
  bytes('a/', 0xff),
  bytes('a/', 0xff, 0x00),
  bytes('a/', 0xff, 0xff),
];

const end = bytes('a/', 0xff, 0xff, 0xff);

/** Writes `keys` in an order unrelated to theirs, each with its hex as value. */
const seed = async (kv: Kv, keys: readonly Uint8Array[]): Promise<void> => {
  const odd = keys.filter((_, index) => index % 2 === 1).reverse();
  const even = keys.filter((_, index) => index % 2 === 0);

  await kv.commit([...odd, ...even].map((key) => put(key, bytes(hex(key)))));
};

export const orderCases: readonly KvCase[] = [
  {
    name: 'order: Range answers unsigned bytewise order, and its reverse',
    async run(target) {
      const kv = target.kv('doric');

      await seed(kv, ordered);

      const forward = await rangeAll(kv, { start: bytes('a/'), end, limit: 100 });

      assert.deepEqual(forward.map((entry) => hex(entry.key)), ordered.map(hex));
      assert.deepEqual(
        forward.map((entry) => new TextDecoder().decode(entry.value)),
        ordered.map(hex),
      );

      const reverse = await rangeAll(kv, {
        start: bytes('a/'),
        end,
        limit: 100,
        reverse: true,
      });

      assert.deepEqual(
        reverse.map((entry) => hex(entry.key)),
        ordered.map(hex).reverse(),
      );
    },
  },
  {
    name: 'order: a key that is a prefix of another sorts first',
    async run(target) {
      const kv = target.kv('doric');
      const keys = [bytes('a/k'), bytes('a/k', 0x00), bytes('a/kk'), bytes('a/kk', 0xff)];

      await seed(kv, keys);

      const forward = await rangeAll(kv, {
        start: bytes('a/k'),
        end: bytes('a/l'),
        limit: 10,
      });

      assert.deepEqual(forward.map((entry) => hex(entry.key)), keys.map(hex));

      const reverse = await rangeAll(kv, {
        start: bytes('a/k'),
        end: bytes('a/l'),
        limit: 10,
        reverse: true,
      });

      assert.deepEqual(reverse.map((entry) => hex(entry.key)), keys.map(hex).reverse());
    },
  },
  {
    name: 'order: limit stops the answer, and continuing from the last key reads every key once',
    async run(target) {
      const kv = target.kv('doric');

      await seed(kv, ordered);

      const seenForward: string[] = [];
      let start = bytes('a/');

      for (let page = 0; page < ordered.length; page += 1) {
        const entries = await rangeAll(kv, { start, end, limit: 3 });

        assert.ok(entries.length <= 3, 'a page holds at most limit entries');
        seenForward.push(...entries.map((entry) => hex(entry.key)));

        const last = entries.at(-1);

        if (entries.length < 3 || last === undefined) {
          break;
        }

        start = concat(last.key, Uint8Array.of(0x00));
      }

      assert.deepEqual(seenForward, ordered.map(hex));

      const seenReverse: string[] = [];
      let before = end;

      for (let page = 0; page < ordered.length; page += 1) {
        const entries = await rangeAll(kv, {
          start: bytes('a/'),
          end: before,
          limit: 3,
          reverse: true,
        });

        assert.ok(entries.length <= 3, 'a page holds at most limit entries');
        seenReverse.push(...entries.map((entry) => hex(entry.key)));

        const last = entries.at(-1);

        if (entries.length < 3 || last === undefined) {
          break;
        }

        before = last.key;
      }

      assert.deepEqual(seenReverse, ordered.map(hex).reverse());
    },
  },
  {
    name: 'order: keysOnly answers keys and versions with empty values',
    async run(target) {
      const kv = target.kv('doric');
      const { position } = await kv.commit([
        put(bytes('a/x'), bytes('one')),
        put(bytes('a/y'), bytes('two')),
      ]);

      for (const reverse of [false, true]) {
        const entries = await rangeAll(kv, {
          start: bytes('a/'),
          end: bytes('a/z'),
          limit: 10,
          reverse,
          keysOnly: true,
        });
        const keys = [hex(bytes('a/x')), hex(bytes('a/y'))];

        assert.deepEqual(
          entries.map((entry) => ({
            key: hex(entry.key),
            value: entry.value.length,
            version: entry.version,
          })),
          (reverse ? keys.reverse() : keys).map((key) => ({
            key,
            value: 0,
            version: position,
          })),
        );
      }
    },
  },
  {
    name: 'order: Get answers in request order; an absent key has no value and version 0; an empty value is present',
    async run(target) {
      const kv = target.kv('doric');
      const { position } = await kv.commit([
        put(bytes('a/b'), bytes('bee')),
        put(bytes('a/e'), new Uint8Array()),
        put(bytes('a/a'), bytes('ay')),
      ]);
      const requested = [bytes('a/e'), bytes('a/missing'), bytes('a/b'), bytes('a/a')];
      const items = await getAll(kv, requested);

      assert.deepEqual(
        items.map((item) => ({
          key: hex(item.key),
          value: item.value === undefined ? undefined : hex(item.value),
          version: item.version,
        })),
        [
          { key: hex(bytes('a/e')), value: '', version: position },
          { key: hex(bytes('a/missing')), value: undefined, version: 0 },
          { key: hex(bytes('a/b')), value: hex(bytes('bee')), version: position },
          { key: hex(bytes('a/a')), value: hex(bytes('ay')), version: position },
        ],
      );
    },
  },
];
