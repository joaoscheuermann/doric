// Desktop exposure (HR-10): a method is reachable from a window only when its
// provider declares it, the platform specification decides for the contracts
// it publishes, and the contract document carries the declaration to the
// boundaries. Malformed declarations are refused, never widened.

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { checkRecording } from '../src/build/record.js';
import { isMethodExposure, methodExposures } from '../src/contracts/expose.js';
import { defineMethod, defineService } from '../src/contracts/index.js';
import {
  documentExposure,
  documentExposureKey,
  exposureOf,
  isDesktopExposed,
  misdeclaredExposure,
} from '../src/runtime/exposure.js';
import {
  contractDocument,
  type RecordedContract,
} from '../src/runtime/json-schema.js';
import { manifestV1Schema } from '../src/runtime/manifest.js';

const noInput = z.tuple([]);

const probe = defineMethod({
  input: noInput,
  output: z.string(),
  expose: 'desktop',
  execute: () => 'ok',
});

void test('defineMethod records the exposure, and absent means no exposure', () => {
  assert.equal(probe.expose, 'desktop');
  assert.equal(
    defineMethod({
      input: noInput,
      output: z.string(),
      execute: () => 'ok',
    }).expose,
    undefined,
  );
});

void test('an exposure outside the known targets is refused at definition', () => {
  assert.deepEqual(methodExposures, ['desktop']);
  assert.ok(isMethodExposure('desktop'));
  assert.ok(!isMethodExposure('everyone'));
  assert.throws(
    () =>
      defineMethod({
        input: noInput,
        output: z.string(),
        expose: 'everyone' as 'desktop',
        execute: () => 'ok',
      }),
    TypeError,
  );
});

void test('a bundle contract is exposed exactly by its provider declaration', () => {
  const declared = { expose: 'desktop' as const };

  assert.equal(exposureOf('acme.notes/v1', 'list', declared), 'desktop');
  assert.equal(exposureOf('acme.notes/v1', 'write', {}), undefined);
  assert.ok(isDesktopExposed('acme.notes/v1', 'list', declared));
  assert.ok(!isDesktopExposed('acme.notes/v1', 'write', {}));
  assert.ok(!isDesktopExposed('acme.notes/v1', 'list', undefined));
});

void test('a published contract takes its exposure from the platform specification', () => {
  // tools/v1.catalog is exposed by the platform specification; a provider that
  // does not declare it is still exposed, and secrets/v1.resolve is not.
  assert.equal(exposureOf('tools/v1', 'catalog', undefined), 'desktop');
  assert.ok(isDesktopExposed('tools/v1', 'catalog', {}));
  assert.equal(
    exposureOf('secrets/v1', 'resolve', { expose: 'desktop' }),
    undefined,
  );
  assert.equal(exposureOf('log/v1', 'write', { expose: 'desktop' }), undefined);
  assert.equal(
    exposureOf('doric.generation/v1', 'describe', { expose: 'desktop' }),
    undefined,
  );
});

void test('a provider may not declare an exposure its platform specification does not give', () => {
  assert.equal(
    misdeclaredExposure('secrets/v1', { resolve: { expose: 'desktop' } }),
    'resolve',
  );
  assert.equal(
    misdeclaredExposure('log/v1', { write: { expose: 'desktop' } }),
    'write',
  );
  assert.equal(
    misdeclaredExposure('doric.generation/v1', { hold: { expose: 'desktop' } }),
    'hold',
  );
  // Matching the specification, or not declaring at all, is accepted.
  assert.equal(
    misdeclaredExposure('tools/v1', { catalog: { expose: 'desktop' } }),
    undefined,
  );
  assert.equal(misdeclaredExposure('tools/v1', { catalog: {} }), undefined);
  assert.equal(
    misdeclaredExposure('acme.notes/v1', { write: { expose: 'desktop' } }),
    undefined,
  );
});

void test('the build refuses a recorded misdeclaration of a platform contract', () => {
  const manifest = manifestV1Schema.parse({
    manifestVersion: 1,
    id: 'acme',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides: ['log/v1@1.0.0'],
  });
  const recorded: RecordedContract = {
    id: 'log/v1',
    environment: 'host',
    cardinality: 'one',
    kind: 'service',
    methods: {
      write: defineMethod({
        input: noInput,
        output: z.void(),
        expose: 'desktop',
        execute: () => undefined,
      }),
    },
  };

  assert.deepEqual(checkRecording(manifest, [recorded]), [
    'log/v1 write may not be exposed to the desktop: the platform specification decides.',
  ]);
});

void test('the contract document carries the exposed methods only', () => {
  const contract = defineService('acme.notes/v1', {
    list: probe,
    write: defineMethod({
      input: noInput,
      output: z.void(),
      execute: () => undefined,
    }),
  });
  const { document } = contractDocument({
    id: 'acme.notes/v1',
    environment: 'host',
    cardinality: 'one',
    kind: 'service',
    methods: contract.methods,
  });

  assert.deepEqual(document[documentExposureKey], { list: 'desktop' });
  assert.deepEqual(documentExposure(document), { list: 'desktop' });
});

void test('a contract with no exposed method publishes no exposure key', () => {
  const { document } = contractDocument({
    id: 'acme.quiet/v1',
    environment: 'host',
    cardinality: 'one',
    kind: 'service',
    methods: {
      write: defineMethod({
        input: noInput,
        output: z.void(),
        execute: () => undefined,
      }),
    },
  });

  assert.equal(documentExposureKey in document, false);
  assert.deepEqual(documentExposure(document), {});
});

void test('a malformed exposure in a document is refused, never widened', () => {
  const defs = {
    'list.input': { type: 'array', maxItems: 0 },
    'list.output': {},
  };

  assert.throws(
    () => documentExposure({ $defs: defs, [documentExposureKey]: 'list' }),
    TypeError,
  );
  assert.throws(
    () =>
      documentExposure({
        $defs: defs,
        [documentExposureKey]: { ghost: 'desktop' },
      }),
    /"ghost", which is no method/,
  );
  assert.throws(
    () =>
      documentExposure({
        $defs: defs,
        [documentExposureKey]: { list: 'everyone' },
      }),
    /not a known exposure/,
  );
});

const manifest = (desktopScope: unknown, provides = ['acme.notes/v1@1.0.0']) =>
  manifestV1Schema.safeParse({
    manifestVersion: 1,
    id: 'acme',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides,
    desktopScope,
  });

void test('a provider declares scope keys for the contracts it provides', () => {
  const declared = manifest({
    'acme.notes/v1': ['projectId', 'tenantSlug'],
  });

  assert.ok(declared.success);
  assert.deepEqual(declared.data?.desktopScope, {
    'acme.notes/v1': ['projectId', 'tenantSlug'],
  });
});

void test('a provider may not declare scope keys for a contract it does not provide', () => {
  assert.equal(manifest({ 'other.notes/v1': ['projectId'] }).success, false);
});

void test('the platform window key is never declared, in any case', () => {
  for (const key of ['windowKey', 'windowkey', 'WindowKey', 'WINDOWKEY']) {
    assert.equal(manifest({ 'acme.notes/v1': [key] }).success, false, key);
  }
});

void test('a declared scope key must match the scope key pattern and stay unique', () => {
  assert.equal(manifest({ 'acme.notes/v1': ['1abc'] }).success, false);
  assert.equal(manifest({ 'acme.notes/v1': ['a b'] }).success, false);
  assert.equal(
    manifest({ 'acme.notes/v1': ['projectId', 'projectId'] }).success,
    false,
  );
});

void test('a provider declares at most the bounded number of scope keys', () => {
  const keys = Array.from({ length: 16 }, (_, index) => `key${index}`);

  assert.ok(manifest({ 'acme.notes/v1': keys }).success);
  assert.equal(
    manifest({ 'acme.notes/v1': [...keys, 'extra'] }).success,
    false,
  );
});
