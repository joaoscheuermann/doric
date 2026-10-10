import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Lifecycle } from '../src/platform/lifecycle';
import { silentLog } from '../src/platform/log';

const tick = () => new Promise((resolve) => setImmediate(resolve));

const setup = (decide: () => Promise<unknown>) => {
  const runs: { hook: string; input: unknown }[] = [];
  let quits = 0;
  const lifecycle = new Lifecycle({
    target: {
      run: async (hook, input) => {
        runs.push({ hook, input });

        return hook === 'onBeforeQuitHook' ? await decide() : undefined;
      },
    },
    log: silentLog,
    quit: () => {
      quits += 1;
    },
  });
  const quitEvent = () => {
    let prevented = false;

    lifecycle.beforeQuit({ preventDefault: () => (prevented = true) });

    return prevented;
  };

  return { lifecycle, runs, quits: () => quits, quitEvent };
};

describe('app lifecycle hooks', () => {
  test('a quit waits for onBeforeQuitHook; allow quits for real', async () => {
    const { quits, quitEvent } = setup(async () => ({ allow: true }));

    assert.equal(quitEvent(), true);
    await tick();
    assert.equal(quits(), 1);
    // The quit main asked for itself goes through.
    assert.equal(quitEvent(), false);
  });

  test('a denied quit keeps the app and lets a later quit ask again', async () => {
    const { lifecycle, quits, quitEvent } = setup(async () => ({
      allow: false,
      reason: 'busy',
    }));

    quitEvent();
    await tick();

    assert.equal(quits(), 0);
    assert.equal(lifecycle.quitting, false);
  });

  test('a second quit request while the hook decides forces the quit', async () => {
    const { quits, quitEvent } = setup(() => new Promise(() => undefined));

    quitEvent();
    quitEvent();
    await tick();

    assert.equal(quits(), 1);
  });

  test('connection changes reach onConnectionChangedHook once per transition', async () => {
    const { lifecycle, runs } = setup(async () => undefined);

    lifecycle.connectionChanged(true);
    lifecycle.connectionChanged(true);
    lifecycle.connectionChanged(false);
    await tick();

    assert.deepEqual(
      runs.map(({ hook, input }) => ({ hook, input })),
      [
        { hook: 'onConnectionChangedHook', input: { connected: true } },
        { hook: 'onConnectionChangedHook', input: { connected: false } },
      ],
    );
  });
});
