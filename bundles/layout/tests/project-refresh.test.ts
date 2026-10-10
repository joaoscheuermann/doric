import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ActivityTerminal,
  projectActivity,
} from '../src/client/domain/project-refresh.js';
import type { Thread } from '../src/client/domain/workspace.js';

// The changedSandboxProjects cases moved to the chat bundle with that rule.

const thread = (id: string, projectId = 'project'): Thread => ({
  id,
  projectId,
  name: id,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
});

test('terminal commands, exits and removals change the project signal', () => {
  const terminal: ActivityTerminal & Record<string, unknown> = {
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
