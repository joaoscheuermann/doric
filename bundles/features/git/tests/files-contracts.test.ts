// Bundle isolation 9 (D32, AC9.2): `files` publishes `files/contracts`, so git
// takes the `files.*` contracts it uses from it instead of keeping copies, and
// the edge of the cycle test runs git → files only. git imports values of
// `files/contracts` at run time, so `files` is a dependency, not a dev one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string): string =>
  readFileSync(`bundles/features/git/${path}`, 'utf8');

test('git keeps no copy of the files contracts it uses', () => {
  const peers = read('src/client/api/peers.ts');
  for (const name of [
    'FilesSandbox',
    'FilesRefresh',
    'ProjectReads',
    'TreeObservation',
  ]) {
    assert.doesNotMatch(
      peers,
      new RegExp(`\\binterface\\s+${name}\\b`),
      `peers.ts still declares interface ${name}.`,
    );
  }
});

test('git lists files as a dependency, and not as a dev dependency', () => {
  const manifest = JSON.parse(read('package.json')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  assert.equal(manifest.dependencies?.files, '0.0.1');
  assert.equal(manifest.devDependencies?.files, undefined);
});
