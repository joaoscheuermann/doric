// PC13, PC14 (D10, D28): the per-Thread entry — the `papercraft.cwd/v1`
// event papercraft appends at a prompt start and at a move during a prompt,
// the binding of a fence by its `turnSequence`, and the retained library
// instruct given only inside the two hooks once the Thread loaded the skill.
// Over the fakes of `tests/support/host.ts` and a programs host whose runner
// jobs are scripted by `cwd` (the sandbox is the boundary).
//
// Contract matrix (PC13):
// - prompt start appends the cwd event, scoped with the hook's ids, only
//   when the working directory changed; a move with a `promptId` appends
//   before it returns; a move without one appends nothing and the next prompt
//   start appends; a rejected append is retried by the next hook;
// - no instruct before the skill load; then one retained instruct
//   (`reason: 'library'`) with the prompt's `promptId`, none for the same
//   text again, again after a rewind marker, none after a rewind that removes
//   the load;
// - a prompt start with the skill loaded starts a job, the next hook gives
//   its instruct; a prompt start without the load, and a move, start none;
// - the texts: ready (one line per component), `none` once after a root,
//   `ignoredBy`'s line, 16,000 characters with the `Also:` line, a failed
//   build, a failure without a root;
// - with the setting off, neither hook reads, appends, instructs or starts a job.
// PC14:
// - `library({ turnSequence })` uses the last cwd event below the sequence;
// - fences before and after a move get different roots; a rewind that removes
//   the move rebinds later fences to the earlier root and the next hook
//   appends again; a restarted host binds the same; no event answers `none`.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { PapercraftProgramsV1 } from '../src/contracts/index.js';
import {
  createLibraryHooks,
  instructText,
  type LibraryHooks,
  MAX_INSTRUCT_CHARS,
} from '../src/host/library.js';
import {
  createPrograms,
  type JobRequest,
  type ProgramsHost,
} from '../src/host/programs.js';
import type {
  LibraryComponent,
  LibraryOutput,
} from '../src/sandbox/protocol.js';
import {
  cwdChangedInput,
  eventually,
  projectId,
  promptStartedInput,
  settle,
  type World,
  type WorldOptions,
  world,
} from './support/host.js';

const threadId = 'thread-1';
const APP = '/workspace/app';
const WEB = '/workspace/web';

const component = (name: string): LibraryComponent => ({
  name,
  description: `The ${name}.`,
  signature: `${name}(label: string)`,
  file: `.doric/papercraft/schemas/${name}.tsx`,
});

/** A runner's `built` answer for a library at `root`. */
const built = (
  root: string,
  components: readonly LibraryComponent[],
  extra: { readonly ignoredBy?: string } = {},
): LibraryOutput => ({
  status: 'built',
  root,
  js: `export const components = []; // ${root}`,
  components: [...components],
  sources: {},
  globalCss: [],
  componentCss: [],
  styles: {},
  windowSpecifiers: [],
  hostSpecifiers: [],
  warnings: [],
  manifest: { [`${root}/.doric/papercraft/schemas/`]: 'h1' },
  ...extra,
});

interface Setup {
  readonly world: World;
  readonly hooks: LibraryHooks;
  readonly programs: ProgramsHost;
  /** The library jobs run, by `cwd`. */
  readonly jobs: string[];
  /** What the runner answers a library job, by `cwd` (`none` when absent). */
  readonly outputs: Map<string, LibraryOutput>;
}

const worlds: World[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((entry) => entry.dispose()));
});

const setup = (
  options: WorldOptions = {},
  shared?: { readonly world: World },
): Setup => {
  const host = shared?.world ?? world(options);
  if (shared === undefined) worlds.push(host);
  const jobs: string[] = [];
  const outputs = new Map<string, LibraryOutput>();
  let hooks: LibraryHooks | undefined;
  const programs = createPrograms(host.test.services, {
    runJob: async (_project: string, job: JobRequest) => {
      if ('kind' in job && job.kind === 'library') {
        jobs.push(job.cwd);
        return outputs.get(job.cwd) ?? { status: 'none' };
      }
      return { status: 'unavailable', reason: 'no bundle jobs here' };
    },
    cwdAt: async (scope, turnSequence) =>
      hooks?.bindingAt(scope.threadId, turnSequence),
  });
  hooks = createLibraryHooks(host.test.services, programs);

  return { world: host, hooks, programs, jobs, outputs };
};

const started = (s: Setup, promptId: string, cwd: string) =>
  s.hooks.promptStarted(promptStartedInput(threadId, promptId, cwd));

const moved = (s: Setup, cwd: string, previous: string, promptId?: string) =>
  s.hooks.cwdChanged(cwdChangedInput(threadId, cwd, previous, promptId));

const libraryInstructs = (s: Setup) =>
  s.world.instructs.filter(({ reason }) => reason === 'library');

describe('PC13: the cwd event', () => {
  test('a prompt start appends it, scoped with the hook ids, only when the directory changed', async () => {
    const s = setup();

    await started(s, 'p1', APP);
    await started(s, 'p2', APP);
    await started(s, 'p3', WEB);

    assert.deepEqual(
      s.world.cwdRows(threadId).map((row) => [row.promptId, row.event]),
      [
        ['p1', { type: 'papercraft.cwd/v1', cwd: APP }],
        ['p3', { type: 'papercraft.cwd/v1', cwd: WEB }],
      ],
    );
    const append = s.world.calls.find(({ method }) => method === 'append');
    assert.deepEqual(
      {
        projectId: append?.call.scope?.projectId,
        threadId: append?.call.scope?.threadId,
        promptId: append?.call.scope?.promptId,
      },
      { projectId, threadId, promptId: 'p1' },
    );
  });

  test('a move during a prompt appends before the hook returns; one without a promptId appends nothing', async () => {
    const s = setup();
    await started(s, 'p1', APP);

    await moved(s, WEB, APP, 'p1');
    assert.deepEqual(
      s.world
        .cwdRows(threadId)
        .map((row) => (row.event as { cwd: string }).cwd),
      [APP, WEB],
    );

    await moved(s, APP, WEB);
    assert.equal(s.world.cwdRows(threadId).length, 2);

    await started(s, 'p2', APP);
    assert.deepEqual(
      s.world
        .cwdRows(threadId)
        .map((row) => [row.promptId, (row.event as { cwd: string }).cwd]),
      [
        ['p1', APP],
        ['p1', WEB],
        ['p2', APP],
      ],
    );
  });

  test('a rejected append leaves lastCwd: the next hook appends again', async () => {
    const s = setup();
    s.world.appendCheck = () => {
      throw new Error('the sink is closed');
    };

    await started(s, 'p1', APP);
    assert.equal(s.world.cwdRows(threadId).length, 0);

    s.world.appendCheck = () => undefined;
    await started(s, 'p2', APP);

    assert.deepEqual(
      s.world.cwdRows(threadId).map((row) => row.promptId),
      ['p2'],
    );
  });
});

describe('PC13: the library instruct', () => {
  test('none before the skill load; then one retained instruct with the prompt id', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));

    await started(s, 'p1', APP);
    assert.equal((await s.programs.libraryFor(projectId, APP)).status, 'ready');
    await started(s, 'p2', APP);
    assert.deepEqual(libraryInstructs(s), []);

    s.world.loadSkill(threadId, 'p2');
    await started(s, 'p3', APP);

    const given = libraryInstructs(s);
    assert.equal(given.length, 1);
    assert.equal(given[0]?.id, threadId);
    assert.equal(given[0]?.promptId, 'p3');
    assert.equal(given[0]?.retain, true);
    assert.match(
      given[0]?.prompt ?? '',
      /^Repository library at \/workspace\/app: 1 components?\./u,
    );
    assert.ok(
      given[0]?.prompt
        .split('\n')
        .includes('AppButton(label: string) — The AppButton.'),
      given[0]?.prompt,
    );

    // The same library at the next hook: no instruct.
    await settle();
    await started(s, 'p4', APP);
    assert.equal(libraryInstructs(s).length, 1);
  });

  test('a prompt start with the skill loaded starts a job; the next hook gives its instruct', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    await started(s, 'p1', APP);
    s.world.loadSkill(threadId, 'p1');

    await started(s, 'p2', APP);
    assert.deepEqual(libraryInstructs(s), []);
    await eventually(() => s.jobs.length === 1);
    assert.deepEqual(s.jobs, [APP]);
    await eventually(
      () => s.programs.lastAnswerOf(projectId, APP) !== undefined,
    );

    await started(s, 'p3', APP);
    assert.deepEqual(
      libraryInstructs(s).map(({ promptId }) => promptId),
      ['p3'],
    );
  });

  test('no job from a prompt start without the skill load, nor from a move; a move without promptId gives no instruct', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    s.outputs.set(WEB, built(WEB, [component('WebCard')]));

    await started(s, 'p1', APP);
    await settle();
    assert.deepEqual(s.jobs, []);

    s.world.loadSkill(threadId, 'p1');
    await moved(s, WEB, APP, 'p1');
    await settle();
    assert.deepEqual(s.jobs, []);

    await s.programs.libraryFor(projectId, APP);
    await moved(s, APP, WEB);
    assert.deepEqual(libraryInstructs(s), []);
  });

  test('a move during a prompt gives the new directory’s instruct; leaving a library gives the none text once', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    await started(s, 'p1', APP);
    s.world.loadSkill(threadId, 'p1');
    await s.programs.libraryFor(projectId, APP);
    await started(s, 'p2', APP);
    assert.equal(libraryInstructs(s).length, 1);

    await s.programs.libraryFor(projectId, WEB);
    await moved(s, WEB, APP, 'p2');
    await started(s, 'p3', WEB);

    const texts = libraryInstructs(s).map(({ prompt }) => prompt);
    assert.deepEqual(texts.slice(1), [
      'No repository library here; use built-in components only.',
    ]);
    assert.equal(libraryInstructs(s)[1]?.promptId, 'p2');
  });

  test('a rejected instruct records nothing: the next hook gives it again', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    await started(s, 'p1', APP);
    s.world.loadSkill(threadId, 'p1');
    await s.programs.libraryFor(projectId, APP);
    s.world.instructCheck = () => {
      throw new Error('the Thread is closing');
    };
    await started(s, 'p2', APP);

    s.world.instructCheck = () => undefined;
    await started(s, 'p3', APP);

    assert.deepEqual(
      libraryInstructs(s).map(({ promptId }) => promptId),
      ['p3'],
    );
  });

  test('a rewind marker gives the instruct again; a rewind that removes the load stops it until a later load', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    await started(s, 'p1', APP);
    s.world.loadSkill(threadId, 'p1');
    await s.programs.libraryFor(projectId, APP);
    await started(s, 'p2', APP);
    s.world.row(threadId, 'p2', 'text.delta', { text: 'hello' });
    assert.equal(libraryInstructs(s).length, 1);

    // A rewind of p2 keeps the load (in p1).
    s.world.rewind(threadId, 'p2');
    await started(s, 'p3', APP);
    assert.equal(libraryInstructs(s).length, 2);

    // A rewind of p1 removes the load.
    s.world.rewind(threadId, 'p1');
    await started(s, 'p4', APP);
    assert.equal(libraryInstructs(s).length, 2);

    s.world.loadSkill(threadId, 'p4');
    await started(s, 'p5', APP);
    assert.deepEqual(
      libraryInstructs(s).map(({ promptId }) => promptId),
      ['p2', 'p3', 'p5'],
    );
  });

  test('a failed build and a missing cwd give their texts', async () => {
    const s = setup();
    s.outputs.set(APP, {
      status: 'failed',
      root: APP,
      error: 'AppButton.tsx: Unexpected token',
      manifest: {},
    });
    s.outputs.set(WEB, {
      status: 'failed',
      error: `The working directory ${WEB} no longer exists`,
      manifest: {},
    });
    await started(s, 'p1', APP);
    s.world.loadSkill(threadId, 'p1');
    await s.programs.libraryFor(projectId, APP);
    await started(s, 'p2', APP);

    await s.programs.libraryFor(projectId, WEB);
    await moved(s, WEB, APP, 'p2');

    assert.deepEqual(
      libraryInstructs(s).map(({ prompt }) => prompt),
      [
        `The repository library at ${APP} did not compile: AppButton.tsx: Unexpected token`,
        `The repository library could not be checked: The working directory ${WEB} no longer exists`,
      ],
    );
  });

  test('with the setting off, neither hook reads, appends, instructs or starts a job', async () => {
    const s = setup({ enabled: false });
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    s.world.row(threadId, 'p0', 'text.delta', { text: 'before' });
    s.world.loadSkill(threadId, 'p0');

    await started(s, 'p1', APP);
    await moved(s, WEB, APP, 'p1');
    await settle();

    assert.equal(s.world.reads(), 0);
    assert.deepEqual(s.world.cwdRows(threadId), []);
    assert.deepEqual(s.world.instructs, []);
    assert.deepEqual(s.jobs, []);
  });
});

describe('PC13: instructText', () => {
  const ready = (
    root: string,
    components: readonly LibraryComponent[],
    ignoredBy?: string,
  ) =>
    [
      { root },
      {
        root,
        components,
        ...(ignoredBy === undefined ? {} : { ignoredBy }),
      },
    ] as const;

  test('a ready root: the count, then one line per component in order', () => {
    const [answer, entry] = ready(APP, [
      component('AppButton'),
      component('AppCard'),
    ]);

    const result = instructText(answer, entry, undefined);

    assert.equal(result?.root, APP);
    const lines = result?.text.split('\n') ?? [];
    assert.match(
      lines[0] ?? '',
      /^Repository library at \/workspace\/app: 2 components\.$/u,
    );
    assert.deepEqual(lines.slice(1), [
      'AppButton(label: string) — The AppButton.',
      'AppCard(label: string) — The AppCard.',
    ]);
  });

  test('an ignoredBy adds its line', () => {
    const [answer, entry] = ready(
      APP,
      [component('AppButton')],
      '.gitignore:9',
    );

    assert.ok(
      instructText(answer, entry, undefined)?.text.includes(
        "Git ignores these schema files (`.gitignore:9`), so they are not versioned. Tell the reader. Removing that rule keeps Doric's app state out of Git, because each Doric folder under `.doric/` has its own `.gitignore`.",
      ),
    );
  });

  test('a text past 16,000 characters ends with the Also: line and stays within the limit', () => {
    const components = Array.from({ length: 100 }, (_, index) => ({
      ...component(`Component${String(index).padStart(3, '0')}`),
      signature: `Component${String(index).padStart(3, '0')}(${'field: string, '.repeat(14)}last: string)`,
    }));
    for (const ignoredBy of [undefined, '.gitignore:9']) {
      const [answer, entry] = ready(APP, components, ignoredBy);

      const text = instructText(answer, entry, undefined)?.text ?? '';

      assert.equal(MAX_INSTRUCT_CHARS, 16_000);
      assert.ok(text.length <= 16_000, String(text.length));
      const lines = text.split('\n');
      const also = lines.find((line) => line.startsWith('Also: '));
      assert.ok(also, 'an Also: line');
      assert.match(also, /; read their schema files for their props\.$/u);
      const listed = lines
        .filter((line) => / — /u.test(line))
        .map((line) => line.slice(0, line.indexOf('(')));
      const rest = also
        .slice('Also: '.length, also.indexOf('; read their'))
        .split(', ');
      assert.deepEqual(
        [...listed, ...rest],
        components.map(({ name }) => name),
      );
      if (ignoredBy !== undefined) {
        assert.ok(text.includes(`(\`${ignoredBy}\`)`));
      }
    }
  });

  test('none: the text only after a root, with root null', () => {
    assert.deepEqual(instructText({ none: true }, undefined, APP), {
      root: null,
      text: 'No repository library here; use built-in components only.',
    });
    assert.equal(instructText({ none: true }, undefined, null), undefined);
    assert.equal(instructText({ none: true }, undefined, undefined), undefined);
    assert.equal(instructText(undefined, undefined, APP), undefined);
  });

  test('a failed root, and a failure without a root (a missing lease)', () => {
    assert.deepEqual(
      instructText({ root: APP }, { root: APP, error: 'boom' }, undefined),
      {
        root: APP,
        text: `The repository library at ${APP} did not compile: boom`,
      },
    );
    assert.deepEqual(
      instructText(
        {
          failed:
            "The Project's sandbox is not running; repository components need it",
        },
        undefined,
        undefined,
      ),
      {
        root: null,
        text: "The repository library could not be checked: The Project's sandbox is not running; repository components need it",
      },
    );
  });
});

describe('PC14: binding by turnSequence', () => {
  const library = (s: Setup, turnSequence: number) =>
    s.world.test.services
      .use(PapercraftProgramsV1, { projectId, threadId })
      .library({ turnSequence });

  test('fences before and after a move bind to their own directory; no event answers none', async () => {
    const s = setup();
    s.outputs.set(APP, built(APP, [component('AppButton')]));
    s.outputs.set(WEB, built(WEB, [component('WebCard')]));

    assert.deepEqual(await library(s, 1), { status: 'none' });

    await started(s, 'p1', APP);
    const before = s.world.row(threadId, 'p1', 'text.delta', {
      text: 'fence 1',
    });
    await moved(s, WEB, APP, 'p1');
    const after = s.world.row(threadId, 'p1', 'text.delta', {
      text: 'fence 2',
    });
    await started(s, 'p2', WEB);

    const [appEvent, webEvent] = s.world.cwdRows(threadId);
    assert.equal(
      s.hooks.bindingAt(threadId, appEvent?.sequence ?? 0),
      undefined,
    );
    assert.equal(s.hooks.bindingAt(threadId, before.sequence), APP);
    assert.equal(s.hooks.bindingAt(threadId, webEvent?.sequence ?? 0), APP);
    assert.equal(s.hooks.bindingAt(threadId, after.sequence), WEB);

    const first = await library(s, before.sequence);
    const second = await library(s, after.sequence);
    assert.equal(first.status === 'ready' ? first.root : first.status, APP);
    assert.equal(second.status === 'ready' ? second.root : second.status, WEB);
  });

  test('a rewind removing the move rebinds later fences; the next hook appends again; a restarted host agrees', async () => {
    const s = setup();
    await started(s, 'p1', APP);
    await started(s, 'p2', WEB);
    s.world.row(threadId, 'p2', 'text.delta', { text: 'fence' });

    s.world.rewind(threadId, 'p2');
    const fence = s.world.row(threadId, 'p3', 'text.delta', {
      text: 'later fence',
    });
    await started(s, 'p3', WEB);

    // The rewind dropped p2's event: a fence below p3's new event binds to APP.
    assert.equal(s.hooks.bindingAt(threadId, fence.sequence), APP);
    assert.deepEqual(
      s.world
        .cwdRows(threadId)
        .map((row) => [row.promptId, (row.event as { cwd: string }).cwd]),
      [
        ['p1', APP],
        ['p3', WEB],
      ],
    );

    // A host restarted after the rewind reads the same log.
    const restarted = setup({}, { world: s.world });
    await restarted.hooks.promptStarted(
      promptStartedInput(threadId, 'p4', WEB),
    );
    assert.equal(restarted.hooks.bindingAt(threadId, fence.sequence), APP);
  });
});
