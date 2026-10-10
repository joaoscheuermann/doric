// Stream methods [S8-20]: a `streamListener` argument records its item
// schema in the contract document, a function or an observer listens, and
// across the process envelope the listener crosses with the callback codec.
// The envelope also parses the bridge `end` kind and the desktop lifecycle
// control messages.

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  type CatalogChange,
  DoricCatalogV1,
  defineMethod,
  defineService,
  type StreamListener,
  streamListener,
  toStreamObserver,
} from '../src/contracts/index.js';
import { ajvValidators } from '../src/process/ajv.js';
import {
  documentMethodSpecs,
  wireMessageSchema,
} from '../src/runtime/envelope/index.js';
import {
  contractDocument,
  DiagnosticsStore,
  memberSchema,
  providePlatformServices,
  STREAM_KEY,
  streamItemSchema,
} from '../src/runtime/index.js';
import { processes, snapshot } from './support/envelope.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

void test('a stream method records its item schema, and a plain method does not', () => {
  const item = z.object({ id: z.string() }).strict();
  const service = defineService('demo.watch/v1', {
    watch: defineMethod({
      input: z.tuple([z.string(), streamListener(item)]),
      output: z.custom<{ dispose(): void }>(() => true),
      execute: () => ({ dispose: () => undefined }),
    }),
    get: defineMethod({
      input: z.tuple([z.string()]),
      output: z.string(),
      execute: ([id]) => id,
    }),
  });
  const { document } = contractDocument({
    id: 'demo.watch/v1',
    environment: 'host',
    cardinality: 'one',
    kind: 'service',
    methods: service.methods,
  });
  const defs = document.$defs as Record<string, Record<string, unknown>>;
  const watchInput = defs['watch.input'] as Record<string, unknown>;
  const listener = (
    watchInput.prefixItems as Record<string, unknown>[]
  )[1] as Record<string, unknown>;

  assert.equal(listener['x-doric-local'], 'callback');
  assert.deepEqual(streamItemSchema(defs['watch.input']), listener[STREAM_KEY]);
  assert.equal(
    (streamItemSchema(defs['watch.input']) as { type: string }).type,
    'object',
  );
  assert.equal(streamItemSchema(defs['get.input']), undefined);
});

void test('a provider of another process keeps its stream methods streams (R-STREAM)', () => {
  const item = z.object({ id: z.string() }).strict();
  const service = defineService('demo.watch/v1', {
    watch: defineMethod({
      input: z.tuple([z.string(), streamListener(item)]),
      output: z.custom<{ dispose(): void }>(() => true),
      execute: () => ({ dispose: () => undefined }),
    }),
    get: defineMethod({
      input: z.tuple([z.string()]),
      output: z.string(),
      execute: ([id]) => id,
    }),
  });
  const { document } = contractDocument({
    id: 'demo.watch/v1',
    environment: 'host',
    cardinality: 'one',
    kind: 'service',
    methods: service.methods,
  });
  // The kernel reads a generation provider's specs from its published document.
  const remote = documentMethodSpecs(ajvValidators(), document);
  const watch = remote.watch;
  const get = remote.get;
  assert.ok(watch !== undefined && get !== undefined);

  assert.notEqual(
    streamItemSchema(memberSchema(watch.input, 'input').schema),
    undefined,
  );
  assert.equal(
    streamItemSchema(memberSchema(get.input, 'input').schema),
    undefined,
  );
  assert.equal(
    watch.input.safeParse(['a', { next: () => undefined }]).success,
    true,
  );
  assert.equal(watch.input.safeParse(['a', 'not a listener']).success, false);
});

void test('a function listener is an observer with only next', () => {
  const seen: number[] = [];
  const observer = toStreamObserver<number>((value) => seen.push(value));

  observer.next(3);

  assert.deepEqual(seen, [3]);
  assert.equal(observer.end, undefined);

  const schema = streamListener(z.number());

  assert.equal(schema.safeParse({ next: () => undefined }).success, true);
  assert.equal(schema.safeParse(() => undefined).success, true);
  assert.equal(schema.safeParse({ next: 1 }).success, false);
  assert.equal(
    schema.safeParse({ next: () => undefined, end: 'x' }).success,
    false,
  );
});

void test('doric.catalog/v1 watch delivers items across the envelope until disposed', async () => {
  const { kernel, generation } = processes();
  const listeners = new Set<StreamListener<CatalogChange>>();

  providePlatformServices(kernel.principal('doric'), {
    snapshot: () => snapshot([]),
    diagnostics: new DiagnosticsStore({ generation: 1 }),
    sink: { write: () => undefined },
    distribution: {
      distribution: () => Promise.reject(new Error('unused')),
      artifact: () => Promise.reject(new Error('unused')),
      watch: (listener) => {
        listeners.add(listener);

        return { dispose: () => listeners.delete(listener) };
      },
    },
  });
  kernel.expose('doric.catalog/v1', 'doric');

  const catalog = generation.principal('watcher').services.use(DoricCatalogV1);
  const functionItems: number[] = [];
  const observerItems: number[] = [];
  const first = catalog.watch((change) =>
    functionItems.push(change.generation),
  );
  const second = catalog.watch({
    next: (change) => observerItems.push(change.generation),
  });

  await tick();
  assert.equal(listeners.size, 2);

  for (const listener of listeners) {
    toStreamObserver(listener).next({ generation: 7 });
  }

  await tick();
  assert.deepEqual(functionItems, [7]);
  assert.deepEqual(observerItems, [7]);

  first.dispose();
  second.dispose();
  await tick();
  assert.equal(listeners.size, 0);
});

void test('the envelope parses the end kind and the lifecycle control messages', () => {
  for (const message of [
    { kind: 'end', id: 'k:1' },
    { kind: 'end', id: 'k:1', error: { code: 'disconnected', message: 'x' } },
    { kind: 'lifecycle', id: 'm:1', hook: 'onAppReadyHook', input: {} },
    {
      kind: 'lifecycle-result',
      id: 'm:1',
      ok: true,
      output: { allow: true },
    },
    {
      kind: 'lifecycle-result',
      id: 'm:1',
      ok: false,
      error: { code: 'internal', message: 'boom' },
    },
  ]) {
    assert.equal(wireMessageSchema.safeParse(message).success, true);
  }

  for (const message of [
    { kind: 'lifecycle', id: 'm:1', hook: 'onUnknownHook', input: {} },
    { kind: 'lifecycle-result', id: 'm:1', ok: false },
  ]) {
    assert.equal(wireMessageSchema.safeParse(message).success, false);
  }
});
