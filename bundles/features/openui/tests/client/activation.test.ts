// B10′ (openui.md D24, stage 4): the `openui` client registers the
// `openui-lang` fence renderer at activation, without waiting for any
// setting provider, and has no Generative UI settings section or route.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { activateClient, type ClientWorld } from './support/client.js';
import { closeWindow, settle } from './support/dom.js';

after(closeWindow);

const live = (world: ClientWorld) =>
  world.fenceRenderers
    .filter(({ disposed }) => !disposed)
    .map(({ spec }) => spec);

test('B10′: the fence renderer is registered at activation with no setting reported, and cleanup disposes it', async () => {
  const world = await activateClient();
  await settle();

  assert.deepEqual(live(world), [
    { tag: 'openui-lang', elementTag: 'openui-fence' },
  ]);
  assert.ok(world.elements.has('openui-fence'));

  await world.deactivate();
  assert.deepEqual(live(world), []);
});

test('B10′: no Generative UI settings section and no /settings/generative-ui route', async () => {
  const world = await activateClient();
  await settle();

  assert.deepEqual(
    world.regions.filter(({ spec }) => spec.region === 'settings.sections'),
    [],
  );
  assert.deepEqual(
    world.routes
      .map(({ spec }) => spec.path)
      .filter((path) => path.includes('generative-ui')),
    [],
  );

  await world.deactivate();
});
