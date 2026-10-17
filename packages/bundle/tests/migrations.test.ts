// doric.migrations/v1: the one-time storage copy the desktop platform runs for
// a bundle. The caller names a storage key and a marker; the origins are not
// part of the contract, so no input can carry one.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DoricMigrationsV1 } from '../src/contracts/index.js';
import { platformContracts } from '../src/contracts/platform.js';

const storage = platformContracts['doric.migrations/v1'].methods.storage;

void test('doric.migrations/v1 is a desktopMain contract only', () => {
  assert.equal(DoricMigrationsV1.id, 'doric.migrations/v1');
  assert.deepEqual(platformContracts['doric.migrations/v1'].environments, [
    'desktopMain',
  ]);
});

void test('storage takes a key and a marker, for any example pair', () => {
  for (const request of [
    { key: 'example.note', marker: 'exampleMigration' },
    { key: 'doric.selection', marker: 'selectionOrigin' },
  ]) {
    assert.equal(storage.input.safeParse(request).success, true);
  }
});

void test('storage refuses any input that carries an origin, page or extra field', () => {
  for (const request of [
    { key: 'k', marker: 'm', origin: 'file:///tmp/x' },
    { key: 'k', marker: 'm', legacyPage: '/tmp/x.html' },
    { key: 'k', marker: 'm', blankPath: '/blank' },
    { key: 'k', marker: 'm', packaged: false },
  ]) {
    assert.equal(storage.input.safeParse(request).success, false);
  }
});

void test('storage refuses a key or marker outside its bounds', () => {
  const valid = (key: string, marker: string) =>
    storage.input.safeParse({ key, marker }).success;

  assert.equal(valid('', 'm'), false);
  assert.equal(valid('k', ''), false);
  assert.equal(valid('a'.repeat(128), 'm'), true);
  assert.equal(valid('a'.repeat(129), 'm'), false);
  assert.equal(valid('has space', 'm'), false);
  assert.equal(valid('k', '1marker'), false);
  assert.equal(valid('k', 'a'.repeat(64)), true);
  assert.equal(valid('k', 'a'.repeat(65)), false);
});

void test('storage answers one of the four migration results', () => {
  for (const result of ['migrated', 'none', 'skipped', 'failed']) {
    assert.equal(storage.output.safeParse(result).success, true);
  }

  assert.equal(storage.output.safeParse('copied').success, false);
});
