// Publish and drain with processes (spec `docs/designs/grpc-processes.md`,
// section 6, "Generations and drain"; T2.6, T2.18, AC2.6): a publish that
// changes a bundle's executable starts its generation 2, which takes the
// new calls, while generation 1 drains: it gets `GenerationChanged
// { event: "draining" }`, finishes its calls, keeps running while it holds
// a work hold, is cut at the drain deadline, and then stops. Bundles that
// did not change keep their processes; a changed `core` answers
// `kernel_restart_required`; a generation 2 that does not become active
// leaves generation 1 active with `generation_failed`; a `PeerSignal` goes
// to the bundle's other live instances only. The fixture
// `tests/fixtures/scripted` logs what each process sees
// (`tests/support/scripted-host.ts`); every process is ended in `after`.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  codesOf,
  type FixtureLog,
  isAlive,
  resolveHost,
  setupPlatform,
  sleep,
  until,
  within,
} from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers

/** The events of the process of `bundleId` that ran as `<generation>.<incarnation>`. */
const eventsOfInstance = (
  log: FixtureLog,
  bundleId: string,
  instance: string,
): string[] => {
  const fields = log
    .lines()
    .map((line) => line.split(' '))
    .filter(([id]) => id === bundleId);
  const pid = fields.find(([, event]) => event === `as-${instance}`)?.[2];

  return pid === undefined
    ? []
    : fields
        .filter(([, , seen]) => seen === pid)
        .map(([, event]) => event ?? '');
};

/** The pid of the process of `bundleId` that ran as `<generation>.<incarnation>`. */
const pidOf = (
  log: FixtureLog,
  bundleId: string,
  instance: string,
): number | undefined => {
  const line = log
    .lines()
    .map((entry) => entry.split(' '))
    .find(([id, event]) => id === bundleId && event === `as-${instance}`);

  return line === undefined ? undefined : Number(line[2]);
};

const settingsProvider = {
  mode: 'generations',
  provides: ['settings/v1@1.0.0'],
} as const;

const generationFailures = (
  env: Awaited<ReturnType<typeof setupPlatform>>,
  bundleId: string,
): number =>
  env.diagnostics
    .snapshot()
    .errors.filter(
      (error) =>
        error.bundleId === bundleId && error.kind === 'generation_failed',
    ).length;

// ---------------------------------------------------------------------------
// Publish

describe('a publish that changes a bundle', () => {
  test('starts generation 2, which takes new calls, while generation 1 finishes its call and stops', async (t) => {
    const env = await setupPlatform(t, {
      settings: { ...settingsProvider, ms: 1_500 },
      app: {
        mode: 'call-repeat',
        ms: 100,
        count: 2,
        requires: ['settings/v1@^1.0.0'],
      },
    });

    await until(
      () => env.log.eventsOf('settings').includes('call'),
      'the first call to reach generation 1',
    );

    env.scripts.settings = { mode: 'generations' };
    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
          app: { mode: 'call-repeat', requires: ['settings/v1@^1.0.0'] },
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });
    assert.ok(
      eventsOfInstance(env.log, 'settings', '2.1').includes('activated'),
      'generation 2 is active when the publish answers',
    );
    assert.ok(
      eventsOfInstance(env.log, 'settings', '1.1').includes(
        'changed:draining:1.1',
      ),
      'generation 1 acknowledged draining before the publish answered',
    );

    await until(
      () =>
        env.log.eventsOf('app').filter((event) => event.startsWith('call-'))
          .length === 2,
      'both calls to end',
      4_000,
    );

    assert.deepEqual(
      env.log.eventsOf('app').filter((event) => event.startsWith('call-')),
      ['call-ok:g1', 'call-ok:g2'],
    );

    await until(
      () =>
        eventsOfInstance(env.log, 'settings', '1.1').includes('deactivated'),
      'generation 1 to stop',
    );

    const first = eventsOfInstance(env.log, 'settings', '1.1');

    assert.ok(
      first.indexOf('answered') < first.indexOf('deactivate'),
      `generation 1 stopped before its call ended: ${first.join(', ')}`,
    );
    await until(
      () => !isAlive(pidOf(env.log, 'settings', '1.1') ?? 0),
      'generation 1 to exit',
    );
    await until(
      () =>
        eventsOfInstance(env.log, 'settings', '2.1').includes(
          'changed:stopped:1.1',
        ),
      'generation 2 to hear that generation 1 stopped',
    );
    assert.deepEqual(
      eventsOfInstance(env.log, 'settings', '1.1').filter((event) =>
        event.startsWith('changed:'),
      ),
      ['changed:draining:1.1', 'changed:activated:2.1'],
    );
  });

  test('keeps the processes of the bundles that did not change', async (t) => {
    const env = await setupPlatform(t, {
      settings: settingsProvider,
      other: { mode: 'generations' },
    });
    const before = env.log.pids();

    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
          other: { mode: 'generations' },
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });
    assert.deepEqual(env.log.pidsOf('core').length, 1);
    assert.deepEqual(env.log.pidsOf('other').length, 1);
    assert.ok(
      env.log
        .pidsOf('core')
        .every((pid) => before.includes(pid) && isAlive(pid)),
    );
    assert.ok(
      env.log
        .pidsOf('other')
        .every((pid) => before.includes(pid) && isAlive(pid)),
    );
    assert.deepEqual(
      eventsOfInstance(env.log, 'other', '1.1').filter((event) =>
        event.startsWith('changed:'),
      ),
      [],
    );
  });

  test('answers kernel_restart_required and changes nothing when the core changed', async (t) => {
    const env = await setupPlatform(t, { settings: settingsProvider });
    const before = env.log.lines().length;

    env.digests.set('core', 'v2');
    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
        }),
      ),
      'the publish',
    );

    assert.deepEqual(result, {
      status: 'kernel_restart_required',
      reason: 'The core changed; restart the host.',
    });

    await sleep(300);

    assert.equal(
      env.log.lines().length,
      before,
      'no process started or changed',
    );
  });

  test('keeps generation 1 active, with generation_failed, when generation 2 does not become active', async (t) => {
    const env = await setupPlatform(t, { settings: settingsProvider });

    env.scripts.settings = { mode: 'activate-fails' };
    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
        }),
      ),
      'the publish',
      4_000,
    );

    assert.equal(result.status, 'failed');
    assert.ok(result.status === 'failed');
    assert.deepEqual(result.bundles, ['settings']);
    assert.ok(generationFailures(env, 'settings') > 0, 'generation_failed');
    assert.deepEqual(codesOf(env.diagnostics, 'settings'), []);

    const first = eventsOfInstance(env.log, 'settings', '1.1');

    assert.ok(!first.includes('changed:draining:1.1'), first.join(', '));
    assert.ok(!first.includes('deactivate'), first.join(', '));
    assert.ok(isAlive(pidOf(env.log, 'settings', '1.1') ?? 0));
  });
});

// ---------------------------------------------------------------------------
// Drain

describe('the drain of generation 1', () => {
  test('lasts while it holds a work hold, and Stop comes after Release', async (t) => {
    const env = await setupPlatform(t, {
      settings: {
        mode: 'hold-on-drain',
        ms: 800,
        provides: ['settings/v1@1.0.0'],
      },
    });

    env.scripts.settings = { mode: 'generations' };
    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });
    assert.ok(
      eventsOfInstance(env.log, 'settings', '1.1').includes('held'),
      'the hold was taken before the publish answered',
    );

    await sleep(300);

    assert.ok(
      !eventsOfInstance(env.log, 'settings', '1.1').includes('deactivate'),
      'generation 1 stopped while it held a hold',
    );

    await until(
      () =>
        eventsOfInstance(env.log, 'settings', '1.1').includes('deactivated'),
      'generation 1 to stop',
      3_000,
    );

    const first = eventsOfInstance(env.log, 'settings', '1.1');

    assert.ok(
      first.indexOf('released') < first.indexOf('deactivate'),
      first.join(', '),
    );
  });

  test('is cut at the drain deadline: the call in flight ends with generation_lost and generation 1 stops', async (t) => {
    const drainDeadlineMs = 600;
    const env = await setupPlatform(
      t,
      {
        settings: { ...settingsProvider, ms: 60_000 },
        app: {
          mode: 'call-repeat',
          ms: 100,
          count: 1,
          requires: ['settings/v1@^1.0.0'],
        },
      },
      { timings: { drainDeadlineMs } },
    );

    await until(
      () => env.log.eventsOf('settings').includes('call'),
      'the call to reach generation 1',
    );

    env.scripts.settings = { mode: 'generations' };
    env.digests.set('settings', 'v2');

    const started = performance.now();
    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
          app: { mode: 'call-repeat', requires: ['settings/v1@^1.0.0'] },
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });

    await until(
      () => env.log.eventsOf('app').some((event) => event.startsWith('call-')),
      'the call to end',
      3_000,
    );

    assert.ok(
      performance.now() - started >= drainDeadlineMs,
      'the call was cut before the deadline',
    );
    assert.deepEqual(
      env.log.eventsOf('app').filter((event) => event.startsWith('call-')),
      ['call-failed:generation_lost'],
    );

    await until(
      () =>
        eventsOfInstance(env.log, 'settings', '1.1').includes('deactivated'),
      'generation 1 to stop',
    );
    assert.ok(
      eventsOfInstance(env.log, 'settings', '1.1').includes('cancelled'),
    );
  });
});

// ---------------------------------------------------------------------------
// Peer signals and core

describe('generation frames between live instances', () => {
  test('a PeerSignal reaches the other live instance of the bundle only', async (t) => {
    const env = await setupPlatform(t, {
      settings: {
        mode: 'hold-on-drain',
        ms: 1_000,
        provides: ['settings/v1@1.0.0'],
      },
      other: { mode: 'generations' },
    });

    env.scripts.settings = { mode: 'generations' };
    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
          other: { mode: 'generations' },
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });

    await until(
      () =>
        eventsOfInstance(env.log, 'settings', '1.1').includes(
          'signal:hello:2.1',
        ),
      'generation 1 to receive the signal',
    );
    await sleep(100);

    const signals = env.log
      .events()
      .filter((event) => event.includes(' signal:'));

    assert.deepEqual(signals, ['settings signal:hello:2.1']);
    assert.equal(
      eventsOfInstance(env.log, 'settings', '1.1').filter((event) =>
        event.startsWith('signal:'),
      ).length,
      1,
    );
  });

  test('a crashed core restarts as incarnation 2 of generation 1, and a later publish does not replace it', async (t) => {
    const env = await setupPlatform(
      t,
      { settings: settingsProvider },
      { scripts: { core: { mode: 'crash-after-active', ms: 100, count: 1 } } },
    );

    await until(
      () => env.log.eventsOf('core').includes('as-1.2'),
      'the core to restart',
    );
    await until(
      () => eventsOfInstance(env.log, 'core', '1.2').includes('activated'),
      'the core to be active again',
    );

    env.digests.set('settings', 'v2');

    const result = await within(
      env.platform.publish(
        resolveHost({
          settings: settingsProvider,
        }),
      ),
      'the publish',
      4_000,
    );

    assert.deepEqual(result, { status: 'published', bundles: ['settings'] });
    assert.deepEqual(
      env.log.eventsOf('core').filter((event) => event.startsWith('as-')),
      ['as-1.1', 'as-1.2'],
    );
  });
});
