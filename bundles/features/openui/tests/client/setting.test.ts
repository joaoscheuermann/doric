// B17 (openui.md D24, conversation-openui.md D29): the `openui` client
// registers the `openui-lang` fence renderer while `openui.setting/v1.watch`
// reports `true` and disposes it when it reports `false`; its Generative UI
// section in the settings window writes the reader's choice with `set`.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { activateClient, type ClientWorld } from './support/client.js';
import { closeWindow, settle, window } from './support/dom.js';

after(closeWindow);

const live = (world: ClientWorld) =>
  world.fenceRenderers
    .filter(({ disposed }) => !disposed)
    .map(({ spec }) => spec);

test('the fence renderer is registered while watch reports true and disposed when it reports false', async () => {
  const world = await activateClient();
  await settle();

  assert.deepEqual(live(world), []);

  world.report({ enabled: true });
  await settle();
  assert.deepEqual(live(world), [
    { tag: 'openui-lang', elementTag: 'openui-fence' },
  ]);
  assert.ok(world.elements.has('openui-fence'));

  world.report({ enabled: false });
  await settle();
  assert.deepEqual(live(world), []);

  world.report({ enabled: true });
  await settle();
  assert.equal(live(world).length, 1);

  await world.deactivate();
  assert.deepEqual(live(world), []);
});

test('the Generative UI section: a settings link, a child route and an element', async () => {
  const world = await activateClient();

  assert.deepEqual(
    world.regions.map(({ spec }) => spec),
    [
      {
        region: 'settings.sections',
        item: {
          id: 'generative-ui',
          tag: 'settings-link',
          order: 70,
          props: {
            label: 'Generative UI',
            path: '/settings/generative-ui',
            icon: 'wrench',
            description:
              'Answers, questions and previews drawn as UI in the conversation.',
          },
        },
      },
    ],
  );
  const route = world.routes.find(
    ({ spec }) => spec.path === '/settings/generative-ui',
  );
  assert.equal(route?.spec.parent, '/settings');
  assert.ok(world.elements.has('openui-settings'));

  await world.deactivate();
});

test("the section's switch writes set with the new value", async () => {
  const world = await activateClient();
  const element = world.elements.get('openui-settings');
  assert.ok(element !== undefined);

  window.customElements.define('test-openui-settings', element as never);
  const section = window.document.createElement(
    'test-openui-settings',
  ) as unknown as HTMLElement & {
    services: unknown;
  };
  section.services = world.services;
  window.document.body.appendChild(section as never);
  await settle(10);

  const root = (section.shadowRoot ?? section) as ParentNode;
  assert.match(root.textContent ?? '', /Draw answers and questions as UI/);
  const control = root.querySelector(
    '[role="switch"], input[type="checkbox"]',
  ) as HTMLElement | null;
  assert.ok(control !== null);

  control.click();
  await settle(10);

  assert.deepEqual(world.settingWrites, [{ enabled: true }]);
  section.remove();
  await world.deactivate();
});
