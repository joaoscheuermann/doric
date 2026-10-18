import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveDistribution } from '../src/platform/catalog/resolve';
import { fixtureDistribution } from './support/distribution';

const part = 'export const activate = () => undefined;';

const { catalog } = fixtureDistribution({
  core: 'mincore',
  bundles: [
    { id: 'mincore', files: { 'desktop/index.js': part } },
    { id: 'probe-ok', files: { 'client/index.js': part } },
    // The host runs a newer platform; this desktop does not satisfy it.
    { id: 'probe-new', engines: '^2.0.0', files: { 'client/index.js': part } },
    {
      id: 'probe-host',
      state: 'quarantined',
      reasons: [{ code: 'activate_failed', message: 'boom on the host' }],
      files: { 'client/index.js': part },
    },
    { id: 'probe-off', state: 'disabled', files: { 'client/index.js': part } },
  ],
});

const stateOf = (
  environment: { entries: readonly { id: string; state: string }[] },
  id: string,
) => environment.entries.find((entry) => entry.id === id)?.state;

describe('desktop resolution of a host distribution', () => {
  test('an incompatible client part is quarantined without blocking the others', () => {
    const resolution = resolveDistribution(catalog, 1);
    const newer = resolution.client.entries.find(
      (entry) => entry.id === 'probe-new',
    );

    assert.equal(stateOf(resolution.client, 'probe-ok'), 'scheduled');
    assert.equal(stateOf(resolution.client, 'mincore'), 'scheduled');
    assert.equal(newer?.state, 'quarantined');
    assert.deepEqual(
      newer?.reasons.map((reason) => reason.code),
      ['engines_unsatisfied'],
    );
    assert.deepEqual(
      resolution.quarantines.map((quarantine) => quarantine.id),
      ['probe-new'],
    );
  });

  test('a host-side quarantine carries over with its reason and is not reported again', () => {
    const resolution = resolveDistribution(catalog, 1);
    const host = resolution.client.entries.find(
      (entry) => entry.id === 'probe-host',
    );

    assert.equal(host?.state, 'quarantined');
    assert.equal(host?.reasons[0]?.message, 'boom on the host');
    assert.ok(
      !resolution.quarantines.some(
        (quarantine) => quarantine.id === 'probe-host',
      ),
    );
  });

  test('a bundle the host disabled is not enabled on the desktop', () => {
    const resolution = resolveDistribution(catalog, 1);

    assert.ok(!resolution.client.composition.enabled.includes('probe-off'));
    assert.notEqual(stateOf(resolution.client, 'probe-off'), 'scheduled');
  });

  test('an artifact that failed verification quarantines its bundle with invalid_part', () => {
    const resolution = resolveDistribution(catalog, 1, [
      {
        bundleId: 'probe-ok',
        path: 'client/index.js',
        reason: 'hash_mismatch',
        message: 'artifact hash mismatch: client/index.js',
      },
    ]);
    const entry = resolution.client.entries.find(
      (candidate) => candidate.id === 'probe-ok',
    );

    assert.equal(entry?.state, 'quarantined');
    assert.deepEqual(entry?.reasons, [
      {
        code: 'invalid_part',
        message: 'artifact hash mismatch: client/index.js',
      },
    ]);
    assert.ok(
      resolution.quarantines.some((quarantine) => quarantine.id === 'probe-ok'),
    );
  });
});
