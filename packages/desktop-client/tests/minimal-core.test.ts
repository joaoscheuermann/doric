// Stage 9 window platform (§3.3): the bootstrap shows `<${core}-outlet>`, so
// a core that is not the default one opens a window with its own outlet and
// no default UI bundle; a core that defines no outlet is a core failure.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { minimalUiCore } from 'bundle/testing';

import { bootstrapWindow } from '../src/index.js';
import { type InstalledDom, installDom } from './support/dom.js';
import {
  asDocument,
  type ClientBundle,
  describe,
  fakeDesktop,
  fakeDocument,
  fakeKeyTarget,
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

void test('a window of the minimal core shows its own outlet', async () => {
  const bundles = [mincoreBundle()];
  const desktop = fakeDesktop(
    describe(),
    windowCatalog(bundles, { core: 'mincore' }),
  );

  dom.document.body.innerHTML = '<div id="splash">Loading</div>';

  await bootstrapWindow({
    desktop,
    document: dom.document,
    importPart: importerOf(bundles),
    keyTarget: fakeKeyTarget(),
    elementRegistry: () => dom.registry,
  });

  const children = Array.from(dom.document.body.children);

  assert.deepEqual(
    children.map((child) => child.localName),
    ['mincore-outlet'],
  );
  assert.equal(children[0]?.textContent, 'Minimal core');
  assert.equal(children[0]?.querySelector('p')?.textContent, 'Minimal core');

  for (const tag of ['layout-workspace', 'chat-view', 'settings-page']) {
    assert.equal(dom.registry.get(tag), undefined, tag);
  }

  assert.deepEqual(desktop.failures, []);
  assert.equal(desktop.steps.at(-1), 'ready');
});

void test('a core that defines no outlet reports a core failure instead of ready', async () => {
  const bundles: ClientBundle[] = [{ id: 'core', activate: () => undefined }];
  const desktop = fakeDesktop(
    describe({ key: 'settings' }),
    windowCatalog(bundles, { core: 'core' }),
  );

  await bootstrapWindow({
    desktop,
    document: asDocument(fakeDocument()),
    importPart: importerOf(bundles),
    keyTarget: fakeKeyTarget(),
    elementRegistry: () => dom.registry,
  });

  assert.equal(desktop.steps.includes('ready'), false);
  assert.deepEqual(desktop.failures, [
    {
      kind: 'core',
      bundleId: 'core',
      message: 'Core bundle "core" did not define <core-outlet>.',
    },
  ]);
});

void test('a quarantined core in the workspace window reports its reason even when its outlet exists', async () => {
  const core = minimalUiCore({ id: 'core' });
  const bundles: ClientBundle[] = [
    {
      ...mincoreBundle('core'),
      activate: async (context) => {
        await core.client.activate(context);
        throw new Error('core client failed');
      },
    },
  ];
  const desktop = fakeDesktop(
    describe(),
    windowCatalog(bundles, { core: 'core' }),
  );

  await bootstrapWindow({
    desktop,
    document: dom.document,
    importPart: importerOf(bundles),
    keyTarget: fakeKeyTarget(),
    elementRegistry: () => dom.registry,
  });

  assert.equal(desktop.steps.includes('ready'), false);
  assert.deepEqual(desktop.failures, [
    { kind: 'core', bundleId: 'core', message: 'core client failed' },
  ]);
  assert.equal(dom.document.body.querySelector('core-outlet'), null);
});
