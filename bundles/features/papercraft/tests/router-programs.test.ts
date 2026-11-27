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

// The kernel suite `library.test.ts` (PC14: the binding by `turnSequence`),
// moved to the router world in S68c (X3): `Library` answers the library of the
// last cwd row below the fence's `turnSequence`.

const WEB = '/workspace/web';

/** A ready lease whose runner answers each library job with the library of its `cwd`. */
const leasedByCwd = (world: RouterWorld): void => {
  world.lease.status = 'ready';
  world.lease.sandbox = scriptedSandbox((input) =>
    builtLibrary(String(input.cwd), String(input.cwd)),
  );
};

const rootAt = async (
  world: RouterWorld,
  turnSequence: number,
): Promise<string> => {
  const answer = await world.programs().library({ turnSequence });
  return answer.status.case === 'ready'
    ? answer.status.value.root
    : (answer.status.case ?? 'unset');
};

void test('PC14: fences before and after a move bind to their own directory; no cwd row answers none', async (t) => {
  const world = await activated(t);
  leasedByCwd(world);

  assert.equal(await rootAt(world, 1), 'none');
  await world.promptStarted('p1', APP);
  const before = world.row('p1', 'text.delta', { text: 'fence 1' });
  await world.cwdChanged(WEB, APP, 'p1');
  const after = world.row('p1', 'text.delta', { text: 'fence 2' });
  await world.promptStarted('p2', WEB);
  const [appRow, webRow] = world.log.filter(
    ({ type }) => type === 'papercraft.cwd/v1',
  );

  assert.equal(await rootAt(world, appRow?.sequence ?? 0), 'none');
  assert.equal(await rootAt(world, before.sequence), APP);
  assert.equal(await rootAt(world, webRow?.sequence ?? 0), APP);
  assert.equal(await rootAt(world, after.sequence), WEB);
});

void test('PC14: a rewind removing the move rebinds later fences; the next hook appends again; a restarted host agrees', async (t) => {
  const world = await activated(t);
  leasedByCwd(world);

  await world.promptStarted('p1', APP);
  await world.promptStarted('p2', WEB);
  world.row('p2', 'text.delta', { text: 'fence' });
  world.rewind('p2');
  const fence = world.row('p3', 'text.delta', { text: 'later fence' });
  await world.promptStarted('p3', WEB);

  // The rewind dropped p2's row: a fence below p3's new row binds to APP.
  assert.equal(await rootAt(world, fence.sequence), APP);
  assert.deepEqual(
    world.log
      .filter(({ type }) => type === 'papercraft.cwd/v1')
      .map(({ promptId, event }) => [promptId, event.cwd]),
    [
      ['p1', APP],
      ['p3', WEB],
    ],
  );

  // A host restarted after the rewind reads the same log.
  const restarted = await activated(t);
  leasedByCwd(restarted);
  for (const { promptId, type, event } of world.log) {
    const { type: _type, ...fields } = event;
    restarted.row(promptId, type, fields);
  }
  const replayed = restarted.log.find(
    ({ event }) => event.text === 'later fence',
  );
  await restarted.promptStarted('p4', WEB);

  assert.equal(await rootAt(restarted, replayed?.sequence ?? 0), APP);
});
