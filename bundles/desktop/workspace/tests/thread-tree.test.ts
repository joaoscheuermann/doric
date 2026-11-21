import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canExpand,
  childThreads,
  isExpanded,
  isThreadRunning,
  type ThreadNode,
  threadActivity,
  threadLevel,
  threadPath,
} from '../src/client/domain/thread-tree.js';
import type { Thread } from '../src/client/domain/workspace.js';

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
  lastSequence: 0,
  cwd: '/workspace/doric',
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
    const [root] = level.nodes;
    assert.ok(root);
    assert.deepEqual(ids(root.children.nodes), ['b']);
    const [child] = root.children.nodes;
    assert.ok(child);
    assert.deepEqual(ids(child.children.nodes), ['c']);
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
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.expandable, true);
    assert.equal(b.expandable, true);
  });

  test('marks a childless leaf with no draft as not expandable', () => {
    const level = threadLevel([thread('a', 'p')], undefined, 'p');
    const [node] = level.nodes;
    assert.ok(node);
    assert.equal(node.expandable, false);
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
    const [node] = level.nodes;
    assert.ok(node);
    assert.equal(node.children.draft, true);
  });

  test('ignores a project draft and drafts from other projects', () => {
    const level = threadLevel([thread('a', 'p')], { kind: 'project' }, 'p');
    assert.equal(level.draft, false);
    const [node] = level.nodes;
    assert.ok(node);
    assert.equal(node.children.draft, false);

    const other = threadLevel(
      [thread('a', 'p')],
      { kind: 'thread', projectId: 'other', parentThreadId: 'a' },
      'p',
    );
    const [otherNode] = other.nodes;
    assert.ok(otherNode);
    assert.equal(otherNode.children.draft, false);
  });
});

describe('threadPath', () => {
  const threads = [
    thread('root', 'p'),
    thread('child', 'p', 'root'),
    thread('grandchild', 'p', 'child'),
    thread('sibling', 'p', 'root'),
  ];

  test('names every ancestor from the outermost down to the Thread', () => {
    assert.deepEqual(
      threadPath(threads, 'grandchild').map(({ id }) => id),
      ['root', 'child', 'grandchild'],
    );
  });

  test('is a single entry for a Thread with no parent', () => {
    assert.deepEqual(
      threadPath(threads, 'root').map(({ id }) => id),
      ['root'],
    );
  });

  test('stops at a parent the list does not describe', () => {
    const orphan = [thread('child', 'p', 'missing')];

    assert.deepEqual(
      threadPath(orphan, 'child').map(({ id }) => id),
      ['child'],
    );
  });

  test('is empty for a Thread the list does not know', () => {
    assert.deepEqual(threadPath(threads, 'ghost'), []);
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

describe('threadActivity', () => {
  const never = (): boolean => false;
  const start = '2026-11-10T12:00:00.000Z';
  const finished = '2026-11-10T12:10:00.000Z';

  const running = (value: Thread, startedAt = start): Thread => ({
    ...value,
    state: 'running',
    activePromptId: 'prompt-run',
    executionStartedAt: startedAt,
  });

  const finishedAfter = (value: Thread, lastExecutionMs?: number): Thread => ({
    ...value,
    result: {
      status: 'completed',
      text: '',
      promptId: 'prompt-done',
      at: finished,
    },
    ...(lastExecutionMs === undefined ? {} : { lastExecutionMs }),
  });

  const level = (threads: readonly Thread[]) =>
    threadLevel(threads, undefined, 'p');

  test('an idle tree with nothing busy has no active Thread (T-2.1)', () => {
    const activity = threadActivity(
      level([thread('r', 'p'), thread('c', 'p', 'r'), thread('s', 'p')]),
      never,
    );
    assert.equal(activity.size, 0);
  });

  test('a running grandchild makes its ancestors active, each with its own start (T-2.2)', () => {
    const activity = threadActivity(
      level([
        thread('r', 'p'),
        finishedAfter(thread('c', 'p', 'r'), 90_000),
        running(thread('g', 'p', 'c')),
        thread('s', 'p'),
      ]),
      never,
    );

    assert.deepEqual([...activity.keys()].sort(), ['c', 'g', 'r']);
    assert.equal(activity.has('s'), false);
    assert.equal(activity.get('g')?.startedAt, start);
    assert.equal(
      activity.get('c')?.startedAt,
      new Date(Date.parse(finished) - 90_000).toISOString(),
    );
    assert.equal(activity.get('r')?.startedAt, undefined);
  });

  test('a busy idle leaf makes itself and every ancestor active (T-2.3)', () => {
    const activity = threadActivity(
      level([thread('r', 'p'), thread('c', 'p', 'r'), thread('l', 'p', 'c')]),
      (id) => id === 'l',
    );
    assert.deepEqual([...activity.keys()].sort(), ['c', 'l', 'r']);
  });

  test('a running state without an active prompt is idle (T-2.3)', () => {
    const halfRunning: Thread = { ...thread('a', 'p'), state: 'running' };
    const promptOnly: Thread = { ...thread('b', 'p'), activePromptId: 'x' };

    assert.equal(isThreadRunning(halfRunning), false);
    assert.equal(isThreadRunning(promptOnly), false);
    assert.equal(isThreadRunning(running(thread('c', 'p'))), true);
    assert.equal(
      threadActivity(level([halfRunning, promptOnly]), never).size,
      0,
    );
  });

  test('an active idle Thread without a whole latest execution has no start (T-2.4)', () => {
    const activity = threadActivity(
      level([
        thread('never', 'p'),
        running(thread('a', 'p', 'never')),
        finishedAfter(thread('paused', 'p')),
        running(thread('b', 'p', 'paused')),
      ]),
      never,
    );

    assert.ok(activity.has('never'));
    assert.equal(activity.get('never')?.startedAt, undefined);
    assert.ok(activity.has('paused'));
    assert.equal(activity.get('paused')?.startedAt, undefined);
  });

  test('a running Thread whose start does not parse is active without a start', () => {
    const activity = threadActivity(
      level([running(thread('a', 'p'), 'not a date')]),
      never,
    );
    assert.ok(activity.has('a'));
    assert.equal(activity.get('a')?.startedAt, undefined);
  });

  test('asks busy exactly once per Thread, whatever is collapsed (T-2.5)', () => {
    const asked: string[] = [];
    const tree = level([
      thread('r', 'p'),
      thread('c', 'p', 'r'),
      thread('g', 'p', 'c'),
      thread('s', 'p'),
    ]);
    // The caller draws `r` collapsed; the level still holds every Thread.
    assert.equal(
      isExpanded(tree.nodes[0] as ThreadNode, new Set(['r'])),
      false,
    );

    const activity = threadActivity(tree, (id) => {
      asked.push(id);
      return id === 'g';
    });

    assert.deepEqual([...asked].sort(), ['c', 'g', 'r', 's']);
    assert.ok(activity.has('r'));
  });
});
