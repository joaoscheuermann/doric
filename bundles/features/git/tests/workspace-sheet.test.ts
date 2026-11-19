// Bundle isolation 4(c), AC4.9, plan 2.6: the navigation's classes moved to
// the `workspace` bundle with its files, so this bundle's sheet scans them
// (R18), and the bundle ships it as a patch, 1.2.10; 6(c) ships the next
// patch, 1.2.11.
// Step 4(d) moves the bundle to the workspace and runtime contracts, the
// next patch, 1.2.12. Step 5(c) change 2 observes `chat.hooks/v2`, the next
// patch, 1.2.13.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the git sheet scans the workspace client sources, at version 1.2.13', () => {
  const sheet = readFileSync(
    'bundles/features/git/src/client/styles.css',
    'utf8',
  );
  const manifest = JSON.parse(
    readFileSync('bundles/features/git/manifest.json', 'utf8'),
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
  assert.equal(manifest.version, '1.2.13');
});
