import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DoricBundleV1,
  DoricCatalogV1,
  DoricLogV1,
  DoricTokensV1,
  HooksV1,
  WindowHooksV1,
} from 'bundle/contracts';

import { activateClientBundles } from '../../src/client/index.js';
import {
  asDocument,
  type ClientBundle,
  clientHooksBundle,
  describe,
  fakeDesktop,
  fakeDocument,
  type HooksLog,
  importerOf,
  settle,
  stylesUrl,
  windowCatalog,
} from './support/fixtures.js';

const activateWith = async (
  bundles: readonly ClientBundle[],
  options: { readonly key?: string | null } = {},
) => {
  const description = describe(
    options.key === undefined ? {} : { key: options.key },
  );
  const catalog = windowCatalog(bundles, { core: 'core' });
  const desktop = fakeDesktop(description, catalog);
  const document = fakeDocument();
  const activation = await activateClientBundles({
    catalog,
    desktop,
    description,
    document: asDocument(document),
    importPart: importerOf(bundles),
  });

  return { activation, desktop, document };
};

void test('a failing client part is quarantined, main is told, and the other bundles stay active', async () => {
  const log: HooksLog = { registrations: [], defined: [] };
  const { activation, desktop } = await activateWith([
    clientHooksBundle(log),
    {
      id: 'broken',
      activate: () => {
        throw new Error('client part exploded');
      },
    },
    { id: 'healthy', activate: () => undefined },
  ]);

  await settle();

  assert.deepEqual(activation.result.active, ['core', 'healthy']);
  assert.equal(activation.diagnostics.state('broken'), 'quarantined');
  assert.deepEqual(
    desktop
      .shell('diagnostic')
      .filter((entry) => (entry as { kind: string }).kind === 'quarantine'),
    [
      {
        kind: 'quarantine',
        bundleId: 'broken',
        reason: { code: 'activate_failed', message: 'client part exploded' },
      },
    ],
  );
  assert.ok(
    desktop.calls
      .filter(({ contract }) => contract === 'doric.shell/v1')
      .every(({ bundleId }) => bundleId === null),
  );
});

void test('bundle styles are linked in activation order, only for parts that ship them', async () => {
  const log: HooksLog = { registrations: [], defined: [] };
  const { activation, document } = await activateWith([
    { id: 'zeta', styles: true, activate: () => undefined },
    clientHooksBundle(log),
    { id: 'alpha', activate: () => undefined },
    { id: 'beta', styles: true, activate: () => undefined },
  ]);

  assert.deepEqual(
    document.head.children.map(({ rel, href }) => ({ rel, href })),
    activation.result.active
      .filter((id) => id === 'zeta' || id === 'beta')
      .map((id) => ({ rel: 'stylesheet', href: stylesUrl(id) })),
  );
  assert.equal(document.head.children.length, 2);
});

void test('WindowHooksV1 is defined once the client hooks provider is active and registrations see the window key', async () => {
  const log: HooksLog = { registrations: [], defined: [] };
  const { activation } = await activateWith(
    [
      clientHooksBundle(log),
      {
        id: 'closer',
        requires: ['hooks/v1@^1.0.0'],
        activate: ({ services }) => {
          services
            .use(HooksV1)
            .use(WindowHooksV1)
            .onCloseHook(() => ({
              allow: true,
            }));
        },
      },
    ],
    { key: 'settings' },
  );

  assert.notEqual(activation.windowHooks, undefined);
  assert.ok(log.defined.includes('doric.window.hooks/v1'));
  assert.deepEqual(log.registrations, [
    { hook: 'onCloseHook', windowKey: 'settings' },
  ]);
});

void test('without a hooks/v1 provider there are no window hooks', async () => {
  const { activation } = await activateWith([
    { id: 'core', activate: () => undefined },
  ]);

  assert.equal(activation.windowHooks, undefined);
});

void test('the window platform serves tokens, bundle identity, its catalog and forwards logs to main', async () => {
  let seen:
    | {
        tokens: Readonly<Record<string, string>>;
        environment: string;
        bundleId: string;
        generation: number;
        catalogBundles: string[];
      }
    | undefined;
  const { desktop } = await activateWith([
    {
      id: 'core',
      activate: async ({ services }) => {
        const identity = services.use(DoricBundleV1).describe();

        seen = {
          tokens: await services.use(DoricTokensV1).get(),
          environment: identity.environment,
          bundleId: identity.bundleId,
          generation: identity.generation,
          catalogBundles: services
            .use(DoricCatalogV1)
            .get()
            .bundles.map(({ id }) => id),
        };
        services.use(DoricLogV1).write({
          level: 'info',
          message: 'hello from the window',
          bundleId: 'core',
          version: '1.0.0',
          generation: 3,
          environment: 'client',
        });
      },
    },
  ]);

  await settle();

  assert.deepEqual(seen, {
    tokens: { titlebarHeight: '36', window: '#101010' },
    environment: 'client',
    bundleId: 'core',
    generation: 3,
    catalogBundles: ['core'],
  });
  assert.deepEqual(
    desktop
      .shell('log')
      .map((record) => (record as { message: string }).message),
    ['hello from the window'],
  );
});
