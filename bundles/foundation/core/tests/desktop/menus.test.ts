import assert from 'node:assert/strict';
import test from 'node:test';

import { MenusV1 } from 'bundle/contracts';

import { bootDesktop, probe } from '../support/desktop.js';

const owner = { bundleId: 'graph', version: '1.0.0', generation: 1 };

void test('menu items and keybindings reach main owned by the bundle that added them', async () => {
  const desktop = await bootDesktop([
    probe('graph', {
      requires: ['menus/v1@^1.0.0'],
      activate: async ({ services }) => {
        const menus = services.use(MenusV1);

        await menus.addItem({
          id: 'graph.show',
          location: 'app/view',
          command: 'graph.show/v1',
          label: 'Show Graph',
          order: 2,
        });
        await menus.addKeybinding({
          command: 'graph.show/v1',
          key: 'CmdOrCtrl+G',
          when: { path: '/graph' },
        });
      },
    }),
  ]);

  try {
    assert.deepEqual(
      desktop.received('doric.menus/v1.add').map(({ input }) => input),
      [
        {
          id: 'graph.show',
          location: 'app/view',
          command: 'graph.show/v1',
          label: 'Show Graph',
          order: 2,
          owner,
        },
      ],
    );
    assert.deepEqual(
      desktop
        .received('doric.menus/v1.addKeybinding')
        .map(({ input }) => input),
      [
        {
          command: 'graph.show/v1',
          key: 'CmdOrCtrl+G',
          when: { path: '/graph' },
          owner,
        },
      ],
    );
  } finally {
    await desktop.stop();
  }
});

void test('setContext applies to the calling window, and is refused without one', async () => {
  const failures: unknown[] = [];
  const desktop = await bootDesktop([
    probe('graph', {
      requires: ['menus/v1@^1.0.0'],
      activate: async ({ services }) => {
        await services
          .use(MenusV1, { windowKey: 'graph:main' })
          .setContext({ key: 'path', value: '/graph' });

        try {
          await services.use(MenusV1).setContext({ key: 'focus', value: null });
        } catch (error) {
          failures.push(error);
        }
      },
    }),
  ]);

  try {
    assert.deepEqual(
      desktop.received('doric.menus/v1.setContext').map(({ input }) => input),
      [{ windowKey: 'graph:main', key: 'path', value: '/graph' }],
    );
    assert.equal((failures[0] as { code?: string }).code, 'invalid_input');
  } finally {
    await desktop.stop();
  }
});
