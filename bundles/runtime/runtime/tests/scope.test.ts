// The runtime's scope helpers (M1): the Project, Thread and prompt keys of a
// call scope, read and written through one owner. Other keys of the scope
// are the platform's and the bundles' to read, never the runtime's.

import assert from 'node:assert/strict';
import test from 'node:test';

import { readRuntimeScope, runtimeScope } from '../src/contracts/scope.js';

void test('a runtime scope carries exactly the keys it names', () => {
  assert.deepEqual(runtimeScope({ projectId: 'p1', threadId: 't1' }), {
    projectId: 'p1',
    threadId: 't1',
  });
  assert.deepEqual(runtimeScope({}), {});
});

void test('reading a call takes its Project, Thread and prompt and ignores other keys', () => {
  const scope = {
    projectId: 'p1',
    threadId: 't1',
    promptId: 'r1',
    windowKey: 'main',
    workspaceId: 'w1',
  };

  assert.deepEqual(readRuntimeScope({ scope }), {
    projectId: 'p1',
    threadId: 't1',
    promptId: 'r1',
  });
});

void test('a call without a scope reads no runtime key', () => {
  assert.deepEqual(readRuntimeScope({}), {
    projectId: undefined,
    threadId: undefined,
    promptId: undefined,
  });
});

void test('a runtime scope read back from a call is the scope it was built from', () => {
  const scope = { projectId: 'p1', threadId: 't1', promptId: 'r1' };

  assert.deepEqual(readRuntimeScope({ scope: runtimeScope(scope) }), scope);
});
