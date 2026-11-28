/**
 * The conformance kit of `storage.kv/v1`: the cases every engine must pass,
 * run against a `Kv` (order and reverse ranges, `limit` and continuation,
 * versions and positions, positioned puts, conditions, item order,
 * `ClearRange`, concurrent commits, one state per read, every limit, the
 * refusals and their order, the caller's prefix, and a seeded random
 * sequence checked against a model). An engine's test suite gives the kit a
 * harness and calls `runKvConformance`.
 */
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Kv } from '../../kv.js';
import { accessCases } from './access.js';
import { commitCases } from './commit.js';
import { limitCases } from './limits.js';
import { orderCases } from './order.js';
import { randomCases } from './random.js';
import type { KvCase } from './support.js';

/** Every case, in the order the kit runs them. */
const kvCases: readonly KvCase[] = [
  ...orderCases,
  ...commitCases,
  ...limitCases,
  ...accessCases,
  ...randomCases,
];

/** One open engine, shared by every case of a run. */
export interface KvTarget {
  /**
   * The engine as `caller`: every call is stamped with that caller. The
   * engine serves only `doric`, which reaches every prefix; every other
   * caller is refused with `not_owner`.
   */
  kv(caller: string): Kv;
  /** Removes every key of every caller; the next case starts empty. */
  reset(): Promise<void>;
  /** Stops the engine. */
  close(): Promise<void>;
}

/** What an engine's test suite gives the kit. */
export interface KvConformanceHarness {
  /** The engine's name, the title of the suite. */
  readonly name: string;
  /** Opens the engine the cases run on, empty. */
  open(): Promise<KvTarget>;
}

/** Which cases a run of the kit registers. */
export interface KvConformanceOptions {
  /**
   * `true` registers only the heavy cases; `false` or absent, every other
   * case. The heavy cases stream a commit of `commitItems + 1` items (200,001)
   * and take minutes on a real engine: the `commitItems` limit case, and the
   * order-of-the-checks case of the item that crosses `commitItems` and
   * `commitBytes` at once.
   */
  readonly heavy?: boolean;
}

/**
 * Registers one `node:test` suite titled `harness.name`, with one test per
 * case: the heavy cases when `options.heavy` is `true`, every other case
 * otherwise. The suite opens one target in its `before` hook, resets it before
 * each case and closes it in its `after` hook, even when a case fails. A
 * case fails on the first answer, version, position or error that differs
 * from the contract; the seeded case uses the seed 20261127, or
 * `DORIC_KV_SEED` when it is set, and its failure names the seed and the
 * index of the first operation that differs.
 */
export const runKvConformance = (
  harness: KvConformanceHarness,
  options: KvConformanceOptions = {},
): void => {
  const heavy = options.heavy === true;
  const cases = kvCases.filter((each) => (each.heavy === true) === heavy);

  void describe(harness.name, () => {
    let target: KvTarget | undefined;

    before(async () => {
      target = await harness.open();
    });

    beforeEach(async () => {
      await opened().reset();
    });

    after(async () => {
      await target?.close();
    });

    const opened = (): KvTarget => {
      if (target === undefined) {
        throw new Error(`${harness.name}: the engine did not open`);
      }

      return target;
    };

    for (const kvCase of cases) {
      void test(
        kvCase.name,
        kvCase.timeout === undefined ? {} : { timeout: kvCase.timeout },
        () => kvCase.run(opened()),
      );
    }
  });
};
