// Stage 9 window platform contracts (§3.3): `doric.elements/v1` gives an
// element a child scope of its owner's services, `doric.connection/v1`
// follows main's status stream, and the client `doric.notifications/v1`
// forwards to main. Real client activation over a fake preload and happy-dom.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  type ConnectionStatus,
  type Disposable,
  DoricConnectionV1,
  DoricElementsV1,
  DoricNotificationsV1,
  defineMethod,
  defineService,
  disposableSchema,
  ref,
  type Services,
  UiV1,
} from 'bundle/contracts';
import { z } from 'zod';

import { activateClientBundles } from '../src/index.js';
import { type InstalledDom, installDom } from './support/dom.js';
import {
  type ClientBundle,
  describe,
  fakeDesktop,
  importerOf,
  windowCatalog,
} from './support/fixtures.js';
import { mincoreBundle } from './support/mincore.js';

let dom: InstalledDom;

beforeEach(() => {
  dom = installDom();
});

afterEach(async () => {
  await dom.close();
});

interface Watch {
  watch(name: string): Disposable;
}

const WatchV1 = ref<Watch>('probe.watch/v1');

/** A bundle providing `probe.watch/v1`; `live` holds the open watches. */
const watchBundle = (live: Set<string>): ClientBundle => ({
  id: 'probe',
  provides: ['probe.watch/v1@1.0.0'],
  contracts: [{ id: 'probe.watch/v1', version: '1.0.0' }],
  activate: ({ services }) => {
    services.provide(
      defineService('probe.watch/v1', {
        watch: defineMethod({
          input: z.string(),
          output: disposableSchema,
          execute: (name: string) => {
            live.add(name);

            return { dispose: () => live.delete(name) };
          },
        }),
      }),
    );
  },
});

const activate = async (bundles: readonly ClientBundle[]) => {
  const desktop = fakeDesktop(
    describe(),
    windowCatalog(bundles, { core: 'mincore' }),
  );
  const activation = await activateClientBundles({
    catalog: windowCatalog(bundles, { core: 'mincore' }),
    desktop,
    description: describe(),
    document: dom.document,
    importPart: importerOf(bundles),
    elementRegistry: () => dom.registry,
  });

  return { desktop, activation };
};

void test('registrations through element services end with ui.dispose; the owner’s survive', async () => {
  const live = new Set<string>();
  let feature: Services | undefined;
  const bundles: ClientBundle[] = [
    mincoreBundle(),
    watchBundle(live),
    {
      id: 'feat',
      requires: ['ui/v1@^1.0.0', 'probe.watch/v1@^1.0.0'],
      activate: ({ services }) => {
        feature = services;

        class FeatView extends HTMLElement {}

        services.use(UiV1).define('feat-view', FeatView);
      },
    },
  ];

  await activate(bundles);

  const services = feature as Services;
  const ui = services.use(UiV1);
  const element = ui.create('feat-view', { threadId: 't1' }) as HTMLElement & {
    readonly services: Services;
    readonly threadId: string;
  };

  assert.equal(element.localName, 'feat-view');
  assert.equal(element.threadId, 't1');

  services.use(WatchV1).watch('owner');

  // A stub kept by the element and called later still lands in its scope.
  const watches = element.services.use(WatchV1);

  await Promise.resolve();
  watches.watch('element');
  assert.deepEqual([...live].sort(), ['element', 'owner']);

  ui.dispose(element);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual([...live], ['owner']);

  // Idempotent.
  ui.dispose(element);
});

void test('only the active ui/v1 provider may use doric.elements/v1', async () => {
  let feature: Services | undefined;
  const bundles: ClientBundle[] = [
    mincoreBundle(),
    {
      id: 'feat',
      activate: ({ services }) => {
        feature = services;
      },
    },
  ];

  await activate(bundles);

  const elements = (feature as Services).use(DoricElementsV1);

  assert.throws(() => elements.owner('mincore-outlet'), {
    code: 'not_owner',
  });
  assert.throws(
    () =>
      elements.define({
        tag: 'feat-thing',
        element: class extends HTMLElement {},
        owner: { bundleId: 'feat', version: '1.0.0', generation: 3 },
      }),
    { code: 'not_owner' },
  );
  assert.equal(dom.registry.get('feat-thing'), undefined);
});

void test('a tag defined twice is a registration conflict', async () => {
  let feature: Services | undefined;
  const bundles: ClientBundle[] = [
    mincoreBundle(),
    {
      id: 'feat',
      requires: ['ui/v1@^1.0.0'],
      activate: ({ services }) => {
        feature = services;
        services.use(UiV1).define('feat-view', class extends HTMLElement {});
      },
    },
  ];

  await activate(bundles);

  assert.throws(
    () =>
      (feature as Services)
        .use(UiV1)
        .define('feat-view', class extends HTMLElement {}),
    { code: 'registration_conflict' },
  );
});

void test('the connection status starts disconnected and listeners hear each change once', async () => {
  let feature: Services | undefined;
  const bundles: ClientBundle[] = [
    mincoreBundle(),
    {
      id: 'feat',
      activate: ({ services }) => {
        feature = services;
      },
    },
  ];
  const { desktop } = await activate(bundles);
  const connection = (feature as Services).use(DoricConnectionV1);
  const heard: ConnectionStatus[] = [];

  assert.equal(connection.status(), 'disconnected');
  connection.subscribe((status) => heard.push(status));

  desktop.push('doric.shell/v1', 'connection', 'disconnected');
  desktop.push('doric.shell/v1', 'connection', 'connected');
  desktop.push('doric.shell/v1', 'connection', 'connected');
  desktop.push('doric.shell/v1', 'connection', 'unknown');
  desktop.push('doric.shell/v1', 'connection', 'disconnected');

  assert.deepEqual(heard, ['connected', 'disconnected']);
  assert.equal(connection.status(), 'disconnected');
});

void test('a client notification is forwarded to main as exactly a title and a body', async () => {
  let feature: Services | undefined;
  const bundles: ClientBundle[] = [
    mincoreBundle(),
    {
      id: 'chat',
      activate: ({ services }) => {
        feature = services;
      },
    },
  ];
  const { desktop } = await activate(bundles);
  const notifications = (feature as Services).use(DoricNotificationsV1);

  await notifications.show({ title: 'Prompt finished', body: 'Thread A' });
  await assert.rejects(
    async () => notifications.show({ title: 'x' } as never),
    { code: 'invalid_input' },
  );

  assert.deepEqual(desktop.shell('notify'), [
    { title: 'Prompt finished', body: 'Thread A' },
  ]);
});
