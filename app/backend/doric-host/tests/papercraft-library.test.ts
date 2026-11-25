import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { defaultConfig } from 'host-config/testing';
import type pino from 'pino';

import {
  type HostPlatform,
  hostComposition,
  type StartHostPlatformOptions,
  startHostPlatform,
} from '../src/lib/bundles/boot.js';
import { callApi, openStream } from './helpers/api.js';
import { freshDatabase } from './helpers/host.js';
import {
  papercraftPrompts,
  scriptedEndpoint,
  scriptedModel,
} from './helpers/integration-provider.js';
import { cleanupStack } from './helpers/persistence-fixture.js';
import {
  baseEnvironment,
  bundlesPath,
  credentialKey,
  recorded,
} from './helpers/platform.js';

// PC23 (papercraft-openui.md D28, R36) on the platform: with the real
// `default` and `papercraft` bundles, papercraft finds the skill load in the
// Thread log by `default`'s tool name and input. Prompt 1 loads the skill;
// prompt 2's start finds the load and starts a library job; prompt 3's first
// model request carries the instruct of that job's failure, which has no
// root, so only the skill load read from the log can have brought it. A
// prompt runs only on a Project that holds a sandbox lease, so `docker` is
// swapped for the `nodeless-sandbox` fixture process: its Project is ready
// without Docker, and no `node` in it makes the library job fail. Build doric
// first (`dist/bundles`); the case needs PostgreSQL only.

/** The composition the host ships. */
const compositionPath = 'app/backend/doric-host/composition.json';

/** The fixture's committed files, and its host part as the spec build emits it. */
const fixtureSource =
  'app/backend/doric-host/tests/fixtures/platform-bundles/nodeless-sandbox';
const fixtureMain =
  'app/backend/doric-host/dist-tests/tests/fixtures/platform-bundles/nodeless-sandbox/host/main.js';

const fixtureId = 'nodeless-sandbox';

/** The instruct prompt 3's first model request carries. */
const libraryInstruct =
  'The repository library could not be checked: The sandbox could not run the library job: the sandbox has no `node`';

/**
 * A bundles root for PC23: a copy of the staged `dist/bundles` inside
 * `app/backend/doric-host/dist-tests` (so package imports resolve), plus
 * `nodeless-sandbox/` staged as `stage --dev` stages a host part: the
 * fixture's `manifest.json`, `contracts.json`, `package.json`; `schemas/` and
 * `descriptors.binpb` copied from the staged `docker`; the compiled
 * `main.js` copied to `host/main.js`; `host/command.json` =
 * `[process.execPath, <absolute host/main.js>]`. Resolves with the root's
 * path; the caller removes it. Rejects with the file system's error when
 * `dist/bundles` or the compiled fixture is missing (build first).
 */
const nodelessRoot = async (): Promise<string> => {
  const root = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'bundles-'),
  );
  const fixture = join(root, fixtureId);

  try {
    await cp(bundlesPath, root, { recursive: true });
    for (const file of ['manifest.json', 'contracts.json', 'package.json']) {
      await cp(join(fixtureSource, file), join(fixture, file));
    }
    await cp(join(root, 'docker', 'schemas'), join(fixture, 'schemas'), {
      recursive: true,
    });
    await cp(
      join(root, 'docker', 'descriptors.binpb'),
      join(fixture, 'descriptors.binpb'),
    );
    await cp(fixtureMain, join(fixture, 'host', 'main.js'));
    await writeFile(
      join(fixture, 'host', 'command.json'),
      JSON.stringify([process.execPath, resolve(fixture, 'host', 'main.js')]),
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return root;
};

/**
 * Boots `root` as the host does (`hostComposition` of the shipped
 * `composition.json`, then `startHostPlatform`), with `enabled` naming
 * `nodeless-sandbox` in `docker`'s place, the public listener on
 * 127.0.0.1:0, and `env` as the instances' base environment (this process's
 * without `DORIC_*`, plus `DORIC_DATABASE_URL`, `DORIC_CREDENTIAL_KEY`,
 * `DORIC_STORAGE_PATH`). Rejects as `startHostPlatform` does
 * (`BundleRecoveryError` when `sandbox/v1` has no provider). The caller
 * shuts the platform down.
 */
const bootNodeless = async (
  root: string,
  env: NodeJS.ProcessEnv,
  logger: pino.Logger,
): Promise<HostPlatform> => {
  const { required } = await hostComposition({}, compositionPath);
  const shipped = JSON.parse(await readFile(compositionPath, 'utf8')) as {
    readonly enabled: readonly string[];
  };
  const composition = {
    ...shipped,
    enabled: shipped.enabled.map((id) => (id === 'docker' ? fixtureId : id)),
  } as StartHostPlatformOptions['composition'];

  return startHostPlatform({
    bundlesPath: root,
    compositionPath,
    composition,
    required,
    publicAddress: '127.0.0.1:0',
    startup: { stage: () => undefined, log: () => undefined },
    logger,
    exit: () => undefined,
    env,
  });
};

interface Project {
  readonly id: string;
  readonly state: string;
  readonly errorCode?: string;
}

/** One item of `ProjectsService/Watch`. */
interface ProjectItem {
  readonly projectSnapshot?: { readonly project?: Project };
  readonly projectUpdated?: Project;
}

/** One item of `ThreadsService/Watch`. */
interface ThreadItem {
  readonly agentEvent?: { readonly type: string; readonly promptId?: string };
}

void test('PC23: a papercraft skill load read from the log brings the library instruct at the second prompt start', {
  skip:
    process.env.DORIC_TEST_DATABASE_URL === undefined
      ? 'Requires DORIC_TEST_DATABASE_URL'
      : false,
  timeout: 180_000,
}, async (t) => {
  const connectionString = process.env.DORIC_TEST_DATABASE_URL;
  assert.ok(connectionString);
  const cleanup = cleanupStack();
  t.after(() => cleanup.close());

  const model = await scriptedEndpoint();
  cleanup.defer(model.close);
  const database = await freshDatabase(connectionString);
  cleanup.defer(database.close);
  const root = await nodelessRoot();
  cleanup.defer(() => rm(root, { recursive: true, force: true }));
  const storage = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'storage-'),
  );
  cleanup.defer(() => rm(storage, { recursive: true, force: true }));
  const { lines, logger } = recorded();
  const host = await bootNodeless(
    root,
    baseEnvironment({
      DORIC_DATABASE_URL: database.url,
      DORIC_CREDENTIAL_KEY: credentialKey,
      DORIC_STORAGE_PATH: storage,
    }),
    logger,
  );
  cleanup.defer(() => host.platform.shutdown());

  // `sandbox/v1` is the fixture's alone; `docker` is not booted.
  assert.deepEqual(
    (
      host.resolved.contracts.find(({ id }) => id === 'sandbox/v1')
        ?.providers ?? []
    ).map(({ bundleId }) => bundleId),
    [fixtureId],
  );
  assert.ok(!host.resolved.order.includes('docker'));

  assert.ok(host.platform.publicPort);
  const base = `http://127.0.0.1:${String(host.platform.publicPort)}`;
  const api = <T = Record<string, unknown>>(
    procedure: string,
    request: unknown = {},
  ) => callApi<T>(base, `doric.api.${procedure}`, request);
  const watch = async <T>(procedure: string, request: unknown) => {
    const stream = await openStream<T>(base, `doric.api.${procedure}`, request);
    cleanup.defer(async () => stream.close());
    return stream;
  };

  const credential = await api<{ credentialDescription: { id: string } }>(
    'credentials.v1.CredentialsService/CreateCredential',
    { kind: 'API_TOKEN', name: 'scripted', secret: 'sk-scripted' },
  );
  await api('config.v1.ConfigService/PutConfig', {
    configuration: {
      ...defaultConfig,
      providers: [
        {
          id: 'scripted',
          kind: 'openrouter',
          configuration: {
            endpoint: model.endpoint,
            token: credential.credentialDescription.id,
          },
          models: [{ name: scriptedModel, reasonings: [] }],
        },
      ],
      models: {
        execution: { providerId: 'scripted', model: scriptedModel },
      },
    },
  });

  const { project } = await api<{ project: Project }>(
    'projects.v1.ProjectsService/CreateProject',
    { name: 'PC23' },
  );
  const projectWatch = await watch<ProjectItem>(
    'projects.v1.ProjectsService/Watch',
    { projectId: project.id },
  );
  const snapshot = (await projectWatch.next()).projectSnapshot?.project;
  if (snapshot?.state !== 'ready') {
    const settled =
      snapshot?.state === 'failed'
        ? snapshot
        : (
            await projectWatch.until(
              ({ projectUpdated }) =>
                projectUpdated?.state === 'ready' ||
                projectUpdated?.state === 'failed',
              120_000,
            )
          ).projectUpdated;
    assert.equal(
      settled?.state,
      'ready',
      `Project failed: ${settled?.errorCode ?? 'no errorCode'}`,
    );
  }

  const { thread } = await api<{ thread: { id: string } }>(
    'projects.v1.ProjectsService/CreateThread',
    { projectId: project.id, name: 'PC23 thread' },
  );
  const threadWatch = await watch<ThreadItem>(
    'threads.v1.ThreadsService/Watch',
    { threadId: thread.id },
  );

  for (const prompt of [
    papercraftPrompts.load,
    papercraftPrompts.second,
    papercraftPrompts.third,
  ]) {
    const { promptId } = await api<{ promptId: string }>(
      'threads.v1.ThreadsService/Prompt',
      { threadId: thread.id, prompt },
    );
    await threadWatch.until(
      ({ agentEvent }) =>
        agentEvent?.type === 'prompt.finished' &&
        agentEvent.promptId === promptId,
      120_000,
    );
  }

  assert.deepEqual(model.failures, []);
  const third = model.requests.find(({ messages }) =>
    JSON.stringify(messages).includes(papercraftPrompts.third),
  );
  assert.ok(third, 'prompt 3 reached the model');
  assert.ok(
    JSON.stringify(third.messages).includes(libraryInstruct),
    'prompt 3 carries the library instruct',
  );
  assert.deepEqual(
    lines.filter(({ msg }) => msg === 'skill not registered'),
    [],
  );
});
