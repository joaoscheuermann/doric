// Guarantees 2 to 4: positions and versions, positioned puts, conditions,
// item order, `clear_range`, concurrent commits, and one committed state per
// read call (T4.2).

import assert from 'node:assert/strict';

import type { KvTarget } from './index.js';
import {
  bytes,
  clearRange,
  concat,
  condition,
  del,
  dump,
  getAll,
  getRequest,
  hex,
  type KvCase,
  positionedPut,
  put,
  rangeAll,
  rangeRequest,
  refusal,
  u64be,
} from './support.js';

/** The version `Get` answers for `key`, as `doric`. */
const versionOf = async (target: KvTarget, key: Uint8Array): Promise<number> => {
  const [item] = await getAll(target.kv('doric'), [key]);

  assert.ok(item !== undefined, 'Get answers one item per key');

  return item.version;
};

/** `count` keys `a/s/00` to `a/s/<count-1>`, two decimal digits each. */
const snapshotKeys = (count: number): Uint8Array[] =>
  Array.from({ length: count }, (_, index) =>
    bytes(`a/s/${String(index).padStart(2, '0')}`),
  );

export const commitCases: readonly KvCase[] = [
  {
    name: 'commit: positions rise below 2^53, a version is the last write\'s position, a deleted key has version 0',
    async run(target) {
      const kv = target.kv('doric');
      const first = await kv.commit([put(bytes('a/k'), bytes('1'))]);
      const second = await kv.commit([put(bytes('a/other'), bytes('2'))]);
      const third = await kv.commit([put(bytes('a/k'), bytes('3'))]);

      for (const { position } of [first, second, third]) {
        assert.ok(Number.isSafeInteger(position) && position > 0, `position ${position}`);
        assert.ok(position < 2 ** 53, `position ${position} is below 2^53`);
      }

      assert.ok(first.position < second.position, 'positions rise');
      assert.ok(second.position < third.position, 'positions rise');
      assert.equal(await versionOf(target, bytes('a/k')), third.position);
      assert.equal(await versionOf(target, bytes('a/other')), second.position);

      const [entry] = await rangeAll(kv, {
        start: bytes('a/k'),
        end: bytes('a/k', 0x00),
        limit: 1,
      });

      assert.equal(entry?.version, third.position, 'Range answers the same version');

      const fourth = await kv.commit([del(bytes('a/k'))]);

      assert.ok(third.position < fourth.position, 'positions rise');
      assert.equal(await versionOf(target, bytes('a/k')), 0);
    },
  },
  {
    name: 'commit: a positioned put writes its prefix followed by the position, 8 bytes big-endian',
    async run(target) {
      const kv = target.kv('doric');
      const prefix = bytes('a/log/');
      const { position } = await kv.commit([positionedPut(prefix, bytes('entry'))]);
      const entries = await rangeAll(kv, {
        start: prefix,
        end: bytes('a/log0'),
        limit: 10,
      });

      assert.deepEqual(
        entries.map((entry) => ({
          key: hex(entry.key),
          value: hex(entry.value),
          version: entry.version,
        })),
        [
          {
            key: hex(concat(prefix, u64be(position))),
            value: hex(bytes('entry')),
            version: position,
          },
        ],
      );
    },
  },
  {
    name: 'commit: conditions on a version and on absence that hold let the commit apply',
    async run(target) {
      const kv = target.kv('doric');
      const { position } = await kv.commit([put(bytes('a/v'), bytes('old'))]);
      const next = await kv.commit([
        condition(bytes('a/v'), position),
        condition(bytes('a/absent'), 0),
        put(bytes('a/v'), bytes('new')),
        put(bytes('a/absent'), bytes('here')),
      ]);
      const items = await getAll(kv, [bytes('a/v'), bytes('a/absent')]);

      assert.deepEqual(
        items.map((item) => ({ value: hex(item.value ?? bytes('?')), version: item.version })),
        [
          { value: hex(bytes('new')), version: next.position },
          { value: hex(bytes('here')), version: next.position },
        ],
      );
    },
  },
  {
    name: 'commit: a failing condition answers condition_failed with the first failing key in item order and writes nothing',
    async run(target) {
      const kv = target.kv('doric');
      const { position } = await kv.commit([
        put(bytes('a/p'), bytes('present')),
        put(bytes('a/q'), bytes('present')),
      ]);
      const before = await dump(target);

      // A wrong version, then a presence where absence is required: the first fails.
      await assert.rejects(
        kv.commit([
          condition(bytes('a/p'), position),
          condition(bytes('a/q'), position + 1),
          condition(bytes('a/p'), 0),
          put(bytes('a/written'), bytes('x')),
        ]),
        refusal('condition_failed', { key: hex(bytes('a/q')) }),
      );
      // Absence required on a present key.
      await assert.rejects(
        kv.commit([condition(bytes('a/p'), 0), del(bytes('a/q'))]),
        refusal('condition_failed', { key: hex(bytes('a/p')) }),
      );
      // A version required on an absent key.
      await assert.rejects(
        kv.commit([condition(bytes('a/none'), position), put(bytes('a/none'), bytes('x'))]),
        refusal('condition_failed', { key: hex(bytes('a/none')) }),
      );
      assert.deepEqual(await dump(target), before);
    },
  },
  {
    name: 'commit: mutations apply in item order, so a later item on a key wins',
    async run(target) {
      const kv = target.kv('doric');
      const { position } = await kv.commit([
        put(bytes('a/twice'), bytes('first')),
        put(bytes('a/twice'), bytes('second')),
        put(bytes('a/gone'), bytes('written')),
        del(bytes('a/gone')),
      ]);
      const items = await getAll(kv, [bytes('a/twice'), bytes('a/gone')]);

      assert.deepEqual(
        items.map((item) => ({
          value: item.value === undefined ? undefined : hex(item.value),
          version: item.version,
        })),
        [
          { value: hex(bytes('second')), version: position },
          { value: undefined, version: 0 },
        ],
      );

      const revived = await kv.commit([
        del(bytes('a/twice')),
        put(bytes('a/twice'), bytes('third')),
      ]);
      const [twice] = await getAll(kv, [bytes('a/twice')]);

      assert.equal(hex(twice?.value ?? new Uint8Array()), hex(bytes('third')));
      assert.equal(twice?.version, revived.position);
    },
  },
  {
    name: 'commit: clearRange removes the keys from start, included, to end, excluded',
    async run(target) {
      const kv = target.kv('doric');

      await kv.commit(
        ['a/c0', 'a/c1', 'a/c1x', 'a/c2', 'a/c3'].map((key) => put(bytes(key), bytes('v'))),
      );
      await kv.commit([clearRange(bytes('a/c1'), bytes('a/c3'))]);

      const keys = await rangeAll(kv, { start: bytes('a/'), end: bytes('a/d'), limit: 10 });

      assert.deepEqual(
        keys.map((entry) => hex(entry.key)),
        [hex(bytes('a/c0')), hex(bytes('a/c3'))],
      );
    },
  },
  {
    name: 'commit: of two concurrent commits requiring one key absent, exactly one succeeds',
    async run(target) {
      const commitOnce = (value: string) =>
        target.kv('doric').commit([condition(bytes('a/race'), 0), put(bytes('a/race'), bytes(value))]);
      const results = await Promise.allSettled([commitOnce('left'), commitOnce('right')]);
      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.filter((result) => result.status === 'rejected');

      assert.equal(won.length, 1, 'exactly one commit succeeds');
      assert.equal(lost.length, 1);
      refusal('condition_failed', { key: hex(bytes('a/race')) })(lost[0]?.reason);

      const [item] = await getAll(target.kv('doric'), [bytes('a/race')]);

      assert.equal(item?.version, won[0]?.value.position);
    },
  },
  {
    name: 'commit: a commit during an unfinished Range of 20 keys does not reach the rest of that Range',
    async run(target) {
      const kv = target.kv('doric');
      const keys = snapshotKeys(20);
      const { position } = await kv.commit(keys.map((key) => put(key, bytes('old'))));
      const answer = kv
        .range(
          rangeRequest({
            start: bytes('a/s/'),
            end: bytes('a/s0'),
            limit: 100,
          }),
        )
        [Symbol.asyncIterator]();
      const first = await answer.next();

      assert.equal(first.done, false);

      const later = await kv.commit([
        ...keys.map((key) => put(key, bytes('new'))),
        put(bytes('a/s/05x'), bytes('new')),
        del(bytes('a/s/19')),
      ]);
      const rest: { key: string; value: string; version: number }[] = [];

      for (let item = await answer.next(); item.done !== true; item = await answer.next()) {
        rest.push({
          key: hex(item.value.key),
          value: hex(item.value.value),
          version: item.value.version,
        });
      }

      assert.deepEqual(
        rest,
        keys.slice(1).map((key) => ({ key: hex(key), value: hex(bytes('old')), version: position })),
      );

      const after = await rangeAll(kv, { start: bytes('a/s/'), end: bytes('a/s0'), limit: 100 });

      assert.equal(after.length, 20, 'a later Range sees the commit');
      assert.ok(after.every((entry) => entry.version === later.position));
    },
  },
  {
    name: 'commit: a commit during an unfinished Get of 20 keys does not reach the rest of that Get',
    async run(target) {
      const kv = target.kv('doric');
      const keys = snapshotKeys(20);
      const { position } = await kv.commit(keys.map((key) => put(key, bytes('old'))));
      const answer = kv
        .get(getRequest(keys))
        [Symbol.asyncIterator]();
      const first = await answer.next();

      assert.equal(first.done, false);

      const later = await kv.commit([
        ...keys.slice(0, 10).map((key) => put(key, bytes('new'))),
        ...keys.slice(10).map((key) => del(key)),
      ]);
      const rest: { key: string; value: string | undefined; version: number }[] = [];

      for (let item = await answer.next(); item.done !== true; item = await answer.next()) {
        rest.push({
          key: hex(item.value.key),
          value: item.value.value === undefined ? undefined : hex(item.value.value),
          version: item.value.version,
        });
      }

      assert.deepEqual(
        rest,
        keys.slice(1).map((key) => ({ key: hex(key), value: hex(bytes('old')), version: position })),
      );

      const after = await getAll(kv, keys);

      assert.deepEqual(
        after.map((item) => item.version),
        keys.map((_, index) => (index < 10 ? later.position : 0)),
        'a later Get sees the commit',
      );
    },
  },
];
