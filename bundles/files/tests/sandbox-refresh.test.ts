/**
 * The files client's refresh of one Project: it rereads the Project's sandbox
 * reads in its own query client and leaves every other query alone. Git's Thread
 * summaries and changes live in the git bundle's client and are reread there.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QueryClient, QueryObserver } from '@tanstack/query-core';

import { refreshSandbox } from '../src/client/sandbox-store.js';

const client = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });

test('rereads the sandbox reads of the owning Project and nothing else', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const queries = client();
  const watch = (key: readonly unknown[]) => {
    const observer = new QueryObserver(queries, {
      queryKey: key,
      initialData: 'old',
      queryFn: async () => 'new',
    });
    const stop = observer.subscribe(() => undefined);
    context.after(stop);
    return observer;
  };
  const tree = watch(['files', 'selected', 'tree', undefined]);
  const file = watch(['files', 'selected', 'file', 'src/app.ts']);
  const otherTree = watch(['files', 'other', 'tree', undefined]);
  const thread = watch(['thread', 'selected-thread', 'git']);
  const pending = refreshSandbox(queries, 'selected', false);
  context.mock.timers.tick(250);
  await pending;
  assert.equal(tree.getCurrentResult().data, 'new');
  assert.equal(file.getCurrentResult().data, 'new');
  assert.equal(otherTree.getCurrentResult().data, 'old');
  assert.equal(thread.getCurrentResult().data, 'old');
  queries.clear();
});
