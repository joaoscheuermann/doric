// <core-outlet> in a real window: the bootstrap shows the core's outlet, a
// child route renders inside its parent's outlet, the same pattern keeps its
// element, and an unmatched path shows <core-not-found> with the URL kept.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1, type Services, UiV1 } from 'bundle/contracts';

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

/** `x-parent` holds an inner outlet; `x-child` shows its params. */
const nesting = (services: Services) => {
  const ui = services.use(UiV1);
  const navigation = services.use(NavigationV1);

  class Parent extends HTMLElement {
    connectedCallback(): void {
      if (this.firstChild === null) {
        const header = document.createElement('h1');

        header.textContent = 'Projects';
        this.append(header, document.createElement('core-outlet'));
      }
    }
  }

  class Child extends HTMLElement {
    projectId = '';
    threadId = '';
    disposed = 0;

    dispose(): void {
      this.disposed += 1;
    }
  }

  ui.define('x-parent', Parent);
  ui.define('x-child', Child);
  navigation.register({
    path: '/',
    create: () => ui.create('x-parent'),
  });
  navigation.register({
    path: '/projects/:projectId/threads/:threadId',
    parent: '/',
    create: (match) => ui.create('x-child', match.params),
  });
};

void test('a child route renders inside its parent outlet', async () => {
  const x = probe('x', nesting);

  opened = await openWindow({
    url: 'doric://app/projects/p1/threads/t1',
    probes: [x],
  });

  const { document } = opened;
  const top = document.body.firstElementChild;

  assert.equal(top?.localName, 'core-outlet');
  assert.equal(document.body.children.length, 1);
  assert.equal(top?.firstElementChild?.localName, 'x-parent');

  const child = document.querySelector(
    'core-outlet > x-parent > core-outlet > x-child',
  ) as unknown as { projectId: string; threadId: string } | null;

  assert.ok(child, document.body.innerHTML);
  assert.equal(child.projectId, 'p1');
  assert.equal(child.threadId, 't1');
  assert.deepEqual(opened.steps, ['ready']);
});

void test('the same pattern keeps its element and receives the new params', async () => {
  const x = probe('x', nesting);

  opened = await openWindow({
    url: 'doric://app/projects/p1/threads/t1',
    probes: [x],
  });

  const before = opened.document.querySelector('x-child') as unknown as {
    threadId: string;
    disposed: number;
  };

  x.services().use(NavigationV1).navigate('/projects/p1/threads/t2');
  await settle();

  const after = opened.document.querySelector('x-child') as unknown as {
    threadId: string;
  };

  assert.equal(after, before);
  assert.equal(after.threadId, 't2');
  assert.equal(before.disposed, 0);
});

void test('another pattern disposes the shown element', async () => {
  const x = probe('x', nesting);

  opened = await openWindow({
    url: 'doric://app/projects/p1/threads/t1',
    probes: [x],
  });

  const child = opened.document.querySelector('x-child') as unknown as {
    disposed: number;
    isConnected: boolean;
  };

  x.services().use(NavigationV1).navigate('/');
  await settle();

  assert.equal(child.disposed, 1);
  assert.equal(child.isConnected, false);
  assert.equal(opened.document.querySelector('x-child'), null);
  assert.ok(opened.document.querySelector('core-outlet > x-parent'));
});

void test('an unmatched path shows core-not-found and keeps the URL', async () => {
  const x = probe('x', nesting);

  opened = await openWindow({ url: 'doric://app/nowhere/here', probes: [x] });

  const notFound = opened.document.querySelector(
    'body > core-outlet > core-not-found',
  ) as unknown as { path: string; textContent: string } | null;

  assert.ok(notFound, opened.document.body.innerHTML);
  assert.equal(notFound.path, '/nowhere/here');
  assert.equal(notFound.textContent, 'Nothing is registered at /nowhere/here.');
  assert.equal(
    opened.document.querySelector('core-not-found [role="status"] code')
      ?.textContent,
    '/nowhere/here',
  );
  assert.equal(opened.window.location.pathname, '/nowhere/here');
});

void test('a path without a child route leaves the inner outlet empty', async () => {
  const x = probe('x', nesting);

  opened = await openWindow({ url: 'doric://app/', probes: [x] });

  const inner = opened.document.querySelector('x-parent > core-outlet');

  assert.ok(inner);
  assert.equal(inner.childNodes.length, 0);
  assert.equal(opened.document.querySelector('core-not-found'), null);
});
