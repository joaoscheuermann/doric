// The sidebar stack's registry and open state (`layout.stack/v1`): bundles
// register their groups (`registerPane`), the layout draws them in order, and a
// pane's own state decides whether its content is drawn — a pane that cannot
// collapse never closes, and a drag that reaches the header reports the pane
// collapsed.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  isPaneOpen,
  registerPane,
  resetStack,
  setPaneOpen,
  stackStore,
  togglePane,
} from '../src/client/stores/stack.js';
import type { StackPane } from '../src/contracts/index.js';

const screens: StackPane = {
  id: 'screen-sidebar',
  order: 10,
  title: 'Screens',
  tag: 'screen-sidebar',
  headerTag: 'screen-group-action',
  initiallyOpen: false,
  minSize: '20%',
};

const pane = (id: string, extra: Partial<StackPane> = {}): StackPane => ({
  id,
  title: id,
  ...extra,
});

beforeEach(() => {
  resetStack();
});

describe('the stack registry', () => {
  test('keeps an empty stack until a pane registers', () => {
    assert.deepEqual(stackStore.getState().panes, []);
    assert.deepEqual(stackStore.getState().open, {});
  });

  test('registers panes top to bottom and hands them back in order', () => {
    registerPane(screens);
    registerPane(pane('first', { order: 0 }));

    assert.deepEqual(
      stackStore.getState().panes.map((entry) => entry.id),
      ['first', 'screen-sidebar'],
    );
  });

  test('refuses a duplicate id', () => {
    registerPane(screens);

    assert.throws(
      () => registerPane(pane('screen-sidebar')),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === 'registration_conflict',
    );
  });

  test('disposing the registration removes the pane and its state', () => {
    const registration = registerPane(screens);
    assert.deepEqual(stackStore.getState().panes, [screens]);

    registration.dispose();
    registration.dispose();

    assert.deepEqual(stackStore.getState().panes, []);
    assert.deepEqual(stackStore.getState().open, {});
  });

  test('notifies its subscribers on every change', () => {
    let notifications = 0;
    const stop = stackStore.subscribe(() => {
      notifications += 1;
    });

    const registration = registerPane(screens);
    registration.dispose();
    stop();

    assert.equal(notifications, 2);
  });
});

describe('a pane the reader can collapse', () => {
  test('starts open unless it declares otherwise', () => {
    registerPane(pane('open-by-default'));
    registerPane(screens);

    assert.equal(isPaneOpen('open-by-default'), true);
    assert.equal(isPaneOpen('screens'), false);
  });

  test('opens and collapses from that state', () => {
    registerPane(screens);

    setPaneOpen('screen-sidebar', true);
    assert.equal(isPaneOpen('screen-sidebar'), true);

    togglePane('screen-sidebar');
    assert.equal(isPaneOpen('screen-sidebar'), false);
  });

  test('an unknown pane is not open', () => {
    assert.equal(isPaneOpen('missing'), false);
  });
});

describe('a pane that cannot collapse', () => {
  const fixed = pane('fixed', { collapsible: false, initiallyOpen: false });

  test('is always open, whatever it declared', () => {
    registerPane(fixed);

    assert.equal(isPaneOpen('fixed'), true);
  });

  test('ignores the requests that would close it', () => {
    registerPane(fixed);

    setPaneOpen('fixed', false);
    togglePane('fixed');

    assert.equal(isPaneOpen('fixed'), true);
  });
});
