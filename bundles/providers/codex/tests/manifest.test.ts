// The codex manifest once the kind descriptor carries the optional `site`
// (bundle isolation 6(b)): the minor 1.2.0, still asking for platform ^1.0.0
// (AC6.3: no range rises). Since grpc-processes S62c it provides
// models.provider/v1 at its .proto header version, 1.4.0, and lists the
// contracts its host process calls: runtime.attachments/v1 and, as every host
// part, secrets/v1 (log/v1 it requires).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly optional?: readonly string[];
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(
    await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../manifest.json'),
      'utf8',
    ),
  ) as Manifest;

void test('codex ships as 1.2.0, provides models.provider/v1@1.4.0 and asks for platform ^1.0.0', async () => {
  const { version, provides, engines } = await manifest();

  assert.equal(version, '1.2.0');
  assert.deepEqual(provides, ['models.provider/v1@1.4.0']);
  assert.equal(engines.doric, '^1.0.0');
});

void test('codex lists runtime.attachments/v1 and secrets/v1 as optional', async () => {
  const { optional = [] } = await manifest();

  for (const id of ['runtime.attachments/v1', 'secrets/v1']) {
    assert.ok(optional.includes(id), id);
  }
});
