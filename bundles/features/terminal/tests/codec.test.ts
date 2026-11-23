// The codec of `terminal`'s host part as a process (phase 3, S54b, C1–C3):
// the domain answers of terminal/v1 → its wire messages, which must pass
// protovalidate (`run_response.shape`, the `TerminalSession` bounds).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  type DescMessage,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';

import {
  RunResponseSchema,
  TerminalSessionSchema,
  TerminalSnapshotSchema,
  WatchProjectResponseSchema,
} from '../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import type {
  TerminalSession,
  TerminalWatchItem,
} from '../src/contracts/index.js';
import {
  runResponseOf,
  sessionMessageOf,
  snapshotMessageOf,
  watchItemMessageOf,
} from '../src/host/codec.js';

const validator = createValidator();

const valid = <Desc extends DescMessage>(
  schema: Desc,
  init: MessageInitShape<Desc>,
) => {
  const message = create(schema, init);
  const result = validator.validate(schema, message);

  assert.equal(result.kind, 'valid', JSON.stringify(result));

  return message;
};

const session: TerminalSession = {
  id: 'terminal-1',
  projectId: 'project-1',
  threadId: 'thread-1',
  origin: 'user',
  command: 'bash',
  cwd: '/workspace/app',
  startedAt: '2026-11-23T10:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
};

void test('C1: sessionMessageOf leaves a null timeoutMs and an absent name absent, and keeps them when set', () => {
  const bare = valid(TerminalSessionSchema, sessionMessageOf(session));

  assert.equal(bare.timeoutMs, undefined);
  assert.equal(bare.name, undefined);
  assert.equal(bare.id, 'terminal-1');
  assert.equal(bare.origin, 'user');
  assert.equal(bare.state, 'running');
  assert.equal(bare.pty, true);

  const named = valid(
    TerminalSessionSchema,
    sessionMessageOf({ ...session, timeoutMs: 5_000, name: 'build' }),
  );

  assert.equal(named.timeoutMs, 5_000);
  assert.equal(named.name, 'build');

  const snapshot = valid(
    TerminalSnapshotSchema,
    snapshotMessageOf({
      terminal: session,
      output: 'hello',
      offset: 5,
      truncated: false,
    }),
  );

  assert.equal(snapshot.terminal?.timeoutMs, undefined);
  assert.equal(snapshot.output, 'hello');
  assert.equal(snapshot.offset, 5);
});

void test('C2: runResponseOf of a background answer and of a result both pass run_response.shape', () => {
  const background = valid(
    RunResponseSchema,
    runResponseOf({ terminalId: 'terminal-1', background: true }),
  );

  assert.equal(background.terminalId, 'terminal-1');
  assert.equal(background.background, true);
  assert.equal(background.stdout, undefined);
  assert.equal(background.reason, undefined);

  const result = valid(
    RunResponseSchema,
    runResponseOf({
      terminalId: 'terminal-2',
      stdout: '',
      stderr: 'oops',
      exitCode: -1,
      durationMs: 12,
      reason: 'failed',
    }),
  );

  assert.equal(result.background, undefined);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'oops');
  assert.equal(result.exitCode, -1);
  assert.equal(result.durationMs, 12);
  assert.equal(result.reason, 'failed');
});

void test('C3: watchItemMessageOf maps each kind to its oneof case', () => {
  const items: readonly TerminalWatchItem[] = [
    { kind: 'snapshot', projectId: 'project-1', terminals: [session] },
    { kind: 'updated', terminal: { ...session, name: 'build' } },
    {
      kind: 'removed',
      projectId: 'project-1',
      threadId: 'thread-1',
      terminalId: 'terminal-1',
    },
    {
      kind: 'output',
      output: {
        projectId: 'project-1',
        threadId: 'thread-1',
        terminalId: 'terminal-1',
        data: 'hi',
        offset: 2,
      },
    },
  ];
  const [snapshot, updated, removed, output] = items.map((item) =>
    valid(WatchProjectResponseSchema, watchItemMessageOf(item)),
  );

  assert.equal(snapshot?.item.case, 'snapshot');
  assert.equal(
    snapshot?.item.case === 'snapshot' && snapshot.item.value.terminals[0]?.id,
    'terminal-1',
  );
  assert.equal(updated?.item.case, 'updated');
  assert.equal(
    updated?.item.case === 'updated' && updated.item.value.name,
    'build',
  );
  assert.equal(removed?.item.case, 'removed');
  assert.equal(
    removed?.item.case === 'removed' && removed.item.value.terminalId,
    'terminal-1',
  );
  assert.equal(output?.item.case, 'output');
  assert.deepEqual(
    output?.item.case === 'output' && {
      data: output.item.value.data,
      offset: output.item.value.offset,
    },
    { data: 'hi', offset: 2 },
  );
});
