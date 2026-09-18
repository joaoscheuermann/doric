import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenRouterCatalog } from '../src/lib/providers/unified/catalog.js';
import type { Model } from '../src/lib/types/provider.js';

const models: readonly Model[] = [
  { id: 'model', raw: { supported_parameters: ['tools'] } },
];

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

for (const cancelled of ['initiator', 'follower'] as const) {
  test(`cancels the ${cancelled} promptly without interrupting shared catalog loading`, async () => {
    const loading = deferred<readonly Model[]>();
    let loads = 0;
    const catalog = createOpenRouterCatalog((signal) => {
      loads += 1;
      signal?.addEventListener('abort', () => loading.reject(signal.reason));
      return loading.promise;
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const first = catalog(
      'model',
      cancelled === 'initiator' ? controller.signal : undefined,
    );
    const second = catalog(
      'model',
      cancelled === 'follower' ? controller.signal : undefined,
    );
    const cancelledWait = cancelled === 'initiator' ? first : second;
    const survivingWait = cancelled === 'initiator' ? second : first;
    const rejected = assert.rejects(cancelledWait, (error) => error === reason);

    controller.abort(reason);
    try {
      await Promise.race([
        rejected,
        new Promise<never>((_, reject) => {
          setImmediate(() =>
            reject(new Error('abort did not settle the waiter')),
          );
        }),
      ]);
    } finally {
      loading.resolve(models);
    }

    assert.equal((await survivingWait).parameters.has('tools'), true);
    assert.equal((await catalog('model')).parameters.has('tools'), true);
    assert.equal(loads, 1);
  });
}

test('rejects already aborted callers without loading, including cached lookups', async () => {
  let loads = 0;
  const catalog = createOpenRouterCatalog(async () => {
    loads += 1;
    return models;
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(catalog('model', controller.signal), {
    name: 'AbortError',
  });
  assert.equal(loads, 0);
  await catalog('model');
  await assert.rejects(catalog('model', controller.signal), {
    name: 'AbortError',
  });
  assert.equal(loads, 1);
});

test('uses the cache until TTL and preserves stale support after refresh failure', async (t) => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  let loads = 0;
  const catalog = createOpenRouterCatalog(async () => {
    loads += 1;
    if (loads === 2) throw new Error('offline');
    return loads === 1 ? models : [];
  }, 10);

  assert.equal((await catalog('model')).parameters.has('tools'), true);
  now = 109;
  assert.equal((await catalog('model')).parameters.has('tools'), true);
  assert.equal(loads, 1);
  now = 110;
  assert.equal((await catalog('model')).parameters.has('tools'), true);
  assert.equal(loads, 2);
  assert.deepEqual(await catalog('model'), {
    known: true,
    parameters: new Set(),
  });
});

test('returns unknown support on initial failure and retries on the next lookup', async () => {
  let offline = true;
  const catalog = createOpenRouterCatalog(async () => {
    if (offline) throw new Error('offline');
    return models;
  });

  assert.equal((await catalog('model')).known, false);
  offline = false;
  assert.equal((await catalog('model')).parameters.has('tools'), true);
  assert.deepEqual(await catalog('missing'), {
    known: true,
    parameters: new Set(),
  });
});
