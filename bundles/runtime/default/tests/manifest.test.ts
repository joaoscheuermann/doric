// The default manifest (bundle isolation 5(b), change 2): the bundle gains a
// client part that draws `load_skill` calls in the chat through
// `chat.views/v1` (listed under `optional`), defined through `ui/v1`, on
// platform `^1.10.0` — the minor 2.7.0. What it provided and required before
// stays.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

type Manifest = {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly optional: readonly string[];
};

const manifest = JSON.parse(
  readFileSync('bundles/runtime/default/manifest.json', 'utf8'),
) as Manifest;

describe('the default manifest', () => {
  test('is version 2.7.0 on platform ^1.10.0', () => {
    assert.equal(manifest.version, '2.7.0');
    assert.equal(manifest.engines.doric, '^1.10.0');
  });

  test('requires ui/v1@^1.0.0 for its element', () => {
    assert.ok(
      manifest.requires.includes('ui/v1@^1.0.0'),
      manifest.requires.join(', '),
    );
  });

  // The registration needs the contract when it is there and nothing when it
  // is not; an `optional` line carries no range.
  test('takes chat.views/v1 as optional and requires no chat contract', () => {
    assert.ok(
      manifest.optional.includes('chat.views/v1'),
      manifest.optional.join(', '),
    );
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('chat.')),
      [],
    );
  });

  test('keeps what it provided, required and took as optional', () => {
    assert.deepEqual(manifest.provides, [
      'executor/v1@1.5.0',
      'default.hooks/v1@1.0.0',
      'default.agents/v1@1.0.0',
    ]);
    for (const ref of [
      'tools/v1@^1.0.0',
      'skills/v1@^1.0.0',
      'models/v1@^1.2.0',
      'host-config/v1@^1.1.0',
      'hooks/v1@^1.0.0',
      'log/v1@^1.0.0',
    ])
      assert.ok(manifest.requires.includes(ref), ref);
    for (const ref of ['runtime.lease/v1', 'runtime.workspace/v1', 'mcp/v1'])
      assert.ok(manifest.optional.includes(ref), ref);
  });
});
