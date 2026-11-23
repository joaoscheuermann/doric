// Shared fixtures of the router tests of `files` (router-tools.test.ts):
// activate the part, call its tools as `core` does, read the failure as a
// Doric error, and run the kernel-bound tool on a twin workspace for parity.

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
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import type { FilesToolPorts } from '../../src/host/ports.js';
import {
  type FakeCall,
  type Harness,
  type HarnessOptions,
  harness,
} from './router.js';
import {
  type AttachedImages,
  bindTool,
  type LeasedSandbox,
} from './services.js';

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

/** What the kernel-bound `definition` answers for `payload`, as JSON. */
export const kernelAnswer = async (
  definition: UnboundTool<ToolInput, ToolOutput, FilesToolPorts>,
  sandbox: LeasedSandbox,
  host: Host,
  payload: JsonValue,
  attached?: AttachedImages,
): Promise<JsonValue> => {
  const output = await bindTool(definition, sandbox, host, attached).execute(
    payload as never,
  );

  return JSON.parse(JSON.stringify(output)) as JsonValue;
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
