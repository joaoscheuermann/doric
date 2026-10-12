// regions/v1 and <core-region name> in a real window: order then add order,
// late additions, removal on disposal of the item or of its owner, and
// duplicate ids refused.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  isContractError,
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

const items = (services: Services) => {
  class Item extends HTMLElement {
    label = '';
    disposed = 0;

    connectedCallback(): void {
      this.textContent = this.label;
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  services.use(UiV1).define('x-item', Item);
};

const texts = (region: Element): string[] =>
  Array.from(region.children).map((child) => child.textContent ?? '');

const open = async (others: ReturnType<typeof probe>[] = []) => {
  const x = probe('x', items);

  opened = await openWindow({ probes: [x, ...others] });

  const region = opened.document.createElement('core-region');

  region.setAttribute('name', 'x.footer');
  opened.document.body.append(region);

  return { regions: x.services().use(RegionsV1), region };
};

void test('items appear by order, then by add order, absent order last', async () => {
  const { regions, region } = await open();

  regions.add('x.footer', { id: 'c', tag: 'x-item', props: { label: 'C' } });
  regions.add('x.footer', {
    id: 'b',
    tag: 'x-item',
    order: 20,
    props: { label: 'B' },
  });
  regions.add('x.footer', {
    id: 'a',
    tag: 'x-item',
    order: 10,
    props: { label: 'A' },
  });
  regions.add('x.footer', {
    id: 'b2',
    tag: 'x-item',
    order: 20,
    props: { label: 'B2' },
  });

  assert.deepEqual(texts(region), ['A', 'B', 'B2', 'C']);
  assert.deepEqual(
    regions.items('x.footer').map(({ id, owner }) => [id, owner]),
    [
      ['a', 'x'],
      ['b', 'x'],
      ['b2', 'x'],
      ['c', 'x'],
    ],
  );
});

void test('a late item appears in place without recreating the others', async () => {
  const { regions, region } = await open();

  regions.add('x.footer', {
    id: 'last',
    tag: 'x-item',
    order: 30,
    props: { label: 'Last' },
  });

  const kept = region.firstElementChild;

  regions.add('x.footer', {
    id: 'first',
    tag: 'x-item',
    order: 10,
    props: { label: 'First' },
  });

  assert.deepEqual(texts(region), ['First', 'Last']);
  assert.equal(region.lastElementChild, kept);
});

void test('a removed item is disposed and leaves the region', async () => {
  const { regions, region } = await open();
  const added = regions.add('x.footer', {
    id: 'one',
    tag: 'x-item',
    props: { label: 'One' },
  });
  const element = region.firstElementChild as unknown as { disposed: number };

  added.dispose();

  assert.deepEqual(texts(region), []);
  assert.equal(element.disposed, 1);
});

void test("a quarantined owner's items leave the region", async () => {
  const failing = probe('y', (services) => {
    services.use(RegionsV1).add('x.footer', {
      id: 'from-y',
      tag: 'x-item',
      props: { label: 'Y' },
    });
    throw new Error('y fails after adding');
  });
  const { regions } = await open([failing]);

  await settle();

  assert.equal(opened?.quarantines.y?.code, 'activate_failed');
  assert.deepEqual(regions.items('x.footer'), []);
});

void test('a duplicate id in one region is refused', async () => {
  const { regions } = await open();

  regions.add('x.footer', { id: 'same', tag: 'x-item' });

  assert.throws(
    () => regions.add('x.footer', { id: 'same', tag: 'x-item' }),
    (error: unknown) =>
      isContractError(error) && error.code === 'registration_conflict',
  );
  regions.add('x.header', { id: 'same', tag: 'x-item' });
});

void test('an item whose tag nobody owns renders nothing visible', async () => {
  const { regions, region } = await open();

  regions.add('x.footer', { id: 'ghost', tag: 'z-missing' });

  const child = region.firstElementChild as HTMLElement | null;

  assert.equal(child?.localName, 'core-unavailable');
  assert.equal(child?.hidden, true);
});
