import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  baseName,
  compactPath,
  joinPath,
  parentPath,
  ROOT_PATH,
} from '../src/paths.js';

describe('workspace-relative paths', () => {
  test('joins and parents a path at the workspace root', () => {
    assert.equal(joinPath(ROOT_PATH, 'src'), 'src');
    assert.equal(joinPath('src', 'app.ts'), 'src/app.ts');
    assert.equal(parentPath('src/app.ts'), 'src');
    assert.equal(parentPath('app.ts'), ROOT_PATH);
    assert.equal(baseName('src/app.ts'), 'app.ts');
    assert.equal(baseName('app.ts'), 'app.ts');
    assert.equal(baseName(ROOT_PATH), ROOT_PATH);
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
