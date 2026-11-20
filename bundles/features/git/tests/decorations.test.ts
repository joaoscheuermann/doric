// git as a provider of `files.decorations/v1` (bundle isolation 9, T9.2,
// plan cases 9–12): for a scope, git answers the marks its Changes view shows,
// from the same changes read:
// - the marks are the entries of the changes read's marks, path by path;
// - a failed read answers the read's error, and fetches when the read does;
// - `whenAvailable` reports the provider as `git`, and its `observe` answers;
// - a refresh that answers the same changes keeps the list of marks, so the
//   Files tree keeps its rows.

import assert from 'node:assert/strict';
import { describe, type TestContext, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type DecorationsObservation,
  type FileMark,
  type FilesDecorations,
  FilesDecorationsV1,
} from 'files/contracts';

import type { GitApi } from '../src/client/api/git-api.js';
import {
  createFilesDecorations,
  createGitStore,
  type GitStore,
} from '../src/client/changes/store.js';
import type {
  ChangesObservation,
  ProjectChangesResult,
} from '../src/contracts/index.js';

/** The Files tree of `project-1` rooted at the Thread's `apps/web`. */
const scope = { projectId: 'project-1', cwd: '/workspace/apps/web' };

/** One unstaged modified file in the repository at `apps/web`. */
const readyChanges = (): ProjectChangesResult => ({
  status: 'ready',
  changes: {
    path: 'apps/web',
    repositories: [
      {
        path: 'apps/web',
        changes: [
          {
            path: 'src/app.ts',
            status: 'modified',
            staged: false,
            unstaged: true,
            indexStatus: '.',
            worktreeStatus: 'M',
          },
        ],
        added: 1,
        removed: 1,
      },
    ],
  },
});

const unexpected = (): never => {
  throw new Error('Only the changes are read.');
};

/** The host's git calls, of which only `changes` answers. */
const fakeApi = (changes: GitApi['changes']): GitApi => ({
  changes,
  fileDiff: unexpected,
  git: unexpected,
  branches: unexpected,
  switchBranch: unexpected,
  discard: unexpected,
});

const storeOver = (t: TestContext, changes: GitApi['changes']): GitStore => {
  const api = fakeApi(changes);
  const store = createGitStore(() => api);
  t.after(() => store.dispose());
  return store;
};

/** The providers of `files.decorations/v1` when git provides it over `store`. */
const providersOver = (t: TestContext, store: GitStore) => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    providers: [{ bundleId: 'git', provide: [createFilesDecorations(store)] }],
  });
  const found: { readonly bundleId: string; readonly api: FilesDecorations }[] =
    [];
  const binding = harness.services.whenAvailable(
    FilesDecorationsV1,
    (api, { bundleId }) => {
      found.push({ bundleId, api });
    },
  );
  t.after(async () => {
    binding.dispose();
    await harness.dispose();
  });
  return found;
};

/** git's `observe`, the only provider's. */
const gitDecorations = (t: TestContext, store: GitStore): FilesDecorations => {
  const [git] = providersOver(t, store);
  assert.ok(git, 'git does not provide files.decorations/v1.');
  return git.api;
};

/**
 * Observes until `done` holds for a state: `states` holds every state seen,
 * and `settled` the first for which `done` holds. The observation stays open
 * until the test ends.
 */
const watch = <S>(
  t: TestContext,
  observe: (listener: (state: S) => void) => Disposable,
  done: (state: S) => boolean,
): { readonly states: S[]; readonly settled: Promise<S> } => {
  const states: S[] = [];
  let resolve: (state: S) => void = () => undefined;
  const settled = new Promise<S>((ready) => {
    resolve = ready;
  });
  const observation = observe((state) => {
    states.push(state);
    if (done(state)) resolve(state);
  });
  t.after(() => observation.dispose());
  return { states, settled };
};

const answered = (state: DecorationsObservation): boolean =>
  !state.fetching && (state.marks.length > 0 || state.error !== undefined);

const read = (state: ChangesObservation): boolean =>
  !state.fetching &&
  (state.read.status === 'ready' || state.error !== undefined);

type Entry = { readonly path: string; readonly mark: FileMark };

const byPath = (entries: readonly Entry[]): Entry[] =>
  [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

describe('git as a provider of files.decorations/v1', () => {
  test('answers for a scope the marks of the changes read of the same scope', async (t) => {
    const store = storeOver(t, async () => readyChanges());
    const decorations = watch(
      t,
      (listener) => gitDecorations(t, store).observe(scope, listener),
      answered,
    );
    const changes = watch(
      t,
      (listener) => store.observeChanges(scope, listener),
      read,
    );

    const marks = (await decorations.settled).marks;
    const shown = (await changes.settled).decorations;

    assert.deepEqual(
      byPath(marks),
      byPath([...shown].map(([path, mark]) => ({ path, mark }))),
    );
    const directory: FileMark = {
      description: '1 changed file',
      count: 1,
      tone: 'text-[var(--git-modified)]',
      letter: 'M',
      struck: false,
    };
    assert.deepEqual(byPath(marks), [
      { path: 'apps', mark: directory },
      { path: 'apps/web', mark: directory },
      { path: 'apps/web/src', mark: directory },
      {
        path: 'apps/web/src/app.ts',
        mark: {
          description: 'modified · Unstaged',
          count: 1,
          tone: 'text-[var(--git-modified)]',
          letter: 'M',
          struck: false,
        },
      },
    ]);
  });

  test("answers a failed read's error, and fetches when the read does", async (t) => {
    // The read retries a failure a bounded number of times, seconds apart.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = storeOver(t, async () => {
      throw new Error('Doric backend is unavailable.');
    });
    const decorations = watch(
      t,
      (listener) => gitDecorations(t, store).observe(scope, listener),
      answered,
    );
    const changes = watch(
      t,
      (listener) => store.observeChanges(scope, listener),
      read,
    );
    await flush();
    assert.equal(decorations.states.at(-1)?.fetching, true);
    assert.equal(
      decorations.states.at(-1)?.fetching,
      changes.states.at(-1)?.fetching,
    );

    for (let second = 0; second < 30; second += 1) {
      t.mock.timers.tick(1000);
      await flush();
    }

    const failed = await decorations.settled;
    const shown = await changes.settled;
    assert.equal(failed.error, 'Doric backend is unavailable.');
    assert.equal(failed.error, shown.error);
    assert.equal(failed.fetching, false);
    assert.equal(failed.fetching, shown.fetching);
    assert.deepEqual(failed.marks, []);
  });

  test('is reported as git, and its observe answers', async (t) => {
    const store = storeOver(t, async () => readyChanges());
    const providers = providersOver(t, store);

    assert.deepEqual(
      providers.map(({ bundleId }) => bundleId),
      ['git'],
    );
    const [git] = providers;
    assert.ok(git);
    const first = await watch<DecorationsObservation>(
      t,
      (listener) => git.api.observe(scope, listener),
      () => true,
    ).settled;
    assert.equal(typeof first.fetching, 'boolean');
    assert.ok(Array.isArray(first.marks));
  });

  test('keeps the list of marks through a refresh that answers the same changes', async (t) => {
    const store = storeOver(t, async () => readyChanges());
    const decorations = watch(
      t,
      (listener) => gitDecorations(t, store).observe(scope, listener),
      answered,
    );
    const before = await decorations.settled;
    const seen = decorations.states.length;

    await store.refresh(scope.projectId, false);
    await flush();

    const during = decorations.states.slice(seen);
    assert.ok(
      during.some((state) => state.fetching),
      'The refresh sent no notification.',
    );
    const after = decorations.states.at(-1);
    assert.equal(after?.fetching, false);
    for (const state of during) assert.equal(state.marks, before.marks);
  });
});
