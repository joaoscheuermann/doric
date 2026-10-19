import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canHoldChild,
  childThreadKind,
  threadControl,
  threadKind,
  threadKindHint,
  threadKindIcon,
  threadKindLabel,
} from '../src/client/domain/thread-kind.js';
import type { Thread } from '../src/client/domain/workspace.js';

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  name: 'A thread',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('threadKind', () => {
  test('a Thread with no parent is a main thread', () => {
    assert.equal(threadKind(thread()), 'main');
  });

  test('a child the reader opened is a sub-thread', () => {
    assert.equal(
      threadKind(thread({ parentThreadId: 'parent', origin: 'user' })),
      'sub-thread',
    );
  });

  test('a child an agent spawned is an agent thread', () => {
    assert.equal(
      threadKind(thread({ parentThreadId: 'parent', origin: 'agent' })),
      'sub-agent',
    );
  });

  test('a Thread written before the host recorded its origin reads as the reader\u2019s', () => {
    assert.equal(
      threadKind(thread({ parentThreadId: 'parent' })),
      'sub-thread',
    );
  });

  test('every kind is named', () => {
    assert.deepEqual(Object.keys(threadKindLabel).sort(), [
      'main',
      'sub-agent',
      'sub-thread',
    ]);
    assert.deepEqual(Object.keys(threadKindHint).sort(), [
      'main',
      'sub-agent',
      'sub-thread',
    ]);
  });

  test('every kind wears the bubble, and only the kind changes it', () => {
    assert.deepEqual(threadKindIcon, {
      main: 'message-circle',
      'sub-thread': 'message-circle-plus',
      'sub-agent': 'bot-message-square',
    });
  });
});

describe('threadControl', () => {
  test('a main thread offers prompts, rename, delete and a branch', () => {
    assert.deepEqual(threadControl(thread()), {
      prompts: true,
      supervises: false,
      renames: true,
      deletes: true,
      branches: true,
    });
  });

  test('a sub-thread offers prompts, but no branch of its own', () => {
    assert.deepEqual(
      threadControl(thread({ parentThreadId: 'parent', origin: 'user' })),
      {
        prompts: true,
        supervises: false,
        renames: true,
        deletes: true,
        branches: false,
      },
    );
  });

  test('an agent thread offers only the three levers', () => {
    const control = threadControl(
      thread({ parentThreadId: 'parent', origin: 'agent' }),
    );

    assert.equal(control.prompts, false);
    assert.equal(control.supervises, true);
    assert.equal(control.renames, false);
    assert.equal(control.deletes, false);
    assert.equal(control.branches, false);
  });
});

describe('childThreadKind', () => {
  test('the reader branches a main thread into a sub-thread', () => {
    assert.equal(childThreadKind('main', 'user'), 'sub-thread');
  });

  test('the reader opens nothing under a sub-thread or an agent thread', () => {
    assert.equal(childThreadKind('sub-thread', 'user'), undefined);
    assert.equal(childThreadKind('sub-agent', 'user'), undefined);
  });

  test('an agent spawns a sub-agent thread from any kind', () => {
    assert.equal(childThreadKind('main', 'agent'), 'sub-agent');
    assert.equal(childThreadKind('sub-thread', 'agent'), 'sub-agent');
    assert.equal(childThreadKind('sub-agent', 'agent'), 'sub-agent');
  });
});

describe('canHoldChild', () => {
  test('a main thread holds both child kinds', () => {
    assert.equal(canHoldChild('main', 'sub-thread'), true);
    assert.equal(canHoldChild('main', 'sub-agent'), true);
    assert.equal(canHoldChild('main', 'main'), false);
  });

  test('a child thread holds agent threads only', () => {
    assert.equal(canHoldChild('sub-thread', 'sub-agent'), true);
    assert.equal(canHoldChild('sub-thread', 'sub-thread'), false);
    assert.equal(canHoldChild('sub-agent', 'sub-agent'), true);
    assert.equal(canHoldChild('sub-agent', 'sub-thread'), false);
  });
});
