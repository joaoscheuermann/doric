// The terminal manifest (G1, S15, T-4.4.9, T-1.10, T-2.11; bundle isolation
// 4(a) change 5; 4(b); 4(d)): terminal provides terminal/v1@1.2.0 and
// requires layout.tabs/v2@^2.0.0, whose tabs take an `iconTag`, a `menu` and
// `retitle`; the sidebar's Thread rows through workspace.sidebar/v1@^1.0.0,
// whose 1.0.0 asks `busy`; the selected ids through
// workspace.selection/v1@^1.0.0 and the Thread records through
// runtime.records/v1@^1.0.0. No line names the layout's transition contracts.
// Bundle isolation 5(b) change 4 ships 1.2.0: the bundle draws the `terminal`
// tool and the source `terminal` in the chat through `chat.views/v1` (listed
// under `optional`), on platform `^1.10.0`. Bundle isolation 7(c) ships the
// patch 1.2.1: its client copies of the runtime and workspace contracts
// become imports. grpc-processes S62c provides terminal/v1 at its .proto
// header version, 1.3.0, and requires runtime.lease/v1@^1.5.0, which its host
// process calls, and the host ranges the contracts' new versions meet.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Manifest = {
  readonly version: string;
  readonly engines: { readonly doric: string };
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly optional: readonly string[];
};

const manifest = JSON.parse(
  readFileSync('bundles/features/terminal/manifest.json', 'utf8'),
) as Manifest;

void test('terminal 1.2.1 on platform ^1.10.0 provides terminal/v1@1.3.0 and requires layout.tabs/v2@^2.0.0, workspace.sidebar/v1@^1.0.0, workspace.selection/v1@^1.0.0 and runtime.records/v1@^1.0.0', () => {
  assert.equal(manifest.version, '1.2.1');
  assert.equal(manifest.engines.doric, '^1.10.0');
  assert.deepEqual(manifest.provides, ['terminal/v1@1.3.0']);
  assert.deepEqual(
    manifest.requires.filter((range) => range.startsWith('layout.tabs/')),
    ['layout.tabs/v2@^2.0.0'],
  );
  for (const range of [
    'workspace.sidebar/v1@^1.0.0',
    'workspace.selection/v1@^1.0.0',
    'runtime.records/v1@^1.0.0',
  ]) {
    assert.ok(manifest.requires.includes(range), `${range} is not required`);
  }
  assert.deepEqual(
    manifest.requires.filter(
      (range) =>
        range.startsWith('layout.sidebar/') ||
        range.startsWith('layout.workspace/'),
    ),
    [],
  );
});

// The registrations need the contract when it is there and nothing when it
// is not; an `optional` line carries no range.
void test('terminal takes chat.views/v1 as optional beside files.refresh/v1 and keeps requiring ui/v1', () => {
  assert.deepEqual([...manifest.optional].sort(), [
    'chat.views/v1',
    'files.refresh/v1',
  ]);
  assert.ok(manifest.requires.includes('ui/v1@^1.0.0'));
  assert.deepEqual(
    manifest.requires.filter((ref) => ref.startsWith('chat.')),
    [],
  );
});

void test('terminal requires runtime.lease/v1@^1.5.0 and the host ranges tools/v1@^1.5.0, secrets/v1@^1.3.0, hooks/v1@^1.1.0 and runtime.workspace/v1@^1.3.0', () => {
  for (const range of [
    'runtime.lease/v1@^1.5.0',
    'tools/v1@^1.5.0',
    'secrets/v1@^1.3.0',
    'hooks/v1@^1.1.0',
    'runtime.workspace/v1@^1.3.0',
  ]) {
    assert.ok(manifest.requires.includes(range), `${range} is not required`);
  }
});
