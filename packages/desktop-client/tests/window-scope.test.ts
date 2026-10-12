// What a window may send as a call scope: exactly the three keys HEAD admitted
// (`projectId`, `threadId`, `promptId`), never another key and never a
// `windowKey` in any letter case. Main fills the window key itself, so a
// window cannot name another window or reach a key the platform never admitted.

import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopRequestSchema } from '../src/index.js';

const callWithScope = (scope: Record<string, string> | undefined) => ({
  op: 'call',
  envelope: {
    id: 'call-1',
    contract: 'probe.api/v1',
    method: 'ping',
    input: [],
    bundleId: 'app',
    ...(scope === undefined ? {} : { scope }),
    deadline: 0,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  },
});

const accepts = (scope: Record<string, string> | undefined): boolean =>
  desktopRequestSchema.safeParse(callWithScope(scope)).success;

void test('a window sends the closed set of scope keys, unchanged', () => {
  const scope = { projectId: 'p1', threadId: 't1', promptId: 'r1' };
  const parsed = desktopRequestSchema.parse(callWithScope(scope));

  assert.ok(parsed.op === 'call');
  assert.deepEqual(parsed.envelope.scope, scope);
});

void test('a window may send a call without a scope or an empty one', () => {
  assert.ok(accepts(undefined));
  assert.ok(accepts({ projectId: 'p1' }));
});

void test('a window cannot send any other scope key, as HEAD refused', () => {
  assert.equal(accepts({ workspaceId: 'w1' }), false);
  assert.equal(accepts({ projectId: 'p1', 'bad key': 'v' }), false);
  assert.equal(accepts({ projectId: 'p1', projectid: 'v' }), false);
});

void test('a window cannot send windowKey in any letter case', () => {
  assert.equal(accepts({ windowKey: 'forged' }), false);
  assert.equal(accepts({ WindowKey: 'forged' }), false);
  assert.equal(accepts({ WINDOWKEY: 'forged' }), false);
  assert.equal(accepts({ projectId: 'p1', windowkey: 'forged' }), false);
});

void test('a window scope value must be a string', () => {
  assert.equal(
    desktopRequestSchema.safeParse({
      ...callWithScope(undefined),
      envelope: {
        ...callWithScope(undefined).envelope,
        scope: { projectId: 1 },
      },
    }).success,
    false,
  );
});
