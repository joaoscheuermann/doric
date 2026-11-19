import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedSandboxProjects } from '../src/client/domain/project-refresh.js';
import {
  applyThreadEvents,
  emptyThreadChats,
  openThread,
} from '../src/client/domain/thread-chats.js';
import type { Thread, ThreadEvent } from '../src/client/domain/workspace.js';

const thread = (id: string, projectId = 'project'): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});
const finished = (
  threadId: string,
  sequence: number,
  name = 'git',
): ThreadEvent => ({
  threadId,
  projectId: 'project',
  promptId: 'prompt',
  sequence,
  createdAt: '',
  type: 'tool.finished',
  event: {
    type: 'tool.finished',
    call: { id: `call-${sequence}`, name, arguments: '{}' },
    record: { output: 'ok' },
  },
});

test('refreshes the shared project after a background conversation changes the sandbox', () => {
  const first = openThread(emptyThreadChats, thread('background'), null).chats;
  const before = openThread(
    first,
    thread('selected', 'other-project'),
    null,
  ).chats;
  const after = applyThreadEvents(before, 'background', [
    finished('background', 1),
  ]).chats;
  assert.deepEqual([...changedSandboxProjects(before, after)], ['project']);
});

test('ignores replayed completions and read-only tools but notices later writes', () => {
  const opened = openThread(emptyThreadChats, thread('one'), null).chats;
  const before = applyThreadEvents(opened, 'one', [finished('one', 1)]).chats;
  const replayed = applyThreadEvents(before, 'one', [
    finished('one', 1),
    finished('one', 2, 'tree'),
  ]).chats;
  assert.equal(changedSandboxProjects(before, replayed).size, 0);
  const written = applyThreadEvents(replayed, 'one', [
    finished('one', 3, 'edit'),
  ]).chats;
  assert.deepEqual([...changedSandboxProjects(replayed, written)], ['project']);
});

test('a Thread starting to run refreshes nothing; finishing or failing does', () => {
  const opened = openThread(emptyThreadChats, thread('one'), null).chats;
  const withState = (chats: typeof opened, state: Thread['state']) =>
    openThread(chats, { ...thread('one'), state }, null).chats;
  const running = withState(opened, 'running');
  assert.equal(changedSandboxProjects(opened, running).size, 0);
  assert.deepEqual(
    [...changedSandboxProjects(running, withState(running, 'ready'))],
    ['project'],
  );
  assert.deepEqual(
    [...changedSandboxProjects(running, withState(running, 'failed'))],
    ['project'],
  );
});

// Bundle isolation 5(c), T5.5: what `chat.hooks/v2` hears — the lifecycle
// causes only, never a finished tool call.
test('without tool calls, a finished edit names no Project; a changed cwd or a finished prompt does', () => {
  const opened = openThread(emptyThreadChats, thread('one'), null).chats;
  const lifecycle = { toolCalls: false } as const;
  const edited = applyThreadEvents(opened, 'one', [
    finished('one', 1, 'edit'),
  ]).chats;
  assert.equal(changedSandboxProjects(opened, edited, lifecycle).size, 0);

  const moved = openThread(
    edited,
    { ...thread('one'), cwd: '/workspace/other' },
    null,
  ).chats;
  assert.deepEqual(
    [...changedSandboxProjects(edited, moved, lifecycle)],
    ['project'],
  );

  const running = openThread(
    moved,
    { ...thread('one'), cwd: '/workspace/other', state: 'running' },
    null,
  ).chats;
  const done = openThread(
    running,
    { ...thread('one'), cwd: '/workspace/other', state: 'ready' },
    null,
  ).chats;
  assert.deepEqual(
    [...changedSandboxProjects(running, done, lifecycle)],
    ['project'],
  );
});
