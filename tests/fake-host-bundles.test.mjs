// Regression: the fake host's stage-on-demand fallback must stage the same
// bundle set the host build's `build-bundles` command stages.

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveBundlesRoot } from '../scripts/fake-host/bundles.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'fake-host-bundles-'));

after(() => rmSync(root, { recursive: true, force: true }));

// `stageBundles` only parses `<dir>/dist/manifest.json` and copies `dist`, so a
// hand-written manifest is a built bundle as far as staging is concerned.
const writeBuiltBundle = (dir, id) => {
  const manifest = `${JSON.stringify(
    {
      manifestVersion: 1,
      id,
      version: '1.0.0',
      engines: { doric: '^1.0.0' },
      description: `Demo bundle ${id}.`,
      provides: [],
      requires: [],
    },
    null,
    2,
  )}\n`;
  const target = join(root, dir);
  mkdirSync(join(target, 'dist'), { recursive: true });
  writeFileSync(join(target, 'manifest.json'), manifest);
  writeFileSync(join(target, 'dist/manifest.json'), manifest);
};

test('stages every bundle under bundles/<group>/<id> when dist/bundles is absent', async () => {
  mkdirSync(join(root, 'app/backend/doric-host'), { recursive: true });
  cpSync(
    join(repo, 'app/backend/doric-host/project.json'),
    join(root, 'app/backend/doric-host/project.json'),
  );
  writeBuiltBundle('bundles/g1/a', 'a');
  writeBuiltBundle('bundles/g2/b', 'b');
  mkdirSync(join(root, 'bundles/g1/node_modules/some-dep'), {
    recursive: true,
  });

  const result = await resolveBundlesRoot({ root, log: { note() {} } });

  const expected = join(root, 'tmp/fake-host/bundles');
  assert.equal(result, expected);
  assert.deepEqual(readdirSync(expected).sort(), ['a', 'b']);
});
