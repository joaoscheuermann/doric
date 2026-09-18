import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionStore } from '../src/index.js';

type StoredValue = {
  readonly name: string;
};

test('stores and returns typed values by ID', async () => {
  const store = createSessionStore<StoredValue>();
  const value = await store.getOrCreate('alpha', () => ({ name: 'first' }));

  assert.deepEqual(value, { name: 'first' });

  assert.deepEqual(store.get('alpha'), { name: 'first' });

  await assertResolves(store.load('alpha'), { name: 'first' });
});

test('reuses the existing value when the same ID is requested again', async () => {
  const store = createSessionStore<StoredValue>();
  let calls = 0;

  const first = await store.getOrCreate('alpha', () => {
    calls += 1;

    return { name: 'first' };
  });

  const second = await store.getOrCreate('alpha', () => {
    calls += 1;

    return { name: 'second' };
  });

  assert.equal(calls, 1);

  assert.equal(second, first);
});

test('dedupes concurrent creation for the same ID', async () => {
  const store = createSessionStore<StoredValue>();
  let calls = 0;
  const pending = deferred<StoredValue>();

  const first = store.getOrCreate('alpha', () => {
    calls += 1;

    return pending.promise;
  });

  const second = store.getOrCreate('alpha', () => {
    calls += 1;

    return { name: 'second' };
  });

  assert.equal(store.load('alpha'), first);

  pending.resolve({ name: 'first' });

  assert.equal(await first, await second);

  assert.equal(calls, 1);

  assert.deepEqual(store.get('alpha'), { name: 'first' });
});

test('allows retry after creation fails', async () => {
  const store = createSessionStore<StoredValue>();
  let calls = 0;

  await assert.rejects(
    store.getOrCreate('alpha', () => {
      calls += 1;

      throw new Error('failed');
    }),
    /failed/u,
  );

  const value = await store.getOrCreate('alpha', () => {
    calls += 1;

    return { name: 'retry' };
  });

  assert.equal(calls, 2);

  assert.deepEqual(value, { name: 'retry' });
});

test('deletes resolved sessions by ID', async () => {
  const store = createSessionStore<StoredValue>();

  await store.getOrCreate('alpha', () => ({ name: 'first' }));

  assert.equal(store.delete('alpha'), true);

  assert.equal(store.delete('alpha'), false);

  assert.equal(store.get('alpha'), undefined);

  assert.equal(store.load('alpha'), undefined);
});

test('lists resolved sessions in insertion order', async () => {
  const store = createSessionStore<StoredValue>();

  await store.getOrCreate('alpha', () => ({ name: 'first' }));

  await store.getOrCreate('beta', () => ({ name: 'second' }));

  assert.deepEqual(store.list(), [
    { id: 'alpha', value: { name: 'first' } },
    { id: 'beta', value: { name: 'second' } },
  ]);
});

test('clears resolved and in-flight sessions', async () => {
  const store = createSessionStore<StoredValue>();
  const pending = deferred<StoredValue>();

  await store.getOrCreate('alpha', () => ({ name: 'first' }));

  const created = store.getOrCreate('beta', () => pending.promise);

  store.clear();

  pending.resolve({ name: 'second' });

  await created;

  assert.deepEqual(store.list(), []);

  assert.equal(store.load('beta'), undefined);
});

const assertResolves = async <Value>(
  promise: Promise<Value> | undefined,
  expected: Value,
): Promise<void> => {
  assert.ok(promise, 'expected a session promise');

  assert.deepEqual(await promise, expected);
};

const deferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} => {
  let resolve: (value: Value) => void = () => undefined;

  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};
