// Stage 9 platform deltas (§3.1-§3.2): the navigation/regions additions,
// the new client platform contracts, `doric.windows/v1.focus`, element
// scopes and the minimal UI core of `bundle/testing`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import { definePlatformService } from '../src/contracts/define.js';
import {
  basicContracts,
  type Disposable,
  defineHook,
  defineHooks,
  defineMethod,
  defineService,
  disposableSchema,
  HooksV1,
  NavigationV1,
  RegionsV1,
  ref,
} from '../src/contracts/index.js';
import {
  DoricElementsV1,
  platformContracts,
} from '../src/contracts/platform.js';
import {
  createElementScope,
  createPrincipal,
  emptyCatalogView,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';
import { createMinimalHooks, minimalUiCore } from '../src/testing/index.js';

const accepts = (schema: z.ZodType, value: unknown): boolean =>
  schema.safeParse(value).success;

void test('navigation/v1 adds chain(): no input, an array of route entries', () => {
  const { methods } = basicContracts['navigation/v1'];

  assert.deepEqual(Object.keys(methods).sort(), [
    'back',
    'chain',
    'current',
    'navigate',
    'register',
    'subscribe',
  ]);
  assert.equal(accepts(methods.chain.input, []), true);
  assert.equal(accepts(methods.chain.output, []), true);
  assert.equal(accepts(methods.chain.output, undefined), false);
});

void test('regions/v1 adds items(region) and subscribe(region, listener)', () => {
  const { methods } = basicContracts['regions/v1'];

  assert.deepEqual(Object.keys(methods).sort(), ['add', 'items', 'subscribe']);
  assert.equal(accepts(methods.items.input, 'layout.footer'), true);
  assert.equal(accepts(methods.items.output, []), true);
  assert.equal(
    accepts(methods.subscribe.input, ['layout.footer', () => undefined]),
    true,
  );
  assert.equal(accepts(methods.subscribe.input, ['layout.footer']), false);
});

void test('the stage-9 platform contracts and their environments', () => {
  assert.deepEqual(platformContracts['doric.elements/v1'].environments, [
    'client',
  ]);
  assert.deepEqual(platformContracts['doric.connection/v1'].environments, [
    'client',
  ]);

  const { status } = platformContracts['doric.connection/v1'].methods;

  assert.equal(accepts(status.output, 'connected'), true);
  assert.equal(accepts(status.output, 'disconnected'), true);
  assert.equal(accepts(status.output, 'connecting'), false);

  const { define, owner } = platformContracts['doric.elements/v1'].methods;
  const caller = { bundleId: 'core', version: '1.0.0', generation: 1 };

  assert.equal(
    accepts(define.input, {
      tag: 'core-outlet',
      element: class {},
      owner: caller,
    }),
    true,
  );
  assert.equal(
    accepts(define.input, { tag: 'core-outlet', element: {}, owner: caller }),
    false,
  );
  assert.equal(accepts(owner.output, undefined), true);
  assert.equal(accepts(owner.output, caller), true);

  const { focus } = platformContracts['doric.windows/v1'].methods;

  assert.equal(accepts(focus.input, 'settings'), true);
  assert.equal(accepts(focus.output, true), true);
  assert.equal(accepts(focus.output, undefined), false);
});

const runtimeFor = (): ServiceRuntime => ({
  directory: new ServiceDirectory(),
  catalog: emptyCatalogView,
  environment: 'client',
  generation: 1,
  generationSignal: new AbortController().signal,
  report: () => undefined,
});

interface Watch {
  watch(name: string): Disposable;
}

const WatchV1 = ref<Watch>('probe.watch/v1');

const watchProvider = (live: Set<string>) =>
  defineService('probe.watch/v1', {
    watch: defineMethod({
      input: z.string(),
      output: disposableSchema,
      execute: (name: string) => {
        live.add(name);

        return { dispose: () => live.delete(name) };
      },
    }),
  });

const WidgetHooks = defineHooks('probe.widget.hooks/v1', {
  onOpenHook: defineHook({ kind: 'observe', input: z.object({}).strict() }),
});

void test('an element scope ends its own registrations and leaves the owner’s', async () => {
  const runtime = runtimeFor();
  const live = new Set<string>();
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });
  const owner = createPrincipal(runtime, {
    bundleId: 'feat',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });

  platform.services.provide(createMinimalHooks());
  platform.services.provide(watchProvider(live));
  owner.services.use(WatchV1).watch('owner');

  const scope = createElementScope(owner);
  const stub = scope.services.use(WatchV1);
  const hooks = scope.services.use(HooksV1);
  const registrar = hooks.use(WidgetHooks);
  let available = 0;

  stub.watch('direct');
  // Calls made later through a kept stub or registrar stay in the scope.
  await Promise.resolve();
  stub.watch('later');
  registrar.onOpenHook(() => undefined);
  scope.services.whenAvailable(WatchV1, (api) => {
    available += 1;
    api.watch('available');
  });
  scope.services.provide(
    defineService('probe.scoped/v1', {
      ping: defineMethod({
        input: z.tuple([]),
        output: z.literal('pong'),
        execute: () => 'pong' as const,
      }),
    }),
  );

  assert.equal(available, 1);
  assert.deepEqual([...live].sort(), ['available', 'direct', 'later', 'owner']);
  assert.equal(runtime.directory.active('probe.scoped/v1')?.bundleId, 'feat');

  await scope.dispose();
  await scope.dispose();

  assert.deepEqual([...live], ['owner']);
  assert.equal(runtime.directory.active('probe.scoped/v1'), undefined);
  // A registration made after the end is ended at once.
  scope.services.use(WatchV1).watch('after');
  assert.deepEqual([...live], ['owner']);
});

void test('an element scope ends with its owner', async () => {
  const runtime = runtimeFor();
  const live = new Set<string>();
  const owner = createPrincipal(runtime, {
    bundleId: 'feat',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });

  createPrincipal(runtime, {
    bundleId: 'probe',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  }).services.provide(watchProvider(live));

  const scope = createElementScope(owner);

  scope.services.use(WatchV1).watch('element');
  await owner.scope.dispose();

  assert.deepEqual([...live], []);
});

void test('the minimal UI core provides hooks, ui, navigation and regions for the client', () => {
  const core = minimalUiCore();

  assert.equal(core.manifest.id, 'mincore');
  assert.deepEqual(core.manifest.provides, [
    'hooks/v1@1.0.0',
    'ui/v1@1.0.0',
    'navigation/v1@1.0.0',
    'regions/v1@1.0.0',
  ]);
  assert.ok(
    core.descriptor.contracts.every(
      (contract) => contract.environment === 'client',
    ),
  );
});

void test('the minimal core’s regions sort by order, then add order, and notify', async () => {
  const runtime = runtimeFor();
  const core = createPrincipal(runtime, {
    bundleId: 'mincore',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });
  const layout = createPrincipal(runtime, {
    bundleId: 'layout',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });
  const definedTags: string[] = [];

  createPrincipal(runtime, {
    bundleId: 'doric',
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  }).services.provide(
    definePlatformService(DoricElementsV1, {
      define: defineMethod({
        input: platformContracts['doric.elements/v1'].methods.define.input,
        output: disposableSchema,
        execute: (input: { tag: string }) => {
          definedTags.push(input.tag);

          return { dispose: () => undefined };
        },
      }),
      owner: defineMethod({
        input: z.string(),
        output: z.undefined(),
        execute: () => undefined,
      }),
      attach: defineMethod({
        input: z.unknown(),
        output: z.void(),
        execute: () => undefined,
      }),
      release: defineMethod({
        input: z.unknown(),
        output: z.void(),
        execute: () => undefined,
      }),
    }),
  );

  const globals = globalThis as unknown as Record<string, unknown>;

  globals.HTMLElement = class {};

  try {
    await minimalUiCore().client.activate({ services: core.services });
  } finally {
    delete globals.HTMLElement;
  }

  assert.deepEqual(definedTags, ['mincore-outlet']);

  const regions = layout.services.use(RegionsV1);
  let changes = 0;

  regions.subscribe('layout.footer', () => {
    changes += 1;
  });
  regions.add('layout.footer', { id: 'usage', tag: 'layout-usage', order: 30 });
  regions.add('layout.footer', { id: 'late', tag: 'layout-late' });
  regions.add('layout.footer', { id: 'cwd', tag: 'layout-cwd', order: 10 });

  const items = regions.items('layout.footer');

  assert.deepEqual(
    items.map(({ id, owner }) => [id, owner]),
    [
      ['cwd', 'layout'],
      ['usage', 'layout'],
      ['late', 'layout'],
    ],
  );
  assert.equal(regions.items('layout.footer'), items);
  assert.equal(changes, 3);
  assert.throws(
    () => regions.add('layout.footer', { id: 'cwd', tag: 'layout-cwd' }),
    { code: 'registration_conflict' },
  );

  const navigation = layout.services.use(NavigationV1);

  navigation.register({ path: '/', create: () => ({}) });
  navigation.register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: () => ({}),
  });
  navigation.navigate('/projects/p1/threads/t1');

  assert.deepEqual(
    navigation.chain().map(({ match }) => [match.pattern, match.params]),
    [
      ['/', {}],
      [
        '/projects/:projectId/threads/:threadId',
        { projectId: 'p1', threadId: 't1' },
      ],
    ],
  );
  assert.deepEqual(navigation.current()?.params, {
    projectId: 'p1',
    threadId: 't1',
  });
  navigation.navigate('/nowhere');
  assert.deepEqual(navigation.chain(), []);
  assert.equal(navigation.current(), undefined);
});
