import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type LoadOutcome,
  Startup,
  type StartupDeps,
} from '../src/platform/catalog/distribution';
import { silentLog } from '../src/platform/log';
import type { SplashState } from '../src/platform/splash/state';
import type { Clock } from '../src/platform/splash/timing';

/** A clock whose time moves only when the test says so. */
const fakeClock = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  };
  const clock: Clock = {
    now: () => now,
    setTimeout: (run, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, run });

      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };

  return {
    clock,
    flush,
    advance: async (ms: number) => {
      const until = now + ms;

      await flush();

      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, left], [, right]) => left.at - right.at)[0];

        if (due === undefined) {
          break;
        }

        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await flush();
      }

      now = until;
      await flush();
    },
  };
};

/** The host bridge as the startup sees it: a status the test drives. */
const fakeHost = (connected: boolean) => {
  const listeners = new Set<
    (status: { connected: boolean; error?: string }) => void
  >();
  const host = {
    url: 'http://127.0.0.1:3000',
    connected,
    retries: 0,
    onStatus: (
      listener: (status: { connected: boolean; error?: string }) => void,
    ) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    retry: () => {
      host.retries += 1;
    },
    emit: (status: { connected: boolean; error?: string }) => {
      host.connected = status.connected;

      for (const listener of [...listeners]) {
        listener(status);
      }
    },
  };

  return host;
};

const boot = (
  options: {
    readonly connected?: boolean;
    readonly recovery?: boolean;
    readonly outcome?: LoadOutcome;
  } = {},
) => {
  const time = fakeClock();
  const host = fakeHost(options.connected ?? true);
  const states: SplashState[] = [];
  const events: string[] = [];
  const deps: StartupDeps = {
    clock: time.clock,
    splash: {
      set: (state) => states.push(state),
      open: () => events.push('splash-open'),
      close: () => events.push('splash-close'),
    },
    host,
    log: silentLog,
    recovery: options.recovery ?? false,
    hasSnapshot: async () => false,
    hasLastGoodCore: () => false,
    load: async () =>
      options.outcome ?? { kind: 'ready', generation: 1, quarantines: [] },
    appReady: async () => {
      events.push(`app-ready@${time.clock.now()}`);
    },
    disable: async () => undefined,
    resetComposition: async () => undefined,
    diagnostics: () => undefined,
  };
  const startup = new Startup(deps);

  return { startup, time, host, states, events };
};

const last = (states: readonly SplashState[]) => states.at(-1);

describe('splash and startup timing', () => {
  test('a host that answers at once still holds the splash for five seconds before onAppReadyHook', async () => {
    const { startup, time, events } = boot();

    void startup.run();
    await time.advance(4_999);
    assert.equal(events.length, 0);
    await time.advance(1);
    assert.deepEqual(events, ['app-ready@5000']);
  });

  test('the splash stays until the first window is ready; later ready() calls do nothing', async () => {
    const { startup, time, events } = boot();

    void startup.run();
    await time.advance(5_000);
    await time.advance(10_000);
    assert.ok(!events.includes('splash-close'));

    startup.windowReady();
    startup.windowReady();

    assert.deepEqual(
      events.filter((event) => event === 'splash-close'),
      ['splash-close'],
    );
  });

  test('no window ready within 30 seconds of onAppReadyHook shows recovery', async () => {
    const { startup, time, states } = boot();

    void startup.run();
    await time.advance(5_000);
    await time.advance(29_999);
    assert.notEqual(last(states)?.state, 'recovery');
    await time.advance(1);
    assert.equal(last(states)?.state, 'recovery');
  });

  test('--recovery shows recovery and never fires onAppReadyHook', async () => {
    const { startup, time, states, events } = boot({ recovery: true });

    void startup.run();
    await time.advance(60_000);

    assert.equal(last(states)?.state, 'recovery');
    assert.ok(!events.some((event) => event.startsWith('app-ready')));
  });

  test('a refusing host shows host-unreachable with the attempts and connects on its own', async () => {
    const { startup, time, host, states, events } = boot({ connected: false });

    void startup.run();
    await time.flush();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      host.emit({
        connected: false,
        error: 'connect ECONNREFUSED 127.0.0.1:3000',
      });
      await time.advance(1_000);
    }

    assert.deepEqual(last(states), {
      state: 'host-unreachable',
      hostUrl: 'http://127.0.0.1:3000',
      lastError: 'connect ECONNREFUSED 127.0.0.1:3000',
      attempts: 3,
      hasSnapshot: false,
    });

    host.emit({ connected: true });
    await time.advance(5_000);

    assert.equal(
      events.filter((event) => event.startsWith('app-ready')).length,
      1,
    );
  });

  test('Retry on host-unreachable asks for an immediate attempt', async () => {
    const { startup, time, host } = boot({ connected: false });

    void startup.run();
    await time.flush();
    host.emit({ connected: false, error: 'refused' });
    await startup.act({ action: 'retry' });

    assert.equal(host.retries, 1);
  });

  test('a core failure waits for an action instead of firing onAppReadyHook', async () => {
    const { startup, time, states, events } = boot({
      outcome: {
        kind: 'core-failure',
        core: { id: 'core', version: '1.3.0' },
        error: 'core core failed: boom',
      },
    });

    void startup.run();
    await time.advance(60_000);

    assert.deepEqual(last(states), {
      state: 'core-failure',
      core: { id: 'core', version: '1.3.0' },
      error: 'core core failed: boom',
      hasLastGoodCore: false,
    });
    assert.ok(!events.some((event) => event.startsWith('app-ready')));
  });

  test('desktop-detected bundle failures wait for Continue, then the app starts', async () => {
    const quarantines = [
      {
        id: 'probe-new',
        version: '1.0.0',
        reasons: [
          {
            code: 'engines_unsatisfied' as const,
            message: 'requires doric ^2.0.0; platform is 1.0.0',
          },
        ],
      },
    ];
    const { startup, time, states, events } = boot({
      outcome: { kind: 'ready', generation: 1, quarantines },
    });

    void startup.run();
    await time.advance(10_000);
    assert.deepEqual(last(states), {
      state: 'bundle-failure',
      bundles: quarantines,
    });
    assert.equal(events.length, 0);

    await startup.act({ action: 'continue' });
    await time.advance(0);

    assert.equal(
      events.filter((event) => event.startsWith('app-ready')).length,
      1,
    );
  });
});
