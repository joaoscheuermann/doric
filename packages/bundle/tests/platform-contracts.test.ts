// Stage-8 platform contracts (section 9): doric.notifications/v1,
// doric.windows/v1.lastPath, the host distribution members of
// doric.catalog/v1 and the environments widened by [S8-7].

import assert from 'node:assert/strict';
import test from 'node:test';

import { DoricNotificationsV1 } from '../src/contracts/index.js';
import { platformContracts } from '../src/contracts/platform.js';
import { platformSchemaDocuments } from '../src/index.js';

void test('doric.notifications/v1 is a desktopMain contract only (WP-10N), taking exactly a title and a body', () => {
  const spec = platformContracts['doric.notifications/v1'];

  assert.equal(DoricNotificationsV1.id, 'doric.notifications/v1');
  assert.deepEqual(spec.environments, ['desktopMain']);
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'Done', body: 'ok' }).success,
    true,
  );
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'Done' }).success,
    false,
  );
  assert.equal(
    spec.methods.show.input.safeParse({ title: 'a', body: 'b', icon: 'x' })
      .success,
    false,
  );
});

void test('doric.windows/v1 lastPath answers a path or null for a key', () => {
  const { lastPath } = platformContracts['doric.windows/v1'].methods;

  assert.equal(lastPath.input.safeParse('workspace').success, true);
  assert.equal(lastPath.output.safeParse('/settings').success, true);
  assert.equal(lastPath.output.safeParse(null).success, true);
  assert.equal(lastPath.output.safeParse(undefined).success, false);
});

void test('catalog and diagnostics exist in every environment', () => {
  for (const id of ['doric.catalog/v1', 'doric.diagnostics/v1'] as const) {
    assert.deepEqual(platformContracts[id].environments, [
      'host',
      'desktopMain',
      'client',
    ]);
  }
});

void test('catalog artifact takes a lowercase SHA-256 only', () => {
  const { artifact } = platformContracts['doric.catalog/v1'].methods;

  assert.equal(
    artifact.input.safeParse({ sha256: 'a'.repeat(64) }).success,
    true,
  );
  assert.equal(
    artifact.input.safeParse({ sha256: 'A'.repeat(64) }).success,
    false,
  );
  assert.equal(artifact.input.safeParse({ sha256: 'abc' }).success, false);
});

void test('the platform schema documents include the new contract members', () => {
  const documents = platformSchemaDocuments();
  const notifications = documents.get('contracts/doric.notifications/v1.json');
  const windows = documents.get('contracts/doric.windows/v1.json');
  const catalog = documents.get('contracts/doric.catalog/v1.json');

  assert.ok(notifications !== undefined);
  assert.deepEqual(Object.keys(notifications.$defs as object).sort(), [
    'show.input',
    'show.output',
  ]);
  assert.ok(Object.hasOwn(windows?.$defs as object, 'lastPath.output'));
  assert.ok(Object.hasOwn(catalog?.$defs as object, 'watch.input'));
});
