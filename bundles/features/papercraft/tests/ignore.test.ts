// PC4 (D8): papercraft's own ignore file and the one-time migration of the
// old Doric-wide `.doric/.gitignore`, over a real workspace folder.
//
// Contract matrix:
// - the first job writes `.doric/papercraft/.gitignore` with D8's content, and
//   never rewrites one that exists;
// - a `.doric/.gitignore` holding exactly `*` (newline or not) is deleted,
//   after `.doric/artifacts/.gitignore` is written when `.doric/artifacts/`
//   exists; with no `.doric/artifacts/` nothing is written there;
// - any other content is left;
// - the migration runs once per Project per host session;
// - an old-path job (`bundleInSandbox`, no setting involved) runs both steps
//   before the runner copy;
// - a rejected `putFile` leaves the job running, and the next job tries again.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { ensureIgnoreFiles } from '../src/host/ignore.js';
import { bundleInSandbox, type RunnerScript } from '../src/host/sandbox.js';
import {
  type DiskWorkspace,
  diskWorkspace,
  RUNNER_URL,
  removeWorkspaces,
} from './support/disk-sandbox.js';

after(removeWorkspaces);

/** D8's content of `.doric/papercraft/.gitignore`, as the design writes it. */
const EXPECTED_GITIGNORE = [
  '# Written by papercraft: the runner and its jobs stay out of Git; schemas/ is versioned.',
  '/*',
  '!/.gitignore',
  '!/schemas/',
  '',
].join('\n');

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const text = (workspace: DiskWorkspace, path: string) =>
  readFile(join(workspace.root, path), 'utf8');

const project = () => `project-${randomUUID()}`;

describe('ensureIgnoreFiles', () => {
  test("writes .doric/papercraft/.gitignore with D8's content", async () => {
    const workspace = await diskWorkspace({ 'README.md': '# app\n' });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      EXPECTED_GITIGNORE,
    );
  });

  test('leaves an existing .doric/papercraft/.gitignore as it is', async () => {
    const workspace = await diskWorkspace({
      '.doric/papercraft/.gitignore': '# mine\n',
    });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      '# mine\n',
    );
  });

  test('migrates `*\\n`: writes .doric/artifacts/.gitignore, then deletes .doric/.gitignore', async () => {
    const workspace = await diskWorkspace({
      '.doric/.gitignore': '*\n',
      '.doric/artifacts/a1/revision-1.json': '{}',
    });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(await text(workspace, '.doric/artifacts/.gitignore'), '*\n');
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
  });

  test('migrates `*` without .doric/artifacts/: deletes the file and writes nothing there', async () => {
    const workspace = await diskWorkspace({ '.doric/.gitignore': '*' });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
    assert.equal(await exists(join(workspace.root, '.doric/artifacts')), false);
  });

  test('keeps an existing .doric/artifacts/.gitignore', async () => {
    const workspace = await diskWorkspace({
      '.doric/.gitignore': '*\n',
      '.doric/artifacts/.gitignore': '# kept\n',
    });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(
      await text(workspace, '.doric/artifacts/.gitignore'),
      '# kept\n',
    );
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
  });

  test('leaves a .doric/.gitignore holding other content', async () => {
    const workspace = await diskWorkspace({
      '.doric/.gitignore': '*\n!papercraft/\n',
      '.doric/artifacts/a1/revision-1.json': '{}',
    });

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());

    assert.equal(
      await text(workspace, '.doric/.gitignore'),
      '*\n!papercraft/\n',
    );
    assert.equal(
      await exists(join(workspace.root, '.doric/artifacts/.gitignore')),
      false,
    );
    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      EXPECTED_GITIGNORE,
    );
  });

  test('runs the migration once per Project in a host session', async () => {
    const workspace = await diskWorkspace({ '.doric/.gitignore': '*\n' });
    const projectId = project();

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, projectId);
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );

    // The old file comes back (an older artifacts store, D8's downgrade).
    await workspace.write('.doric/.gitignore', '*\n');
    await ensureIgnoreFiles(workspace.sandbox, workspace.root, projectId);

    assert.equal(await text(workspace, '.doric/.gitignore'), '*\n');

    // Another Project of the session migrates its own workspace.
    await ensureIgnoreFiles(workspace.sandbox, workspace.root, project());
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
  });

  test('a rejected putFile neither rejects nor sets the flag: the next call migrates', async () => {
    const workspace = await diskWorkspace({
      '.doric/.gitignore': '*\n',
      '.doric/artifacts/a1/revision-1.json': '{}',
    });
    const projectId = project();
    workspace.failPut(() => true);

    await ensureIgnoreFiles(workspace.sandbox, workspace.root, projectId);

    assert.equal(await text(workspace, '.doric/.gitignore'), '*\n');
    assert.equal(
      await exists(join(workspace.root, '.doric/papercraft/.gitignore')),
      false,
    );

    workspace.failPut(() => false);
    await ensureIgnoreFiles(workspace.sandbox, workspace.root, projectId);

    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      EXPECTED_GITIGNORE,
    );
    assert.equal(await text(workspace, '.doric/artifacts/.gitignore'), '*\n');
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
  });
});

describe('an old-path job (papercraft_preview, any setting)', () => {
  const runner = async (): Promise<RunnerScript> => ({
    bytes: await readFile(RUNNER_URL),
    hash: `pc4-${randomUUID().slice(0, 8)}`,
  });

  const component = {
    'src/Note.tsx':
      'export default function Note() { return <p className="note">Note</p>; }\n',
  };

  const request = async () => ({
    path: 'src/Note.tsx',
    version: (await import('esbuild')).version,
    windowUnserved: [],
  });

  test('writes the ignore file and migrates before the runner copy', async () => {
    const workspace = await diskWorkspace({
      ...component,
      '.doric/.gitignore': '*\n',
    });

    const outcome = await bundleInSandbox(
      workspace.sandbox,
      await request(),
      await runner(),
    );

    assert.equal(outcome.status, 'built');
    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      EXPECTED_GITIGNORE,
    );
    assert.equal(
      await exists(join(workspace.root, '.doric/.gitignore')),
      false,
    );
    const ignoreAt = workspace.puts.findIndex((path) =>
      path.endsWith('.doric/papercraft/.gitignore'),
    );
    const runnerAt = workspace.puts.findIndex((path) =>
      /\.doric\/papercraft\/runner-[^/]+\.mjs$/u.test(path),
    );
    assert.ok(ignoreAt >= 0, 'the ignore file was put');
    assert.ok(
      runnerAt > ignoreAt,
      'the ignore file comes before the runner copy',
    );
  });

  test('a rejected ignore putFile leaves the job running; the next job writes it', async () => {
    const workspace = await diskWorkspace(component);
    const script = await runner();
    workspace.failPut((path) => path.endsWith('.gitignore'));

    const first = await bundleInSandbox(
      workspace.sandbox,
      await request(),
      script,
    );

    assert.equal(first.status, 'built');
    assert.ok(
      workspace.puts.some((path) =>
        path.endsWith('.doric/papercraft/.gitignore'),
      ),
      'the job tried the ignore file',
    );
    assert.equal(
      await exists(join(workspace.root, '.doric/papercraft/.gitignore')),
      false,
    );

    workspace.failPut(() => false);
    const second = await bundleInSandbox(
      workspace.sandbox,
      await request(),
      script,
    );

    assert.equal(second.status, 'built');
    assert.equal(
      await text(workspace, '.doric/papercraft/.gitignore'),
      EXPECTED_GITIGNORE,
    );
  });
});
