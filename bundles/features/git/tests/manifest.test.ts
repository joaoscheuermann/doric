// The git manifest (ui-redesign S15, S35; T-4.4.9 for git): the diff tab's
// `menu` (A6) and `iconTag` need `layout.tabs/v2@2.0.0`, so the bundle
// requires it; it provides `git.commands/v1@1.1.0` (`discard`) at version
// 1.2.6 (G1; the sidebar alignment's patches, T-1.10, T-4.7 and T-5.7; bundle
// isolation 4(a) changes 4 and 6, the last for the Monaco rule in its sheet),
// and at 1.2.11 from bundle isolation 6(c) (a patch: its copy of
// `settings.config/v1` becomes an import of `settings/contracts`), and at
// 1.2.12 from bundle isolation 4(d) (a patch: the selection and the records
// come from `workspace.selection/v1` and `runtime.records/v1`), and at
// 1.2.13 from bundle isolation 5(c) change 2 (a patch: it observes
// `chat.hooks/v2` to refresh after its own tool), and at 1.2.14 from bundle
// isolation 7(c) (a patch: the busy check reads `terminal/v1`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('the git manifest', () => {
  test('requires layout.tabs/v2@^2.0.0 and provides git.commands/v1@1.1.0', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { version: string; provides: string[]; requires: string[] };

    assert.equal(manifest.version, '1.2.14');
    assert.ok(manifest.provides.includes('git.commands/v1@1.1.0'));
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.tabs/')),
      ['layout.tabs/v2@^2.0.0'],
    );
  });

  // Bundle isolation 4(d), O1: the new lines take the section of the line
  // they replace.
  test('requires workspace.selection/v1 and runtime.records/v1, and no layout.workspace/*', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { requires: string[] };

    assert.ok(manifest.requires.includes('workspace.selection/v1@^1.0.0'));
    assert.ok(manifest.requires.includes('runtime.records/v1@^1.0.0'));
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.workspace/')),
      [],
    );
  });

  // Bundle isolation 5(c) change 2 (OD-1, S-1): git observes
  // `chat.hooks/v2` `onThreadUpdateHook` through `hooks/v1`, so it requires
  // `hooks/v1` and takes `chat.hooks/v2` as optional.
  test('requires hooks/v1@^1.0.0 and takes chat.hooks/v2 as its only optional chat hooks', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { requires: string[]; optional: string[] };

    assert.ok(manifest.requires.includes('hooks/v1@^1.0.0'));
    assert.deepEqual(
      manifest.optional.filter((ref) => ref.startsWith('chat.hooks/')),
      ['chat.hooks/v2'],
    );
  });

  // Bundle isolation 7(c), AC7.4 and T7.2: the busy check reads the Project's
  // terminals from the terminal bundle's `terminal/v1`, while some bundle
  // provides it; the runtime no longer provides `runtime.terminals/v1`.
  test('takes terminal/v1 as optional and no runtime.terminals/v1', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { requires: string[]; optional: string[] };

    assert.ok(manifest.optional.includes('terminal/v1'));
    assert.equal(manifest.optional.includes('runtime.terminals/v1'), false);
    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('terminal/')),
      [],
    );
  });

  // Part 2i (S36): git uses no layout.panel/* contract.
  test('requires no layout.panel/* contract', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/features/git/manifest.json', 'utf8'),
    ) as { requires: string[] };

    assert.deepEqual(
      manifest.requires.filter((ref) => ref.startsWith('layout.panel/')),
      [],
    );
  });
});
