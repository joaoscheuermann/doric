// The call scope is an opaque bounded record (M1): the platform accepts any
// key that matches the key pattern, up to SCOPE_MAX_KEYS keys of at most
// SCOPE_MAX_VALUE characters, and names none of them.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callScopeSchema,
  SCOPE_MAX_KEYS,
  SCOPE_MAX_VALUE,
} from '../src/contracts/index.js';

/** `count` distinct keys, each a valid scope key. */
const keysOf = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key${index}`, 'v']),
  );

void test('a scope names no key: any well-formed key crosses unchanged', () => {
  const scope = { workspaceId: 'w1', 'segment.two-three_4': 'x' };

  assert.deepEqual(callScopeSchema.parse(scope), scope);
});

void test('the key count is bounded at SCOPE_MAX_KEYS', () => {
  assert.equal(SCOPE_MAX_KEYS, 16);
  assert.ok(callScopeSchema.safeParse(keysOf(SCOPE_MAX_KEYS)).success);
  assert.ok(!callScopeSchema.safeParse(keysOf(SCOPE_MAX_KEYS + 1)).success);
});

void test('a value is bounded at SCOPE_MAX_VALUE characters', () => {
  assert.equal(SCOPE_MAX_VALUE, 512);
  assert.ok(
    callScopeSchema.safeParse({ k: 'a'.repeat(SCOPE_MAX_VALUE) }).success,
  );
  assert.ok(
    !callScopeSchema.safeParse({ k: 'a'.repeat(SCOPE_MAX_VALUE + 1) }).success,
  );
});

void test('a key must start with a letter and stay within 64 characters', () => {
  assert.ok(callScopeSchema.safeParse({ a: 'v' }).success);
  assert.ok(callScopeSchema.safeParse({ [`a${'b'.repeat(63)}`]: 'v' }).success);
  assert.ok(
    !callScopeSchema.safeParse({ [`a${'b'.repeat(64)}`]: 'v' }).success,
  );
  assert.ok(!callScopeSchema.safeParse({ '1abc': 'v' }).success);
  assert.ok(!callScopeSchema.safeParse({ 'a b': 'v' }).success);
  assert.ok(!callScopeSchema.safeParse({ 'a/b': 'v' }).success);
});

void test('a value must be a string', () => {
  assert.ok(!callScopeSchema.safeParse({ projectId: 1 }).success);
});
