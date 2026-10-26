// layout.dashboard/v1: the /projects dashboard starts on the project list,
// `show` opens a page another bundle added to `layout.dashboard.page`,
// `close` goes back to the list, and subscribers hear each change of the
// shown page until they dispose.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { createLayoutDashboard } from '../src/client/services/layout-dashboard.js';
import { resetDashboard } from '../src/client/stores/dashboard.js';
import { LayoutDashboardV1 } from '../src/contracts/index.js';

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'settings' },
    provide: [createLayoutDashboard()],
  });
  return {
    dashboard: harness.services.use(LayoutDashboardV1),
    dispose: harness.dispose,
  };
};

beforeEach(resetDashboard);

describe('layout.dashboard/v1', () => {
  test('a fresh dashboard shows the project list', async () => {
    const { dashboard, dispose } = setup();
    assert.equal(dashboard.active(), undefined);
    await dispose();
  });

  test('show opens the page it names and notifies subscribers', async () => {
    const { dashboard, dispose } = setup();
    let heard = 0;
    dashboard.subscribe(() => {
      heard += 1;
    });

    dashboard.show('settings.provider');

    assert.equal(dashboard.active(), 'settings.provider');
    assert.equal(heard, 1);
    await dispose();
  });

  test('showing the page already shown notifies no one', async () => {
    const { dashboard, dispose } = setup();
    dashboard.show('settings.provider');
    let heard = 0;
    dashboard.subscribe(() => {
      heard += 1;
    });

    dashboard.show('settings.provider');

    assert.equal(heard, 0);
    assert.equal(dashboard.active(), 'settings.provider');
    await dispose();
  });

  test('close goes back to the project list and notifies subscribers', async () => {
    const { dashboard, dispose } = setup();
    dashboard.show('settings.provider');
    let heard = 0;
    dashboard.subscribe(() => {
      heard += 1;
    });

    dashboard.close();

    assert.equal(dashboard.active(), undefined);
    assert.equal(heard, 1);
    await dispose();
  });

  test('an empty page id is refused as invalid input', async () => {
    const { dashboard, dispose } = setup();
    assert.throws(
      () => dashboard.show(''),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    assert.equal(dashboard.active(), undefined);
    await dispose();
  });

  test('a disposed subscription hears nothing', async () => {
    const { dashboard, dispose } = setup();
    let heard = 0;
    const subscription = dashboard.subscribe(() => {
      heard += 1;
    });
    subscription.dispose();

    dashboard.show('settings.provider');

    assert.equal(heard, 0);
    await dispose();
  });

  test('resetting the dashboard goes back to the project list', async () => {
    const { dashboard, dispose } = setup();
    dashboard.show('settings.provider');

    resetDashboard();

    assert.equal(dashboard.active(), undefined);
    await dispose();
  });
});
