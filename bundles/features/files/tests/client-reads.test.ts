import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  ProjectFileContent,
  ProjectTreeNode,
} from '../src/client/reads/project-files.js';
import {
  fileReadState,
  pathSegments,
  ROOT_NAME,
  treeReadState,
  truncationNotice,
} from '../src/client/reads/state.js';
import { ROOT_PATH, sandboxNotice } from '../src/contracts/index.js';

describe('the path chain the breadcrumb names', () => {
  test('names every segment from the workspace root down to the path', () => {
    assert.deepEqual(pathSegments('src/domain/files.ts'), [
      { name: ROOT_NAME, path: ROOT_PATH },
      { name: 'src', path: 'src' },
      { name: 'domain', path: 'src/domain' },
      { name: 'files.ts', path: 'src/domain/files.ts' },
    ]);
    assert.deepEqual(pathSegments(ROOT_PATH), [
      { name: ROOT_NAME, path: ROOT_PATH },
    ]);
  });
});

describe('what the surface says', () => {
  test('states that a truncated payload shows only its first part', () => {
    assert.equal(
      truncationNotice(true),
      'This file is larger than the read limit, so only its first part is shown.',
    );
    assert.equal(truncationNotice(false), undefined);
  });

  test('explains a sandbox the surface cannot read', () => {
    assert.equal(
      sandboxNotice('pending', 5),
      'The sandbox is still being prepared; the host suggests trying again in 5 seconds.',
    );
    assert.equal(
      sandboxNotice('pending'),
      'The sandbox is still being prepared.',
    );
    assert.match(sandboxNotice('expired'), /lease/);
    assert.match(sandboxNotice('unavailable'), /unavailable/);
    assert.match(sandboxNotice('missing'), /no sandbox yet/);
    assert.match(sandboxNotice('invalid_path'), /not inside the workspace/);
    assert.match(sandboxNotice('not_found'), /no longer in the workspace/);
  });
});

const treeNode: ProjectTreeNode = {
  name: 'app.ts',
  path: 'src/app.ts',
  type: 'file',
};

const fileContent: ProjectFileContent = {
  path: 'src/app.ts',
  content: 'one',
  truncated: false,
  binary: false,
};

const lease = { status: 'pending', retryAfterSeconds: 5 } as const;

describe('what a sandbox read shows', () => {
  test('shows the tree and the file each read answered with', () => {
    assert.deepEqual(
      treeReadState({ status: 'ready', path: '', entries: [treeNode] }, false),
      {
        status: 'ready',
        value: [treeNode],
      },
    );
    assert.deepEqual(
      fileReadState({ status: 'ready', file: fileContent }, false, false),
      { status: 'ready', value: fileContent },
    );
  });

  test('explains a lease instead of failing, and reuses its retry hint', () => {
    for (const state of [treeReadState(lease, false)]) {
      assert.equal(state.status, 'pending');
      assert.equal(
        state.status === 'pending' ? state.retryAfterSeconds : undefined,
        5,
      );
    }
    assert.deepEqual(fileReadState(lease, false, false), lease);
    assert.deepEqual(treeReadState({ status: 'not_found' }, false), {
      status: 'not_found',
    });
  });

  test('keeps what is on screen when a reread of it fails', () => {
    assert.deepEqual(
      fileReadState({ status: 'ready', file: fileContent }, false, true),
      { status: 'ready', value: fileContent },
    );
    assert.deepEqual(
      treeReadState({ status: 'ready', path: '', entries: [treeNode] }, true),
      {
        status: 'ready',
        value: [treeNode],
      },
    );
  });

  test('keeps waiting on a tree whose read failed without answering', () => {
    assert.deepEqual(treeReadState(undefined, false), { status: 'loading' });
    assert.deepEqual(treeReadState(undefined, true), { status: 'loading' });
    // A lease that a failed reread left behind is no longer an answer.
    assert.deepEqual(treeReadState(lease, true), { status: 'loading' });
  });

  test('keeps cached file content visible during background reads', () => {
    assert.deepEqual(
      fileReadState({ status: 'ready', file: fileContent }, true, false),
      { status: 'ready', value: fileContent },
    );
  });

  test('shows loading placeholders only while awaiting first content', () => {
    assert.deepEqual(fileReadState(undefined, true, false), {
      status: 'loading',
    });
  });

  test('has no file content when the first read failed', () => {
    assert.deepEqual(fileReadState(undefined, false, true), { status: 'idle' });
    assert.deepEqual(fileReadState(undefined, false, false), {
      status: 'idle',
    });
  });
});
