// layout.stack/v2 (2.0.0, sidebar alignment §9.4, D14; T-3.6): a pane is a
// group under the Thread region, and nothing in the stack resizes, so a pane
// that still declares a size is refused at the contract boundary. A valid
// pane registers, is listed, and opens and collapses through the service.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { createLayoutStack } from '../src/client/services/layout-stack.js';
import { resetStack } from '../src/client/stores/stack.js';
import { LayoutStackV2, type StackPane } from '../src/contracts/index.js';

const screens: StackPane = {
  id: 'screen-sidebar',
  order: 10,
  title: 'Screens',
  tag: 'screen-sidebar',
  headerTag: 'screen-group-action',
  collapsible: true,
  initiallyOpen: false,
};

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'screen' },
    provide: [createLayoutStack()],
  });
  return {
    stack: harness.services.use(LayoutStackV2),
    dispose: harness.dispose,
  };
};

beforeEach(resetStack);

describe('layout.stack/v2', () => {
  for (const [size, value] of [
    ['minSize', '20%'],
    ['maxSize', '80%'],
    ['defaultSize', '30%'],
  ] as const) {
    test(`refuses a pane that declares ${size}`, async () => {
      const { stack, dispose } = setup();
      // The old v1 shape: the v2 type has no size, so it is cast to reach the
      // boundary as another bundle's call would.
      const sized = { ...screens, [size]: value } as unknown as StackPane;

      assert.throws(
        () => stack.register(sized),
        (error: unknown) =>
          error instanceof ContractError && error.code === 'invalid_input',
      );
      assert.deepEqual(stack.panes(), [], 'The refused pane is listed.');
      await dispose();
    });
  }

  test('registers a pane without sizes, lists it, and opens and collapses it', async () => {
    const { stack, dispose } = setup();

    stack.register(screens);

    assert.deepEqual(
      stack.panes().map((pane: StackPane) => pane.id),
      ['screen-sidebar'],
    );
    assert.equal(stack.isOpen('screen-sidebar'), false);
    stack.setOpen('screen-sidebar', true);
    assert.equal(stack.isOpen('screen-sidebar'), true);
    stack.toggle('screen-sidebar');
    assert.equal(stack.isOpen('screen-sidebar'), false);
    await dispose();
  });
});
