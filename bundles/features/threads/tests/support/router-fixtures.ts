// Shared fixtures of the router tests (router.test.ts, router-spawn.test.ts):
// a fixed child record and control, and helpers to activate the part and
// call its tools.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError } from '@connectrpc/connect';
import {
  type ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { AgentDefinition } from 'default/contracts';
import type {
  ThreadControl,
  ThreadEventView,
  ThreadView,
} from 'runtime/contracts';
import { createToolStorage, type ToolCall } from 'tool';

import { type Harness, type HarnessOptions, harness } from './router.js';
import { activatedTools } from './services.js';

export const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
export const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

/** A child record with every field the wire `ThreadView` carries. */
export const view: ThreadView = {
  id: threadId,
  projectId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600',
  parentThreadId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603',
  name: 'Child',
  state: 'ready',
  lastSequence: 4,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:01.000Z',
};

/** One persisted event of the child carrying `event`. */
export const eventView = (
  sequence: number,
  event: unknown,
): ThreadEventView => ({
  projectId: view.projectId,
  threadId,
  promptId,
  sequence,
  type: 'assistant.message',
  event,
  createdAt: '2026-10-09T00:00:02.000Z',
});

export const review: AgentDefinition = {
  name: 'review',
  source: 'built-in',
  description: 'Reviews.',
  instructions: 'Review it.',
};

/** A control answering every method with a fixed domain value. */
export const control: ThreadControl = {
  spawn: async () => ({ threadId, promptId }),
  list: async () => ({ items: [view], nextCursor: 'cursor-2' }),
  get: async () => ({
    thread: view,
    result: {
      status: 'completed',
      text: 'Done.',
      promptId,
      at: '2026-10-09T00:00:03.000Z',
    },
  }),
  events: async () => ({
    events: [eventView(1, { text: 'hello' })],
    nextSequence: 1,
  }),
  send: async () => ({ status: 'accepted', promptId }),
  restart: async () => ({ status: 'accepted', promptId }),
  interrupt: async () => 'interrupted',
  terminate: async () => ({ ...view, state: 'cancelled' }),
};

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
export const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) {
    return fromConnectError(error);
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error;
};

/** The error `promise` rejects with; fails the test when it resolves. */
export const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  return assert.fail('the call succeeded');
};

/** The part activated on a test router, stopped when the test ends. */
export const activated = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.router.control.stop());
  await h.activate();

  return h;
};

/** `json` as a `google.protobuf.Value`. */
export const toValue = (json: JsonValue) => fromJson(ValueSchema, json);

/** `Execute{name, payload, projectId?}`'s result: the tool's text answer. */
export const execute = async (
  h: Harness,
  name: string,
  payload: JsonValue,
  projectId?: string,
): Promise<string> => {
  const { result } = await h.client.execute({
    name,
    payload: toValue(payload),
    ...(projectId === undefined ? {} : { projectId }),
  });
  const json = result === undefined ? undefined : toJson(ValueSchema, result);

  assert.equal(typeof json, 'string', `${name} answered ${String(json)}`);

  return json as string;
};

/** What the kernel tool `name` answers for `payload` over `kernelControl`. */
export const kernelAnswer = async (
  kernelControl: ThreadControl,
  name: string,
  payload: ToolCall['payload'],
): Promise<unknown> =>
  createToolStorage(await activatedTools(kernelControl)).execute({
    id: 'call',
    name,
    payload,
  });

/** The calls of `method` the fakes received. */
export const callsOf = (h: Harness, method: string) =>
  h.calls.filter((call) => call.method === method);
