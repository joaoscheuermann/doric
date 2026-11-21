// The workspace manifest (bundle isolation 4(e), AC4.12, O5): workspace
// 1.0.0 provides the four `workspace.*` contracts and nothing of the layout's
// namespace; of the layout it requires `layout.tabs/v2` only, and nothing
// is optional.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

type Manifest = {
  version: string;
  provides: string[];
  requires: string[];
  optional?: string[];
};

const manifest = (): Manifest =>
  JSON.parse(
    readFileSync('bundles/desktop/workspace/manifest.json', 'utf8'),
  ) as Manifest;

describe('the workspace manifest (bundle isolation AC4.12)', () => {
  test('is at version 1.0.0', () => {
    assert.equal(manifest().version, '1.0.0');
  });

  test('provides exactly workspace.selection/v1, workspace.hooks/v1, workspace.sidebar/v1 and workspace.dashboard/v1', () => {
    assert.deepEqual([...manifest().provides].sort(), [
      'workspace.dashboard/v1@1.0.0',
      'workspace.hooks/v1@1.0.0',
      'workspace.selection/v1@1.0.0',
      'workspace.sidebar/v1@1.0.0',
    ]);
  });

  test('requires exactly the host contracts, runtime.records/v1 and layout.tabs/v2, and lists nothing optional', () => {
    const { requires, optional } = manifest();
    assert.deepEqual([...requires].sort(), [
      'commands/v1@^1.0.0',
      'hooks/v1@^1.0.0',
      'layout.tabs/v2@^2.0.0',
      'navigation/v1@^1.1.0',
      'regions/v1@^1.0.0',
      'runtime.records/v1@^1.0.0',
      'ui/v1@^1.0.0',
    ]);
    assert.equal(optional, undefined);
  });

  test('names no layout contract but layout.tabs/v2, so not layout.conversation/v1', () => {
    const { provides, requires, optional = [] } = manifest();
    assert.deepEqual(
      [...provides, ...requires, ...optional].filter(
        (entry) =>
          entry.startsWith('layout.') && !entry.startsWith('layout.tabs/v2@'),
      ),
      [],
    );
  });
});
