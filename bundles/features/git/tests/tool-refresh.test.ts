// Bundle isolation 5(c) change 2, T5.5: the chat no longer refreshes after a
// tool call, so git asks for its Project's refresh after a finished `git`
// call it hears through `chat.hooks/v2` `onThreadUpdateHook`, and after no
// other update.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refreshAfterGit } from '../src/client/tool-refresh.js';

const projectId = 'project-a';

/** A live event of Thread `thread-a` of `type`, its record as the host stores it. */
const live = (type: string, event: unknown) => ({
  projectId,
  threadId: 'thread-a',
  threadName: 'Fix the parser',
  update: {
    kind: 'event' as const,
    event: {
      projectId,
      threadId: 'thread-a',
      promptId: 'prompt',
      sequence: 1,
      createdAt: '',
      type,
      event,
    },
  },
});

const call = (type: string, name: string) =>
  live(type, {
    type,
    call: { id: 'call-1', name, arguments: '{}' },
    record: { output: 'ok' },
  });

const requests = (input: Parameters<ReturnType<typeof refreshAfterGit>>[0]) => {
  const asked: string[] = [];
  refreshAfterGit((id) => asked.push(id))(input);
  return asked;
};

test('a finished git call requests its Project once', () => {
  assert.deepEqual(requests(call('tool.finished', 'git')), [projectId]);
});

test('a finished call of another tool requests nothing', () => {
  for (const name of ['edit', 'write', 'terminal', 'tree'])
    assert.deepEqual(requests(call('tool.finished', name)), [], name);
});

test('a git call that starts or fails requests nothing', () => {
  assert.deepEqual(requests(call('tool.started', 'git')), []);
  assert.deepEqual(requests(call('tool.failed', 'git')), []);
});

test('an updated Thread record requests nothing', () => {
  assert.deepEqual(
    requests({
      projectId,
      threadId: 'thread-a',
      threadName: 'Fix the parser',
      update: {
        kind: 'updated',
        thread: { id: 'thread-a', projectId, state: 'ready' },
      },
    }),
    [],
  );
});

test('an event whose record is not an object requests nothing', () => {
  assert.deepEqual(requests(live('tool.finished', 'tool.finished')), []);
  assert.deepEqual(requests(live('tool.finished', null)), []);
});
