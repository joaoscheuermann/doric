// The generic JSON ⇄ message codec, moved to `runtime/contracts` (S60a §2.3,
// test C1): other bundles (`transport`'s routed ports, S60c) import `encode`,
// `decode` and `runtimeOneofs` from `runtime/contracts`; runtime's host keeps
// importing them from `src/host/rpc/codec.ts`, which re-exports the same
// functions (its own tests, `tests/router/codec.test.ts`, stay unchanged).

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { isContractError } from 'bundle/contracts';

import {
  ThreadSchema,
  WatchProjectResponseSchema,
} from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import {
  decode,
  encode,
  type OneofMapping,
  runtimeOneofs,
} from '../../src/contracts/index.js';
import * as hostCodec from '../../src/host/rpc/codec.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const threadId = '00000000-0000-4000-8000-000000000002';
const at = '2026-11-23T12:00:00.000Z';

/** A Thread with only its required fields, as today's JSON. */
const minimalThread = {
  id: threadId,
  projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: at,
  updatedAt: at,
};

describe('runtime/contracts: the JSON codec (C1)', () => {
  test("exports the codec runtime's host uses: the same encode, decode and runtimeOneofs", () => {
    assert.equal(encode, hostCodec.encode);
    assert.equal(decode, hostCodec.decode);
    assert.equal(runtimeOneofs, hostCodec.runtimeOneofs);
  });

  test("runtimeOneofs maps runtime's three Watch responses", () => {
    const mappings: readonly OneofMapping[] = runtimeOneofs;

    assert.deepEqual(
      mappings.map((mapping) => mapping.message),
      [
        'doric.runtime.v2.WatchResponse',
        'doric.runtime.v2.WatchProjectResponse',
        'doric.runtime.threads.v1.WatchThreadResponse',
      ],
    );
  });

  test("a Thread encodes and decodes back to today's JSON, optional fields absent", () => {
    const message = encode(ThreadSchema, minimalThread);

    assert.equal(message.id, threadId);
    assert.equal(message.lastSequence, 0);
    assert.deepEqual(decode(ThreadSchema, message), minimalThread);
  });

  test('encode drops an unknown key of a loose object and leaves a null optional unset', () => {
    const message = encode(ThreadSchema, {
      ...minimalThread,
      extra: 'dropped',
      parentThreadId: null,
    });

    assert.equal(message.parentThreadId, undefined);
    assert.deepEqual(decode(ThreadSchema, message), minimalThread);
  });

  test("a discriminated oneof round-trips through runtimeOneofs ('project-deleted' ↔ projectDeleted, spread)", () => {
    const item = { kind: 'project-deleted', projectId };
    const message = encode(WatchProjectResponseSchema, item, runtimeOneofs);

    assert.equal(message.item.case, 'projectDeleted');
    assert.deepEqual(
      decode(WatchProjectResponseSchema, message, runtimeOneofs),
      item,
    );
  });

  test('encode of a value that does not fit the schema throws invalid_output', () => {
    assert.throws(
      () => encode(ThreadSchema, { ...minimalThread, lastSequence: 'many' }),
      (error: unknown) =>
        isContractError(error) && error.code === 'invalid_output',
    );
  });
});
