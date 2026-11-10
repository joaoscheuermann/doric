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

import { createNavigation } from '../../src/client/navigation.js';
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

// Back/Forward (S11): each entry the core writes holds `{ doric: { index, max } }`.

const threadPath = (threadId: string) => `/projects/p1/threads/${threadId}`;

void test('Back shows the previous Thread and enables Forward; Forward shows the next (T-4.2.1)', async () => {
  const { window, navigation } = await open();
  const seen: (string | undefined)[] = [];

  navigation.subscribe((match) => seen.push(match?.params.threadId));
  assert.deepEqual(navigation.history(), {
    canGoBack: false,
    canGoForward: false,
  });

  navigation.navigate(threadPath('a'));
  navigation.navigate(threadPath('b'));
  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: false,
  });

  await popped(window, () => navigation.back());
  assert.equal(navigation.current()?.params.threadId, 'a');
  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: true,
  });

  await popped(window, () => navigation.forward());
  assert.equal(navigation.current()?.params.threadId, 'b');
  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: false,
  });
  assert.deepEqual(seen, ['a', 'b', 'a', 'b']);
});

void test('a navigation after Back disables Forward (T-4.2.2)', async () => {
  const { window, navigation } = await open();

  navigation.navigate(threadPath('a'));
  navigation.navigate(threadPath('b'));
  await popped(window, () => navigation.back());
  navigation.navigate(threadPath('c'));

  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: false,
  });
});

void test('a replace keeps the entry where it is in the list', async () => {
  const { window, navigation } = await open();

  navigation.navigate(threadPath('a'));
  navigation.navigate(threadPath('b'));
  await popped(window, () => navigation.back());
  navigation.navigate(threadPath('c'), { replace: true });

  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: true,
  });
  assert.deepEqual(window.history.state, { doric: { index: 1, max: 2 } });
});

/** Calls a method of a navigation definition as the runtime would. */
const invoke = (
  definition: ReturnType<typeof createNavigation>,
  name: string,
): unknown => {
  const method = (
    definition.methods as Record<
      string,
      { execute(input: unknown, call: unknown, services: unknown): unknown }
    >
  )[name];

  assert.ok(method, `navigation has no ${name}`);

  return method.execute(undefined, undefined, undefined);
};

void test('after a reload, Back and Forward keep the list the entries hold (T-4.2.4)', async () => {
  const { window, navigation } = await open();

  navigation.navigate(threadPath('a'));
  navigation.navigate(threadPath('b'));
  navigation.navigate(threadPath('c'));
  await popped(window, () => navigation.back());

  // A reload runs a new navigation module over the same session history.
  const reloaded = createNavigation();

  assert.deepEqual(invoke(reloaded, 'history'), {
    canGoBack: true,
    canGoForward: true,
  });

  await popped(window, () => invoke(reloaded, 'forward'));
  assert.equal(window.location.pathname, threadPath('c'));
  assert.deepEqual(invoke(reloaded, 'history'), {
    canGoBack: true,
    canGoForward: false,
  });
});

void test('popstate to an entry with a larger max raises the max (T-4.2.5)', async () => {
  const { window, navigation } = await open();

  navigation.navigate(threadPath('a'));
  window.history.pushState(
    { doric: { index: 2, max: 7 } },
    '',
    threadPath('z'),
  );
  await popped(window, () => window.history.back());
  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: false,
  });

  await popped(window, () => window.history.forward());
  assert.deepEqual(navigation.history(), {
    canGoBack: true,
    canGoForward: true,
  });
  assert.deepEqual(window.history.state, { doric: { index: 2, max: 7 } });
});

void test('popstate to an entry without doric state counts as the first entry', async () => {
  const { window, navigation } = await open();

  navigation.navigate(threadPath('a'));
  navigation.navigate(threadPath('b'));
  window.history.pushState(null, '', threadPath('z'));
  navigation.navigate(threadPath('c'));
  await popped(window, () => window.history.back());

  assert.deepEqual(navigation.history(), {
    canGoBack: false,
    canGoForward: true,
  });
  assert.equal(window.history.state, null);
});

void test('the history state lives only in the entries the core writes (T-4.2.6)', async () => {
  const { window, navigation } = await open();
  const states: unknown[] = [];

  navigation.subscribe(() => states.push(window.history.state));
  states.push(window.history.state);
  navigation.navigate(threadPath('a'));
  states.push(window.history.state);
  navigation.navigate(threadPath('b'));
  states.push(window.history.state);
  navigation.navigate(threadPath('c'), { replace: true });
  states.push(window.history.state);
  await popped(window, () => navigation.back());
  states.push(window.history.state);

  for (const state of states) {
    assert.ok(typeof state === 'object' && state !== null, String(state));
    assert.deepEqual(Object.keys(state), ['doric']);
    const { doric } = state as { doric: object };
    assert.deepEqual(Object.keys(doric).sort(), ['index', 'max']);
  }
  assert.deepEqual(states.at(0), { doric: { index: 0, max: 0 } });
  assert.equal(window.sessionStorage.length, 0);
  assert.equal(window.localStorage.length, 0);
});

void test('the history methods follow the app: six without them, eight with them (T-4.2.11)', () => {
  const old = ['back', 'chain', 'current', 'navigate', 'register', 'subscribe'];

  assert.deepEqual(
    Object.keys(createNavigation({ historyMethods: false }).methods).sort(),
    old,
  );
  assert.deepEqual(
    Object.keys(createNavigation().methods).sort(),
    [...old, 'forward', 'history'].sort(),
  );
});
