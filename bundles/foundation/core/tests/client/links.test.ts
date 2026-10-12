// Same-origin anchors navigate through navigation/v1; modified clicks,
// anchors with a target and other origins keep the browser's behavior.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

import { openWindow, probe, type TestWindow } from './support/window.js';

let opened: TestWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const open = async () => {
  const x = probe('x', (services) => {
    services.use(NavigationV1).register({
      path: '/settings/:section',
      create: () => document.createElement('div'),
    });
  });

  opened = await openWindow({ probes: [x] });

  return x.services().use(NavigationV1);
};

const click = (
  href: string,
  init: MouseEventInit = {},
  attributes: Record<string, string> = {},
): boolean => {
  const document = opened?.document as Document;
  const anchor = document.createElement('a');

  anchor.setAttribute('href', href);

  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }

  anchor.textContent = 'Open';
  document.body.append(anchor);

  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });

  let prevented = false;
  // After every document listener: record the outcome, then stop the test
  // DOM's own link activation, which would load the URL.
  const stop = (seen: Event) => {
    prevented = seen.defaultPrevented;
    seen.preventDefault();
  };

  opened?.window.addEventListener('click', stop as never, { once: true });
  // On the anchor itself: the test DOM activates an anchor around a nested
  // target before the event bubbles.
  anchor.dispatchEvent(event);
  anchor.remove();

  return prevented;
};

void test('a plain click on a same-origin anchor navigates without loading', async () => {
  const navigation = await open();

  assert.equal(click('/settings/tools?x=1'), true);
  assert.equal(opened?.window.location.pathname, '/settings/tools');
  assert.equal(opened?.window.location.search, '?x=1');
  assert.deepEqual(navigation.current()?.params, { section: 'tools' });
});

void test('modified clicks, targets, downloads and other origins are left alone', async () => {
  const navigation = await open();

  assert.equal(click('/settings/a', { metaKey: true }), false);
  assert.equal(click('/settings/b', { button: 1 }), false);
  assert.equal(click('/settings/c', {}, { target: '_blank' }), false);
  assert.equal(click('/settings/d', {}, { download: '' }), false);
  assert.equal(click('https://example.com/settings/e'), false);
  assert.equal(click('other://app/settings/f'), false);
  assert.equal(opened?.window.location.pathname, '/');
  assert.equal(navigation.current(), undefined);
});
