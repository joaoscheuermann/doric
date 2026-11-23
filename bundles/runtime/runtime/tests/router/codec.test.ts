// The codec between today's JSON and runtime's generated messages (phase 3,
// slice S46a, contract §1.2): one generic rule, plus the per-oneof mappings
// of `runtimeOneofs` for the discriminated oneofs whose domain encodings
// differ per case. Tests 1–7 of the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { JsonValue } from '@bufbuild/protobuf';
import { isContractError } from 'bundle/contracts';

import { OnPromptStartedHookInputSchema } from '../../src/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import { WatchThreadResponseSchema } from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  ProjectSchema,
  ThreadEventSchema,
  ThreadSchema,
  WatchProjectResponseSchema,
  WatchResponseSchema,
} from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { decode, encode, runtimeOneofs } from '../../src/host/rpc/codec.js';

// ---------------------------------------------------------------------------
// Fixtures: today's JSON, as the domain answers it

const projectId = '00000000-0000-4000-8000-000000000001';
const threadId = '00000000-0000-4000-8000-000000000002';
const promptId = '00000000-0000-4000-8000-000000000003';
const terminalId = '00000000-0000-4000-8000-000000000004';
const at = '2026-11-23T12:00:00.000Z';

/** A Thread with only its required fields. */
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

const project = {
  id: projectId,
  name: 'Project',
  color: 'blue',
  state: 'ready',
  configRevision: 1,
  createdAt: at,
  updatedAt: at,
};

const thread = {
  ...minimalThread,
  queuePaused: false,
  lastSequence: 3,
  activePromptId: promptId,
};

const threadEvent = {
  projectId,
  threadId,
  promptId,
  sequence: 1,
  type: 'prompt.accepted',
  event: { type: 'prompt.accepted', text: 'hello', source: { kind: 'user' } },
  createdAt: at,
};

const terminal = {
  id: terminalId,
  projectId,
  threadId,
  origin: 'agent',
  command: 'ls',
  cwd: '/workspace',
  startedAt: at,
  timeoutMs: 1000,
  state: 'running',
  pty: false,
};

const terminalOutput = {
  projectId,
  threadId,
  terminalId,
  data: 'hello',
  offset: 5,
};

// ---------------------------------------------------------------------------
// 1. The generic rule

describe('codec: the generic rule', () => {
  test("1: a Thread with only required fields encodes and decodes to today's JSON, optional fields absent and lastSequence 0 present", () => {
    const message = encode(ThreadSchema, minimalThread);

    assert.equal(message.id, threadId);
    assert.equal(message.lastSequence, 0);
    assert.equal(message.parentThreadId, undefined);

    const json = decode(ThreadSchema, message);

    assert.deepEqual(json, minimalThread);
    assert.ok(
      Object.hasOwn(json as object, 'lastSequence'),
      'lastSequence is present',
    );
    for (const optional of ['parentThreadId', 'origin', 'result', 'agent'])
      assert.ok(!Object.hasOwn(json as object, optional), `${optional} absent`);
  });

  test("2: each InputSource kind round-trips through a hook input by the default rule (case = today's kind, fields spread)", () => {
    const sources = [
      { kind: 'user' },
      { kind: 'terminal', terminalId, promptId },
      { kind: 'parent', threadId, promptId },
      {
        kind: 'result',
        threadId,
        promptId,
        requestPromptId: '00000000-0000-4000-8000-000000000005',
      },
      { kind: 'bundle', bundleId: 'scheduler', reason: 'cron', retain: true },
    ];

    for (const source of sources) {
      const input = {
        projectId,
        threadId,
        promptId,
        source,
        cwd: '/workspace',
      };
      const message = encode(OnPromptStartedHookInputSchema, input);

      assert.equal(message.source?.kind.case, source.kind);
      assert.deepEqual(decode(OnPromptStartedHookInputSchema, message), input);
    }
  });

  test('5: ThreadEvent.event keeps nested JSON (null, arrays, numbers) unchanged', () => {
    const event = {
      ...threadEvent,
      type: 'tool.finished',
      event: {
        a: [1, null, 'x', { b: 2.5, c: [] }],
        n: null,
        t: true,
        nested: { deep: { value: -7 } },
      },
    };

    assert.deepEqual(
      decode(ThreadEventSchema, encode(ThreadEventSchema, event)),
      event,
    );
  });

  test('6: encode drops an unknown key of a loose object and leaves a null optional unset', () => {
    const message = encode(ProjectSchema, {
      ...project,
      color: null,
      extra: 'not in the proto',
    });

    assert.equal(message.color, undefined);

    const json = decode(ProjectSchema, message) as Record<string, JsonValue>;
    const { color: _color, ...rest } = project;

    assert.deepEqual(json, rest);
  });
});

// ---------------------------------------------------------------------------
// 2. The discriminated oneofs of runtime's services

describe('codec: runtimeOneofs', () => {
  test('3: each RuntimeNotice kind round-trips through WatchResponse, value-wrapped kinds and the spread ones', () => {
    const notices: readonly { notice: JsonValue; case: string }[] = [
      { notice: { kind: 'event', value: threadEvent }, case: 'event' },
      { notice: { kind: 'threadUpdated', value: thread }, case: 'threadUpdated' },
      {
        notice: { kind: 'threadDeleted', projectId, threadId },
        case: 'threadDeleted',
      },
      { notice: { kind: 'projectUpdated', value: project }, case: 'projectUpdated' },
      { notice: { kind: 'projectDeleted', projectId }, case: 'projectDeleted' },
      {
        notice: { kind: 'terminalUpdated', value: terminal },
        case: 'terminalUpdated',
      },
      {
        notice: { kind: 'terminalOutput', value: terminalOutput },
        case: 'terminalOutput',
      },
      {
        notice: { kind: 'terminalRemoved', projectId, threadId, terminalId },
        case: 'terminalRemoved',
      },
    ];

    for (const { notice, case: expected } of notices) {
      const message = encode(WatchResponseSchema, notice, runtimeOneofs);

      assert.equal(message.notice.case, expected);
      assert.deepEqual(
        decode(WatchResponseSchema, message, runtimeOneofs),
        notice,
      );
    }
  });

  test("4: each ProjectWatchItem kind round-trips through WatchProjectResponse ('project-updated' ↔ projectUpdated)", () => {
    const items: readonly { item: JsonValue; case: string }[] = [
      {
        item: { kind: 'snapshot', projectId, project, threads: [thread] },
        case: 'snapshot',
      },
      { item: { kind: 'project-updated', project }, case: 'projectUpdated' },
      { item: { kind: 'project-deleted', projectId }, case: 'projectDeleted' },
      { item: { kind: 'thread-updated', thread }, case: 'threadUpdated' },
      {
        item: { kind: 'thread-deleted', projectId, threadId },
        case: 'threadDeleted',
      },
    ];

    for (const { item, case: expected } of items) {
      const message = encode(WatchProjectResponseSchema, item, runtimeOneofs);

      assert.equal(message.item.case, expected);
      assert.deepEqual(
        decode(WatchProjectResponseSchema, message, runtimeOneofs),
        item,
      );
    }
  });

  test("4: each ThreadWatchItem kind round-trips through WatchThreadResponse ('updated' ↔ updated with key thread)", () => {
    const items: readonly { item: JsonValue; case: string }[] = [
      {
        item: {
          kind: 'snapshot',
          threadId,
          projectId,
          project,
          thread,
          events: [threadEvent],
        },
        case: 'snapshot',
      },
      { item: { kind: 'event', event: threadEvent }, case: 'event' },
      { item: { kind: 'updated', thread }, case: 'updated' },
      { item: { kind: 'deleted', projectId, threadId }, case: 'deleted' },
    ];

    for (const { item, case: expected } of items) {
      const message = encode(WatchThreadResponseSchema, item, runtimeOneofs);

      assert.equal(message.item.case, expected);
      assert.deepEqual(
        decode(WatchThreadResponseSchema, message, runtimeOneofs),
        item,
      );
    }
  });

  test('7: encode of an unknown discriminator value throws invalid_output', () => {
    assert.throws(
      () =>
        encode(
          WatchResponseSchema,
          { kind: 'threadRenamed', value: thread },
          runtimeOneofs,
        ),
      (error: unknown) => isContractError(error) && error.code === 'invalid_output',
    );
  });
});
