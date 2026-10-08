/**
 * The two translations the cwd lives between: the sandbox's absolute form the
 * host serves, and the workspace-relative form the sandbox endpoints expect.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compactPath, SANDBOX_ROOT, workspacePath } from '../src/domain/cwd';

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

describe('compact path', () => {
  test('keeps the last components and drops the rest behind an ellipsis', () => {
    assert.equal(compactPath('/home/me/projetos/doric'), '…/projetos/doric');
  });

  test('leaves a path that is short enough whole', () => {
    assert.equal(compactPath('/workspace/doric'), '/workspace/doric');
    assert.equal(compactPath('/workspace'), '/workspace');
  });

  test('keeps as many components as the caller asks for', () => {
    assert.equal(compactPath('/home/me/projetos/doric', 1), '…/doric');
    assert.equal(
      compactPath('/home/me/projetos/doric', 3),
      '…/me/projetos/doric',
    );
  });
});
