// Crashes (spec `docs/designs/grpc-processes.md`, section 7, "Crashes",
// "Structural providers"; T2.7; A67): a lost instance's pending calls end
// with `generation_lost`; the supervisor spawns the next incarnation of the
// same generation after the restart delays; a fourth loss within the restart
// window quarantines with `process_failed`, and the bundles that require it
// are quarantined with `dependency_quarantined` and stopped without drain; a
// required bundle's quarantine after the boot ends the host with code 1. The
// fixture `tests/fixtures/scripted` runs each bundle against a real router
// listener (`tests/support/scripted-host.ts`); at most three fixture processes
// are alive at once, and every test stops what it started in `after`.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { InstanceState } from '../../src/platform/router/instances.js';
import {
  codesOf,
  type FixtureLog,
  isAlive,
  lossesOf,
  setupPlatform,
  setupSupervisor,
  sleep,
  until,
  within,
} from '../support/scripted-host.js';

/** When the test first saw each log line, by `performance.now()`. */
interface Seen {
  readonly event: string;
  readonly at: number;
}

/** Polls the log every 2 ms and stamps each new line until `stop`. */
const watch = (log: FixtureLog): { stop(): Seen[] } => {
  const seen: Seen[] = [];
  const poll = setInterval(() => {
    const events = log.events();

    for (const event of events.slice(seen.length)) {
      seen.push({ event, at: performance.now() });
    }
  }, 2);

  return {
    stop: () => {
      clearInterval(poll);

      return seen;
    },
  };
};

// ---------------------------------------------------------------------------
// Pending calls

describe('a lost instance', () => {
  test('its pending calls end with generation_lost', async (t) => {
    const env = await setupSupervisor(t, {
      settings: { mode: 'crash-in-call', provides: ['settings/v1@1.0.0'] },
      app: { mode: 'call-provider', ms: 100, requires: ['settings/v1@^1.0.0'] },
    });

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => env.log.eventsOf('app').some((event) => event.startsWith('call-')),
      'the call to end',
      5_000,
    );

    const events = env.log.events();

    assert.ok(
      events.indexOf('settings call') < events.indexOf('settings crash'),
      `the provider crashed before the call: ${events.join(', ')}`,
    );
    assert.deepEqual(
      env.log.eventsOf('app').filter((event) => event.startsWith('call-')),
      ['call-failed:generation_lost'],
    );
    await until(
      () => lossesOf(env.diagnostics, 'settings').length > 0,
      'the loss to be recorded',
    );
    assert.deepEqual(lossesOf(env.diagnostics, 'settings')[0], {
      generation: 1,
      incarnation: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Restarts

describe('restarts', () => {
  test('follow restartDelaysMs, each as the next incarnation of the same generation', async (t) => {
    const delays = [300, 600, 1_200];
    const env = await setupSupervisor(
      t,
      { base: { mode: 'crash-after-active', ms: 100, count: 3 } },
      { restartDelaysMs: delays },
    );
    const watcher = watch(env.log);

    t.after(() => void watcher.stop());

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => env.log.countOf('base', 'activated') === 4,
      'the fourth incarnation to be active',
      10_000,
    );

    const seen = watcher.stop();
    const crashes = seen.filter(({ event }) => event === 'base crash');
    const starts = seen.filter(({ event }) => event === 'base start');

    assert.equal(crashes.length, 3);
    assert.equal(starts.length, 4);

    for (const [n, delay] of delays.entries()) {
      const crash = crashes[n] as Seen;
      const start = starts[n + 1] as Seen;
      const gap = start.at - crash.at;

      assert.ok(
        gap >= delay,
        `restart ${n + 1} came ${gap.toFixed(0)} ms after the loss, before its delay of ${delay} ms`,
      );
      assert.ok(
        gap < delay + 2_000,
        `restart ${n + 1} came ${gap.toFixed(0)} ms after the loss`,
      );
    }

    assert.deepEqual(
      env.log.eventsOf('base').filter((event) => event.startsWith('as-')),
      ['as-1.1', 'as-1.2', 'as-1.3', 'as-1.4'],
    );
    assert.deepEqual(lossesOf(env.diagnostics, 'base'), [
      { generation: 1, incarnation: 1 },
      { generation: 1, incarnation: 2 },
      { generation: 1, incarnation: 3 },
    ]);
    await until(
      () => env.supervisor.state('base') === 'active',
      'the fourth incarnation to be the current one',
    );
  });

  test('three losses within the window do not quarantine', async (t) => {
    const env = await setupSupervisor(t, {
      base: { mode: 'crash-after-active', ms: 50, count: 3 },
    });

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => env.log.countOf('base', 'activated') === 4,
      'the fourth incarnation to be active',
      10_000,
    );
    await sleep(500);

    assert.deepEqual(codesOf(env.diagnostics, 'base'), []);
    assert.deepEqual(env.quarantines, []);
    assert.equal(env.diagnostics.state('base'), 'active');
    assert.equal(env.supervisor.state('base'), 'active');
    assert.equal(env.log.countOf('base', 'start'), 4);
    assert.equal(lossesOf(env.diagnostics, 'base').length, 3);
  });

  test('a fourth loss within the window quarantines with process_failed and is not restarted', async (t) => {
    const env = await setupSupervisor(t, {
      base: { mode: 'crash-after-active', ms: 50 },
    });

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => codesOf(env.diagnostics, 'base').includes('process_failed'),
      'the process_failed quarantine',
      10_000,
    );
    // Past every restart delay: no fifth process.
    await sleep(600);

    assert.deepEqual(codesOf(env.diagnostics, 'base'), ['process_failed']);
    assert.deepEqual(env.quarantines, ['base process_failed']);
    assert.equal(env.diagnostics.state('base'), 'quarantined');
    assert.equal(env.log.countOf('base', 'start'), 4);
    assert.equal(lossesOf(env.diagnostics, 'base').length, 4);
    assert.ok(
      env.log.pidsOf('base').every((pid) => !isAlive(pid)),
      'a process of base is alive',
    );
    assert.equal(env.diagnostics.state('core'), 'active');
  });

  test('losses further apart than the window start counting from zero', async (t) => {
    // Each incarnation stays up 500 ms, longer than the 300 ms window: four
    // losses, none within the window of another.
    const env = await setupSupervisor(
      t,
      { base: { mode: 'crash-after-active', ms: 500, count: 4 } },
      { restartWindowMs: 300 },
    );

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => env.log.countOf('base', 'activated') === 5,
      'the fifth incarnation to be active',
      15_000,
    );
    await sleep(300);

    assert.deepEqual(codesOf(env.diagnostics, 'base'), []);
    assert.deepEqual(env.quarantines, []);
    assert.equal(env.diagnostics.state('base'), 'active');
    assert.equal(env.supervisor.state('base'), 'active');
    assert.equal(lossesOf(env.diagnostics, 'base').length, 4);
  });

  test('a bundle lost during its activation is restarted, not quarantined with activate_failed', async (t) => {
    const env = await setupSupervisor(t, {
      base: { mode: 'crash-in-activate', ms: 50, count: 1 },
    });

    await within(env.supervisor.boot(), 'the boot');

    assert.deepEqual(codesOf(env.diagnostics, 'base'), []);
    assert.deepEqual(env.quarantines, []);
    assert.equal(env.diagnostics.state('base'), 'active');
    assert.equal(env.supervisor.state('base'), 'active');
    assert.deepEqual(
      env.log.eventsOf('base').filter((event) => event.startsWith('as-')),
      ['as-1.1', 'as-1.2'],
    );
    assert.deepEqual(lossesOf(env.diagnostics, 'base'), [
      { generation: 1, incarnation: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dependents and required bundles

describe('a process_failed quarantine', () => {
  test('quarantines its dependents with dependency_quarantined and stops them without drain', async (t) => {
    const env = await setupSupervisor(t, {
      base: {
        mode: 'crash-after-active',
        ms: 100,
        provides: ['base.api/v1@1.0.0'],
      },
      dep: { mode: 'alive', requires: ['base.api/v1@^1.0.0'] },
    });

    await within(env.supervisor.boot(), 'the boot');
    assert.equal(env.diagnostics.state('dep'), 'active');

    const states = new Set<InstanceState | undefined>();
    const poll = setInterval(() => states.add(env.supervisor.state('dep')), 2);

    t.after(() => clearInterval(poll));

    await until(
      () => codesOf(env.diagnostics, 'dep').includes('dependency_quarantined'),
      'the dependency_quarantined quarantine',
      10_000,
    );
    await until(
      () => env.supervisor.state('dep') === 'stopped',
      'the dependent to be stopped',
    );
    clearInterval(poll);

    assert.deepEqual(codesOf(env.diagnostics, 'base'), ['process_failed']);
    assert.deepEqual(codesOf(env.diagnostics, 'dep'), [
      'dependency_quarantined',
    ]);
    assert.deepEqual(env.quarantines, [
      'base process_failed',
      'dep dependency_quarantined',
    ]);
    assert.equal(env.diagnostics.state('dep'), 'quarantined');
    assert.ok(!states.has('draining'), 'the dependent was drained');
    // Stopped through Stop: its deactivation ran, and its process exited.
    assert.ok(env.log.eventsOf('dep').includes('deactivate'));
    assert.equal(env.log.countOf('dep', 'start'), 1);

    const [pid] = env.log.pidsOf('dep');

    await until(() => !isAlive(pid as number), 'the dependent to exit');
    assert.equal(env.diagnostics.state('core'), 'active');
  });

  test('of a bundle under required.bundles after the boot calls exit(1) once', async (t) => {
    const env = await setupPlatform(
      t,
      { base: { mode: 'crash-after-active', ms: 50 } },
      { requiredBundles: ['base'] },
    );

    assert.deepEqual(env.exits, []);
    await until(() => env.exits.length > 0, 'the host to exit', 10_000);
    assert.deepEqual(codesOf(env.diagnostics, 'base'), ['process_failed']);
    await sleep(300);
    assert.deepEqual(env.exits, [1]);
  });
});
