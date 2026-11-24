// P1–P3, P5 (phase 3, S57; D14, D16, D2, D3, D6): `papercraft.programs/v1`'s
// `Library` and `Export` over the router. The call's scope names the Project
// and Thread; a request is checked with protovalidate, then with today's zod
// schema; a library problem is an answer, never a failure. Library jobs and
// every lease run outside the caller's call; an export's source reads are
// `files/v1.Content` with the scope `{projectId}`, its sheet's bytes
// `files/v1.ReadBytes`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_SANDBOX } from '../src/host/programs.js';
import {
  BADGE_PATH,
  badgeProject,
  builtExport,
  builtLibrary,
  FONT,
  failureOf,
  projectId,
  type RouterWorld,
  routerWorld,
  scriptedSandbox,
  sha256,
  until,
} from './support/router.js';

const APP = '/workspace/app';

const activated = async (t: test.TestContext): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.activate();
  return world;
};

/** The Doric code of a failed client call. */
const codeOf = async (call: () => Promise<unknown>): Promise<string> =>
  (await failureOf(call)).code;

/** A cwd row for `APP`, through a prompt start; answers the `turnSequence` above it. */
const boundToApp = async (world: RouterWorld): Promise<number> => {
  await world.promptStarted('p1', APP);
  return world.log.length + 1;
};

void test('P1: Library needs a Thread scope and a whole turnSequence; no cwd row answers none', async (t) => {
  const world = await activated(t);

  assert.equal(
    await codeOf(() =>
      world.programs({ projectId }).library({ turnSequence: 1 }),
    ),
    'invalid_scope',
  );
  assert.equal(
    await codeOf(() => world.programs().library({ turnSequence: 1.5 })),
    'invalid_input',
  );
  const answer = await world.programs().library({ turnSequence: 1 });
  assert.equal(answer.status.case, 'none');
});

void test('P1: a cwd row below and a runner answering built give ready with the root and its module', async (t) => {
  const world = await activated(t);
  world.lease.status = 'ready';
  world.lease.sandbox = scriptedSandbox(() => builtLibrary(APP, 'p1'));
  const turnSequence = await boundToApp(world);

  const answer = await world.programs().library({ turnSequence });

  assert.equal(answer.status.case, 'ready', JSON.stringify(answer));
  if (answer.status.case !== 'ready') return;
  assert.equal(answer.status.value.root, APP);
  assert.ok((answer.status.value.module?.dir ?? '').length > 0);
  assert.ok(
    answer.status.value.module?.files.some(({ path }) => path === 'index.js'),
  );
});

void test('P1: two Library calls at once share one job', async (t) => {
  const world = await activated(t);
  const sandbox = scriptedSandbox(() => builtLibrary(APP, 'shared'));
  world.lease.status = 'ready';
  world.lease.sandbox = sandbox;
  const turnSequence = await boundToApp(world);

  const [one, two] = await Promise.all([
    world.programs().library({ turnSequence }),
    world.programs().library({ turnSequence }),
  ]);

  assert.equal(one.status.case, 'ready');
  assert.deepEqual(two, one);
  assert.equal(sandbox.jobs.length, 1);
});

void test('P2: Describe failing unavailable with leaseStatus pending answers failed with NO_SANDBOX', async (t) => {
  const world = await activated(t);
  world.lease.status = 'pending';
  const turnSequence = await boundToApp(world);

  const answer = await world.programs().library({ turnSequence });

  assert.equal(world.callsOf('lease.describe').length, 1);
  assert.equal(answer.status.case, 'failed');
  if (answer.status.case !== 'failed') return;
  assert.equal(answer.status.value.error, NO_SANDBOX);
});

void test('P3: an Export of a path leaving the Project answers failed', async (t) => {
  const world = await activated(t);

  const answer = await world.programs().export({ path: '../x.tsx' });

  assert.equal(answer.status.case, 'failed');
  if (answer.status.case !== 'failed') return;
  assert.equal(answer.status.value.error, 'The path leaves the Project');
});

void test('P3: an Export with no lease builds on the host from Content reads scoped to the Project, and reads the sheet’s font with ReadBytes', async (t) => {
  const world = await activated(t);
  world.files = badgeProject(FONT);

  const answer = await world.programs().export({ path: BADGE_PATH });

  assert.equal(answer.status.case, 'ready', JSON.stringify(answer));
  if (answer.status.case !== 'ready') return;
  assert.ok(
    answer.status.value.module?.files.some(
      ({ path }) => path === `assets/${sha256(FONT)}.woff2`,
    ),
    JSON.stringify(answer.status.value.module?.files),
  );
  const contents = world.callsOf('files.content');
  assert.ok(
    contents.some(
      ({ request }) => (request as { path: string }).path === BADGE_PATH,
    ),
  );
  for (const call of contents) {
    assert.deepEqual(call.scope, { projectId });
    assert.deepEqual(Object.keys(call.request as object), ['path']);
  }
  const fontReads = world
    .callsOf('files.readBytes')
    .filter(({ request }) =>
      (request as { path: string }).path.endsWith('face.woff2'),
    );
  assert.equal(fontReads.length, 1);
  assert.deepEqual(fontReads[0]?.scope, { projectId });
  assert.ok(
    !contents.some(({ request }) =>
      (request as { path: string }).path.endsWith('face.woff2'),
    ),
  );
});

void test('P3: a caller cancelling Export does not stop its queued job', async (t) => {
  const world = await activated(t);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sandbox = scriptedSandbox(async () => {
    await gate;
    return builtExport('cancelled');
  });
  world.lease.status = 'ready';
  world.lease.sandbox = sandbox;
  world.files = badgeProject(FONT);
  const controller = new AbortController();

  const exported = world
    .programs()
    .export({ path: BADGE_PATH }, { signal: controller.signal });
  await until(() => sandbox.jobs.length === 1, 'the export job');
  controller.abort();
  await assert.rejects(exported);
  release();
  await until(
    () => world.callsOf('lease.getFile').length > 0,
    'the job’s output read',
  );

  for (const call of world.calls.filter(({ method }) =>
    method.startsWith('lease.'),
  )) {
    assert.equal(call.aborted, false, call.method);
    assert.equal(call.deadline, 0, call.method);
  }
});

void test('P5: a whole turnSequence above the safe integers passes protovalidate but is invalid_input, and no ThreadEvents is called', async (t) => {
  const world = await activated(t);

  assert.equal(
    await codeOf(() => world.programs().library({ turnSequence: 2 ** 60 })),
    'invalid_input',
  );
  assert.deepEqual(world.callsOf('threads.threadEvents'), []);
});
