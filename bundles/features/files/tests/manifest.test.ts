// The files manifest's ranges (S15, S35; T-4.4.9 for files; bundle isolation
// 4(a) change 3): the file tab carries a `menu` (A5) and an `iconTag`, which
// `layout.tabs/v2@2.0.0` accepts, so the bundle requires it; Reveal in Files
// and the activation select the Files view through `layout.panel/v3`; it
// provides `files/v1@1.3.0` (the per-directory `directories` read the Files
// tree loads with) at version 1.7.4 (change 6: the Monaco rule in its sheet)
// and keeps `engines.doric`.

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
  test('requires layout.tabs/v2@^2.0.0 and no other layout.tabs contract', () => {
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.tabs/')),
      ['layout.tabs/v2@^2.0.0'],
    );
  });

  // Part 2i (S36): the panel no longer opens or closes; Reveal in Files only
  // selects the Files view, through `layout.panel/v3`.
  test('requires layout.panel/v3@^3.0.0 and no other layout.panel/* contract', () => {
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.panel/')),
      ['layout.panel/v3@^3.0.0'],
    );
  });

  test('provides files/v1@1.3.0 at version 1.7.7 and keeps engines.doric', () => {
    assert.equal(manifest.version, '1.7.7');
    assert.ok(manifest.provides.includes('files/v1@1.3.0'));
    assert.equal(manifest.engines.doric, '^1.0.0');
  });
});
