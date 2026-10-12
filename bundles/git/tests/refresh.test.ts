/**
 * The git client's refresh of one Project: it rereads the Project's changes,
 * its file comparisons and the Git summary of each Thread that carries the
 * Project, in its own query client, and leaves the other Projects alone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QueryClient, QueryObserver } from '@tanstack/query-core';

import { createGitStore } from '../src/client/changes/store.js';

const client = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });

test('rereads the changes and Thread summaries of the owning Project only', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const queries = client();
  const store = createGitStore(() => {
    throw new Error('no host in this test');
  }, queries);
  const watch = (key: readonly unknown[], projectId?: string) => {
    const observer = new QueryObserver(queries, {
      queryKey: key,
      ...(projectId === undefined ? {} : { meta: { projectId } }),
      initialData: 'old',
      queryFn: async () => 'new',
    });
    const stop = observer.subscribe(() => undefined);
    context.after(stop);
    return observer;
  };
  const changes = watch(['files', 'selected', 'changes', undefined]);
  const comparison = watch(['files', 'selected', 'file-diff', '', 'a.ts']);
  const summary = watch(['thread', 'thread-1', 'git'], 'selected');
  const foreign = watch(['thread', 'thread-2', 'git'], 'other');
  const pending = store.refresh('selected', false);
  context.mock.timers.tick(250);
  await pending;
  assert.equal(changes.getCurrentResult().data, 'new');
  assert.equal(comparison.getCurrentResult().data, 'new');
  assert.equal(summary.getCurrentResult().data, 'new');
  assert.equal(foreign.getCurrentResult().data, 'old');
  store.dispose();
});
