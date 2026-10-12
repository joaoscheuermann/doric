// The settings window opens at `/settings`; the page shows the last section
// this window showed, or Providers (D9-14).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSectionRoute,
  type SectionNavigation,
} from '../src/client/domain/section-route.js';

/** A window's route: the path, matched against the settings patterns. */
const windowAt = (path: string) => {
  const listeners = new Set<() => void>();
  const visits: { path: string; replace: boolean }[] = [];
  let current = path;
  const pattern = (value: string) =>
    value === '/settings' || value.startsWith('/settings/') ? value : '/';

  const navigation: SectionNavigation = {
    current: () => ({ path: current, pattern: pattern(current) }),
    navigate: (next, options) => {
      current = next;
      visits.push({ path: next, replace: options?.replace === true });
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };

  return { navigation, visits, path: () => current };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a window opened at /settings shows Providers in place of the bare path', async () => {
  const window = windowAt('/settings');

  createSectionRoute().follow(window.navigation);
  await settled();

  assert.equal(window.path(), '/settings/providers');
  assert.deepEqual(window.visits, [
    { path: '/settings/providers', replace: true },
  ]);
});

test('going back to /settings returns to the last section this window showed', async () => {
  const window = windowAt('/settings/providers');

  createSectionRoute().follow(window.navigation);
  window.navigation.navigate('/settings/tools');
  window.navigation.navigate('/settings');
  await settled();

  assert.equal(window.path(), '/settings/tools');
});

test('a section path is left as it is', async () => {
  const window = windowAt('/settings/credentials');

  createSectionRoute().follow(window.navigation);
  await settled();

  assert.equal(window.path(), '/settings/credentials');
  assert.deepEqual(window.visits, []);
});

test('the memory is per window', async () => {
  const first = windowAt('/settings/versioning');
  const second = windowAt('/settings');

  createSectionRoute().follow(first.navigation);
  createSectionRoute().follow(second.navigation);
  await settled();

  assert.equal(second.path(), '/settings/providers');
});

test('a window that stops following keeps its path', async () => {
  const window = windowAt('/settings/tools');
  const subscription = createSectionRoute().follow(window.navigation);

  subscription.dispose();
  window.navigation.navigate('/settings');
  await settled();

  assert.equal(window.path(), '/settings');
});
