// The core manifest once the kind descriptor carries the optional `site`
// (bundle isolation 6(b)): the minor 1.16.0, providing models/v1@1.4.0, still
// asking for platform ^1.0.0 (AC6.3: no range rises).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(
    await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../manifest.json'),
      'utf8',
    ),
  ) as Manifest;

void test('core ships as 1.16.0, provides models/v1@1.4.0 and asks for platform ^1.0.0', async () => {
  const { version, provides, engines } = await manifest();

  assert.equal(version, '1.16.0');
  assert.deepEqual(
    provides.filter((entry) => entry.startsWith('models/v1@')),
    ['models/v1@1.4.0'],
  );
  assert.equal(engines.doric, '^1.0.0');
});
