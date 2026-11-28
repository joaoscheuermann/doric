// Guarantee 6 (limits), the refusals of A76 and the order of the checks of
// section 17, "Order of the checks" (T4.2).

import assert from 'node:assert/strict';

import type { CommitRequest } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import { kvLimits } from '../../kv.js';
import type { KvTarget } from './index.js';
import {
  bytes,
  clearRange,
  collect,
  condition,
  del,
  dump,
  emptyItem,
  getAll,
  getRequest,
  hex,
  type KvCase,
  positionedPut,
  put,
  rangeAll,
  refusal,
  sized,
} from './support.js';

/** How long the cases that send the largest commits may take. */
const largeCommitTimeoutMs = 600_000;

/** Runs `refused`, which must reject with `matcher`, and checks that nothing changed. */
const refusedWithoutChange = async (
  target: KvTarget,
  refused: () => Promise<unknown>,
  matcher: (error: unknown) => boolean,
): Promise<void> => {
  const before = await dump(target);

  await assert.rejects(refused(), matcher);
  assert.deepEqual(await dump(target), before, 'a refused call changes nothing');
};

const limit = (name: string) => refusal('limit_exceeded', { limit: name });

/** `count` distinct keys `<prefix>0000…`. */
const manyKeys = (prefix: string, count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, index) => bytes(`${prefix}${String(index).padStart(4, '0')}`));

export const limitCases: readonly KvCase[] = [
  {
    name: 'limits: keyBytes passes at 4096 bytes and answers limit_exceeded at 4097, in every field',
    async run(target) {
      const kv = target.kv('doric');
      const atLimit = sized('a/k', kvLimits.keyBytes);
      const overLimit = sized('a/k', kvLimits.keyBytes + 1);
      const { position } = await kv.commit([put(atLimit, bytes('v'))]);
      const [item] = await getAll(kv, [atLimit]);

      assert.equal(item?.version, position);

      const entries = await rangeAll(kv, { start: atLimit, end: sized('a/l', 10), limit: 10 });

      assert.deepEqual(entries.map((entry) => hex(entry.key)), [hex(atLimit)]);

      // A positioned put counts its prefix plus the 8 bytes of the position.
      await kv.commit([positionedPut(sized('a/p', kvLimits.keyBytes - 8), bytes('v'))]);

      await refusedWithoutChange(target, () => kv.commit([put(overLimit, bytes('v'))]), limit('keyBytes'));
      await refusedWithoutChange(target, () => kv.commit([del(overLimit)]), limit('keyBytes'));
      await refusedWithoutChange(
        target,
        () => kv.commit([condition(overLimit, 0), put(bytes('a/x'), bytes('v'))]),
        limit('keyBytes'),
      );
      await refusedWithoutChange(
        target,
        () => kv.commit([clearRange(bytes('a/'), overLimit)]),
        limit('keyBytes'),
      );
      await refusedWithoutChange(
        target,
        () => kv.commit([positionedPut(sized('a/p', kvLimits.keyBytes - 7), bytes('v'))]),
        limit('keyBytes'),
      );
      await assert.rejects(getAll(kv, [overLimit]), limit('keyBytes'));
      await assert.rejects(
        rangeAll(kv, { start: overLimit, end: sized('a/l', 10), limit: 10 }),
        limit('keyBytes'),
      );
      await assert.rejects(
        rangeAll(kv, { start: bytes('a/'), end: overLimit, limit: 10 }),
        limit('keyBytes'),
      );
    },
  },
  {
    name: 'limits: valueBytes passes at 1,048,576 bytes and answers limit_exceeded one past it',
    async run(target) {
      const kv = target.kv('doric');
      const atLimit = new Uint8Array(kvLimits.valueBytes).fill(0x76);
      const overLimit = new Uint8Array(kvLimits.valueBytes + 1).fill(0x76);
      const { position } = await kv.commit([put(bytes('a/big'), atLimit)]);
      const [item] = await getAll(kv, [bytes('a/big')]);

      assert.equal(item?.value?.length, kvLimits.valueBytes);
      assert.equal(item?.version, position);

      await kv.commit([positionedPut(bytes('a/p/'), atLimit)]);
      await refusedWithoutChange(
        target,
        () => kv.commit([put(bytes('a/bigger'), overLimit)]),
        limit('valueBytes'),
      );
      await refusedWithoutChange(
        target,
        () => kv.commit([positionedPut(bytes('a/q/'), overLimit)]),
        limit('valueBytes'),
      );
    },
  },
  {
    name: 'limits: getKeys passes at 1,000 keys and answers limit_exceeded at 1,001',
    async run(target) {
      const kv = target.kv('doric');
      const items = await getAll(kv, manyKeys('a/g', kvLimits.getKeys));

      assert.equal(items.length, kvLimits.getKeys);
      await assert.rejects(getAll(kv, manyKeys('a/g', kvLimits.getKeys + 1)), limit('getKeys'));
    },
  },
  {
    name: 'limits: rangeLimit passes at 1,000 and answers limit_exceeded at 1,001',
    async run(target) {
      const kv = target.kv('doric');
      const keys = manyKeys('a/r', kvLimits.rangeLimit + 1);

      await kv.commit(keys.map((key) => put(key, new Uint8Array())));

      const entries = await rangeAll(kv, {
        start: bytes('a/r'),
        end: bytes('a/s'),
        limit: kvLimits.rangeLimit,
      });

      assert.equal(entries.length, kvLimits.rangeLimit);
      await assert.rejects(
        rangeAll(kv, { start: bytes('a/r'), end: bytes('a/s'), limit: kvLimits.rangeLimit + 1 }),
        limit('rangeLimit'),
      );
    },
  },
  {
    name: 'limits: commitItems passes at 200,000 items and answers limit_exceeded at 200,001',
    timeout: largeCommitTimeoutMs,
    heavy: true,
    async run(target) {
      const kv = target.kv('doric');
      const items = (count: number, key: Uint8Array): CommitRequest[] => {
        const out: CommitRequest[] = [put(key, new Uint8Array())];
        const deletion = del(bytes('a/d'));

        while (out.length < count) {
          out.push(deletion);
        }

        return out;
      };

      await refusedWithoutChange(
        target,
        () => kv.commit(items(kvLimits.commitItems + 1, bytes('a/over'))),
        limit('commitItems'),
      );

      const { position } = await kv.commit(items(kvLimits.commitItems, bytes('a/at')));
      const [item] = await getAll(kv, [bytes('a/at')]);

      assert.equal(item?.version, position);
    },
  },
  {
    name: 'limits: commitBytes passes at 67,108,864 bytes of keys and values and answers limit_exceeded one past it',
    timeout: largeCommitTimeoutMs,
    async run(target) {
      const kv = target.kv('doric');
      const full = new Uint8Array(kvLimits.valueBytes).fill(0x62);
      // 63 puts of a 4-byte key and a full value, then one 4-byte key whose
      // value brings the total to `commitBytes`, or one byte past it.
      const items = (extra: number): CommitRequest[] => {
        const out = Array.from({ length: 63 }, (_, index) =>
          put(bytes(`a/${String(index).padStart(2, '0')}`), full),
        );
        const rest = kvLimits.commitBytes - 63 * (4 + kvLimits.valueBytes) - 4;

        out.push(put(bytes('a/zz'), full.subarray(0, rest + extra)));

        return out;
      };

      await refusedWithoutChange(target, () => kv.commit(items(1)), limit('commitBytes'));

      const { position } = await kv.commit(items(0));
      const [item] = await getAll(kv, [bytes('a/zz')]);

      assert.equal(item?.version, position);
    },
  },
  {
    name: 'refusals: invalid_input for an empty Get, a limit of 0, a start after end, an item with no case and a commit with no mutation',
    async run(target) {
      const kv = target.kv('doric');
      const invalid = refusal('invalid_input');

      await kv.commit([put(bytes('a/c'), bytes('v'))]);
      await assert.rejects(collect(kv.get(getRequest([]))), invalid);
      await assert.rejects(rangeAll(kv, { start: bytes('a/'), end: bytes('a/z'), limit: 0 }), invalid);
      await assert.rejects(rangeAll(kv, { start: bytes('a/z'), end: bytes('a/y'), limit: 10 }), invalid);
      await refusedWithoutChange(
        target,
        () => kv.commit([put(bytes('a/n'), bytes('v')), clearRange(bytes('a/z'), bytes('a/y'))]),
        invalid,
      );
      await refusedWithoutChange(
        target,
        () => kv.commit([put(bytes('a/n'), bytes('v')), emptyItem()]),
        invalid,
      );
      await refusedWithoutChange(target, () => kv.commit([]), invalid);
      await refusedWithoutChange(target, () => kv.commit([condition(bytes('a/c'), 0)]), invalid);

      // A start equal to end is no refusal: the range is empty.
      assert.deepEqual(
        await rangeAll(kv, { start: bytes('a/c'), end: bytes('a/c'), limit: 10 }),
        [],
      );
      await kv.commit([clearRange(bytes('a/c'), bytes('a/c'))]);
      assert.equal((await getAll(kv, [bytes('a/c')]))[0]?.value?.length, 1);
    },
  },
  {
    name: 'order of the checks: Get checks key by key, so an over-long first key answers keyBytes',
    async run(target) {
      const kv = target.kv('doric');

      await assert.rejects(
        getAll(kv, [sized('a/', kvLimits.keyBytes + 1), bytes('b/x')]),
        limit('keyBytes'),
      );
    },
  },
  {
    name: 'order of the checks: Range checks limit 0, then rangeLimit, then start after end',
    async run(target) {
      const kv = target.kv('doric');

      await assert.rejects(
        rangeAll(kv, { start: bytes('c/'), end: bytes('b/'), limit: 0 }),
        refusal('invalid_input'),
      );
      await assert.rejects(
        rangeAll(kv, { start: bytes('c/'), end: bytes('b/'), limit: kvLimits.rangeLimit + 1 }),
        limit('rangeLimit'),
      );
      await assert.rejects(
        rangeAll(kv, { start: bytes('c/'), end: bytes('b/'), limit: 10 }),
        refusal('invalid_input'),
      );
    },
  },
  {
    name: 'order of the checks: each commit item is checked for its case, keyBytes, valueBytes and bounds before the end of the stream and the conditions',
    async run(target) {
      const kv = target.kv('doric');
      const tooLong = sized('a/', kvLimits.keyBytes + 1);
      const tooBig = new Uint8Array(kvLimits.valueBytes + 1);

      // Item by item, as they arrive.
      await refusedWithoutChange(target, () => kv.commit([emptyItem(), put(bytes('b/x'), bytes('v'))]), refusal('invalid_input'));
      // Within an item: keyBytes, then valueBytes.
      await refusedWithoutChange(target, () => kv.commit([put(tooLong, tooBig)]), limit('keyBytes'));
      // A clear range: keyBytes, then its bounds.
      await refusedWithoutChange(
        target,
        () => kv.commit([clearRange(sized('a/z', kvLimits.keyBytes + 1), bytes('a/a'))]),
        limit('keyBytes'),
      );
      // The end of the stream before the conditions: conditions only is invalid_input.
      await refusedWithoutChange(target, () => kv.commit([condition(bytes('a/none'), 7)]), refusal('invalid_input'));
      // The conditions last: an item refusal wins over a failing condition.
      await refusedWithoutChange(
        target,
        () => kv.commit([condition(bytes('a/none'), 7), put(tooLong, bytes('v'))]),
        limit('keyBytes'),
      );
      await refusedWithoutChange(
        target,
        () => kv.commit([condition(bytes('a/none'), 7), emptyItem()]),
        refusal('invalid_input'),
      );
    },
  },
  {
    name: 'order of the checks: a Get of 1,001 keys that holds an over-long key answers getKeys',
    async run(target) {
      const keys = manyKeys('a/g', kvLimits.getKeys);

      keys.splice(1, 0, sized('a/', kvLimits.keyBytes + 1));
      assert.equal(keys.length, kvLimits.getKeys + 1);
      await assert.rejects(getAll(target.kv('doric'), keys), limit('getKeys'));
    },
  },
  {
    name: 'order of the checks: the item that crosses commitItems and commitBytes at once answers commitItems, and a clear range with start after end invalid_input',
    timeout: largeCommitTimeoutMs,
    heavy: true,
    async run(target) {
      const kv = target.kv('doric');
      const full = new Uint8Array(kvLimits.valueBytes).fill(0x62);
      const deletion = del(bytes('a/d'));
      // 64 puts and 199,936 deletes of a 3-byte key: 200,000 items and
      // exactly `commitBytes` bytes, so any further item crosses both limits.
      const deletes = kvLimits.commitItems - 64;
      const rest = kvLimits.commitBytes - 63 * (4 + kvLimits.valueBytes) - 4 - deletes * 3;
      const items = (last: CommitRequest): CommitRequest[] => {
        const out = Array.from({ length: 63 }, (_, index) =>
          put(bytes(`a/${String(index).padStart(2, '0')}`), full),
        );

        out.push(put(bytes('a/zz'), full.subarray(0, rest)));

        for (let index = 0; index < deletes; index += 1) {
          out.push(deletion);
        }

        out.push(last);

        return out;
      };

      // commitItems before commitBytes.
      await refusedWithoutChange(target, () => kv.commit(items(del(bytes('a/d')))), limit('commitItems'));
      // A clear range's bounds before commitItems and commitBytes.
      await refusedWithoutChange(
        target,
        () => kv.commit(items(clearRange(bytes('a/z'), bytes('a/y')))),
        refusal('invalid_input'),
      );
    },
  },
  {
    name: 'limits: commitBytes counts a positioned put\'s key prefix plus 8 bytes, and every condition, delete and clear-range key',
    timeout: largeCommitTimeoutMs,
    async run(target) {
      const kv = target.kv('doric');
      const full = new Uint8Array(kvLimits.valueBytes).fill(0x62);
      // The counted bytes of the tail at its shortest: a condition key and a
      // delete key of 3 bytes, a clear range of two 4-byte keys and a
      // positioned put of a 4-byte prefix, 8 position bytes and no value.
      const tailBytes = 3 + 3 + (4 + 4) + (4 + 8);
      const rest = kvLimits.commitBytes - 63 * (4 + kvLimits.valueBytes) - 4 - tailBytes;
      const items = (tail: {
        readonly condition?: string;
        readonly del?: string;
        readonly start?: string;
        readonly end?: string;
        readonly prefix?: string;
      }): CommitRequest[] => {
        const out = Array.from({ length: 63 }, (_, index) =>
          put(bytes(`a/${String(index).padStart(2, '0')}`), full),
        );

        out.push(put(bytes('a/zz'), full.subarray(0, rest)));
        out.push(condition(bytes(tail.condition ?? 'a/c'), 0));
        out.push(del(bytes(tail.del ?? 'a/x')));
        out.push(clearRange(bytes(tail.start ?? 'a/r0'), bytes(tail.end ?? 'a/r1')));
        out.push(positionedPut(bytes(tail.prefix ?? 'a/p/'), new Uint8Array()));

        return out;
      };

      // One byte more in any one key crosses the limit.
      for (const longer of [
        { condition: 'a/cc' },
        { del: 'a/xx' },
        { start: 'a/r00' },
        { end: 'a/r10' },
        { prefix: 'a/pp/' },
      ]) {
        await refusedWithoutChange(target, () => kv.commit(items(longer)), limit('commitBytes'));
      }

      // Exactly `commitBytes`: the commit applies.
      const { position } = await kv.commit(items({}));
      const [item] = await getAll(kv, [bytes('a/zz')]);

      assert.equal(item?.version, position);
    },
  },
];
