import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  ContractError,
  defineMethod,
  defineService,
  ref,
} from '../src/contracts/index.js';
import {
  createPrincipal,
  LayeredDirectory,
  type ProviderRecord,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';

const record = (
  contractId: string,
  bundleId: string,
  cardinality: 'one' | 'many' = 'one',
): ProviderRecord => ({
  contractId,
  bundleId,
  version: '1.0.0',
  contractVersion: '1.0.0',
  environment: 'host',
  cardinality,
  methods: {},
  invoke: () => bundleId,
});

const events = () => {
  const seen: string[] = [];

  return {
    seen,
    listener: {
      added: (entry: ProviderRecord) => seen.push(`+${entry.bundleId}`),
      removed: (entry: ProviderRecord) => seen.push(`-${entry.bundleId}`),
    },
  };
};

void test('reads list base providers before overlay providers', () => {
  const base = new ServiceDirectory();
  const overlay = new ServiceDirectory();
  const view = new LayeredDirectory(base, overlay);
  const kernel = record('log/v1', 'kernel', 'many');
  const generation = record('log/v1', 'generation', 'many');

  overlay.register(generation);
  base.register(kernel);

  assert.deepEqual(
    view.providers('log/v1').map(({ bundleId }) => bundleId),
    ['kernel', 'generation'],
  );
  assert.equal(view.active('log/v1'), kernel);
  assert.equal(view.isActive(generation), true);
});

void test('registrations through the view go to the base layer', () => {
  const base = new ServiceDirectory();
  const overlay = new ServiceDirectory();
  const view = new LayeredDirectory(base, overlay);
  const provided = record('alpha/v1', 'kernel');
  const unregister = view.register(provided);

  assert.equal(base.active('alpha/v1'), provided);
  assert.equal(overlay.active('alpha/v1'), undefined);

  unregister();

  assert.equal(view.active('alpha/v1'), undefined);
});

void test('a consumer sees a generation provider while it is active and loses it on switch', () => {
  const base = new ServiceDirectory();
  const first = new ServiceDirectory();
  const second = new ServiceDirectory();
  const view = new LayeredDirectory(base);
  const { seen, listener } = events();

  first.register(record('runtime/v1', 'gen1'));
  second.register(record('runtime/v1', 'gen2'));
  view.subscribe('runtime/v1', listener);

  assert.equal(view.active('runtime/v1'), undefined);

  view.setOverlay(first);
  assert.equal(view.active('runtime/v1')?.bundleId, 'gen1');

  view.setOverlay(second);
  assert.equal(view.active('runtime/v1')?.bundleId, 'gen2');

  view.setOverlay(undefined);
  assert.equal(view.active('runtime/v1'), undefined);
  assert.deepEqual(seen, ['+gen1', '-gen1', '+gen2', '-gen2']);
});

void test('subscribers follow later changes in both layers, and not after unsubscribe', () => {
  const base = new ServiceDirectory();
  const overlay = new ServiceDirectory();
  const replaced = new ServiceDirectory();
  const view = new LayeredDirectory(base, overlay);
  const { seen, listener } = events();
  const unsubscribe = view.subscribe('svc/v1', listener);
  const removeKernel = base.register(record('svc/v1', 'kernel', 'many'));
  const removeGeneration = overlay.register(record('svc/v1', 'gen', 'many'));

  removeGeneration();
  removeKernel();
  view.setOverlay(replaced);
  // The old overlay no longer reaches the view's subscribers.
  overlay.register(record('svc/v1', 'stale', 'many'));
  replaced.register(record('svc/v1', 'fresh', 'many'));
  unsubscribe();
  replaced.register(record('svc/v1', 'late', 'many'));
  view.setOverlay(undefined);

  assert.deepEqual(seen, ['+kernel', '+gen', '-gen', '-kernel', '+fresh']);
});

void test('two generations providing the same one contract do not conflict', () => {
  const kernel = new ServiceDirectory();
  const generation1 = new ServiceDirectory();
  const generation2 = new ServiceDirectory();

  generation1.register(record('direct/v1', 'direct'));
  generation2.register(record('direct/v1', 'direct'));

  const view1 = new LayeredDirectory(kernel, generation1);
  const view2 = new LayeredDirectory(kernel, generation2);

  assert.notEqual(view1.active('direct/v1'), view2.active('direct/v1'));
  // Inside one layer the one-provider rule still holds.
  assert.throws(
    () => generation1.register(record('direct/v1', 'other')),
    (error: unknown) =>
      error instanceof ContractError && error.code === 'provider_conflict',
  );
});

void test('whenAvailable through a layered directory follows the switched overlay', () => {
  const echo = defineService('echo/v1', {
    name: defineMethod({
      input: z.tuple([]),
      output: z.string(),
      execute: () => 'gen1',
    }),
  });
  const EchoV1 = ref<typeof echo>('echo/v1');
  const kernel = new ServiceDirectory();
  const generation = new ServiceDirectory();
  const view = new LayeredDirectory(kernel);
  const runtime = (directory: ServiceRuntime['directory']): ServiceRuntime => ({
    directory,
    catalog: { cardinality: () => undefined, activeProvider: () => undefined },
    environment: 'host',
    generation: 1,
    generationSignal: new AbortController().signal,
    report: () => undefined,
  });
  const options = {
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  } as const;

  createPrincipal(runtime(generation), {
    ...options,
    bundleId: 'gen-provider',
  }).services.provide(echo);

  const consumer = createPrincipal(runtime(view), {
    ...options,
    bundleId: 'kernel-consumer',
  });
  const seen: string[] = [];

  consumer.services.whenAvailable(EchoV1, (service) => {
    seen.push(service.name());

    return () => {
      seen.push('gone');
    };
  });
  view.setOverlay(generation);
  view.setOverlay(undefined);

  assert.deepEqual(seen, ['gen1', 'gone']);
});
