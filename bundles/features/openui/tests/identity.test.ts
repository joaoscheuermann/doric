// B5 (openui.md D3): which program a fence writes or patches. The identity is
// the info string's second word when it is a written identity, else the
// anonymous `_<n>`, `n` the fence's ordinal among the Thread's fences of its
// tag; identities are per tag, and the revision counts a Thread's fences of
// one tag and identity.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anonymousIdentity,
  createProgramFold,
  type ProgramFence,
  writtenIdentity,
} from '../src/contracts/index.js';

/** A merge that keeps both texts, so a revision's program shows what was merged. */
const merge = (existing: string, patch: string): string =>
  `${existing}${patch}`;

const closed = (key: string, info: string, body: string): ProgramFence => ({
  key,
  info,
  body,
  state: 'closed',
});

test('settings and p3 are written identities, words after the second ignored', () => {
  assert.equal(writtenIdentity('openui-lang settings'), 'settings');
  assert.equal(writtenIdentity('openui-lang p3'), 'p3');
  assert.equal(
    writtenIdentity('openui-lang settings and more words'),
    'settings',
  );
});

test('Settings, 3d, _2 and a missing word are no written identity', () => {
  assert.equal(writtenIdentity('openui-lang Settings'), undefined);
  assert.equal(writtenIdentity('openui-lang 3d'), undefined);
  assert.equal(writtenIdentity('openui-lang _2'), undefined);
  assert.equal(writtenIdentity('openui-lang'), undefined);
  assert.equal(writtenIdentity(''), undefined);
});

test('a written identity holds at most 64 characters', () => {
  const longest = `a${'b'.repeat(63)}`;

  assert.equal(writtenIdentity(`openui-lang ${longest}`), longest);
  assert.equal(writtenIdentity(`openui-lang ${longest}c`), undefined);
});

test('the anonymous identity is _ and the 1-based ordinal', () => {
  assert.equal(anonymousIdentity(1), '_1');
  assert.equal(anonymousIdentity(42), '_42');
  assert.throws(() => anonymousIdentity(0), RangeError);
  assert.throws(() => anonymousIdentity(1.5), RangeError);
  assert.throws(() => anonymousIdentity(1_000_000_000), RangeError);
});

test("a fence without a written identity gets _<n>, n its ordinal among the tag's fences", () => {
  const fold = createProgramFold(merge);
  const revisions = fold.revisions([
    closed('p1/1/0', 'openui-lang settings', 'root = A()\n'),
    closed('p1/1/1', 'openui-lang Settings', 'root = B()\n'),
    closed('p1/1/2', 'openui-lang 3d', 'root = C()\n'),
    closed('p1/1/3', 'openui-lang', 'root = D()\n'),
  ]);

  assert.equal(revisions.get('p1/1/0')?.identity, 'settings');
  assert.equal(revisions.get('p1/1/1')?.identity, '_2');
  assert.equal(revisions.get('p1/1/2')?.identity, '_3');
  assert.equal(revisions.get('p1/1/3')?.identity, '_4');
  // An anonymous program is never merged with an earlier one.
  for (const key of ['p1/1/1', 'p1/1/2', 'p1/1/3']) {
    assert.equal(revisions.get(key)?.revision, 1);
    assert.equal(revisions.get(key)?.base, undefined);
  }
});

test('the same identity under the other tag is another program', () => {
  // One fold per Thread and tag: the papercraft fold never sees the openui-lang fences.
  const lang = createProgramFold(merge);
  const papercraft = createProgramFold(merge);

  const inLang = lang.revisions([
    closed('p1/1/0', 'openui-lang settings', 'root = A()\n'),
  ]);
  const inPapercraft = papercraft.revisions([
    closed('p1/1/0', 'papercraft settings', 'root = B()\n'),
  ]);

  assert.equal(inLang.get('p1/1/0')?.revision, 1);
  assert.equal(inPapercraft.get('p1/1/0')?.revision, 1);
  assert.equal(inPapercraft.get('p1/1/0')?.program, 'root = B()\n');
  assert.equal(inPapercraft.get('p1/1/0')?.base, undefined);
});

test('with fences a, b, a, _, b, a the revisions are 1, 1, 2, 1, 2, 3', () => {
  const fold = createProgramFold(merge);
  const fences = [
    closed('p1/1/0', 'openui-lang a', 'root = A()\n'),
    closed('p1/1/1', 'openui-lang b', 'root = B()\n'),
    closed('p1/1/2', 'openui-lang a', 'x = 1\n'),
    closed('p1/1/3', 'openui-lang', 'root = C()\n'),
    closed('p1/1/4', 'openui-lang b', 'y = 2\n'),
    closed('p1/1/5', 'openui-lang a', 'z = 3\n'),
  ];
  const revisions = fold.revisions(fences);

  assert.deepEqual(
    fences.map(({ key }) => revisions.get(key)?.revision),
    [1, 1, 2, 1, 2, 3],
  );
  assert.deepEqual(
    fences.map(({ key }) => revisions.get(key)?.identity),
    ['a', 'b', 'a', '_4', 'b', 'a'],
  );
});
