// The claude-login manifest once the bundle carries the client part of the
// sign-in (bundle isolation 6(a), O10): a minor, 1.1.0, that defines its
// element through `ui/v1` and adds its item through `regions/v1`, and asks for
// the desktop app of platform 1.7.0 or later (`desktop/ui/error-notice`).
// What it provides and requires of the host stays as it was. The patch 1.1.1
// (6(a) follow-up, OD48) tells a sign-in that finishes after its element is
// gone apart from a success.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Manifest {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly desktopScope?: Readonly<Record<string, readonly string[]>>;
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(
    await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../manifest.json'),
      'utf8',
    ),
  ) as Manifest;

test('claude-login ships its client part as 1.1.0, then the patch 1.1.1, and asks for platform ^1.7.0', async () => {
  const { version, engines } = await manifest();

  assert.equal(version, '1.1.1');
  assert.equal(engines.doric, '^1.7.0');
});

test('claude-login requires ui/v1 and regions/v1 beside secrets/v1, and still provides claude.login/v1@1.0.0', async () => {
  const { provides, requires, desktopScope } = await manifest();

  assert.deepEqual([...requires].sort(), [
    'regions/v1@^1.0.0',
    'secrets/v1@^1.0.0',
    'ui/v1@^1.0.0',
  ]);
  assert.deepEqual(provides, ['claude.login/v1@1.0.0']);
  assert.deepEqual(desktopScope, {
    'claude.login/v1': ['projectId', 'threadId', 'promptId'],
  });
});
