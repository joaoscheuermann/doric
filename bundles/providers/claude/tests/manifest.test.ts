// The claude manifest once the kind descriptor carries the optional `site`
// (bundle isolation 6(b)): the minor 1.2.0, providing models.provider/v1@1.3.0,
// still asking for platform ^1.0.0 (AC6.3: no range rises).

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

void test('claude ships as 1.2.0, provides models.provider/v1@1.3.0 and asks for platform ^1.0.0', async () => {
  const { version, provides, engines } = await manifest();

  assert.equal(version, '1.2.0');
  assert.deepEqual(provides, ['models.provider/v1@1.3.0']);
  assert.equal(engines.doric, '^1.0.0');
});
