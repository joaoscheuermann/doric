/**
 * The entry `storage/testing`: `openTestEngine`, the `sqlite` engine bundle
 * spawned for a test, on `doric.sqlite3` in a directory of its own, with
 * `startTestProcess` of `bundle/testing` in place of the router; and
 * `openTestStorage`, one bundle's `Storage` over such an engine. There is no
 * in-process `Kv` or `Storage`: a test that needs one opens an engine.
 */
import type { DescFile } from '@bufbuild/protobuf';

import type { Storage } from './client/types.js';
import type { KvTarget } from './conformance/kv/index.js';
import type { Kv } from './kv.js';
import { openTestEngineAt, testEngineBinary } from './test-engine.js';

/**
 * A spawned engine. `kv(caller)` answers the same `Kv` for the same caller,
 * every call stamped with that caller as the router stamps it, so the engine
 * checks the caller itself: it serves only `doric`, and answers any other
 * caller `not_owner` with `storage.kv/v1 serves only the platform.`.
 * `reset()` is one commit of the caller `doric` with a single `clearRange`
 * from the empty key to `[0xff]`, which empties every caller's keys.
 * `close()` stops the process, removes the directory `openTestEngine` made.
 * A second `close()` answers the first one's promise: while that close is
 * pending it waits for it, and once it has settled it resolves at once.
 */
export interface TestEngine extends KvTarget {
  /**
   * Registers `files` (and their imports) as `bundleId` of `generation`, 1
   * when absent, and answers that bundle's `Storage`, every call stamped
   * with `{ bundleId, generation }` as the router stamps it, so its records
   * are under `<bundleId>/`. Each call answers a new `Storage` and
   * registers again. Rejects as `openStorage` does: `limit_exceeded`
   * (`"descriptorSet"`) before any call, then `Register`'s refusal; and
   * with `unavailable` once the engine is closed.
   */
  storage(
    bundleId: string,
    files: readonly DescFile[],
    generation?: number,
  ): Promise<Storage>;
}

/**
 * One bundle's `Storage` over an engine of its own (`openTestStorage`).
 */
export interface TestStorage {
  /** The bundle's `Storage`, registered with the files it was opened with. */
  readonly storage: Storage;
  /** The engine's `Kv` of the caller `doric`, which reaches every key. */
  readonly kv: Kv;
  /**
   * Empties the store, as `TestEngine.reset()` does, then registers the
   * files again as the bundle, so the next case starts on an empty store
   * with the bundle's declarations; `storage` stays usable.
   */
  reset(): Promise<void>;
  /**
   * Stops the process and removes the engine's directory, as
   * `TestEngine.close()` does; a second call answers the first one's
   * promise.
   */
  close(): Promise<void>;
}

export interface TestEngineOptions {
  /**
   * A directory the test made: the engine runs on `doric.sqlite3` there,
   * and `close()` leaves it in place, so a second engine opened on the same
   * `path` reads what the first wrote.
   */
  readonly path?: string;
}

/**
 * Spawns `dist/target/doric-sqlite/debug/doric-sqlite`, the debug build of
 * `npx nx run sqlite:compile`, through `startTestProcess({ bundleId:
 * 'sqlite', command: [binary], env: { DORIC_STORAGE_PATH: dir } })`, and
 * resolves once it is active. Without `path`, `dir` is a new
 * `mkdtemp(join(tmpdir(), 'doric-test-engine-'))` directory that `close()`
 * removes once the process has stopped. Rejects with
 * `Error('doric-sqlite is not built: run npx nx run sqlite:compile')` when
 * the executable is missing, and with the failure of `startTestProcess`
 * when the process does not start.
 */
export const openTestEngine = (
  options?: TestEngineOptions,
): Promise<TestEngine> => openTestEngineAt(testEngineBinary(), options);

/**
 * Opens a test engine (`openTestEngine()`, on a new temporary directory) and
 * answers its `storage(bundleId, files)` with the engine's `kv('doric')`.
 * Rejects as `openTestEngine` and `TestEngine.storage` do; when the
 * registration fails, the engine is closed first.
 */
export const openTestStorage = async (
  bundleId: string,
  files: readonly DescFile[],
): Promise<TestStorage> => {
  const engine = await openTestEngine();
  let storage: Storage;

  try {
    storage = await engine.storage(bundleId, files);
  } catch (error) {
    await engine.close();
    throw error;
  }

  return {
    storage,
    kv: engine.kv('doric'),
    reset: async () => {
      await engine.reset();
      await engine.storage(bundleId, files);
    },
    close: () => engine.close(),
  };
};
