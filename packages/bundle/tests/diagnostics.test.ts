// The diagnostics follow a publish (`DiagnosticsStore.adopt`; s62c Q9,
// groupE S63a §2.1): the bundles a publish adds are listed, those it removes
// are not, its disables and re-enables are recorded, and the states the
// supervisor recorded for a bundle the publish did not change are kept.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DiagnosticsStore,
  type ResolvedEnvironment,
} from '../src/runtime/index.js';
import { type FixtureBundle, resolveHost } from './support/scripted-host.js';

const alive: FixtureBundle = { mode: 'alive' };

/** `resolveHost(bundles, options)` as the generation `generation`. */
const resolution = (
  generation: number,
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: { readonly disabled?: readonly string[] } = {},
): ResolvedEnvironment => ({
  ...resolveHost(bundles, options),
  generation,
});

/** The diagnostics as the platform loads them at boot. */
const loaded = (resolved: ResolvedEnvironment): DiagnosticsStore => {
  const store = new DiagnosticsStore({ generation: resolved.generation });

  store.load(resolved);

  return store;
};

const idsOf = (store: DiagnosticsStore): string[] =>
  store.snapshot().bundles.map(({ id }) => id);

const bundleOf = (store: DiagnosticsStore, id: string) => {
  const bundle = store.snapshot().bundles.find((entry) => entry.id === id);

  assert.ok(bundle !== undefined, `the snapshot has no bundle ${id}`);

  return bundle;
};

describe('DiagnosticsStore.adopt', () => {
  test('a bundle the publish adds is listed inactive', () => {
    const store = loaded(resolution(1, { alpha: alive }));

    store.adopt(resolution(2, { alpha: alive, beta: alive }));

    assert.equal(store.state('beta'), 'inactive');
    assert.equal(bundleOf(store, 'beta').state, 'inactive');
    assert.deepEqual(bundleOf(store, 'beta').reasons, []);
  });

  test('a bundle the publish removes leaves the snapshot', () => {
    const store = loaded(resolution(1, { alpha: alive, beta: alive }));

    store.setState('beta', 'active');
    store.adopt(resolution(2, { alpha: alive }));

    assert.ok(!idsOf(store).includes('beta'), `listed: ${idsOf(store)}`);
    assert.equal(store.state('beta'), undefined);
  });

  test('a bundle the publish disables is disabled; scheduled again, it is inactive', () => {
    const store = loaded(resolution(1, { alpha: alive }));

    store.setState('alpha', 'active');
    store.adopt(resolution(2, { alpha: alive }, { disabled: ['alpha'] }));

    assert.equal(store.state('alpha'), 'disabled');
    assert.equal(bundleOf(store, 'alpha').state, 'disabled');

    store.adopt(resolution(3, { alpha: alive }));

    assert.equal(store.state('alpha'), 'inactive');
    assert.equal(bundleOf(store, 'alpha').state, 'inactive');
  });

  test('an unchanged bundle the supervisor quarantined (process_failed) stays quarantined; an active one stays active', () => {
    const store = loaded(resolution(1, { alpha: alive, beta: alive }));
    const reason = {
      code: 'process_failed',
      message: 'fixture alpha failed',
    } as const;

    store.setState('beta', 'active');
    store.quarantine('alpha', reason);
    store.adopt(resolution(2, { alpha: alive, beta: alive }));

    assert.equal(store.state('alpha'), 'quarantined');
    assert.deepEqual(bundleOf(store, 'alpha').reasons, [reason]);
    assert.equal(store.state('beta'), 'active');
  });

  test('after two adopts the snapshot has one record per id, in the resolution order', () => {
    const store = loaded(resolution(1, { alpha: alive }));
    const next = resolution(2, { alpha: alive, beta: alive });

    store.adopt(next);
    store.adopt(next);

    assert.deepEqual(
      idsOf(store),
      next.entries.map(({ id }) => id),
    );
  });
});
