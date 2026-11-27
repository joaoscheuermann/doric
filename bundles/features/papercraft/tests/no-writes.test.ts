// PC17 (G4, U40, D8, D14): drawing and revising a papercraft fence with a
// library and an `Export` changes no Project file. Over the disk sandbox (a
// real Git repository holding `tests/fixtures/harness-library`) behind the
// fake `runtime.lease/v1` of the router world, whose host part puts the
// build's `dist/sandbox/runner.mjs` (read as its asset) there. Moved from the
// kernel entry to the router (S68c).
//
// Contract matrix:
// - the first run leaves `git status --porcelain` empty except
//   `.doric/papercraft/.gitignore`; a second run (a new host session) leaves
//   it empty;
// - the runner copy stays in `.doric/papercraft/`, and no job folder remains.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  type DiskWorkspace,
  diskWorkspace,
  fixtureFiles,
  removeWorkspaces,
} from './support/disk-sandbox.js';
import { routerWorld } from './support/router.js';

after(async () => {
  await removeWorkspaces();
});

/** One host session: the window's calls for a fence and its revision. */
const session = async (
  workspace: DiskWorkspace,
  files: Record<string, string>,
  promptId: string,
): Promise<void> => {
  const world = routerWorld();
  world.files = files;
  world.lease.status = 'ready';
  world.lease.sandbox = workspace.sandbox;
  await world.activate();
  try {
    world.row(promptId, 'papercraft.cwd/v1', { cwd: workspace.root });
    const fence = world.row(promptId, 'text.delta', {
      text: '```papercraft settings',
    });

    const library = await world
      .programs()
      .library({ turnSequence: fence.sequence });
    assert.equal(library.status.case, 'ready', JSON.stringify(library));
    const exported = await world.programs().export({ path: 'src/Button.tsx' });
    assert.equal(exported.status.case, 'ready', JSON.stringify(exported));

    // The fence's next revision asks again.
    const revision = world.row(promptId, 'text.delta', { text: 'revision' });
    assert.equal(
      (await world.programs().library({ turnSequence: revision.sequence }))
        .status.case,
      'ready',
    );
    assert.equal(
      (await world.programs().export({ path: 'src/Button.tsx' })).status.case,
      'ready',
    );
  } finally {
    await world.stop();
  }
};

describe('PC17: showing and revising a UI writes nothing in the Project', () => {
  test('only .doric/papercraft/.gitignore on the first run, nothing on the second', {
    timeout: 240_000,
  }, async () => {
    const files = await fixtureFiles('harness-library');
    const workspace = await diskWorkspace(files);
    assert.equal(await workspace.git('status', '--porcelain'), '');

    await session(workspace, files, 'p1');

    assert.equal(
      await workspace.git('status', '--porcelain'),
      '?? .doric/papercraft/.gitignore\n',
    );
    const kept = await readdir(join(workspace.root, '.doric/papercraft'));
    assert.ok(
      kept.some((name) => /^runner-.+\.mjs$/u.test(name)),
      kept.join(', '),
    );
    const jobs = await readdir(
      join(workspace.root, '.doric/papercraft/jobs'),
    ).catch(() => []);
    assert.deepEqual(jobs, []);

    await workspace.git('add', '.doric/papercraft/.gitignore');
    await workspace.git('commit', '-q', '-m', 'papercraft ignore file');

    await session(workspace, files, 'p2');

    assert.equal(await workspace.git('status', '--porcelain'), '');
  });
});
