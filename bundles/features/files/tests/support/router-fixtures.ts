// Shared fixtures of the router tests of `files`: activate the part, call
// its tools as `core` does, and read the failure as a Doric error.
// `routedTool` stands a tool definition up as the agent loop reaches it
// through the router, for the tool suites (cwd, edit, find, grep, tree,
// view-image, write).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import {
  type ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { Host } from 'runtime/contracts';
import type { Tool, ToolInput, ToolOutput } from 'tool';

import {
  type AttachRecord,
  type FakeCall,
  type Harness,
  type HarnessOptions,
  harness,
  type LeasedSandbox,
} from './router.js';

/** The part activated on a test router, stopped when the test ends. */
export const activated = async (
  t: TestContext,
  options: HarnessOptions,
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
export const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) {
    return fromConnectError(error);
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** The Doric error `promise` rejects with; fails the test when it resolves. */
export const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    return contractErrorOf(error);
  }

  return assert.fail('the call succeeded');
};

/** `Execute{name, payload}`'s result as JSON (`undefined` when absent). */
export const execute = async (
  h: Harness,
  name: string,
  payload: JsonValue,
): Promise<JsonValue | undefined> => {
  const { result } = await h.client.execute({
    name,
    payload: fromJson(ValueSchema, payload),
  });

  return result === undefined ? undefined : toJson(ValueSchema, result);
};

/** A tool definition's agent-loop face, reached through the router. */
export interface RoutedTool<I extends ToolInput, O extends ToolOutput> {
  /** `Execute{name, payload}`'s result as parsed JSON; a failure rejects with its Doric error. */
  readonly execute: Tool<I, O>['execute'];
  /** The attachments `runtime.attachments/v1` kept, over every `execute`, in order. */
  readonly attached: AttachRecord[];
}

/**
 * `definition`'s tool as `core` calls it: each `execute` serves the part on a
 * fresh test router over `sandbox` and `host` (whose working directory
 * persists between calls), activates it as `main.ts` does, sends
 * `Execute{name: definition.name, payload}` under the prompt scope and stops
 * the router.
 */
export const routedTool = <I extends ToolInput, O extends ToolOutput>(
  definition: { readonly name: string; readonly input: I; readonly output: O },
  sandbox: LeasedSandbox,
  host: Host,
): RoutedTool<I, O> => {
  const attached: AttachRecord[] = [];

  return {
    attached,
    execute: async (payload) => {
      const h = harness({ sandbox, host });

      try {
        await h.activate();
        let answer: JsonValue | undefined;

        try {
          answer = await execute(
            h,
            definition.name,
            payload as unknown as JsonValue,
          );
        } catch (error) {
          throw contractErrorOf(error);
        }
        attached.push(...h.attached);

        return answer as Awaited<ReturnType<Tool<I, O>['execute']>>;
      } finally {
        await h.router.control.stop();
      }
    },
  };
};

/** A fresh local workspace holding `files` (path → content), removed after `t`. */
export const workspace = async (
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'doric-files-router-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }

  return root;
};

/** The calls of `service`'s `method` the fakes received. */
export const callsOf = (
  h: Harness,
  service: string,
  method?: string,
): readonly FakeCall[] =>
  h.calls.filter(
    (call) =>
      call.service === service &&
      (method === undefined || call.method === method),
  );

/** The `target` of a lease request, `{}` when the request leaves it out. */
export const targetOf = (call: FakeCall): JsonValue =>
  (call.request as { target?: JsonValue }).target ?? {};
