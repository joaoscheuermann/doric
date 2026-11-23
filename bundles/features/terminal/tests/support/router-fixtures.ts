// Shared helpers of `terminal`'s router tests (phase 3, S54b): the harness
// activated for one test, the Doric error of a failed call, polling for an
// effect of the background work, and a `WatchProject` reader.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { type JsonValue, toJson } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type CallScope,
  type ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';

import { WatchProjectResponseSchema } from '../../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  type FakeProcess,
  type Harness,
  type HarnessOptions,
  harness,
} from './router.js';

/** The part on a test router, activated, stopped when the test ends. */
export const activated = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** The Doric error `promise` rejects with; fails the test when it resolves. */
export const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectError) return fromConnectError(error);

    assert.ok(isContractError(error), `expected a Doric error: ${error}`);

    return error;
  }

  return assert.fail('the call succeeded');
};

export const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  (await rejectionOf(promise)).code;

/** Waits until `predicate` holds, polling; fails after `timeoutMs`. */
export const until = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const end = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${label}`);

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Waits for the `index`-th `Start` (0-based) and answers it. */
export const processAt = async (
  h: Harness,
  index = 0,
): Promise<FakeProcess> => {
  await until(() => h.processes.length > index, `Start #${index + 1}`);

  return h.processes[index] as FakeProcess;
};

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A `WatchProject` stream read in the background into `items` (JSON). */
export const watching = (
  h: Harness,
  projectId: string,
  scope?: CallScope,
): {
  readonly items: JsonValue[];
  readonly kinds: () => string[];
  stop(): void;
} => {
  const items: JsonValue[] = [];
  const controller = new AbortController();

  void (async () => {
    try {
      for await (const item of h
        .terminal(scope)
        .watchProject({ projectId }, { signal: controller.signal })) {
        items.push(toJson(WatchProjectResponseSchema, item));
      }
    } catch {
      // The test cancels the watch; a failure shows in `items` staying short.
    }
  })();

  return {
    items,
    kinds: () =>
      items.map(
        (item) => Object.keys(item as Record<string, unknown>)[0] ?? '',
      ),
    stop: () => controller.abort(),
  };
};

/** The `JSON` a value round-trips to (undefined keys left out). */
export const plain = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;
