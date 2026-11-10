// T-4.1.12: the Appearance section is offered only while the app answers
// `doric.appearance/v1` (S35). An app before 1.3.0 has no provider, so the nav
// has no Appearance row and no route reaches the section.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RegionItem, RouteRegistration } from 'bundle/contracts';

import { registerAppearanceSection } from '../src/client/appearance-section.js';

/** Recording fakes of the four contracts the registration reads. */
const recorder = () => {
  const callbacks = new Map<string, () => unknown>();
  const items: { region: string; item: RegionItem; disposed: boolean }[] = [];
  const routes: { route: RouteRegistration; disposed: boolean }[] = [];
  const created: string[] = [];

  return {
    callbacks,
    created,
    links: () =>
      items
        .filter((entry) => !entry.disposed)
        .filter((entry) => entry.region === 'settings.sections')
        .map((entry) => entry.item.id),
    order: (id: string) =>
      items.find((entry) => !entry.disposed && entry.item.id === id)?.item
        .order,
    paths: () =>
      routes
        .filter((entry) => !entry.disposed)
        .map((entry) => entry.route.path),
    route: (path: string) =>
      routes.find((entry) => !entry.disposed && entry.route.path === path)
        ?.route,
    input: {
      services: {
        whenAvailable: (contract: { readonly id: string }, callback: never) => {
          callbacks.set(contract.id, callback);
          return { dispose: () => callbacks.delete(contract.id) };
        },
      },
      ui: {
        create: (tag: string) => {
          created.push(tag);
          return { tag };
        },
      },
      navigation: {
        register: (route: RouteRegistration) => {
          const entry = { route, disposed: false };
          routes.push(entry);
          return {
            dispose: () => {
              entry.disposed = true;
            },
          };
        },
      },
      regions: {
        add: (region: string, item: RegionItem) => {
          const entry = { region, item, disposed: false };
          items.push(entry);
          return {
            dispose: () => {
              entry.disposed = true;
            },
          };
        },
      },
    },
  };
};

test('nothing is offered before a doric.appearance/v1 provider answers', () => {
  const fakes = recorder();

  registerAppearanceSection(fakes.input as never);

  assert.deepEqual(fakes.links(), []);
  assert.deepEqual(fakes.paths(), []);
  assert.ok(
    fakes.callbacks.has('doric.appearance/v1'),
    'the section waits for doric.appearance/v1',
  );
});

test('a provider adds the Appearance link after Profile and its route under /settings', () => {
  const fakes = recorder();

  registerAppearanceSection(fakes.input as never);
  fakes.callbacks.get('doric.appearance/v1')?.();

  assert.deepEqual(fakes.links(), ['appearance']);
  const order = fakes.order('appearance') ?? Number.NaN;
  // Profile is order 5 and Providers 10.
  assert.ok(order > 5 && order < 10, `order ${order} sits after Profile`);
  assert.deepEqual(fakes.paths(), ['/settings/appearance']);
  const route = fakes.route('/settings/appearance');
  assert.equal(route?.parent, '/settings');
  route?.create({} as never);
  assert.deepEqual(fakes.created, ['settings-appearance']);
});

test("the provider's cleanup removes the link and the route", () => {
  const fakes = recorder();

  registerAppearanceSection(fakes.input as never);
  const cleanup = fakes.callbacks.get('doric.appearance/v1')?.();
  assert.equal(typeof cleanup, 'function', 'the callback returns a cleanup');
  (cleanup as () => void)();

  assert.deepEqual(fakes.links(), []);
  assert.deepEqual(fakes.paths(), []);
});

test('disposing the registration stops waiting for a provider', () => {
  const fakes = recorder();

  registerAppearanceSection(fakes.input as never).dispose();

  assert.equal(fakes.callbacks.has('doric.appearance/v1'), false);
});
