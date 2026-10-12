// The window's remote method specs keep the exposure their provider's document
// declares: a method reaches a window's catalog with `expose` only when the
// document exposes it, and an unknown exposure is refused by the schema.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  remoteMethodSpecFromSchema,
  remoteMethodSpecSchema,
} from '../src/protocol.js';

const input = { type: 'array', prefixItems: [{ type: 'string' }], maxItems: 1 };
const output = { type: 'string' };

void test('a remote method keeps the desktop exposure of its document', () => {
  assert.equal(
    remoteMethodSpecFromSchema(input, output, 'desktop').expose,
    'desktop',
  );
});

void test('a remote method the document does not expose carries no exposure', () => {
  assert.equal('expose' in remoteMethodSpecFromSchema(input, output), false);
});

void test('the remote method schema admits only a known exposure', () => {
  const spec = { tuple: 1, local: false, stream: false };

  assert.ok(remoteMethodSpecSchema.safeParse(spec).success);
  assert.ok(
    remoteMethodSpecSchema.safeParse({ ...spec, expose: 'desktop' }).success,
  );
  assert.equal(
    remoteMethodSpecSchema.safeParse({ ...spec, expose: 'everyone' }).success,
    false,
  );
});
