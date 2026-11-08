// PC17 (G4, U40, D8, D14): drawing and revising a papercraft fence with a
// library and an `Export` changes no Project file. Over the disk sandbox (a
// real Git repository holding `tests/fixtures/harness-library`) behind the
// lease of the real host entry, which copies its built runner there. The
// compiled host under `dist-tests/` has no runner beside it (the other host
// tests rely on that), so this test activates a private copy of it with the
// build's `dist/sandbox/runner.mjs` at its `../sandbox/runner.mjs`.
//
// Contract matrix:
// - the first run leaves `git status --porcelain` empty except
//   `.doric/papercraft/.gitignore`; a second run (a new host session) leaves
//   it empty;
// - the runner copy stays in `.doric/papercraft/`, and no job folder remains.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PapercraftProgramsV1 } from '../src/contracts/index.js';
import {
  diskWorkspace,
  fixtureFiles,
  RUNNER_URL,
  removeWorkspaces,
} from './support/disk-sandbox.js';
import { projectId, type World, world } from './support/host.js';

/** A copy of the compiled `src/` under `dist-tests/`, beside the built runner. */
const COPY = fileURLToPath(
  new URL(`../pc17-host-${randomUUID().slice(0, 8)}/`, import.meta.url),
);

after(async () => {
  await removeWorkspaces();
  await rm(COPY, { recursive: true, force: true });
});

/** The host entry of the copy, whose runner is the build's. */
const hostWithRunner = async (): Promise<string> => {
  await cp(
    fileURLToPath(new URL('../src/', import.meta.url)),
    join(COPY, 'src'),
    {
      recursive: true,
    },
  );
  await copyFile(
    fileURLToPath(RUNNER_URL),
    join(COPY, 'src/sandbox/runner.mjs'),
  );
  return new URL(`file://${join(COPY, 'src/host/index.js')}`).href;
};

const threadId = 'thread-1';

/** One host session: the window's calls for a fence and its revision. */
const session = async (
  host: World,
  entry: string,
  root: string,
  promptId: string,
): Promise<void> => {
  const active = await host.activate(entry);

  try {
    const programs = host.test.services.use(PapercraftProgramsV1, {
      projectId,
      threadId,
    });
    host.row(threadId, promptId, 'papercraft.cwd/v1', { cwd: root });
    const fence = host.row(threadId, promptId, 'text.delta', {
      text: '```papercraft settings',
    });

    const library = await programs.library({ turnSequence: fence.sequence });
    assert.equal(library.status, 'ready', JSON.stringify(library));
    const exported = await programs.export({ path: 'src/Button.tsx' });
    assert.equal(exported.status, 'ready', JSON.stringify(exported));

    // The fence's next revision asks again.
    const revision = host.row(threadId, promptId, 'text.delta', {
      text: 'revision',
    });
    assert.equal(
      (await programs.library({ turnSequence: revision.sequence })).status,
      'ready',
    );
    assert.equal(
      (await programs.export({ path: 'src/Button.tsx' })).status,
      'ready',
    );
  } finally {
    await active.deactivate();
  }
};

describe('PC17: showing and revising a UI writes nothing in the Project', () => {
  test('only .doric/papercraft/.gitignore on the first run, nothing on the second', {
    timeout: 240_000,
  }, async () => {
    const entry = await hostWithRunner();
    const workspace = await diskWorkspace(
      await fixtureFiles('harness-library'),
    );
    assert.equal(await workspace.git('status', '--porcelain'), '');

    const first = world({ sandbox: workspace.sandbox });
    try {
      await session(first, entry, workspace.root, 'p1');
    } finally {
      await first.dispose();
    }

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

    const second = world({ sandbox: workspace.sandbox });
    try {
      await session(second, entry, workspace.root, 'p2');
    } finally {
      await second.dispose();
    }

    assert.equal(await workspace.git('status', '--porcelain'), '');
  });
});
