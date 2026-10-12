import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isContractError,
  type StorageBackend,
  type StorageCapabilities,
} from 'bundle/contracts';

import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './database.js';
import { type Instance, postgresHarness } from './harness.js';

export interface StorageContext {
  readonly database: TestDatabase;
  readonly harness: ReturnType<typeof postgresHarness>;
  /** A new backend instance over the test schema, closed after the test. */
  open(options?: {
    readonly limits?: Partial<StorageCapabilities>;
  }): StorageBackend;
  /** Like `open`, keeping the instance so the test can crash it. */
  instance(options?: {
    readonly limits?: Partial<StorageCapabilities>;
  }): Instance;
}

/**
 * A test over a fresh migrated schema whose generic storage is emptied
 * first (the migration's own commit included), as the conformance kit does
 * between cases. Skipped without a database.
 */
export const storageTest = (
  name: string,
  run: (context: StorageContext) => Promise<void>,
): void => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase();
    const harness = postgresHarness(database);

    await harness.reset();

    const opened: Instance[] = [];
    const instance = (options?: {
      readonly limits?: Partial<StorageCapabilities>;
    }) => {
      const created = harness.open(options);

      opened.push(created);

      return created;
    };

    try {
      await run({
        database,
        harness,
        open: (options) => instance(options).backend,
        instance,
      });
    } finally {
      for (const created of opened) {
        await created.dispose();
      }

      await database.close();
    }
  });
};

/** An `assert.rejects` matcher for a ContractError code (and its details). */
export const isCode =
  (code: string, details?: unknown) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), String(error));
    assert.equal(error.code, code, error.message);

    if (details !== undefined) {
      assert.deepEqual(error.details, details);
    }

    return true;
  };

/** The code a settled rejection carries, for counting outcomes. */
export const codeOf = (result: PromiseSettledResult<unknown>): string =>
  result.status === 'fulfilled'
    ? 'ok'
    : isContractError(result.reason)
      ? result.reason.code
      : String(result.reason);
