// Guarantee 8 (isolation) and A79: `storage.kv/v1` serves only the platform's
// caller, `doric`, which reaches every prefix; every other caller is refused
// with `not_owner` and the message `storage.kv/v1 serves only the platform.`
// before anything is read or written (T4.2). The prefix check of guarantee 8,
// which guards the keys `doric-storage` writes for a caller, is tested in Rust,
// in the unit tests of `doric-sqlite` (`engine/src/access.rs`, `limits.rs`).

import assert from 'node:assert/strict';

import { isContractError } from 'bundle/contracts';

import {
  bytes,
  clearRange,
  condition,
  dump,
  everything,
  getAll,
  hex,
  type KvCase,
  put,
  rangeAll,
} from './support.js';

/** The message of the refusal of every caller but `doric`. */
const platformOnly = 'storage.kv/v1 serves only the platform.';

/** `error` is the refusal of a caller but `doric`: `not_owner` with its message. */
const servesOnlyThePlatform = (error: unknown): boolean => {
  assert.ok(isContractError(error), `expected not_owner, got ${String(error)}`);
  assert.equal(error.code, 'not_owner', error.message);
  assert.equal(error.message, platformOnly);

  return true;
};

export const accessCases: readonly KvCase[] = [
  {
    name: 'access: a caller but doric is not_owner for a Get, a Range and a Commit, even under its own prefix, and nothing changes',
    async run(target) {
      const doric = target.kv('doric');
      const { position } = await doric.commit([
        put(bytes('a/keep'), bytes('a')),
        put(bytes('b/keep'), bytes('b')),
      ]);

      for (const own of ['a', 'b']) {
        const kv = target.kv(own);

        await assert.rejects(getAll(kv, [bytes(`${own}/keep`)]), servesOnlyThePlatform);
        await assert.rejects(
          rangeAll(kv, { start: bytes(`${own}/`), end: bytes(`${own}/`, 0xff), limit: 10 }),
          servesOnlyThePlatform,
        );
        await assert.rejects(
          kv.commit([put(bytes(`${own}/new`), bytes('n'))]),
          servesOnlyThePlatform,
        );
      }

      assert.deepEqual(await dump(target), [
        { key: hex(bytes('a/keep')), value: hex(bytes('a')), version: position },
        { key: hex(bytes('b/keep')), value: hex(bytes('b')), version: position },
      ]);
    },
  },
  {
    name: 'access: doric reaches a/, b/ and doric/',
    async run(target) {
      const doric = target.kv('doric');
      const keys = [bytes('a/d'), bytes('b/d'), bytes('doric/d')];
      const { position } = await doric.commit([
        condition(bytes('a/d'), 0),
        ...keys.map((key) => put(key, bytes('v'))),
      ]);
      const items = await getAll(doric, keys);

      assert.deepEqual(
        items.map((item) => ({ key: hex(item.key), version: item.version })),
        keys.map((key) => ({ key: hex(key), version: position })),
      );

      const all = await rangeAll(doric, { ...everything, limit: 10 });

      assert.deepEqual(all.map((entry) => hex(entry.key)), keys.map(hex));

      await doric.commit([clearRange(bytes('a/'), bytes('c/'))]);
      assert.deepEqual(
        (await rangeAll(doric, { ...everything, limit: 10 })).map((entry) => hex(entry.key)),
        [hex(bytes('doric/d'))],
      );
    },
  },
];
