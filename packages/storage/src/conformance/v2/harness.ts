/**
 * The harness of the `storage/v2` conformance kit (S77b2; spec
 * `docs/designs/grpc-processes.md`, "Conformance"): what a case runs on.
 * Every case reaches one spawned `sqlite` engine through the `storage/v2`
 * client, as the bundle `conformance` by default, and may open a fresh
 * engine of its own for the generation cases, since `reset()` keeps the
 * engine's remembered highest generation (S77b1's carried PF5 note).
 * Internal to the package: no entry exports it.
 */
import type { DescFile } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import type { StorageService } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import type { Storage } from '../../client/types.js';
import { file_doric_storage_conformance_v1_conformance } from '../../contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { openTestEngineAt, testEngineBinary } from '../../test-engine.js';
import type { TestEngine } from '../../testing.js';

/** The bundle id the suites write as unless a case names another one. */
export const conformanceBundle = 'conformance';

/**
 * The files `open()` registers by default: `conformance.proto`, which
 * declares `conformance.note/v1`, `conformance.thread/v1` and
 * `conformance.plain/v1`. Frozen.
 */
export const conformanceFiles: readonly DescFile[] = Object.freeze([
  file_doric_storage_conformance_v1_conformance,
]);

/**
 * The skip reason of every case that needs blobs or health, which the
 * engine refuses until S78b (S77b1's PF1): B1–B5 and `T4.3-health`. S78b
 * enables them by removing it.
 */
export const untilS78 = 'S78: streams';

/**
 * A spawned engine as the kit uses it: a `TestEngine` that also hands out
 * raw `storage/v2` clients, so a case can send a call the `Storage` client
 * refuses before any I/O, such as a type of another namespace (PF5).
 */
export interface V2Engine extends TestEngine {
  /**
   * A raw `StorageService` client stamped with `{ caller, generation }`,
   * `generation` 1 when absent, as the router stamps a call. Registers
   * nothing. Its calls reject with `ConnectError`, not `ContractError`;
   * once the engine is closed they reject with code `unavailable`.
   */
  raw(caller: string, generation?: number): Client<typeof StorageService>;
}

/**
 * What one case runs on. The kit empties the engine before each case and,
 * when the case ends, even when it fails, closes every engine `fresh()`
 * opened for it.
 */
export interface V2Harness {
  /** The suite's name, used in its titles. */
  readonly name: string;
  /** The engine the case shares with the other cases of its file. */
  readonly engine: V2Engine;
  /**
   * `engine.storage(bundleId, files, generation)`: registers `files` (and
   * their imports) as `bundleId` of `generation` and answers a new
   * `Storage` stamped as that bundle; `conformanceBundle`,
   * `conformanceFiles` and 1 when absent. Two calls answer two instances
   * over one store. Rejects as `TestEngine.storage` does, with
   * `Register`'s refusal among others.
   */
  open(
    bundleId?: string,
    files?: readonly DescFile[],
    generation?: number,
  ): Promise<Storage>;
  /** `engine.raw(bundleId, generation)`: a raw client, nothing registered. */
  raw(bundleId: string, generation?: number): Client<typeof StorageService>;
  /**
   * Empties the store, as `TestEngine.reset()` does. The engine still
   * remembers each bundle's highest generation, and the declarations are
   * gone until the next `open()` registers them again.
   */
  reset(): Promise<void>;
  /**
   * Opens a new, empty engine, with no generation remembered, and answers
   * a harness over it with this one's `name`; the kit closes it when the
   * case ends. Rejects as `openV2Engine` does.
   */
  fresh(): Promise<V2Harness>;
}

/** How a case is registered with `node:test`. */
export interface V2CaseOptions {
  /** Registers the case as skipped with this reason, e.g. `untilS78`. */
  readonly skip?: string;
  /** The time limit of the case in milliseconds; the run's when absent. */
  readonly timeout?: number;
}

/** One conformance case of `storage/v2`: a behavior and its proof. */
export interface V2Case extends V2CaseOptions {
  /** A stable ID, unique in the kit, such as `D1`, `Q10` or `X1-streams`. */
  readonly id: string;
  /** The group the case belongs to: one `node:test` suite per group. */
  readonly group: string;
  readonly title: string;
  /**
   * Runs the case over an emptied engine. Rejects, with an
   * `AssertionError` or the unexpected error, on the first answer that
   * differs from the contract.
   */
  run(harness: V2Harness): Promise<void>;
}

/**
 * Defines the cases of `group`: each call answers a frozen `V2Case` with
 * the given fields. Throws nothing; IDs are not checked here.
 */
export const caseGroup =
  (group: string) =>
  (
    id: string,
    title: string,
    run: (harness: V2Harness) => Promise<void>,
    options?: V2CaseOptions,
  ): V2Case =>
    Object.freeze({
      id,
      group,
      title,
      run,
      ...(options?.skip === undefined ? {} : { skip: options.skip }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
    });

/**
 * Spawns an engine as `openTestEngine()` does, on a new temporary
 * directory that its `close()` removes, with `raw` beside `kv` and
 * `storage`. Rejects as `openTestEngine` does: with `Error('doric-sqlite
 * is not built: run npx nx run sqlite:compile')` when the executable is
 * missing, and with `startTestProcess`'s failure when it does not start.
 */
export const openV2Engine = (): Promise<V2Engine> =>
  openTestEngineAt(testEngineBinary());

/** A harness the run owns: the root of its cases' harnesses. */
export interface V2HarnessHandle extends V2Harness {
  /**
   * Closes the engine and every engine `fresh()` opened; a second call
   * answers the first one's promise.
   */
  close(): Promise<void>;
}

/** How `openV2Harness` opens its engines. */
export interface V2HarnessOptions {
  /** The suite's name; `'sqlite'` when absent. */
  readonly name?: string;
  /**
   * Opens each engine, the shared one and every `fresh()` one;
   * `openV2Engine` when absent.
   */
  readonly openEngine?: () => Promise<V2Engine>;
}

/**
 * Opens the shared engine with `options.openEngine` and answers the
 * harness over it. Rejects as `openEngine` does, and leaves nothing open.
 */
export const openV2Harness = async (
  options?: V2HarnessOptions,
): Promise<V2HarnessHandle> => {
  const name = options?.name ?? 'sqlite';
  const openEngine = options?.openEngine ?? openV2Engine;
  const engines: V2Engine[] = [];
  const harnessOver = (engine: V2Engine): V2Harness => ({
    name,
    engine,
    open: (
      bundleId = conformanceBundle,
      files = conformanceFiles,
      generation = 1,
    ) => engine.storage(bundleId, files, generation),
    raw: (bundleId, generation = 1) => engine.raw(bundleId, generation),
    reset: () => engine.reset(),
    fresh: async () => {
      const opened = await openEngine();

      engines.push(opened);

      return harnessOver(opened);
    },
  });
  const engine = await openEngine();
  let closing: Promise<void> | undefined;

  engines.push(engine);

  return {
    ...harnessOver(engine),
    close: () => {
      closing ??= Promise.allSettled(engines.map((each) => each.close())).then(
        (results) => {
          for (const result of results) {
            if (result.status === 'rejected') {
              throw result.reason;
            }
          }
        },
      );

      return closing;
    },
  };
};
