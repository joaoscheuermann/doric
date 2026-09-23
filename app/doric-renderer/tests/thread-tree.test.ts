import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canExpand,
  childThreads,
  isExpanded,
  threadLevel,
  type ThreadNode,
} from '../src/domain/thread-tree';
import type { Thread } from '../src/domain/workspace';

const thread = (
  id: string,
  projectId: string,
  parentThreadId?: string,
): Thread => ({
  id,
  projectId,
  parentThreadId,
  name: id,
  state: 'ready',
  createdAt: '',
  updatedAt: '',
});

const ids = (nodes: readonly ThreadNode[]): readonly string[] =>
  nodes.map(({ thread: value }) => value.id);

describe('childThreads', () => {
  test('returns the direct children of a parent in list order', () => {
    const threads = [
      thread('a', 'p'),
      thread('b', 'p', 'a'),
      thread('c', 'p', 'a'),
      thread('d', 'p'),
    ];
    assert.deepEqual(
      childThreads(threads, 'p', 'a').map(({ id }) => id),
      ['b', 'c'],
    );
  });

  test('treats an omitted parent as the project roots', () => {
    const threads = [thread('a', 'p'), thread('b', 'p', 'a'), thread('c', 'p')];
    assert.deepEqual(
      childThreads(threads, 'p').map(({ id }) => id),
      ['a', 'c'],
    );
  });

  test('ignores threads from another project', () => {
    const threads = [thread('a', 'p', 'root'), thread('b', 'other', 'root')];
    assert.deepEqual(
      childThreads(threads, 'p', 'root').map(({ id }) => id),
      ['a'],
    );
  });
});

describe('canExpand', () => {
  test('is true when a level has a child node', () => {
    assert.equal(
      canExpand({
        draft: false,
        nodes: [
          {
            thread: thread('a', 'p'),
            children: { draft: false, nodes: [] },
            expandable: false,
          },
        ],
      }),
      true,
    );
  });

  test('is true when a level has only a pending draft', () => {
    assert.equal(canExpand({ draft: true, nodes: [] }), true);
  });

  test('is false when a level is empty', () => {
    assert.equal(canExpand({ draft: false, nodes: [] }), false);
  });
});

describe('threadLevel', () => {
  test('nests grandchildren under their parent', () => {
    const level = threadLevel(
      [thread('a', 'p'), thread('b', 'p', 'a'), thread('c', 'p', 'b')],
      undefined,
      'p',
    );
    assert.deepEqual(ids(level.nodes), ['a']);
    assert.deepEqual(ids(level.nodes[0]!.children.nodes), ['b']);
    assert.deepEqual(ids(level.nodes[0]!.children.nodes[0]!.children.nodes), [
      'c',
    ]);
  });

  test('excludes threads from another project', () => {
    const level = threadLevel(
      [thread('a', 'p'), thread('b', 'other')],
      undefined,
      'p',
    );
    assert.deepEqual(ids(level.nodes), ['a']);
  });

  test('marks a node expandable only when it has children or a draft child', () => {
    const level = threadLevel(
      [thread('a', 'p'), thread('b', 'p'), thread('c', 'p', 'a')],
      { kind: 'thread', projectId: 'p', parentThreadId: 'b' },
      'p',
    );
    const [a, b] = level.nodes;
    assert.equal(a!.expandable, true);
    assert.equal(b!.expandable, true);
  });

  test('marks a childless leaf with no draft as not expandable', () => {
    const level = threadLevel([thread('a', 'p')], undefined, 'p');
    assert.equal(level.nodes[0]!.expandable, false);
  });

  test('places a project-root thread draft at the root level', () => {
    const level = threadLevel([], { kind: 'thread', projectId: 'p' }, 'p');
    assert.equal(level.draft, true);
  });

  test('places a thread draft at the level of its parent thread', () => {
    const level = threadLevel(
      [thread('a', 'p')],
      { kind: 'thread', projectId: 'p', parentThreadId: 'a' },
      'p',
    );
    assert.equal(level.draft, false);
    assert.equal(level.nodes[0]!.children.draft, true);
  });

  test('ignores a project draft and drafts from other projects', () => {
    const level = threadLevel([thread('a', 'p')], { kind: 'project' }, 'p');
    assert.equal(level.draft, false);
    assert.equal(level.nodes[0]!.children.draft, false);

    const other = threadLevel(
      [thread('a', 'p')],
      { kind: 'thread', projectId: 'other', parentThreadId: 'a' },
      'p',
    );
    assert.equal(other.nodes[0]!.children.draft, false);
  });
});

describe('isExpanded', () => {
  const leaf: ThreadNode = {
    thread: thread('a', 'p'),
    children: { draft: false, nodes: [] },
    expandable: false,
  };
  const branch: ThreadNode = { ...leaf, expandable: true };

  test('is false for a node that cannot expand', () => {
    assert.equal(isExpanded(leaf, new Set()), false);
  });

  test('is true for an expandable node that is not collapsed', () => {
    assert.equal(isExpanded(branch, new Set()), true);
  });

  test('is false for an expandable node in the collapsed set', () => {
    assert.equal(isExpanded(branch, new Set(['a'])), false);
  });
});
