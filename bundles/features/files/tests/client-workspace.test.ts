import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SANDBOX_ROOT, workspacePath } from '../src/contracts/index.js';

describe('workspace path', () => {
  test('reads the sandbox root itself as the empty path', () => {
    assert.equal(workspacePath(SANDBOX_ROOT), '');
  });

  test('drops the sandbox prefix from a directory inside it', () => {
    assert.equal(workspacePath('/workspace/doric'), 'doric');
    assert.equal(workspacePath('/workspace/doric/app'), 'doric/app');
  });

  test('tolerates a trailing separator', () => {
    assert.equal(workspacePath('/workspace/doric/'), 'doric');
    assert.equal(workspacePath('/workspace/'), '');
  });

  test('reads a path outside the sandbox as the root, not an invented path', () => {
    assert.equal(workspacePath('/home/me/doric'), '');
  });
});
