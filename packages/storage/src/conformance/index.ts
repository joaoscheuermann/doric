/**
 * The conformance kit of `storage.backend/v1`: the cases every storage
 * backend must pass (documents, concurrency, revision conflicts, paginated
 * queries, sequences with gaps, snapshot + cursor, the commit feed, commit
 * failure, blobs, limits, health and identity). A backend's test suite gives
 * the kit a harness and calls `runStorageConformance`.
 */
import { describe, test } from 'node:test';

import { blobCases } from './blobs.js';
import { concurrencyCases } from './concurrency.js';
import { documentCases, revisionCases } from './documents.js';
import { failureCases } from './failure.js';
import { feedCases } from './feed.js';
import type {
  ConformanceCase,
  ConformanceHarness,
  ConformanceInstance,
} from './harness.js';
import { identityCases } from './identity.js';
import { queryCases } from './indexes.js';
import { limitCases } from './limits.js';
import { snapshotCases } from './snapshot.js';
import { streamCases } from './streams.js';

export type {
  ConformanceCase,
  ConformanceHarness,
  ConformanceInstance,
  ConformanceOpenOptions,
} from './harness.js';

/** Every case, grouped, in the order the kit runs them. */
export const conformanceCases: readonly ConformanceCase[] = Object.freeze([
  ...documentCases,
  ...concurrencyCases,
  ...revisionCases,
  ...queryCases,
  ...streamCases,
  ...snapshotCases,
  ...feedCases,
  ...failureCases,
  ...blobCases,
  ...limitCases,
  ...identityCases,
]);

/**
 * Runs one case over an emptied store. Every instance the case opens and
 * does not close or crash itself is closed afterwards, even when it fails.
 */
export const runConformanceCase = async <Instance extends ConformanceInstance>(
  harness: ConformanceHarness<Instance>,
  conformanceCase: ConformanceCase,
): Promise<void> => {
  const opened = new Set<Instance>();
  const tracked: ConformanceHarness<Instance> = {
    name: harness.name,
    open: async (options) => {
      const instance = await harness.open(options);

      opened.add(instance);

      return instance;
    },
    reset: () => harness.reset(),
    crash: async (instance) => {
      opened.delete(instance);
      await harness.crash(instance);
    },
    close: async (instance) => {
      opened.delete(instance);
      await harness.close(instance);
    },
  };

  await harness.reset();

  try {
    await conformanceCase.run(tracked);
  } finally {
    for (const instance of opened) {
      await harness.close(instance);
    }
  }
};

export interface ConformanceRunOptions {
  /** Skips every case, with this reason when it is a string. */
  readonly skip?: boolean | string;
  /** The time limit of one case in milliseconds; 120 000 by default. */
  readonly timeout?: number;
}

/** Registers one `node:test` suite per case group, with one test per case. */
export const runStorageConformance = <Instance extends ConformanceInstance>(
  harness: ConformanceHarness<Instance>,
  options: ConformanceRunOptions = {},
): void => {
  const groups = new Map<string, ConformanceCase[]>();

  for (const conformanceCase of conformanceCases) {
    const group = groups.get(conformanceCase.group) ?? [];

    group.push(conformanceCase);
    groups.set(conformanceCase.group, group);
  }

  for (const [group, cases] of groups) {
    void describe(`${harness.name} storage conformance: ${group}`, () => {
      for (const conformanceCase of cases) {
        void test(
          `${conformanceCase.id} ${conformanceCase.title}`,
          {
            skip: options.skip ?? false,
            timeout: options.timeout ?? 120_000,
          },
          () => runConformanceCase(harness, conformanceCase),
        );
      }
    });
  }
};
