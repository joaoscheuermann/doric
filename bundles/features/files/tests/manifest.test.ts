// The files manifest's ranges for phase 4.4 (S15, S35; T-4.4.9 for files):
// the file tab carries a `menu` (A5), which only `layout.tabs/v1@1.2.0`
// accepts, so the bundle requires that minor; it provides `files/v1@1.2.0`
// at version 1.6.0 and keeps `engines.doric`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

type Manifest = {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
};

const manifest = JSON.parse(
  readFileSync('bundles/features/files/manifest.json', 'utf8'),
) as Manifest;

describe('the files manifest', () => {
  test('requires layout.tabs/v1@^1.2.0, for the file tab menu', () => {
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.tabs/v1@')),
      ['layout.tabs/v1@^1.2.0'],
    );
  });

  // Part 2i (S36): the panel no longer opens or closes; Reveal in Files only
  // selects the Files view, through `layout.panel/v2`.
  test('requires layout.panel/v2@^2.0.0 and no other layout.panel contract', () => {
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.panel/')),
      ['layout.panel/v2@^2.0.0'],
    );
  });

  test('provides files/v1@1.2.0 at version 1.6.0 and keeps engines.doric', () => {
    assert.equal(manifest.version, '1.6.0');
    assert.ok(manifest.provides.includes('files/v1@1.2.0'));
    assert.equal(manifest.engines.doric, '^1.0.0');
  });
});
