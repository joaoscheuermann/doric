// S59a: the Project every operation runs on is read from the call once
// (`projectOf`), by the kernel's services and the process's alike.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';

import { mcpScopeMessage } from '../src/contracts/index.js';
import { projectOf } from '../src/host/operations.js';
import { P1 } from './support/router.js';
import { codeOf } from './support/wait.js';

void test('S59a PO1 projectOf answers the call scope Project', async (t) => {
  const world = createTestServices({ bundle: { id: 'mcp' } });
  t.after(() => world.dispose());

  assert.equal(projectOf(world.call({ projectId: P1 })), P1);
});

void test('S59a PO2 projectOf refuses a call without a Project, or with an empty one, with invalid_input', async (t) => {
  const world = createTestServices({ bundle: { id: 'mcp' } });
  t.after(() => world.dispose());

  for (const call of [world.call(), world.call({ projectId: '' })]) {
    assert.throws(
      () => projectOf(call),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid_input');
        assert.equal((error as Error).message, mcpScopeMessage);
        return true;
      },
    );
  }
});
