// The menu context `path` of the window follows its route: the active
// pattern, then null when no route matches.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

import {
  openWindow,
  probe,
  settle,
  type TestWindow,
} from './support/window.js';

let opened: TestWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

void test('the menu context path is the active pattern, then null when nothing matches', async () => {
  const x = probe('x', (services) => {
    services.use(NavigationV1).register({
      path: '/settings/:section',
      create: () => document.createElement('div'),
    });
  });

  opened = await openWindow({ url: 'doric://app/settings/tools', probes: [x] });

  const navigation = x.services().use(NavigationV1);

  navigation.navigate('/nowhere');
  await settle();

  const values = opened
    .received('menus/v1.setContext')
    .map(({ input }) => input as { key: string; value: string | null });

  assert.deepEqual(values.at(-2), {
    key: 'path',
    value: '/settings/:section',
  });
  assert.deepEqual(values.at(-1), { key: 'path', value: null });
});
