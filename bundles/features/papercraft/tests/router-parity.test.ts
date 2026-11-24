// K2 (phase 3, S57; D1): one scripted session — a prompt start with a cwd, the
// skill load, a second prompt start, `Library`, a third prompt start,
// `Export`, `Read` — on the kernel's world (`tests/support/host.ts`) and on
// the router world gives equal cwd rows, instruct texts, library answers and
// module `dir`s, and `Read`'s bytes equal the kernel's base64-decoded entries.
// Neither world has a sandbox runner or a lease, so the library fails and the
// export compiles on the host, the same way in both.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { LibraryResponse } from '../src/contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import {
  type LibraryAnswer,
  PapercraftProgramsV1,
} from '../src/contracts/index.js';
import { world } from './support/host.js';
import {
  BADGE_PATH,
  badgeProject,
  projectId,
  RUNNER_PATH,
  readOwnAsset,
  routerWorld,
  threadId,
} from './support/router.js';

const APP = '/workspace/app';

/** The Project's files as text, the kernel fake's form. */
const FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(badgeProject(Buffer.from('FONTBYTES', 'utf8'))).map(
    ([path, content]) => [
      path,
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8'),
    ],
  ),
);

/** A routed `LibraryResponse` as the kernel's `LibraryAnswer`. */
const libraryAnswerOf = ({ status }: LibraryResponse): LibraryAnswer => {
  switch (status.case) {
    case 'ready':
      return {
        status: 'ready',
        root: status.value.root,
        module: {
          dir: status.value.module?.dir ?? '',
          files: (status.value.module?.files ?? []).map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
        },
      };
    case 'failed':
      return {
        status: 'failed',
        ...(status.value.root === undefined ? {} : { root: status.value.root }),
        error: status.value.error,
      };
    default:
      return { status: 'none' };
  }
};

interface Session {
  readonly cwds: readonly string[];
  readonly instructs: readonly string[];
  readonly library: LibraryAnswer;
  readonly dir: string;
  readonly bytes: ReadonlyMap<string, Buffer>;
}

const kernelSession = async (t: test.TestContext): Promise<Session> => {
  const kernel = world({ files: FILES });
  t.after(() => kernel.dispose());
  const active = await kernel.activate();
  const programs = kernel.test.services.use(PapercraftProgramsV1, {
    projectId,
    threadId,
  });

  await active.promptStarted({ threadId, promptId: 'p1', cwd: APP });
  kernel.loadSkill(threadId, 'p1');
  await active.promptStarted({ threadId, promptId: 'p2', cwd: APP });
  const library = await programs.library({
    turnSequence: kernel.log.length + 1,
  });
  await active.promptStarted({ threadId, promptId: 'p3', cwd: APP });
  const exported = await programs.export({ path: BADGE_PATH });
  assert.equal(exported.status, 'ready', JSON.stringify(exported));
  if (exported.status !== 'ready') throw new Error('unreachable');
  const { entries } = await programs.read({ dir: exported.module.dir });

  return {
    cwds: kernel
      .cwdRows(threadId)
      .map((row) => String((row.event as { cwd?: string }).cwd)),
    instructs: kernel.instructs.map(({ prompt }) => prompt),
    library,
    dir: exported.module.dir,
    bytes: new Map(
      entries.map(({ path, base64 }) => [path, Buffer.from(base64, 'base64')]),
    ),
  };
};

const routerSession = async (t: test.TestContext): Promise<Session> => {
  const routed = routerWorld({
    readAsset: (path) =>
      path === RUNNER_PATH
        ? Promise.reject(new Error(`ENOENT: no such file, open '${path}'`))
        : readOwnAsset(path),
  });
  t.after(() => routed.stop());
  routed.files = { ...FILES };
  await routed.activate();

  await routed.promptStarted('p1', APP);
  routed.loadSkill('p1');
  await routed.promptStarted('p2', APP);
  const library = await routed
    .programs()
    .library({ turnSequence: routed.log.length + 1 });
  await routed.promptStarted('p3', APP);
  const exported = await routed.programs().export({ path: BADGE_PATH });
  assert.equal(exported.status.case, 'ready', JSON.stringify(exported));
  if (exported.status.case !== 'ready') throw new Error('unreachable');
  const dir = exported.status.value.module?.dir ?? '';
  const bytes = new Map<string, Buffer>();
  for await (const item of routed.programs().read({ dir })) {
    bytes.set(
      item.path,
      Buffer.concat([bytes.get(item.path) ?? Buffer.alloc(0), item.bytes]),
    );
  }

  return {
    cwds: routed.cwds(),
    instructs: routed
      .callsOf('threads.instruct')
      .map(({ request }) => (request as { prompt: string }).prompt),
    library: libraryAnswerOf(library),
    dir,
    bytes,
  };
};

void test('K2: one session on the kernel and on the router gives equal cwd rows, instruct texts, library answers, module dirs and Read bytes', async (t) => {
  const kernel = await kernelSession(t);
  const routed = await routerSession(t);

  assert.deepEqual(routed.cwds, kernel.cwds);
  assert.ok(kernel.instructs.length > 0, 'the kernel gave no instruct');
  assert.deepEqual(routed.instructs, kernel.instructs);
  assert.deepEqual(routed.library, kernel.library);
  assert.equal(routed.dir, kernel.dir);
  assert.deepEqual(
    [...routed.bytes.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [...kernel.bytes.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
});
