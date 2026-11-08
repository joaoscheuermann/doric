// PC9, PC10, PC12 (D14, D16): `papercraft.programs/v1` over the host memo, the
// per-Project job queue and the failure rules. The runner jobs are scripted
// (`runJob` is the sandbox boundary); `files/v1` is a map of files.
//
// Contract matrix:
// - PC9: an unchanged manifest answers from the memo (the job gets the
//   previous manifest and the runner answers `unchanged`); a changed library
//   gives a new module; the paths the host's CSS step read (a nested
//   `@import`, a font) join the manifest; a failure is kept with its
//   manifest; a crashed or timed-out job is held 5 minutes per Project and
//   `cwd`; no `node` and another esbuild answer `failed` with no hold; with no
//   lease the memo answers; two Projects with one root path keep apart; above
//   64 MiB the least recently used key goes and `read` of its `dir` throws
//   `not_found`; the `cwd`'s last answer follows every kind of answer;
// - PC10: two calls at once share one job; a call during a job waits for the
//   next one; a third job of a Project waits, library jobs ahead of exports;
// - PC12: a path leaving the Project fails; a leading `/` is the root; an
//   export without a name has no entry; a module lists `index.js`,
//   `index.css` and its sheet's `assets/<sha256>.<ext>`, its `dir` is the
//   hash of its file lines, and `read` serves every file; without `node`,
//   `export` builds through `files/v1`, `read` serves it, and the next
//   `export` builds again; the `files/v1` harness probe stops at a nested
//   repository (PC5).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  type LibraryAnswer,
  type ModuleRef,
  PapercraftProgramsV1,
} from '../src/contracts/index.js';
import {
  createPrograms,
  type JobRequest,
  type ProgramsHost,
} from '../src/host/programs.js';
import type { LibraryOutput, RunnerOutput } from '../src/sandbox/protocol.js';
import {
  eventually,
  type World,
  type WorldOptions,
  world,
} from './support/host.js';

const P1 = 'project-1';
const P2 = 'project-2';
const APP = '/workspace/app';
const HOLD_MS = 5 * 60 * 1000;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A runner's `built` library answer. */
const builtLibrary = (
  root: string,
  marker: string,
  extra: Partial<Extract<LibraryOutput, { status: 'built' }>> = {},
): LibraryOutput => ({
  status: 'built',
  root,
  js: `export const components = []; export const marker = ${JSON.stringify(marker)};`,
  components: [
    {
      name: 'AppButton',
      description: 'The app button.',
      signature: 'AppButton(label: string)',
      file: '.doric/papercraft/schemas/AppButton.tsx',
    },
  ],
  sources: {},
  globalCss: [],
  componentCss: [],
  styles: {},
  windowSpecifiers: [],
  hostSpecifiers: [],
  warnings: [],
  manifest: { '.doric/papercraft/schemas/AppButton.tsx': sha256(marker) },
  ...extra,
});

/** A runner's `built` bundle answer (an `Export`). */
const builtExport = (
  marker: string,
  extra: Partial<Extract<RunnerOutput, { status: 'built' }>> = {},
): RunnerOutput => ({
  status: 'built',
  js: `export const marker = ${JSON.stringify(marker)}; export function mount() {}`,
  exportName: 'default',
  sources: {},
  globalCss: [],
  componentCss: [],
  styles: {},
  windowSpecifiers: [],
  hostSpecifiers: [],
  warnings: [],
  ...extra,
});

type Answer = LibraryOutput | RunnerOutput;

interface Job {
  readonly projectId: string;
  readonly job: JobRequest;
}

interface Setup {
  readonly world: World;
  readonly programs: ProgramsHost;
  readonly jobs: Job[];
  /** Answers each job; the default answers `none` / `unavailable`. */
  answer: (job: Job) => Answer | Promise<Answer>;
  /** The clock `now` reads. */
  time: number;
}

const worlds: World[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((entry) => entry.dispose()));
});

const setup = (options: WorldOptions = {}): Setup => {
  const host = world(options);
  worlds.push(host);
  const jobs: Job[] = [];
  const state: Pick<Setup, 'answer' | 'time'> = {
    answer: ({ job }) =>
      'kind' in job && job.kind === 'library'
        ? { status: 'none' }
        : { status: 'unavailable', reason: 'the sandbox has no `node`' },
    time: 1_000_000,
  };
  const programs = createPrograms(host.test.services, {
    runJob: async (projectId, job) => {
      const entry = { projectId, job };
      jobs.push(entry);
      return await state.answer(entry);
    },
    cwdAt: async () => undefined,
    now: () => state.time,
  });
  host.test.services.provide(programs.service);

  return {
    world: host,
    programs,
    jobs,
    get answer() {
      return state.answer;
    },
    set answer(answer) {
      state.answer = answer;
    },
    get time() {
      return state.time;
    },
    set time(time) {
      state.time = time;
    },
  };
};

const libraryJobs = (s: Setup) =>
  s.jobs.filter(({ job }) => 'kind' in job && job.kind === 'library');

const service = (s: Setup, projectId = P1) =>
  s.world.test.services.use(PapercraftProgramsV1, {
    projectId,
    threadId: 'thread-1',
  });

const ready = (answer: LibraryAnswer): ModuleRef => {
  assert.equal(answer.status, 'ready', JSON.stringify(answer));
  return (answer as Extract<LibraryAnswer, { status: 'ready' }>).module;
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const decode = (base64: string) => Buffer.from(base64, 'base64');

describe('PC9: the memo', () => {
  test('an unchanged manifest answers from the memo; a changed library gives a new module', async () => {
    const s = setup();
    s.answer = () => builtLibrary(APP, 'one');

    const first = ready(await s.programs.libraryFor(P1, APP));
    const firstJob = libraryJobs(s)[0]?.job;
    assert.equal(firstJob !== undefined && 'previous' in firstJob, false);

    s.answer = () => ({ status: 'unchanged', root: APP });
    const second = ready(await s.programs.libraryFor(P1, APP));
    const job = libraryJobs(s)[1]?.job as {
      previous?: { root: string; manifest: Record<string, string | null> };
    };
    assert.equal(job.previous?.root, APP);
    assert.equal(
      job.previous?.manifest['.doric/papercraft/schemas/AppButton.tsx'],
      sha256('one'),
    );
    assert.deepEqual(second, first);

    s.answer = () => builtLibrary(APP, 'two');
    const third = ready(await s.programs.libraryFor(P1, APP));
    assert.notEqual(third.dir, first.dir);
  });

  test("the paths the host's CSS step read join the manifest: a nested @import and a font", async () => {
    const base =
      "@font-face { font-family: Brand; src: url('./brand.woff2'); }\n.brand { font-family: Brand; }\n";
    const s = setup({
      files: { 'src/base.css': base, 'src/brand.woff2': 'FONTBYTES' },
    });
    s.answer = () =>
      builtLibrary(APP, 'css', {
        globalCss: ['src/index.css'],
        styles: {
          'src/index.css': '@import "./base.css";\n.app { color: red; }\n',
        },
      });

    const module = ready(await s.programs.libraryFor(P1, APP));
    assert.ok(module.files.some(({ path }) => path === 'index.css'));
    assert.ok(
      module.files.some(
        ({ path }) => path === `assets/${sha256('FONTBYTES')}.woff2`,
      ),
      JSON.stringify(module.files),
    );

    s.answer = () => ({ status: 'unchanged', root: APP });
    await s.programs.libraryFor(P1, APP);
    const secondJob = libraryJobs(s)[1]?.job as
      | { previous?: { manifest: Record<string, string | null> } }
      | undefined;
    const manifest = secondJob?.previous?.manifest ?? {};
    const hashOf = (suffix: string) =>
      Object.entries(manifest).find(([path]) => path.endsWith(suffix))?.[1];
    assert.equal(hashOf('src/base.css'), sha256(base));
    assert.equal(hashOf('src/brand.woff2'), sha256('FONTBYTES'));
  });

  test('a failure is kept with its manifest: an unchanged failing root does not rebuild', async () => {
    const s = setup();
    s.answer = () => ({
      status: 'failed',
      root: APP,
      error: 'AppButton.tsx: Unexpected token',
      manifest: { '.doric/papercraft/schemas/AppButton.tsx': 'h-broken' },
    });
    assert.deepEqual(await s.programs.libraryFor(P1, APP), {
      status: 'failed',
      root: APP,
      error: 'AppButton.tsx: Unexpected token',
    });

    s.answer = () => ({ status: 'unchanged', root: APP });
    assert.deepEqual(await s.programs.libraryFor(P1, APP), {
      status: 'failed',
      root: APP,
      error: 'AppButton.tsx: Unexpected token',
    });
    const job = libraryJobs(s)[1]?.job as {
      previous?: { manifest: Record<string, string | null> };
    };
    assert.deepEqual(job.previous?.manifest, {
      '.doric/papercraft/schemas/AppButton.tsx': 'h-broken',
    });
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), { root: APP });
  });

  test('a crashed or timed-out job is held 5 minutes per Project and cwd', async () => {
    const s = setup();
    const reason =
      'the sandbox could not run the bundle: timed out after 120000 ms';
    s.answer = () => ({ status: 'unavailable', reason });

    const first = await s.programs.libraryFor(P1, APP);
    assert.equal(first.status, 'failed');
    assert.match((first as { error: string }).error, /timed out/u);
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), {
      failed: (first as { error: string }).error,
    });

    s.time += HOLD_MS - 1;
    assert.deepEqual(await s.programs.libraryFor(P1, APP), first);
    assert.equal(libraryJobs(s).length, 1);

    // Another cwd, and another Project, are not held.
    await s.programs.libraryFor(P1, '/workspace/other');
    await s.programs.libraryFor(P2, APP);
    assert.equal(libraryJobs(s).length, 3);

    s.time += 2;
    s.answer = () => builtLibrary(APP, 'back');
    ready(await s.programs.libraryFor(P1, APP));
    assert.equal(libraryJobs(s).length, 4);
  });

  for (const reason of [
    'the sandbox has no `node`',
    'the sandbox has esbuild 0.1.0, the host 0.28.2',
  ]) {
    test(`"${reason}" answers failed with no hold`, async () => {
      const s = setup();
      s.answer = () => ({ status: 'unavailable', reason });

      const first = await s.programs.libraryFor(P1, APP);
      assert.equal(first.status, 'failed');
      assert.ok((first as { error: string }).error.includes(reason));
      await s.programs.libraryFor(P1, APP);

      assert.equal(libraryJobs(s).length, 2);
      assert.ok('failed' in (s.programs.lastAnswerOf(P1, APP) ?? {}));
    });
  }

  test('with no lease the memo answers, else failed; neither is kept as a hold', async () => {
    const s = setup();
    const noLease = {
      status: 'unavailable' as const,
      reason: 'the Project has no sandbox lease (unavailable)',
    };
    s.answer = () => noLease;

    assert.deepEqual(await s.programs.libraryFor(P1, APP), {
      status: 'failed',
      error:
        "The Project's sandbox is not running; repository components need it",
    });
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), {
      failed:
        "The Project's sandbox is not running; repository components need it",
    });

    s.answer = () => builtLibrary(APP, 'one');
    const built = ready(await s.programs.libraryFor(P1, APP));

    s.answer = () => noLease;
    assert.deepEqual(ready(await s.programs.libraryFor(P1, APP)), built);
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), { root: APP });
  });

  test('two Projects with the same root keep separate entries', async () => {
    const s = setup();
    s.answer = ({ projectId }) =>
      builtLibrary(APP, projectId === P1 ? 'from-p1' : 'from-p2');

    const [one, two] = await Promise.all([
      s.programs.libraryFor(P1, APP),
      s.programs.libraryFor(P2, APP),
    ]);

    assert.notEqual(ready(one).dir, ready(two).dir);
    assert.deepEqual(
      libraryJobs(s)
        .map(({ projectId }) => projectId)
        .sort(),
      [P1, P2],
    );
    // P2's next job checks against P2's own manifest.
    s.answer = () => ({ status: 'unchanged', root: APP });
    await s.programs.libraryFor(P2, APP);
    const job = libraryJobs(s).at(-1)?.job as {
      previous?: { manifest: Record<string, string | null> };
    };
    assert.equal(
      job.previous?.manifest['.doric/papercraft/schemas/AppButton.tsx'],
      sha256('from-p2'),
    );
    assert.ok(s.programs.memoOf(P1, APP));
    assert.notDeepEqual(
      s.programs.memoOf(P1, APP)?.module?.ref,
      s.programs.memoOf(P2, APP)?.module?.ref,
    );
  });

  test('above 64 MiB the least recently used key is dropped and read of its dir throws not_found', async () => {
    const s = setup();
    const big = (marker: string) =>
      builtLibrary(`/workspace/${marker}`, marker, {
        js: `export const blob = ${JSON.stringify(marker.repeat(1).padEnd(25 * 1024 * 1024, 'x'))};`,
      });
    s.answer = ({ job }) =>
      big((job as { cwd: string }).cwd.slice('/workspace/'.length));

    const a = ready(await s.programs.libraryFor(P1, '/workspace/a'));
    const b = ready(await s.programs.libraryFor(P1, '/workspace/b'));
    // `a` is used again: `b` is now the least recently used.
    await service(s).read({ dir: a.dir });
    ready(await s.programs.libraryFor(P1, '/workspace/c'));

    await assert.rejects(service(s).read({ dir: b.dir }), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.code, 'not_found');
      return true;
    });
    assert.equal(s.programs.memoOf(P1, '/workspace/b'), undefined);
    assert.ok((await service(s).read({ dir: a.dir })).entries.length > 0);
  });

  test("the cwd's last answer: none, root, and a missing cwd's failure", async () => {
    const s = setup();
    assert.equal(s.programs.lastAnswerOf(P1, APP), undefined);

    s.answer = () => ({ status: 'none' });
    assert.deepEqual(await s.programs.libraryFor(P1, APP), { status: 'none' });
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), { none: true });

    s.answer = () => builtLibrary(APP, 'one');
    await s.programs.libraryFor(P1, APP);
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), { root: APP });

    const missing = `The working directory ${APP} no longer exists`;
    s.answer = () => ({ status: 'failed', error: missing, manifest: {} });
    assert.deepEqual(await s.programs.libraryFor(P1, APP), {
      status: 'failed',
      error: missing,
    });
    assert.deepEqual(s.programs.lastAnswerOf(P1, APP), { failed: missing });
  });
});

describe('PC10: jobs per Project', () => {
  test('two calls at once start one job', async () => {
    const s = setup();
    s.answer = () => builtLibrary(APP, 'one');

    const [one, two] = await Promise.all([
      s.programs.libraryFor(P1, APP),
      s.programs.libraryFor(P1, APP),
    ]);

    assert.equal(libraryJobs(s).length, 1);
    assert.deepEqual(one, two);
  });

  test('a call during a job waits for the next job, which answers every waiting call', async () => {
    const s = setup();
    const gates = [deferred<Answer>(), deferred<Answer>()];
    let index = 0;
    s.answer = () => gates[index++]?.promise ?? builtLibrary(APP, 'late');

    const first = s.programs.libraryFor(P1, APP);
    await eventually(() => libraryJobs(s).length === 1);
    const second = s.programs.libraryFor(P1, APP);
    const third = s.programs.libraryFor(P1, APP);
    gates[0]?.resolve(builtLibrary(APP, 'job-1'));
    await eventually(() => libraryJobs(s).length === 2);
    gates[1]?.resolve(builtLibrary(APP, 'job-2'));

    const [a, b, c] = await Promise.all([first, second, third]);
    assert.equal(libraryJobs(s).length, 2);
    assert.notEqual(ready(a).dir, ready(b).dir);
    assert.deepEqual(b, c);
  });

  test('a Project runs two jobs at once; later jobs wait, library jobs ahead of exports', async () => {
    const s = setup();
    const gates = new Map<string, ReturnType<typeof deferred<Answer>>>();
    const started: string[] = [];
    s.answer = ({ job }) => {
      const name =
        'kind' in job && job.kind === 'library'
          ? `library:${job.cwd}`
          : `export:${(job as { path: string }).path}`;
      started.push(name);
      const gate = deferred<Answer>();
      gates.set(name, gate);
      return gate.promise;
    };

    const e1 = service(s).export({ path: 'src/One.tsx' });
    const e2 = service(s).export({ path: 'src/Two.tsx' });
    await eventually(() => started.length === 2);
    const e3 = service(s).export({ path: 'src/Three.tsx' });
    const lib = s.programs.libraryFor(P1, APP);
    // Another Project is not held by P1's queue.
    const other = s.programs.libraryFor(P2, '/workspace/other');
    await eventually(() => started.includes('library:/workspace/other'));
    assert.equal(started.length, 3);

    gates.get('export:src/One.tsx')?.resolve(builtExport('one'));
    await eventually(() => started.length === 4);
    assert.equal(started[3], `library:${APP}`);

    gates.get('export:src/Two.tsx')?.resolve(builtExport('two'));
    await eventually(() => started.length === 5);
    assert.equal(started[4], 'export:src/Three.tsx');

    gates.get(`library:${APP}`)?.resolve(builtLibrary(APP, 'lib'));
    gates.get('export:src/Three.tsx')?.resolve(builtExport('three'));
    gates.get('library:/workspace/other')?.resolve({ status: 'none' });
    await Promise.all([e1, e2, e3, lib, other]);
  });
});

describe('PC12: export', () => {
  test('a path that leaves the Project answers failed, with no job', async () => {
    const s = setup();

    assert.deepEqual(await service(s).export({ path: '../x.tsx' }), {
      status: 'failed',
      error: 'The path leaves the Project',
    });
    assert.equal(s.jobs.length, 0);
  });

  test('a leading / is the workspace root: both spellings build the same path', async () => {
    const s = setup();
    s.answer = () => builtExport('button');

    const one = await service(s).export({ path: '/apps/web/Button.tsx' });
    const two = await service(s).export({ path: 'apps/web/Button.tsx' });

    assert.deepEqual(
      s.jobs.map(({ job }) => (job as { path: string }).path),
      s.jobs.map(() => 'apps/web/Button.tsx'),
    );
    assert.equal(one.status, 'ready');
    assert.deepEqual(one, two);
  });

  test('an export without a name asks no entry; a named one asks its entry', async () => {
    const s = setup();
    s.answer = () => builtExport('button');

    await service(s).export({ path: 'src/Button.tsx' });
    await service(s).export({ path: 'src/Button.tsx', name: 'Primary' });

    const entries = s.jobs.map(({ job }) => (job as { entry?: string }).entry);
    assert.deepEqual(entries, [undefined, 'Primary']);
  });

  test("a module lists index.js, index.css and its sheet's assets; its dir hashes its files; read serves every file", async () => {
    const s = setup({ files: { 'src/logo.png': 'PNGBYTES' } });
    s.answer = () =>
      builtExport('logo', {
        globalCss: ['src/index.css'],
        styles: {
          'src/index.css': ".logo { background: url('./logo.png'); }\n",
        },
      });

    const answer = await service(s).export({ path: 'src/Logo.tsx' });
    assert.equal(answer.status, 'ready');
    const module = (answer as { module: ModuleRef }).module;
    const paths = module.files.map(({ path }) => path).sort();
    assert.deepEqual(paths, [
      `assets/${sha256('PNGBYTES')}.png`,
      'index.css',
      'index.js',
    ]);
    assert.equal(
      module.dir,
      sha256(
        [...module.files]
          .sort((left, right) => (left.path < right.path ? -1 : 1))
          .map(({ path, sha256: hash }) => `${path}:${hash}`)
          .join('\n'),
      ),
    );

    const { entries } = await service(s).read({ dir: module.dir });
    assert.deepEqual(
      entries.map(({ path }) => path).sort(),
      paths.map((path) => `${module.dir}/${path}`),
    );
    for (const entry of entries) {
      assert.equal(sha256(decode(entry.base64)), entry.sha256);
    }
    assert.equal(
      decode(
        entries.find(({ path }) =>
          path.endsWith(`/assets/${sha256('PNGBYTES')}.png`),
        )?.base64 ?? '',
      ).toString(),
      'PNGBYTES',
    );
  });

  test('without node, export builds through files/v1, read serves it, and the next export builds again', async () => {
    const source =
      'export default function Button() { return <button>files-v1-build</button>; }\n';
    const s = setup({ files: { 'src/Button.tsx': source } });
    const reads = () =>
      s.world.calls.filter(
        ({ method, input }) =>
          method === 'files.content' &&
          (input as { path: string }).path.replace(/^\//u, '') ===
            'src/Button.tsx',
      ).length;

    const answer = await service(s).export({ path: 'src/Button.tsx' });
    assert.equal(answer.status, 'ready', JSON.stringify(answer));
    const module = (answer as { module: ModuleRef }).module;
    const { entries } = await service(s).read({ dir: module.dir });
    const js = entries.find(({ path }) => path.endsWith('/index.js'));
    assert.match(decode(js?.base64 ?? '').toString(), /files-v1-build/u);
    const before = reads();
    assert.ok(before > 0);

    await service(s).export({ path: 'src/Button.tsx' });
    assert.ok(reads() > before, 'the second export read the source again');
  });

  test('the files/v1 harness probe stops at a nested repository (a .git file or directory)', async () => {
    const outer = [
      "import type { ReactNode } from 'react';",
      'export const decorators = [(Story: () => ReactNode) => <div data-outer-harness="outer-harness-marker"><Story /></div>];',
    ].join('\n');
    const card = 'export default function Card() { return <div>card</div>; }\n';
    const files = {
      '.storybook/preview.tsx': outer,
      'apps/web/src/Card.tsx': card,
    };
    const jsOf = async (options: WorldOptions) => {
      const s = setup(options);
      const answer = await service(s).export({ path: 'apps/web/src/Card.tsx' });
      assert.equal(answer.status, 'ready', JSON.stringify(answer));
      const { entries } = await service(s).read({
        dir: (answer as { module: ModuleRef }).module.dir,
      });
      return decode(
        entries.find(({ path }) => path.endsWith('/index.js'))?.base64 ?? '',
      ).toString();
    };

    // With no nested repository, the outer harness wraps the export.
    assert.match(await jsOf({ files }), /outer-harness-marker/u);
    // A `.git` file (a worktree) and a `.git` directory both stop the walk.
    assert.doesNotMatch(
      await jsOf({
        files: {
          ...files,
          'apps/web/.git': 'gitdir: ../../.git/worktrees/web\n',
        },
      }),
      /outer-harness-marker/u,
    );
    assert.doesNotMatch(
      await jsOf({ files, directories: ['apps/web/.git'] }),
      /outer-harness-marker/u,
    );
  });
});
