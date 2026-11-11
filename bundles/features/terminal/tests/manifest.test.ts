// The terminal manifest (G1, S15, T-4.4.9, T-1.10, T-2.11): terminal 1.1.3
// provides terminal/v1@1.2.0 and requires layout.tabs/v1@^1.2.0, the layout
// whose tabs take a `menu` and `retitle`, and still layout.sidebar/v1@^1.0.0:
// a 1.0.0 layout never asks `busy`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

void test('terminal 1.1.3 provides terminal/v1@1.2.0 and requires layout.tabs/v1@^1.2.0 and layout.sidebar/v1@^1.0.0', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/features/terminal/manifest.json', 'utf8'),
  ) as { version: string; provides: string[]; requires: string[] };

  assert.equal(manifest.version, '1.1.3');
  assert.deepEqual(manifest.provides, ['terminal/v1@1.2.0']);
  assert.deepEqual(
    manifest.requires.filter((range) => range.startsWith('layout.tabs/v1@')),
    ['layout.tabs/v1@^1.2.0'],
  );
  assert.deepEqual(
    manifest.requires.filter((range) => range.startsWith('layout.sidebar/v1@')),
    ['layout.sidebar/v1@^1.0.0'],
  );
});
