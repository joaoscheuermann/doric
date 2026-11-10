import assert from 'node:assert/strict';
import test from 'node:test';

import { DoricAboutV1 } from 'bundle/contracts';

import {
  activateClientBundles,
  windowDescriptionSchema,
} from '../../src/client/index.js';
import {
  asDocument,
  type ClientBundle,
  describe,
  fakeDesktop,
  fakeDocument,
  importerOf,
  settle,
  windowCatalog,
} from './support/fixtures.js';

void test('doric.about/v1 answers a client bundle the version of its window description', async () => {
  let seen: { readonly version: string } | undefined;
  const bundles: readonly ClientBundle[] = [
    {
      id: 'core',
      activate: async ({ services }) => {
        seen = await services.use(DoricAboutV1).get();
      },
    },
  ];
  const description = describe({ app: { version: '9.9.9' } });
  const catalog = windowCatalog(bundles, { core: 'core' });

  await activateClientBundles({
    catalog,
    desktop: fakeDesktop(description, catalog),
    description,
    document: asDocument(fakeDocument()),
    importPart: importerOf(bundles),
  });
  await settle();

  assert.deepEqual(seen, { version: '9.9.9' });
});

void test('a window description is valid only with the app it belongs to', () => {
  const { app, ...withoutApp } = describe({ app: { version: '9.9.9' } });

  assert.equal(windowDescriptionSchema.safeParse(withoutApp).success, false);
  assert.equal(
    windowDescriptionSchema.safeParse({ ...withoutApp, app }).success,
    true,
  );
});
