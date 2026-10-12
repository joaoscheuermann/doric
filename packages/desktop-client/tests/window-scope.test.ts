// What a window may send as a call scope: a bounded opaque record. Which keys a
// contract accepts is its provider's declaration, checked by main (see the
// dispatcher tests); here the IPC admits any well-formed key up to the bounds
// and never a `windowKey` in any letter case. Main fills the window key itself,
// so a window cannot name another window.

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

const keysOf = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key${index}`, 'v']),
  );

void test('a window sends its scope unchanged', () => {
  const scope = { projectId: 'p1', threadId: 't1', promptId: 'r1' };
  const parsed = desktopRequestSchema.parse(callWithScope(scope));

  assert.ok(parsed.op === 'call');
  assert.deepEqual(parsed.envelope.scope, scope);
});

void test('a window may send a call without a scope or an empty one', () => {
  assert.ok(accepts(undefined));
  assert.ok(accepts({}));
});

void test('any well-formed scope key crosses the IPC; the provider decides the rest', () => {
  assert.ok(accepts({ workspaceId: 'w1' }));
  assert.ok(accepts({ tenantSlug: 'acme', 'segment.two-three_4': 'x' }));
});

void test('a scope key must match the scope key pattern', () => {
  assert.equal(accepts({ 'bad key': 'v' }), false);
  assert.equal(accepts({ '1abc': 'v' }), false);
});

void test('a window cannot send windowKey in any letter case', () => {
  assert.equal(accepts({ windowKey: 'forged' }), false);
  assert.equal(accepts({ WindowKey: 'forged' }), false);
  assert.equal(accepts({ WINDOWKEY: 'forged' }), false);
  assert.equal(accepts({ projectId: 'p1', windowkey: 'forged' }), false);
});

void test('a window scope holds at most the bounded number of keys', () => {
  assert.ok(accepts(keysOf(16)));
  assert.equal(accepts(keysOf(17)), false);
});

void test('a window scope value is a string of at most the bounded length', () => {
  assert.ok(accepts({ projectId: 'a'.repeat(512) }));
  assert.equal(accepts({ projectId: 'a'.repeat(513) }), false);
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
