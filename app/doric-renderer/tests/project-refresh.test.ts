import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  changedSandboxProjects,
  projectActivity,
} from '../src/domain/project-refresh';
import type { Terminal } from '../src/domain/terminals';
import {
  applyThreadEvents,
  emptyThreadChats,
  openThread,
} from '../src/domain/thread-chats';
import type { Thread, ThreadEvent } from '../src/domain/workspace';

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

test('terminal commands, exits and removals change the project signal', () => {
  const terminal: Terminal = {
    id: 'shell',
    projectId: 'project',
    threadId: 'one',
    origin: 'user',
    command: 'zsh',
    cwd: '/workspace',
    state: 'running',
    pty: true,
    timeoutMs: null,
    startedAt: '',
  };
  const before = projectActivity([thread('one')], [terminal]);
  assert.notEqual(
    projectActivity(
      [thread('one')],
      [{ ...terminal, command: 'git checkout next' }],
    ),
    before,
  );
  assert.notEqual(
    projectActivity([thread('one')], [{ ...terminal, state: 'exited' }]),
    before,
  );
  assert.notEqual(projectActivity([thread('one')], []), before);
  assert.equal(
    projectActivity(
      [{ ...thread('one'), name: 'renamed' }],
      [{ ...terminal, startedAt: 'later' }],
    ),
    before,
  );
});

test('lifecycle changes in a thread whose conversation is unopened refresh the project signal', () => {
  assert.notEqual(
    projectActivity([thread('one')], []),
    projectActivity([{ ...thread('one'), state: 'running' }], []),
  );
});
