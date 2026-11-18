// The terminal manifest (G1, S15, T-4.4.9, T-1.10, T-2.11; bundle isolation
// 4(a) change 5; 4(b); 4(d)): terminal 1.1.9 provides terminal/v1@1.2.0 and
// requires layout.tabs/v2@^2.0.0, whose tabs take an `iconTag`, a `menu` and
// `retitle`; the sidebar's Thread rows through workspace.sidebar/v1@^1.0.0,
// whose 1.0.0 asks `busy`; the selected ids through
// workspace.selection/v1@^1.0.0 and the Thread records through
// runtime.records/v1@^1.0.0. No line names the layout's transition contracts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

void test('terminal 1.1.9 provides terminal/v1@1.2.0 and requires layout.tabs/v2@^2.0.0, workspace.sidebar/v1@^1.0.0, workspace.selection/v1@^1.0.0 and runtime.records/v1@^1.0.0', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/features/terminal/manifest.json', 'utf8'),
  ) as { version: string; provides: string[]; requires: string[] };

  assert.equal(manifest.version, '1.1.9');
  assert.deepEqual(manifest.provides, ['terminal/v1@1.2.0']);
  assert.deepEqual(
    manifest.requires.filter((range) => range.startsWith('layout.tabs/')),
    ['layout.tabs/v2@^2.0.0'],
  );
  for (const range of [
    'workspace.sidebar/v1@^1.0.0',
    'workspace.selection/v1@^1.0.0',
    'runtime.records/v1@^1.0.0',
  ]) {
    assert.ok(manifest.requires.includes(range), `${range} is not required`);
  }
  assert.deepEqual(
    manifest.requires.filter(
      (range) =>
        range.startsWith('layout.sidebar/') ||
        range.startsWith('layout.workspace/'),
    ),
    [],
  );
});
