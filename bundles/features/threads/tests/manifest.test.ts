// `threads`' manifest (moved unchanged from the kernel suite `threads.test.ts`
// when S68a deleted it; the case reads `manifest.json` only).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Bundle isolation 5(b), change 3: threads 2.1.0 draws `thread-spawn` calls
// through `chat.views/v1` (under `optional`), on platform `^1.10.0`. S62d3
// registers its skills through `skills/v1@^1.3.0`, the minor 2.2.0.
void test('the manifest is 2.2.0 on platform ^1.10.0 and declares no provided contract', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'),
  ) as {
    readonly version: string;
    readonly engines: { readonly doric: string };
    readonly provides?: readonly string[];
    readonly requires: readonly string[];
    readonly optional?: readonly string[];
    readonly desktopScope?: Record<string, unknown>;
  };

  assert.equal(manifest.version, '2.2.0');
  assert.equal(manifest.engines.doric, '^1.10.0');
  assert.ok(
    (manifest.optional ?? []).includes('chat.views/v1'),
    (manifest.optional ?? []).join(', '),
  );
  assert.deepEqual(
    manifest.requires.filter((ref) => ref.startsWith('chat.')),
    [],
  );
  assert.ok(manifest.requires.includes('ui/v1@^1.0.0'));
  assert.deepEqual(manifest.provides ?? [], []);
  assert.equal(
    JSON.stringify(manifest).includes('threads.ask/v1'),
    false,
    'no manifest entry names threads.ask/v1',
  );
});
