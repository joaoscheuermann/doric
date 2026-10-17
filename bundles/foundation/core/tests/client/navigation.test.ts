// navigation/v1 in a real window: history entries, back and forward, the
// no-op navigation, replace, other origins, route conflicts and the cached
// current()/chain().

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  isContractError,
  NavigationV1,
  type RouteMatch,
  type Services,
} from 'bundle/contracts';

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

const routes = (services: Services) => {
  const navigation = services.use(NavigationV1);

  navigation.register({
    path: '/',
    create: () => document.createElement('div'),
  });
  navigation.register({
    path: '/projects/:projectId/threads/:threadId',
    create: () => document.createElement('div'),
  });
};

const open = async (url = 'doric://app/') => {
  const x = probe('x', routes);

  opened = await openWindow({ url, probes: [x] });

  return { window: opened.window, navigation: x.services().use(NavigationV1) };
};

const popped = async (window: TestWindow['window'], move: () => void) => {
  const done = new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true });
  });

  move();
  await done;
  await settle();
};

void test('back and forward restore the route and notify', async () => {
  const { window, navigation } = await open();
  const seen: (RouteMatch | undefined)[] = [];

  navigation.subscribe((match) => seen.push(match));
  navigation.navigate('/projects/p1/threads/t1');
  navigation.navigate('/projects/p1/threads/t2');

  await popped(window, () => navigation.back());
  assert.equal(window.location.pathname, '/projects/p1/threads/t1');
  assert.deepEqual(navigation.current()?.params, {
    projectId: 'p1',
    threadId: 't1',
  });

  await popped(window, () => window.history.forward());
  assert.equal(
    navigation.current()?.pattern,
    '/projects/:projectId/threads/:threadId',
  );
  assert.deepEqual(navigation.current()?.params, {
    projectId: 'p1',
    threadId: 't2',
  });
  assert.deepEqual(
    seen.map((match) => match?.params.threadId),
    ['t1', 't2', 't1', 't2'],
  );
});

void test('navigating to the current location adds no history entry', async () => {
  const { window, navigation } = await open(
    'doric://app/projects/p1/threads/t1?a=1#h',
  );
  const length = window.history.length;
  let notified = 0;

  navigation.subscribe(() => {
    notified += 1;
  });
  navigation.navigate('/projects/p1/threads/t1?a=1#h');

  assert.equal(window.history.length, length);
  assert.equal(notified, 0);
});

void test('replace swaps the current entry instead of adding one', async () => {
  const { window, navigation } = await open();
  const length = window.history.length;

  navigation.navigate('/projects/p1/threads/t1', { replace: true });

  assert.equal(window.history.length, length);
  assert.equal(window.location.pathname, '/projects/p1/threads/t1');
  assert.equal(navigation.current()?.params.threadId, 't1');
});

void test('search and hash are kept and do not take part in matching', async () => {
  const { window, navigation } = await open();

  navigation.navigate('/projects/p1/threads/t1?tab=files#bottom');

  assert.equal(window.location.search, '?tab=files');
  assert.equal(window.location.hash, '#bottom');
  assert.equal(navigation.current()?.path, '/projects/p1/threads/t1');
});

void test('a path of another origin is refused', async () => {
  const { window, navigation } = await open();

  assert.throws(
    () => navigation.navigate('https://example.com/'),
    (error: unknown) =>
      isContractError(error) && error.code === 'invalid_input',
  );
  assert.equal(window.location.href, 'doric://app/');
});

void test('current() and chain() keep their identity until the match changes', async () => {
  const { navigation } = await open('doric://app/projects/p1/threads/t1');
  const current = navigation.current();
  const chain = navigation.chain();

  navigation.navigate('/projects/p1/threads/t1?x=1');

  assert.equal(navigation.current(), current);
  assert.equal(navigation.chain(), chain);

  navigation.navigate('/projects/p1/threads/t2');

  assert.notEqual(navigation.current(), current);
  assert.equal(navigation.current()?.params.threadId, 't2');
});

void test('a second route with the same shape is a route conflict', async () => {
  const { navigation } = await open();

  assert.throws(
    () =>
      navigation.register({
        path: '/projects/:id/threads/:other/',
        create: () => ({}),
      }),
    (error: unknown) =>
      isContractError(error) &&
      error.code === 'route_conflict' &&
      error.message.includes('/projects/:id/threads/:other'),
  );
});

void test('a registration that changes the active match notifies; its disposal too', async () => {
  const { navigation } = await open('doric://app/settings');
  const seen: (string | undefined)[] = [];

  assert.equal(navigation.current(), undefined);
  navigation.subscribe((match) => seen.push(match?.pattern));

  const registration = navigation.register({
    path: '/settings',
    create: () => ({}),
  });

  assert.equal(navigation.current()?.pattern, '/settings');
  registration.dispose();
  assert.equal(navigation.current(), undefined);
  assert.deepEqual(seen, ['/settings', undefined]);
});
