// Two bundles registering the same path: the second is quarantined with a
// reason that names the path, and the first route still renders.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1, type Services, UiV1 } from 'bundle/contracts';

import { openWindow, probe, type TestWindow } from './support/window.js';

let opened: TestWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const page = (id: string, text: string) => (services: Services) => {
  class Page extends HTMLElement {
    connectedCallback(): void {
      this.textContent = text;
    }
  }

  services.use(UiV1).define(`${id}-page`, Page);
  services.use(NavigationV1).register({
    path: '/settings',
    create: () => services.use(UiV1).create(`${id}-page`),
  });
};

void test('the second bundle with the same path is quarantined; the first still renders', async () => {
  opened = await openWindow({
    url: 'doric://app/settings',
    probes: [
      probe('first', page('first', 'First')),
      probe('second', page('second', 'Second')),
    ],
  });

  const reason = opened.quarantines.second;

  assert.ok(reason, JSON.stringify(opened.quarantines));
  assert.match(reason.message, /"\/settings"/);
  assert.equal(opened.quarantines.first, undefined);
  assert.equal(
    opened.document.querySelector('body > core-outlet > first-page')
      ?.textContent,
    'First',
  );
  assert.equal(opened.document.querySelector('second-page'), null);
});
