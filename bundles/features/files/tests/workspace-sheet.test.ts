// Bundle isolation 4(c), AC4.9, plan 2.6: the navigation's classes moved to
// the `workspace` bundle with its files, so this bundle's sheet scans them
// (R18), and the bundle ships it as a patch, 1.7.7.
// Step 4(d) moves the bundle to the workspace and runtime contracts, the
// next patch, 1.7.8. Step 5(b) adds the edit element, the minor 1.8.0.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the files sheet scans the workspace client sources, at version 1.8.0', () => {
  const sheet = readFileSync(
    'bundles/features/files/src/client/styles.css',
    'utf8',
  );
  const manifest = JSON.parse(
    readFileSync('bundles/features/files/manifest.json', 'utf8'),
  ) as { version: string };

  assert.equal(
    sheet
      .split('\n')
      .filter(
        (line) =>
          line.trim() === "@source '../../../../desktop/workspace/src/client';",
      ).length,
    1,
    'The sheet does not scan the workspace client sources once.',
  );
  assert.equal(manifest.version, '1.8.0');
});
