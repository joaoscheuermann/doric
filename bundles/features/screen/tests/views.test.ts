// The desktop part's views owner: the list, its cache file, the dials it asks
// for, the state a window watches, and the windows it opens or re-points when
// the host answers.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Disposable } from 'bundle/contracts';

import type { ScreenAttach, ScreenViewsState } from '../src/contracts/index.js';
import { LIVE_RETRY_MS } from '../src/desktop/status.js';
import {
  createScreenViews,
  type ScreenViews,
  type ScreenViewsClock,
  type ScreenViewsEnv,
} from '../src/desktop/views.js';
import type {
  OpenScreenWindow,
  ScreenWindows,
} from '../src/desktop/windows.js';

/** A fresh directory per test, so the cache file is the test's alone. */
const workspace = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'screen-views-'));

/** A microtask flush: the watch's first push lands after its cache read. */
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** One view id per call, so a persisted file is comparable. */
const ids = (): (() => string) => {
  let next = 0;

  return () => {
    next += 1;

    return `v${next}`;
  };
};

/** The platform windows as a recorder: nothing here needs Electron. */
const fakeWindows = () => {
  const opened: OpenScreenWindow[] = [];
  const navigated: { readonly key: string; readonly path: string }[] = [];
  const focused: string[] = [];
  const present = new Set<string>();

  const windows: ScreenWindows = {
    open: async (request) => {
      opened.push(request);
      present.add(request.key);
    },
    focus: async (key) => {
      focused.push(key);

      return present.has(key);
    },
    navigate: async (input) => {
      navigated.push(input);
    },
  };

  return { windows, opened, navigated, focused, present };
};

/** A clock the test drives: `tick()` runs the loop's own pass. */
const fakeClock = () => {
  let now = 0;
  let run: () => void = () => undefined;

  const clock: ScreenViewsClock = {
    now: () => now,
    every: (_ms, pass) => {
      run = pass;

      return { dispose: () => undefined } satisfies Disposable;
    },
  };

  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => run(),
  };
};

const ready = (path: string): ScreenAttach => ({
  status: 'ready',
  path,
  display: ':100',
});

/** Watches the state and keeps every push, so a test can read the last one. */
const watchState = async (
  owner: ScreenViews,
  env: ScreenViewsEnv,
  revision = 0,
) => {
  const states: ScreenViewsState[] = [];
  const watching = owner.watch(revision, (state) => states.push(state), env);

  await settled();

  return {
    states,
    last: () => states.at(-1),
    stop: () => watching.dispose(),
  };
};

void test('a view is listed, persisted and re-read by the next run', async () => {
  const directory = await workspace();
  const owner = createScreenViews({ clock: fakeClock().clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);

  assert.deepEqual(view, {
    id: 'v1',
    label: 'Alpha',
    projectId: 'p1',
    status: { kind: 'waiting' },
  });
  assert.deepEqual(await owner.list(env), [view]);

  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'views.json'), 'utf8')),
    {
      version: 1,
      views: [{ id: 'v1', label: 'Alpha', projectId: 'p1' }],
    },
  );

  const restarted = createScreenViews({ clock: fakeClock().clock, id: ids() });
  const reopened = await restarted.list({
    directory: async () => directory,
    windows: fakeWindows().windows,
  });

  assert.deepEqual(reopened, [view]);
  // The status is never stored: a restarted app asks for it again.
  assert.deepEqual(reopened[0]?.status, { kind: 'waiting' });

  owner.dispose();
  restarted.dispose();
});

void test('a corrupt cache reads as no views at all', async () => {
  const directory = await workspace();
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  for (const contents of [
    'not json',
    JSON.stringify({ version: 2, views: [] }),
    JSON.stringify({
      version: 1,
      views: [{ id: 'v1', label: '', projectId: 'p1' }],
    }),
    JSON.stringify({ version: 1, views: 'nope' }),
  ]) {
    await writeFile(join(directory, 'views.json'), contents);

    const owner = createScreenViews({ clock: fakeClock().clock });

    assert.deepEqual(await owner.list(env), [], contents);
    owner.dispose();
  }
});

void test('the state is pushed to a window, once per change', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);

  // A window that passes a stale cursor gets the current state at once.
  const watching = await watchState(owner, env);

  assert.equal(watching.states.length, 1);
  assert.deepEqual(watching.last()?.views, [view]);
  assert.deepEqual(watching.last()?.dials, []);

  const first = watching.last()?.revision ?? 0;

  // The reader's retry makes the next pass dial, which is a change.
  await owner.retry(view.id, env);
  clock.tick();

  assert.equal(watching.states.length, 2);
  assert.ok((watching.last()?.revision ?? 0) > first);
  assert.deepEqual(watching.last()?.dials, [
    { viewId: 'v1', projectId: 'p1', seq: 1 },
  ]);

  // Nothing changed: a pass with no dial to make pushes nothing.
  clock.tick();

  assert.equal(watching.states.length, 2);

  // A window that already holds the current state gets nothing on subscribe;
  // one that holds none gets that state.
  const current = watching.last() as ScreenViewsState;
  const upToDate = await watchState(owner, env, current.revision);
  const fresh = await watchState(owner, env);

  assert.equal(upToDate.states.length, 0);
  assert.deepEqual(fresh.last()?.revision, current.revision);

  watching.stop();
  upToDate.stop();
  fresh.stop();
  owner.dispose();
});

void test('a view the reader opens is dialled, and a ready answer opens its window', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const fake = fakeWindows();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fake.windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);
  const watching = await watchState(owner, env);

  await owner.open(view.id, env);
  clock.tick();

  const dial = watching.last()?.dials[0];

  assert.deepEqual(dial, { viewId: 'v1', projectId: 'p1', seq: 1 });

  await owner.deliver(
    { viewId: 'v1', seq: dial?.seq ?? 0, answer: ready('/screen/a/') },
    env,
  );

  assert.deepEqual(fake.opened, [
    {
      key: 'screen:v1',
      view: { path: '/screen/a/', partition: 'screen:v1', title: 'Alpha' },
      appearance: { titleBar: 'native' },
    },
  ]);
  assert.deepEqual(watching.last()?.views[0]?.status, {
    kind: 'ready',
    path: '/screen/a/',
    display: ':100',
  });
  assert.deepEqual(watching.last()?.dials, []);

  watching.stop();
  owner.dispose();
});

void test('a screen that moved is navigated, not opened again', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const fake = fakeWindows();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fake.windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);
  const watching = await watchState(owner, env);

  await owner.open(view.id, env);
  clock.tick();
  await owner.deliver(
    { viewId: 'v1', seq: 1, answer: ready('/screen/a/') },
    env,
  );

  // The host generation restarted: the relay answers with a new token path.
  clock.advance(LIVE_RETRY_MS);
  clock.tick();

  const dial = watching.last()?.dials[0];

  assert.deepEqual(dial, { viewId: 'v1', projectId: 'p1', seq: 2 });

  await owner.deliver(
    {
      viewId: 'v1',
      seq: dial?.seq ?? 0,
      answer: ready('/screen/moved/'),
    },
    env,
  );

  assert.deepEqual(fake.navigated, [
    { key: 'screen:v1', path: '/screen/moved/' },
  ]);
  assert.equal(fake.opened.length, 1);
  assert.deepEqual(watching.last()?.views[0]?.status, {
    kind: 'ready',
    path: '/screen/moved/',
    display: ':100',
  });

  watching.stop();
  owner.dispose();
});

void test('a window the reader closed is opened again, not focused', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const fake = fakeWindows();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fake.windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);

  await owner.open(view.id, env);
  clock.tick();
  await owner.deliver(
    { viewId: 'v1', seq: 1, answer: ready('/screen/a/') },
    env,
  );

  assert.equal(fake.opened.length, 1);

  // The reader closed that window; a later click focuses nothing, so the
  // desktop part opens it again instead of leaving the click unanswered.
  fake.present.delete('screen:v1');

  await owner.open(view.id, env);

  assert.equal(fake.opened.length, 2);
  assert.deepEqual(fake.focused, ['screen:v1']);

  owner.dispose();
});

void test('an answer to a dial that was replaced is ignored', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const fake = fakeWindows();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fake.windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);
  const watching = await watchState(owner, env);

  clock.tick();
  await owner.deliver(
    { viewId: view.id, seq: 7, answer: ready('/screen/a/') },
    env,
  );

  assert.deepEqual(watching.last()?.views[0]?.status, { kind: 'waiting' });
  assert.deepEqual(fake.opened, []);

  watching.stop();
  owner.dispose();
});

void test('an answer that never came reads as a retryable failure', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);
  const watching = await watchState(owner, env);

  clock.tick();
  await owner.deliver(
    {
      viewId: view.id,
      seq: watching.last()?.dials[0]?.seq ?? 0,
      answer: null,
    },
    env,
  );

  assert.deepEqual(watching.last()?.views[0]?.status, { kind: 'failed' });

  watching.stop();
  owner.dispose();
});

void test('an image without xpra is never dialled again', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);
  const watching = await watchState(owner, env);

  clock.tick();
  await owner.deliver(
    {
      viewId: view.id,
      seq: watching.last()?.dials[0]?.seq ?? 0,
      answer: { status: 'unavailable', reason: 'missing-xpra' },
    },
    env,
  );

  clock.advance(60_000);
  clock.tick();

  assert.deepEqual(watching.last()?.dials, []);
  assert.deepEqual(watching.last()?.views[0]?.status, {
    kind: 'unavailable',
    reason: 'missing-xpra',
  });

  watching.stop();
  owner.dispose();
});

void test('one view per Project, and removing it persists the shorter list', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const env: ScreenViewsEnv = {
    directory: async () => directory,
    windows: fakeWindows().windows,
  };

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);

  assert.deepEqual(
    await owner.add({ projectId: 'p1', label: 'Other' }, env),
    view,
  );
  assert.equal((await owner.list(env)).length, 1);

  await owner.remove(view.id, env);

  assert.deepEqual(await owner.list(env), []);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'views.json'), 'utf8')),
    {
      version: 1,
      views: [],
    },
  );

  owner.dispose();
});

void test('a cache directory that cannot be written keeps the view in memory', async () => {
  const directory = await workspace();
  const clock = fakeClock();
  const owner = createScreenViews({ clock: clock.clock, id: ids() });
  const blocked = join(directory, 'file');
  const env: ScreenViewsEnv = {
    directory: async () => blocked,
    windows: fakeWindows().windows,
  };

  // `blocked` is a file, so it can never be a directory holding the cache.
  await writeFile(blocked, 'not a directory');

  const view = await owner.add({ projectId: 'p1', label: 'Alpha' }, env);

  assert.deepEqual(await owner.list(env), [view]);

  await rm(directory, { recursive: true, force: true });
  owner.dispose();
});
