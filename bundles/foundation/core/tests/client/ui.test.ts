// ui/v1 in a real window: tag ownership, elements created with their owner's
// services, and disposal that ends what the element registered.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  isContractError,
  LogV1,
  RegionsV1,
  type Services,
  UiV1,
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

interface Card extends HTMLElement {
  label: string;
  seenOnConnect: string | undefined;
  disposed: number;
  services?: Services;
}

const cards = (services: Services) => {
  class XCard extends HTMLElement {
    label = '';
    seenOnConnect: string | undefined;
    disposed = 0;

    connectedCallback(): void {
      this.seenOnConnect = this.label;
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  services.use(UiV1).define('x-card', XCard);
};

const open = async () => {
  const x = probe('x', cards);

  opened = await openWindow({ probes: [x] });

  return { ui: x.services().use(UiV1), services: x.services() };
};

void test('a tag must start with the bundle id', async () => {
  const { ui } = await open();

  assert.throws(
    () => ui.define('y-card', class extends HTMLElement {}),
    (error: unknown) =>
      isContractError(error) &&
      error.code === 'invalid_input' &&
      error.message === 'The tag "y-card" must start with "x-".',
  );
});

void test('a tag already defined is a registration conflict', async () => {
  const { ui } = await open();

  assert.throws(
    () => ui.define('x-card', class extends HTMLElement {}),
    (error: unknown) =>
      isContractError(error) && error.code === 'registration_conflict',
  );
});

void test('a tag nobody owns gives a hidden core-unavailable', async () => {
  const { ui } = await open();
  const element = ui.create('nobody-here') as HTMLElement;

  opened?.document.body.append(element);

  assert.equal(element.localName, 'core-unavailable');
  assert.equal(element.getAttribute('data-tag'), 'nobody-here');
  assert.equal(element.hidden, true);
  assert.equal(element.childNodes.length, 0);
});

void test('props are set before the element is connected', async () => {
  const { ui } = await open();
  const card = ui.create('x-card', { label: 'Hello' }) as Card;

  assert.equal(card.isConnected, false);
  opened?.document.body.append(card);
  assert.equal(card.seenOnConnect, 'Hello');
});

void test('a call through element services is made as the owner', async () => {
  const { ui } = await open();
  const card = ui.create('x-card') as Card;

  card.services?.use(LogV1).info('from the card');
  await settle();

  const record = opened
    ?.received('doric.shell/v1.log')
    .map(({ input }) => input as { message: string; bundleId: string })
    .find(({ message }) => message === 'from the card');

  assert.equal(record?.bundleId, 'x');
});

void test("registrations through element services end with ui.dispose; the owner's survive", async () => {
  const { ui, services } = await open();
  const regions = services.use(RegionsV1);

  regions.add('x.panel', { id: 'owner', tag: 'x-card' });

  const card = ui.create('x-card') as Card;

  card.services
    ?.use(RegionsV1)
    .add('x.panel', { id: 'element', tag: 'x-card' });
  assert.deepEqual(
    regions.items('x.panel').map(({ id }) => id),
    ['owner', 'element'],
  );

  ui.dispose(card);
  await settle();

  assert.deepEqual(
    regions.items('x.panel').map(({ id }) => id),
    ['owner'],
  );
});

void test('dispose removes the element once', async () => {
  const { ui } = await open();
  const card = ui.create('x-card') as Card;

  opened?.document.body.append(card);
  ui.dispose(card);
  ui.dispose(card);

  assert.equal(card.isConnected, false);
  assert.equal(card.disposed, 1);
});
