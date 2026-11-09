// The terminal manifest (G1, S15, T-4.4.9): terminal 1.1.0 provides
// terminal/v1@1.2.0 and requires layout.tabs/v1@^1.2.0, the layout whose tabs
// take a `menu` and `retitle`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

void test('terminal 1.1.0 provides terminal/v1@1.2.0 and requires layout.tabs/v1@^1.2.0', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/features/terminal/manifest.json', 'utf8'),
  ) as { version: string; provides: string[]; requires: string[] };

  assert.equal(manifest.version, '1.1.0');
  assert.deepEqual(manifest.provides, ['terminal/v1@1.2.0']);
  assert.deepEqual(
    manifest.requires.filter((range) => range.startsWith('layout.tabs/v1@')),
    ['layout.tabs/v1@^1.2.0'],
  );
});
