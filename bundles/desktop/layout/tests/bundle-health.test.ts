// T-32: the window's quarantine notice (spec §7.2) is plain data built only
// from the bundle catalog snapshot: one notice for every bundle the snapshot
// lists as quarantined, in its order, titled by their count, with one
// context line per bundle; none when no bundle is quarantined.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  BundleState,
  CatalogBundle,
  CatalogSnapshot,
  QuarantineReason,
} from 'bundle/contracts';

import { quarantineNotice } from '../src/client/domain/bundle-health.js';

const bundle = (
  id: string,
  version: string,
  state: BundleState,
  reasons: readonly QuarantineReason[] = [],
): CatalogBundle => ({ id, version, state, reasons });

const snapshot = (bundles: readonly CatalogBundle[]): CatalogSnapshot => ({
  generation: 1,
  composition: {
    core: 'core',
    enabled: bundles.map(({ id }) => id),
    providers: {},
  },
  bundles,
  order: bundles.map(({ id }) => id),
  contracts: [],
});

/** The loader's `incompatible_version` reason, which names its contract. */
const incompatible: QuarantineReason = {
  code: 'incompatible_version',
  message: 'requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0)',
  contract: 'runtime.threads/v1',
};

/** A reason with no contract. */
const activateFailed: QuarantineReason = {
  code: 'activate_failed',
  message: 'activate() threw: boom',
};

const files = bundle('files', '1.4.0', 'quarantined', [incompatible]);
const terminal = bundle('terminal', '2.0.1', 'quarantined', [
  activateFailed,
  incompatible,
]);
const git = bundle('git', '0.3.0', 'quarantined');

describe('the quarantine notice (T-32)', () => {
  test('a snapshot with no quarantined bundle gives no notice', () => {
    assert.equal(quarantineNotice(snapshot([])), undefined);
    assert.equal(
      quarantineNotice(
        snapshot([
          bundle('chat', '1.0.0', 'active'),
          bundle('usage', '1.0.0', 'disabled'),
          bundle('screen', '1.0.0', 'inactive'),
        ]),
      ),
      undefined,
    );
  });

  test('one quarantined bundle: the singular title, its id and its reasons', () => {
    const notice = quarantineNotice(
      snapshot([bundle('chat', '1.0.0', 'active'), files]),
    );
    assert.ok(notice !== undefined);
    assert.deepEqual(notice.catalog, {
      bundle_quarantined: {
        title: "1 extension couldn't start",
        retryable: false,
        tone: 'warning',
      },
    });
    assert.equal(notice.error.code, 'bundle_quarantined');
    assert.equal(notice.error.message, 'Turned off: files.');
    assert.deepEqual(notice.error.causes, []);
    assert.equal('at' in notice.error, false, 'The notice states a time.');
    assert.deepEqual(notice.context, {
      'files@1.4.0':
        'requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0) (runtime.threads/v1)',
    });
  });

  test('two and three bundles: the counted title, the ids and one context line each, in the snapshot order', () => {
    const two = quarantineNotice(snapshot([files, terminal]));
    assert.ok(two !== undefined);
    assert.equal(
      two.catalog.bundle_quarantined?.title,
      "2 extensions couldn't start",
    );
    assert.equal(two.error.message, 'Turned off: files, terminal.');

    const three = quarantineNotice(snapshot([terminal, git, files]));
    assert.ok(three !== undefined);
    assert.equal(
      three.catalog.bundle_quarantined?.title,
      "3 extensions couldn't start",
    );
    assert.equal(three.error.message, 'Turned off: terminal, git, files.');
    assert.deepEqual(three.error.causes, []);
    assert.equal('at' in three.error, false, 'The notice states a time.');
    assert.deepEqual(Object.entries(three.context), [
      [
        'terminal@2.0.1',
        'activate() threw: boom; requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0) (runtime.threads/v1)',
      ],
      ['git@0.3.0', 'no reason given'],
      [
        'files@1.4.0',
        'requires runtime.threads/v1@^1.8.0; active 1.7.0 (runtime 2.7.0) (runtime.threads/v1)',
      ],
    ]);
    // The catalog holds the one counted entry, and nothing else.
    assert.deepEqual(Object.keys(three.catalog), ['bundle_quarantined']);
    assert.equal(three.catalog.bundle_quarantined?.retryable, false);
    assert.equal(three.catalog.bundle_quarantined?.tone, 'warning');
  });

  test('a disabled bundle is not listed beside a quarantined one', () => {
    const notice = quarantineNotice(
      snapshot([bundle('usage', '1.0.0', 'disabled', [activateFailed]), git]),
    );
    assert.ok(notice !== undefined);
    assert.equal(
      notice.catalog.bundle_quarantined?.title,
      "1 extension couldn't start",
    );
    assert.equal(notice.error.message, 'Turned off: git.');
    assert.deepEqual(notice.context, { 'git@0.3.0': 'no reason given' });
  });

  test('is plain JSON and leaves the snapshot as it was', () => {
    const input = snapshot([files, git]);
    const before = JSON.stringify(input);
    const notice = quarantineNotice(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(JSON.parse(JSON.stringify(notice)), notice);
    assert.deepEqual(quarantineNotice(input), notice);
  });
});
