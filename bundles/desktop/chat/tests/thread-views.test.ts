// Which Threads the window shows (bundle isolation 4(c), T4.13, spec §10,
// D33, Q7), as the chat holds them from this step: the Thread of its Thread
// route, and the Thread of the selected tab when the tab's id is `thread:`
// followed by its `props.threadId`; a file tab, a tab with another id, the
// Project route with no such tab and a route with no owner add none, and a
// Thread in both places counts once. The watch takes a view of the mirror for
// each, on every change of the route, of the tabs or of a record takes the
// views of the new set before it disposes those of the set before, and its
// cleanup disposes all. Rewritten from the layout's
// `tests/thread-views.test.ts:82-141`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Disposable, Services } from 'bundle/contracts';
import { createRecordsApi } from 'runtime/testing';

import { threadsOnScreen } from '../src/client/domain/thread-views.js';
import { watchThreadViews } from '../src/client/services/thread-views.js';

const THREAD_PATTERN = '/projects/:projectId/threads/:threadId';
const PROJECT_PATTERN = '/projects/:projectId';

interface Match {
  readonly path: string;
  readonly pattern: string;
  readonly params: Record<string, string>;
}

interface Tab {
  readonly id: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

const threadRoute = (threadId: string): Match => ({
  path: `/projects/p1/threads/${threadId}`,
  pattern: THREAD_PATTERN,
  params: { projectId: 'p1', threadId },
});

const projectRoute: Match = {
  path: '/projects/p1',
  pattern: PROJECT_PATTERN,
  params: { projectId: 'p1' },
};

const threadTab = (threadId: string): Tab => ({
  id: `thread:${threadId}`,
  props: { projectId: 'p1', threadId },
});

const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

describe('threadsOnScreen (T4.13)', () => {
  test("a Thread route with no tab shows the route's Thread", () => {
    assert.deepEqual(sorted(threadsOnScreen(threadRoute('t1'), undefined)), [
      't1',
    ]);
  });

  test('a selected tab thread:<id> adds its Thread', () => {
    assert.deepEqual(
      sorted(threadsOnScreen(threadRoute('t1'), threadTab('t2'))),
      ['t1', 't2'],
    );
  });

  test("a tab of the route's own Thread counts once", () => {
    assert.deepEqual(
      sorted(threadsOnScreen(threadRoute('t1'), threadTab('t1'))),
      ['t1'],
    );
  });

  test('a file tab adds nothing', () => {
    assert.deepEqual(
      sorted(
        threadsOnScreen(threadRoute('t1'), {
          id: 'file:src/a.ts',
          props: { path: 'src/a.ts' },
        }),
      ),
      ['t1'],
    );
  });

  test('a tab whose id is not thread:<props.threadId> adds nothing', () => {
    assert.deepEqual(
      sorted(
        threadsOnScreen(threadRoute('t1'), {
          id: 'x',
          props: { threadId: 't3' },
        }),
      ),
      ['t1'],
    );
    assert.deepEqual(
      sorted(
        threadsOnScreen(threadRoute('t1'), {
          id: 'thread:t4',
          props: { threadId: 't3' },
        }),
      ),
      ['t1'],
    );
  });

  test('the Project route with no tab shows nothing', () => {
    assert.deepEqual(sorted(threadsOnScreen(projectRoute, undefined)), []);
  });

  test("the Project route shows its selected tab's Thread", () => {
    assert.deepEqual(sorted(threadsOnScreen(projectRoute, threadTab('t2'))), [
      't2',
    ]);
  });

  test('a route with no owner shows only its Thread, and no route shows nothing', () => {
    // On a route with no owner `layout.tabs/v2.current()` answers nothing.
    assert.deepEqual(sorted(threadsOnScreen(threadRoute('t1'), undefined)), [
      't1',
    ]);
    assert.deepEqual(sorted(threadsOnScreen(undefined, undefined)), []);
  });
});

/**
 * The three sources the watch reads, as fakes at the bundle boundary: the
 * window's `navigation/v1`, the shell's `layout.tabs/v2` and the records
 * mirror, whose `view` records each take and dispose in one log.
 */
const sources = (route: Match | undefined) => {
  const log: string[] = [];
  let taken = 0;
  const records = createRecordsApi({});
  records.view = ({ threadId }): Disposable => {
    taken += 1;
    const name = `${threadId}#${taken}`;
    log.push(`take ${name}`);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        log.push(`dispose ${name}`);
      },
    };
  };
  const recordListeners = new Set<() => void>();
  records.subscribe = (listener) => {
    recordListeners.add(listener);
    return { dispose: () => void recordListeners.delete(listener) };
  };

  let current = route;
  const routeListeners = new Set<(match: Match | undefined) => void>();
  const navigation = {
    current: () => current,
    subscribe: (listener: (match: Match | undefined) => void) => {
      routeListeners.add(listener);
      return { dispose: () => void routeListeners.delete(listener) };
    },
  };

  let tab: Tab | undefined;
  const tabListeners = new Set<() => void>();
  const tabs = {
    current: () => tab,
    subscribe: (listener: () => void) => {
      tabListeners.add(listener);
      return { dispose: () => void tabListeners.delete(listener) };
    },
  };

  const apis: Record<string, unknown> = {
    'navigation/v1': navigation,
    'layout.tabs/v2': tabs,
    'runtime.records/v1': records,
  };
  const services = {
    use: (contract: { readonly id: string }) => {
      const api = apis[contract.id];
      if (api === undefined) throw new Error(`No "${contract.id}" here.`);
      return api;
    },
    whenAvailable: (
      contract: { readonly id: string },
      callback: (api: unknown) => undefined | (() => unknown),
    ): Disposable => {
      const api = apis[contract.id];
      if (api === undefined) return { dispose: () => undefined };
      const cleanup = callback(api);
      return {
        dispose: () => {
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  } as unknown as Services;

  return {
    services,
    log,
    navigate: (next: Match | undefined) => {
      current = next;
      for (const listener of [...routeListeners]) listener(next);
    },
    select: (next: Tab | undefined) => {
      tab = next;
      for (const listener of [...tabListeners]) listener();
    },
    recordsChanged: () => {
      for (const listener of [...recordListeners]) listener();
    },
  };
};

describe('watchThreadViews (T4.13)', () => {
  test("at once it holds a view of the route's Thread", () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);

    assert.deepEqual(fake.log, ['take t1#1']);
    stop();
  });

  test('a route change takes the new view before it disposes the old one', () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);

    fake.navigate(threadRoute('t2'));

    const take = fake.log.indexOf('take t2#2');
    const dispose = fake.log.indexOf('dispose t1#1');
    assert.ok(take >= 0, `No view of t2 was taken: ${fake.log.join(', ')}`);
    assert.ok(dispose >= 0, `The view of t1 was kept: ${fake.log.join(', ')}`);
    assert.ok(take < dispose, `t1 was disposed first: ${fake.log.join(', ')}`);
    stop();
  });

  test('a tab change adds its Thread and keeps the view of the route Thread open', () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);

    fake.select(threadTab('t2'));

    const open = new Map<string, number>();
    for (const entry of fake.log) {
      const [action, name] = entry.split(' ') as [string, string];
      const thread = name.split('#')[0] ?? '';
      open.set(thread, (open.get(thread) ?? 0) + (action === 'take' ? 1 : -1));
    }
    assert.equal(open.get('t1'), 1, `t1 lost its view: ${fake.log.join(', ')}`);
    assert.equal(open.get('t2'), 1, `t2 has no view: ${fake.log.join(', ')}`);
    stop();
  });

  test('a Thread in both the route and the selected tab holds one view', () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);

    fake.select(threadTab('t1'));

    const takes = fake.log.filter((entry) => entry.startsWith('take t1'));
    const disposes = fake.log.filter((entry) => entry.startsWith('dispose t1'));
    assert.equal(takes.length - disposes.length, 1, fake.log.join(', '));
    stop();
  });

  test('a change of a record takes the views again before it disposes the earlier ones', () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);

    fake.recordsChanged();

    const take = fake.log.indexOf('take t1#2');
    const dispose = fake.log.indexOf('dispose t1#1');
    assert.ok(take >= 0, `No view was taken again: ${fake.log.join(', ')}`);
    assert.ok(
      dispose >= 0,
      `The earlier view was kept: ${fake.log.join(', ')}`,
    );
    assert.ok(
      take < dispose,
      `The view was disposed first: ${fake.log.join(', ')}`,
    );
    stop();
  });

  test('the cleanup disposes every view it holds, and nothing is taken after it', () => {
    const fake = sources(threadRoute('t1'));
    const stop = watchThreadViews(fake.services);
    fake.select(threadTab('t2'));

    stop();
    const takes = fake.log.filter((entry) => entry.startsWith('take')).length;
    const disposes = fake.log.filter((entry) =>
      entry.startsWith('dispose'),
    ).length;
    assert.equal(
      takes,
      disposes,
      `A view outlived the cleanup: ${fake.log.join(', ')}`,
    );

    fake.navigate(threadRoute('t3'));
    fake.recordsChanged();
    assert.equal(
      fake.log.filter((entry) => entry.startsWith('take')).length,
      takes,
      'A view was taken after the cleanup.',
    );
  });
});
