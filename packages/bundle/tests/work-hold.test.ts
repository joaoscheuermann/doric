// The work hold a bundle sends to doric.generation/v1: an opaque key, bounded,
// with the owner taken from the call (never from the input).

import assert from 'node:assert/strict';
import test from 'node:test';

import { workHoldSchema } from '../src/contracts/index.js';

void test('a work hold key is accepted from one to 256 characters and refused outside that range', () => {
  assert.equal(workHoldSchema.safeParse({ key: 'k' }).success, true);
  assert.equal(
    workHoldSchema.safeParse({ key: 'k'.repeat(256) }).success,
    true,
  );
  assert.equal(workHoldSchema.safeParse({ key: '' }).success, false);
  assert.equal(
    workHoldSchema.safeParse({ key: 'k'.repeat(257) }).success,
    false,
  );
});

void test('a work hold label is optional and bounded', () => {
  assert.equal(
    workHoldSchema.safeParse({ key: 'k', label: 'x' }).success,
    true,
  );
  assert.equal(
    workHoldSchema.safeParse({ key: 'k', label: 'x'.repeat(256) }).success,
    true,
  );
  assert.equal(
    workHoldSchema.safeParse({ key: 'k', label: 'x'.repeat(257) }).success,
    false,
  );
});

void test('a work hold names no owner: a bundle cannot choose whose work it holds', () => {
  assert.equal(
    workHoldSchema.safeParse({ key: 'k', bundleId: 'runtime' }).success,
    false,
  );
  assert.equal(workHoldSchema.safeParse({}).success, false);
});
