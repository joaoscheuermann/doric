// Host shutdown (spec `docs/designs/grpc-processes.md`, section 7, "Stop",
// "Host shutdown"; T2.11; RK19; A67): `platform.shutdown()` stops the bundles
// by dependency level in reverse activation order, so a dependent's
// deactivation can still call its provider, and kills with `SIGKILL` what is
// alive at the shutdown deadline. The fixture `tests/fixtures/scripted` runs
// each bundle against a real router listener
// (`tests/support/scripted-host.ts`); at most four fixture processes are
// alive at once, and every test stops what it started in `after`.
//
// T2.11's `SIGTERM` trigger belongs to the host program (phase 3), which
// calls `shutdown` on the signal; these tests call `shutdown` directly.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  isAlive,
  setupPlatform,
  until,
  within,
} from '../support/scripted-host.js';

describe('platform shutdown', () => {
  test('stops the bundles by dependency level, dependents before their providers', async (t) => {
    const env = await setupPlatform(t, {
      base: { mode: 'alive', provides: ['base.api/v1@1.0.0'] },
      mid: {
        mode: 'alive',
        provides: ['mid.api/v1@1.0.0'],
        requires: ['base.api/v1@^1.0.0'],
      },
      top: { mode: 'alive', requires: ['mid.api/v1@^1.0.0'] },
    });

    await within(env.platform.shutdown(), 'the shutdown');

    const events = env.log.events();
    const at = (event: string): number => {
      const index = events.indexOf(event);

      assert.ok(index >= 0, `${event} is missing: ${events.join(', ')}`);

      return index;
    };

    // Each level starts once the one above it has stopped.
    assert.ok(
      at('top deactivated') < at('mid deactivate'),
      `mid was stopped before top: ${events.join(', ')}`,
    );
    assert.ok(
      at('mid deactivated') < at('base deactivate'),
      `base was stopped before mid: ${events.join(', ')}`,
    );
    assert.ok(
      at('mid deactivated') < at('core deactivate'),
      `core was stopped before mid: ${events.join(', ')}`,
    );

    const pids = env.log.pids();

    assert.equal(pids.length, 4);
    assert.ok(
      pids.every((pid) => !isAlive(pid)),
      'a process is alive after the shutdown',
    );
  });

  test("a dependent's deactivation can still call its provider", async (t) => {
    const env = await setupPlatform(t, {
      settings: { mode: 'serve-settings', provides: ['settings/v1@1.0.0'] },
      app: { mode: 'call-in-deactivate', requires: ['settings/v1@^1.0.0'] },
    });

    await within(env.platform.shutdown(), 'the shutdown');

    const events = env.log.events();

    assert.ok(
      events.includes('app deactivate-call-ok'),
      `the call in the deactivation failed: ${events.join(', ')}`,
    );
    assert.ok(
      events.indexOf('app deactivate-call-ok') <
        events.indexOf('settings deactivate'),
      `the provider was stopped first: ${events.join(', ')}`,
    );
  });

  test('a bundle that ignores Stop is killed with SIGKILL at the shutdown deadline, and shutdown resolves', async (t) => {
    const deadline = 800;
    const env = await setupPlatform(
      t,
      { stuck: { mode: 'ignore-stop' } },
      // The stop timeout is past the deadline: only the deadline ends it.
      { timings: { stopTimeoutMs: 10_000, shutdownDeadlineMs: deadline } },
    );
    const [pid] = env.log.pidsOf('stuck');

    const started = performance.now();

    await within(env.platform.shutdown(), 'the shutdown', 5_000);

    const elapsed = performance.now() - started;

    assert.ok(
      elapsed >= deadline - 20,
      `shutdown resolved after ${elapsed.toFixed(0)} ms, before the deadline`,
    );
    assert.ok(
      elapsed < deadline + 1_500,
      `shutdown resolved after ${elapsed.toFixed(0)} ms`,
    );
    assert.ok(env.log.eventsOf('stuck').includes('deactivate'));
    assert.ok(!env.log.eventsOf('stuck').includes('deactivated'));
    await until(() => !isAlive(pid as number), 'the process to be killed', 500);
    assert.deepEqual(env.exits, []);
  });
});
