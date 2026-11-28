/**
 * The `storage/v2` conformance kit (S77b2; spec
 * `docs/designs/grpc-processes.md`, "Conformance"): the cases of
 * documents, indexes, snapshot, failure, limits, streams, blobs and
 * health, concurrency and registration, run over a spawned `sqlite`
 * through the `storage/v2` client. Each test file of
 * `packages/storage/tests` calls `runStorageV2Conformance` with its
 * cases: `storage.test.ts` with `storageV2Cases`,
 * `storage-instances.test.ts` with `instanceV2Cases`,
 * `registration.test.ts` with `registrationV2Cases`. Not exported from
 * the package; the v1 kit in `../` is unchanged.
 */
import { after, before, describe, test } from 'node:test';

import { blobCases } from './blobs.js';
import { concurrencyCases } from './concurrency.js';
import { documentCases } from './documents.js';
import { failureCases } from './failure.js';
import {
  openV2Harness,
  type V2Case,
  type V2Engine,
  type V2Harness,
  type V2HarnessHandle,
} from './harness.js';
import { queryCases } from './indexes.js';
import { limitCases } from './limits.js';
import { registrationCases } from './registration.js';
import { snapshotCases } from './snapshot.js';
import { streamCases } from './streams.js';

export {
  conformanceBundle,
  conformanceFiles,
  openV2Engine,
  openV2Harness,
  untilS78,
  type V2Case,
  type V2CaseOptions,
  type V2Engine,
  type V2Harness,
  type V2HarnessHandle,
  type V2HarnessOptions,
} from './harness.js';

/**
 * The cases of `storage.test.ts` (T4.3, T4.9, T4.23), in run order:
 * documents, queries, snapshot, failure, limits, streams, then blobs
 * and health, skipped with `untilS78`.
 */
export const storageV2Cases: readonly V2Case[] = Object.freeze([
  ...documentCases,
  ...queryCases,
  ...snapshotCases,
  ...failureCases,
  ...limitCases,
  ...streamCases,
  ...blobCases,
]);

/** The cases of `storage-instances.test.ts` (T4.8). */
export const instanceV2Cases: readonly V2Case[] = concurrencyCases;

/** The cases of `registration.test.ts` (T4.24). */
export const registrationV2Cases: readonly V2Case[] = registrationCases;

/** Every case of the kit; their IDs are unique. */
export const v2ConformanceCases: readonly V2Case[] = Object.freeze([
  ...storageV2Cases,
  ...instanceV2Cases,
  ...registrationV2Cases,
]);

/**
 * Runs one case on `harness`: resets it, runs the case, then closes every
 * engine the case's `fresh()` opened, even when the case rejects. Rejects
 * with the case's rejection; a failed close rejects only when the case
 * succeeded.
 */
export const runV2Case = async (
  harness: V2HarnessHandle,
  conformanceCase: V2Case,
): Promise<void> => {
  const opened: V2Engine[] = [];
  const tracked = (over: V2Harness): V2Harness => ({
    ...over,
    fresh: async () => {
      const fresh = await over.fresh();

      opened.push(fresh.engine);

      return tracked(fresh);
    },
  });

  await harness.reset();

  const [ran] = await Promise.allSettled([
    (async () => conformanceCase.run(tracked(harness)))(),
  ]);
  const closed = await Promise.allSettled(
    opened.map((engine) => engine.close()),
  );

  for (const result of [ran, ...closed]) {
    if (result?.status === 'rejected') {
      throw result.reason;
    }
  }
};

/** Which cases a run registers, and how. */
export interface V2RunOptions {
  /** The suites' name, in every suite title; `'sqlite'` when absent. */
  readonly name?: string;
  /** The cases to register, in order; `v2ConformanceCases` when absent. */
  readonly cases?: readonly V2Case[];
  /** Opens each engine; `openV2Engine` when absent. */
  readonly openEngine?: () => Promise<V2Engine>;
  /**
   * Skips every case, with this reason when it is a string; a case's own
   * `skip` holds when this is absent.
   */
  readonly skip?: boolean | string;
  /** A case's time limit in milliseconds when it sets none; 120 000 when absent. */
  readonly timeout?: number;
}

/**
 * Registers, synchronously, one `node:test` suite per group of
 * `options.cases`, titled `<name> storage/v2 conformance: <group>`, with
 * one test per case titled `<id> <title>`, skipped with the case's `skip`
 * reason when it has one. The first suite's `before` hook opens the
 * harness with `openV2Harness`, every case runs through `runV2Case`, and
 * the last suite's `after` hook closes it, even when a case fails. When
 * the harness does not open, every case fails with that rejection.
 */
export const runStorageV2Conformance = (options: V2RunOptions = {}): void => {
  const name = options.name ?? 'sqlite';
  const groups = new Map<string, V2Case[]>();

  for (const conformanceCase of options.cases ?? v2ConformanceCases) {
    const group = groups.get(conformanceCase.group) ?? [];

    group.push(conformanceCase);
    groups.set(conformanceCase.group, group);
  }

  let opening: Promise<V2HarnessHandle> | undefined;
  const opened = (): Promise<V2HarnessHandle> => {
    opening ??= openV2Harness({
      name,
      ...(options.openEngine === undefined
        ? {}
        : { openEngine: options.openEngine }),
    });

    return opening;
  };
  const last = groups.size - 1;
  let position = 0;

  for (const [group, cases] of groups) {
    const first = position === 0;
    const final = position === last;

    position += 1;
    void describe(`${name} storage/v2 conformance: ${group}`, () => {
      if (first) {
        before(async () => {
          // A rejection fails every case through `opened()`, not the hook.
          await opened().catch(() => undefined);
        });
      }

      if (final) {
        after(async () => {
          if (opening !== undefined) {
            const handle = await opening.catch(() => undefined);

            await handle?.close();
          }
        });
      }

      for (const conformanceCase of cases) {
        void test(
          `${conformanceCase.id} ${conformanceCase.title}`,
          {
            skip: options.skip ?? conformanceCase.skip ?? false,
            timeout: conformanceCase.timeout ?? options.timeout ?? 120_000,
          },
          async () => runV2Case(await opened(), conformanceCase),
        );
      }
    });
  }
};
