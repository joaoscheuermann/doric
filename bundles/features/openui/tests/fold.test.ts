// B6 (openui.md D4): the program fold. A Thread's fences of one tag become
// revisions: completed statements merged into the previous revision of the
// same identity, question fences kept whole, a memo so a flush merges only
// from the first fence that changed, and folds held per Thread and tag.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completedStatements,
  createProgramFold,
  createProgramFolds,
  firstCompletedLine,
  type ProgramFence,
} from '../src/contracts/index.js';

/** A recording merge that keeps both texts, so a program shows each patch it took. */
const recordingMerge = () => {
  const calls: (readonly [string, string])[] = [];
  const merge = (existing: string, patch: string): string => {
    calls.push([existing, patch]);
    return `${existing}${patch.endsWith('\n') ? patch : `${patch}\n`}`;
  };
  return { calls, merge };
};

const isQuestion = (line: string): boolean =>
  /^root\s*=\s*AskForm\(/.test(line);

const fence = (
  key: string,
  info: string,
  body: string,
  state: ProgramFence['state'] = 'closed',
): ProgramFence => ({ key, info, body, state });

test("a closed fence's completed statements are its whole body", () => {
  assert.equal(
    completedStatements(fence('p/1/0', 'openui-lang a', 'x = 1\ny = 2')),
    'x = 1\ny = 2',
  );
});

test('a streaming or unterminated fence holds back a last line without its newline', () => {
  for (const state of ['streaming', 'unterminated'] as const) {
    const completed = completedStatements(
      fence('p/1/0', 'openui-lang a', 'x = 1\ny = 2', state),
    );
    assert.match(completed, /x = 1/);
    assert.doesNotMatch(completed, /y = 2/);
    assert.equal(
      completedStatements(
        fence('p/1/0', 'openui-lang a', 'x = 1\ny = 2\n', state),
      ),
      'x = 1\ny = 2\n',
    );
  }
});

test('the first completed line skips blank lines, and a fence without one has none', () => {
  assert.equal(
    firstCompletedLine(fence('p/1/0', 'openui-lang a', '\n  \nroot = A()\n')),
    'root = A()',
  );
  assert.equal(
    firstCompletedLine(
      fence('p/1/0', 'openui-lang a', 'root = A(', 'streaming'),
    ),
    undefined,
  );
  assert.equal(
    firstCompletedLine(fence('p/1/0', 'openui-lang a', '\n\n', 'streaming')),
    undefined,
  );
});

test('three revisions merge in order', () => {
  const { calls, merge } = recordingMerge();
  const revisions = createProgramFold(merge).revisions([
    fence('p/1/0', 'openui-lang a', 'root = A(x)\nx = 1\n'),
    fence('p/1/1', 'openui-lang a', 'x = 2\n'),
    fence('p/1/2', 'openui-lang a', 'y = 3\n'),
  ]);

  const first = revisions.get('p/1/0');
  const second = revisions.get('p/1/1');
  const third = revisions.get('p/1/2');

  assert.deepEqual(first, {
    key: 'p/1/0',
    identity: 'a',
    revision: 1,
    program: 'root = A(x)\nx = 1\n',
    complete: true,
    question: false,
  });
  assert.equal(second?.revision, 2);
  assert.equal(second?.base, 'root = A(x)\nx = 1\n');
  assert.equal(second?.program, 'root = A(x)\nx = 1\nx = 2\n');
  assert.equal(third?.revision, 3);
  assert.equal(third?.base, second?.program);
  assert.equal(third?.program, 'root = A(x)\nx = 1\nx = 2\ny = 3\n');
  assert.deepEqual(calls, [
    ['root = A(x)\nx = 1\n', 'x = 2\n'],
    ['root = A(x)\nx = 1\nx = 2\n', 'y = 3\n'],
  ]);
});

test("an unterminated fence's completed statements are the next base", () => {
  const { merge } = recordingMerge();
  const revisions = createProgramFold(merge).revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\ny = 2', 'unterminated'),
    fence('p/2/0', 'openui-lang a', 'z = 3\n'),
  ]);

  const cut = revisions.get('p/1/1');
  assert.equal(cut?.complete, false);
  assert.match(cut?.program ?? '', /x = 1/);
  assert.doesNotMatch(cut?.program ?? '', /y = 2/);
  assert.equal(revisions.get('p/2/0')?.base, cut?.program);
  assert.equal(revisions.get('p/2/0')?.revision, 3);
});

test('a held-back last line is not merged', () => {
  const { calls, merge } = recordingMerge();
  const revisions = createProgramFold(merge).revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\ny = 2', 'streaming'),
  ]);

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.[1] ?? '', /x = 1/);
  assert.doesNotMatch(calls[0]?.[1] ?? '', /y = 2/);
  assert.equal(revisions.get('p/1/1')?.complete, false);
  assert.doesNotMatch(revisions.get('p/1/1')?.program ?? '', /y = 2/);
});

test('a streaming fence with no completed line has no entry and takes no revision number', () => {
  const { merge } = recordingMerge();
  const fold = createProgramFold(merge);
  const before = fold.revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1', 'streaming'),
  ]);

  assert.equal(before.size, 1);
  assert.equal(before.has('p/1/1'), false);

  const after = fold.revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\n', 'streaming'),
  ]);

  assert.equal(after.get('p/1/1')?.revision, 2);
});

test('a question fence gets _<n>, keeps its own body, is never a base, and the next fence patches the one before it', () => {
  const { calls, merge } = recordingMerge();
  const question =
    'root = AskForm([q])\nq = AskQuestion("db", "Which?", [a, b])\n';
  const revisions = createProgramFold(merge, isQuestion).revisions([
    fence('p/1/0', 'openui-lang settings', 'root = Card([t])\nt = 1\n'),
    fence('p/2/0', 'openui-lang settings', question),
    fence('p/3/0', 'openui-lang settings', 't = 2\n'),
  ]);

  const asked = revisions.get('p/2/0');
  assert.equal(asked?.identity, '_2');
  assert.equal(asked?.question, true);
  assert.equal(asked?.program, question);
  assert.equal(asked?.base, undefined);
  assert.equal(asked?.revision, 1);

  const patch = revisions.get('p/3/0');
  assert.equal(patch?.identity, 'settings');
  assert.equal(patch?.revision, 2);
  assert.equal(patch?.base, 'root = Card([t])\nt = 1\n');
  assert.equal(patch?.program, 'root = Card([t])\nt = 1\nt = 2\n');
  assert.deepEqual(calls, [['root = Card([t])\nt = 1\n', 't = 2\n']]);
});

test('an AskForm root on a second line is an ordinary revision', () => {
  const { merge } = recordingMerge();
  const revisions = createProgramFold(merge, isQuestion).revisions([
    fence('p/1/0', 'openui-lang settings', 'x = 1\nroot = AskForm([q])\n'),
  ]);

  assert.equal(revisions.get('p/1/0')?.identity, 'settings');
  assert.equal(revisions.get('p/1/0')?.question, false);
});

test('without an isQuestion test a fence rooted at AskForm is an ordinary revision', () => {
  const { calls, merge } = recordingMerge();
  const revisions = createProgramFold(merge).revisions([
    fence('p/1/0', 'openui-lang settings', 'root = Card([t])\n'),
    fence('p/2/0', 'openui-lang settings', 'root = AskForm([q])\n'),
  ]);

  assert.equal(revisions.get('p/2/0')?.identity, 'settings');
  assert.equal(revisions.get('p/2/0')?.question, false);
  assert.equal(revisions.get('p/2/0')?.revision, 2);
  assert.equal(calls.length, 1);
});

test('a second call with an equal list calls merge zero times', () => {
  const { calls, merge } = recordingMerge();
  const fold = createProgramFold(merge);
  const list = () => [
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\n'),
    fence('p/1/2', 'openui-lang a', 'y = 2\n'),
  ];

  const first = fold.revisions(list());
  const count = calls.length;
  const second = fold.revisions(list());

  assert.equal(count, 2);
  assert.equal(calls.length, count);
  assert.deepEqual([...second.entries()], [...first.entries()]);
});

test('with 50 closed fences and one streaming, a flush calls merge once', () => {
  const { calls, merge } = recordingMerge();
  const fold = createProgramFold(merge);
  const closedFences = Array.from({ length: 50 }, (_, index) =>
    fence(`p/1/${index}`, 'openui-lang a', `s${index} = ${index}\n`),
  );

  fold.revisions([
    ...closedFences,
    fence('p/1/50', 'openui-lang a', 'x = 1\n', 'streaming'),
  ]);
  const count = calls.length;
  fold.revisions([
    ...closedFences,
    fence('p/1/50', 'openui-lang a', 'x = 1\ny = 2\n', 'streaming'),
  ]);

  assert.equal(calls.length - count, 1);
});

test('folds held per Thread and tag: the same fold while held, its memo kept across a release and hold in one task', async () => {
  const { calls, merge } = recordingMerge();
  const folds = createProgramFolds(merge);
  const list = [
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\n'),
  ];

  const one = folds.hold('thread-1', 'openui-lang');
  const two = folds.hold('thread-1', 'openui-lang');
  const other = folds.hold('thread-2', 'openui-lang');
  assert.equal(one.fold, two.fold);
  assert.notEqual(one.fold, other.fold);

  one.fold.revisions(list);
  const count = calls.length;

  one.release();
  two.release();
  two.release(); // idempotent
  const again = folds.hold('thread-1', 'openui-lang');
  again.fold.revisions(list);

  assert.equal(again.fold, one.fold);
  assert.equal(calls.length, count);
  again.release();
  other.release();
});

test('a fold released for a microtask is rebuilt by the next hold', async () => {
  const { calls, merge } = recordingMerge();
  const folds = createProgramFolds(merge);
  const list = [
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\n'),
  ];

  const held = folds.hold('thread-1', 'openui-lang');
  held.fold.revisions(list);
  const count = calls.length;
  held.release();

  await new Promise((resolve) => setTimeout(resolve, 0));

  const again = folds.hold('thread-1', 'openui-lang');
  again.fold.revisions(list);

  assert.notEqual(again.fold, held.fold);
  assert.equal(calls.length, count * 2);
  again.release();
});

test('removing the last fence removes its revision', () => {
  const { merge } = recordingMerge();
  const fold = createProgramFold(merge);
  fold.revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/2/0', 'openui-lang a', 'x = 1\n'),
  ]);

  const after = fold.revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
  ]);

  assert.equal(after.has('p/2/0'), false);
  assert.equal(after.get('p/1/0')?.revision, 1);
});

test('a merge that throws for the third revision keeps its base, and the fourth merges into it', () => {
  const calls: (readonly [string, string])[] = [];
  const merge = (existing: string, patch: string): string => {
    calls.push([existing, patch]);
    if (patch === 'bad = (\n') throw new Error('merge failed');
    return `${existing}${patch}`;
  };
  const revisions = createProgramFold(merge).revisions([
    fence('p/1/0', 'openui-lang a', 'root = A()\n'),
    fence('p/1/1', 'openui-lang a', 'x = 1\n'),
    fence('p/1/2', 'openui-lang a', 'bad = (\n'),
    fence('p/1/3', 'openui-lang a', 'y = 2\n'),
  ]);

  const third = revisions.get('p/1/2');
  assert.equal(third?.revision, 3);
  assert.equal(third?.mergeFailed, true);
  assert.equal(third?.program, third?.base);
  assert.equal(third?.program, 'root = A()\nx = 1\n');

  const fourth = revisions.get('p/1/3');
  assert.equal(fourth?.base, 'root = A()\nx = 1\n');
  assert.equal(fourth?.program, 'root = A()\nx = 1\ny = 2\n');
  assert.equal(fourth?.mergeFailed, undefined);
});
