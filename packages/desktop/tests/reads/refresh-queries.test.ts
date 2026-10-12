import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QueryClient, QueryObserver } from '@tanstack/query-core';

import { refreshQueries } from '../../src/reads/refresh.js';

const client = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('rereads only the observed queries the scope selects', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const queries = client();
  const watch = (key: readonly string[]) => {
    const observer = new QueryObserver(queries, {
      queryKey: key,
      initialData: 'old',
      queryFn: async () => 'new',
    });
    const stop = observer.subscribe(() => undefined);
    context.after(stop);
    return observer;
  };
  const selected = watch(['scope', 'selected', 'tree']);
  const other = watch(['scope', 'other', 'tree']);
  const pending = refreshQueries(
    queries,
    'selected',
    (query) => query.queryKey[1] === 'selected',
  );
  context.mock.timers.tick(250);
  await pending;
  assert.equal(selected.getCurrentResult().data, 'new');
  assert.equal(other.getCurrentResult().data, 'old');
  queries.clear();
});

test('marks selected surfaces stale without reading disabled queries', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const queries = client();
  let hostReads = 0;
  const observer = new QueryObserver(queries, {
    queryKey: ['scope', 'project', 'diff'],
    enabled: false,
    initialData: 'old',
    queryFn: async () => {
      hostReads++;
      return 'new';
    },
  });
  const stop = observer.subscribe(() => undefined);
  const pending = refreshQueries(queries, 'project', () => true);
  context.mock.timers.tick(250);
  await pending;
  assert.equal(hostReads, 0);
  assert.equal(
    queries.getQueryState(['scope', 'project', 'diff'])?.isInvalidated,
    true,
  );
  stop();
  queries.clear();
});

for (const outcome of ['ready', 'pending', 'failed'] as const) {
  test(`handles a preexisting ${outcome} read without losing freshness or restarting recovery`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const queries = client();
    type Result = {
      status: 'ready' | 'pending';
      content?: string;
      retryAfterSeconds?: number;
    };
    let reads = 0;
    let finish: (result: Result) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const observer = new QueryObserver(queries, {
      queryKey: ['scope', 'project', 'tree'],
      queryFn: async (): Promise<Result> => {
        reads++;
        if (reads === 1)
          return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        return { status: 'ready', content: 'new' };
      },
    });
    const stop = observer.subscribe(() => undefined);
    const matches = () => true;
    const pending = refreshQueries(queries, 'project', matches);
    context.mock.timers.tick(250);
    await turn();
    if (outcome === 'failed') fail(new Error('offline'));
    else
      finish(
        outcome === 'pending'
          ? { status: 'pending', retryAfterSeconds: 60 }
          : { status: 'ready', content: 'old' },
      );
    await pending;
    if (outcome === 'ready')
      assert.equal(observer.getCurrentResult().data?.content, 'new');
    else {
      assert.equal(
        reads,
        1,
        'failed and pending reads own their recovery schedule',
      );
      assert.equal(
        observer.getCurrentResult().status,
        outcome === 'failed' ? 'error' : 'success',
      );
      const periodic = refreshQueries(queries, 'project', matches, true);
      context.mock.timers.tick(250);
      await periodic;
      assert.equal(reads, 1, 'periodic checks preserve the recovery schedule');
      const retry = refreshQueries(queries, 'project', matches);
      context.mock.timers.tick(250);
      await retry;
      assert.equal(observer.getCurrentResult().data?.content, 'new');
    }
    stop();
    queries.clear();
  });
}
