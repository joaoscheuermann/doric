import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  freshDatabase,
  type LogLine,
  startHostProcess,
} from './helpers/host.js';

// The compiled host's boot and stop, observed as an operator sees them: the
// startup log, the fatal stage of a refused boot, the HTTP surface and the
// exit code. Build doric first.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const databaseCase = connectionString === undefined;

const startup = (lines: readonly LogLine[]) =>
  lines.filter(({ component }) => component === 'startup');

const fatalStage = (lines: readonly LogLine[]) =>
  lines.find(({ msg }) => msg === 'Doric failed to start')?.stage;

void test('boots through every startup stage in order, serves, and stops on SIGTERM', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      const lines = await host.lines();

      // Each bundle logs its own start step, in activation order (BWP-6): the
      // transport names its socket namespaces, the sandbox its pool, and the
      // runtime its workspace. The kernel no longer logs those.
      assert.deepEqual(
        startup(lines).map(({ msg }) => msg),
        [
          'Doric starting',
          'Loading bundles',
          'Bundles loaded',
          'Initializing PostgreSQL client',
          'PostgreSQL client initialized',
          'Activating stored credentials',
          'Activating Doric configuration',
          'Doric configuration activated',
          'Network interfaces configured',
          'Configuring sandbox pool',
          'Sandbox pool configured',
          'Reconciling persisted projects and threads',
          'Workspace reconciled',
          'Binding HTTP listener',
          'Doric listening',
        ],
      );
      const line = (msg: string) =>
        startup(lines).find((entry) => entry.msg === msg);

      assert.equal(line('Bundles loaded')?.bundleCount, 22);
      assert.equal(line('Bundles loaded')?.toolCount, 16);
      assert.equal(
        line('Sandbox pool configured')?.sandboxProviderName,
        'docker',
      );
      assert.equal(line('Sandbox pool configured')?.networkMode, 'egress');
      assert.deepEqual(
        line('Network interfaces configured')?.socketNamespaces,
        ['/status', '/projects', '/threads'],
      );
      assert.equal(line('Workspace reconciled')?.interruptedThreads, 0);
      assert.equal(line('Workspace reconciled')?.interruptedProjects, 0);
      // The chosen sandbox option is logged as the alternatives it belongs to.
      assert.deepEqual(line('Doric starting')?.alternatives, {
        sandbox: 'docker',
      });
      assert.deepEqual(line('Doric listening')?.alternatives, {
        sandbox: 'docker',
      });
      // The runtime logs its own recovery steps through log/v1, between
      // reconciliation and the workspace it found.
      const recovery = lines
        .filter(({ msg }) =>
          [
            'Reconciling persisted projects and threads',
            'Project and thread reconciliation complete',
            'Interrupted prompts resumed',
            'Project sandbox recovery scheduled',
            'Workspace reconciled',
          ].includes(msg ?? ''),
        )
        .map(({ msg }) => msg);
      assert.deepEqual(recovery, [
        'Reconciling persisted projects and threads',
        'Project and thread reconciliation complete',
        'Interrupted prompts resumed',
        'Project sandbox recovery scheduled',
        'Workspace reconciled',
      ]);

      const config = await host.request('/config');
      assert.equal(config.status, 200);
      // The configuration the boot activated is the one the host serves.
      assert.equal(
        ((await config.json()) as { revision: number }).revision,
        line('Doric configuration activated')?.configRevision,
      );
      const projects = await host.request('/projects');
      assert.equal(projects.status, 200);
      assert.deepEqual(await projects.json(), { items: [] });
      const missing = await host.request('/nowhere');
      assert.equal(missing.status, 404);

      assert.equal(await host.stop(), 0);
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('a missing database URL fails the boot at database_client', {
  timeout: 120_000,
}, async () => {
  const host = await startHostProcess({});
  try {
    assert.equal(await host.exited, 1);
    const lines = await host.lines();
    assert.equal(fatalStage(lines), 'database_client');
    // Every bundle was loaded first: the database is the first I/O.
    assert.ok(startup(lines).some(({ msg }) => msg === 'Bundles loaded'));
  } finally {
    await host.close();
  }
});

void test('legacy Project rows the stage-7 migration never moved fail the boot at database_client', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString, {
    skip: (migration) => migration.endsWith('_runtime_documents'),
  });
  try {
    await database.query(
      `INSERT INTO "project" ("id", "name", "state", "config_revision", "config_snapshot", "created_at", "updated_at")
       VALUES ($1, 'Legacy', 'READY', 1, '{}'::jsonb, now(), now())`,
      ['018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600'],
    );
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      assert.equal(await host.exited, 1);
      assert.equal(fatalStage(await host.lines()), 'database_client');
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('a composition without a structural provider fails the boot at bundle_load', {
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(join('agents/doric/dist-tests', 'boot-'));
  try {
    const composition = JSON.parse(
      await readFile('agents/doric/composition.json', 'utf8'),
    ) as { enabled: string[] };
    const path = resolve(directory, 'composition.json');
    await writeFile(
      path,
      JSON.stringify({
        ...composition,
        enabled: composition.enabled.filter((id) => id !== 'direct'),
      }),
    );
    const host = await startHostProcess({
      DORIC_DATABASE_URL: 'postgresql://unused.invalid/doric',
      DORIC_COMPOSITION: path,
    });
    try {
      assert.equal(await host.exited, 1);
      const lines = await host.lines();
      assert.equal(fatalStage(lines), 'bundle_load');
      assert.ok(
        lines.some(
          ({ msg, reason }) =>
            msg === 'Bundle recovery mode' &&
            typeof reason === 'string' &&
            reason.includes('executor/v1'),
        ),
      );
    } finally {
      await host.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
