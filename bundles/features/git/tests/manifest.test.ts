// The git manifest (ui-redesign S15, S35; T-4.4.9 for git): the diff tab's
// `menu` (A6) needs `layout.tabs/v1@1.2.0`, so the bundle requires it; it
// provides `git.commands/v1@1.1.0` (`discard`) at version 1.2.3 (G1; the
// sidebar alignment's patches, T-1.10, T-4.7 and T-5.7).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('the git manifest', () => {
  test('requires layout.tabs/v1@^1.2.0 and provides git.commands/v1@1.1.0', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { version: string; provides: string[]; requires: string[] };

    assert.equal(manifest.version, '1.2.3');
    assert.ok(manifest.provides.includes('git.commands/v1@1.1.0'));
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.tabs/')),
      ['layout.tabs/v1@^1.2.0'],
    );
  });

  // Part 2i (S36): git uses no layout.panel contract.
  test('requires no layout.panel contract', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { requires: string[] };

    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.panel/')),
      [],
    );
  });
});
