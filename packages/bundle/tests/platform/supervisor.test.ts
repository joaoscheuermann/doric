// The supervisor (spec `docs/designs/grpc-processes.md`, section 7: "Spawn",
// "Invalid bundles", "Activation failure", "Structural providers"; section 15;
// T2.1, T2.2, the run-time order of T2.15; A64, A67): it spawns each scheduled
// bundle with `commandOf`'s command and the spawn environment, activates it
// once its providers are active, and quarantines what fails. The tests run
// the fixture `tests/fixtures/scripted` (its arguments pick its behavior)
// against a real router listener, with at most four fixture processes alive
// at once; every test stops what it started in `after`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import type { QuarantineReason } from '../../src/contracts/platform.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import { startPlatform } from '../../src/platform/index.js';
import type {
  InvalidReason,
  StreamEnd,
} from '../../src/platform/router/control.js';
import {
  type InstanceKey,
  InstanceTable,
} from '../../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../../src/platform/router/listener.js';
import { createRouterRelay } from '../../src/platform/supervisor/router-relay.js';
import {
  instanceEnvironment,
  type SpawnCommand,
} from '../../src/platform/supervisor/spawn.js';
import {
  type Supervisor,
  startSupervisor,
} from '../../src/platform/supervisor/supervisor.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import {
  type CatalogCandidate,
  DiagnosticsStore,
  type ManifestV2Input,
  manifestV1Schema,
  manifestV2Schema,
  type ResolvedEnvironment,
  resolveEnvironment,
} from '../../src/runtime/index.js';
import { descriptorFor, manifest } from '../support/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers

/** Timings short enough for tests; each test overrides what it exercises. */
const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 3_000,
  spawnConcurrency: 4,
  activationTimeoutMs: 3_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  restartDelaysMs: [50, 50, 50],
  stopTimeoutMs: 1_000,
  shutdownDeadlineMs: 3_000,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` until it holds; fails the test after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(5);
  }
};

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 8_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Whether a process is alive. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const scripted = fileURLToPath(
  new URL('../fixtures/scripted/main.js', import.meta.url),
);

/** What a fixture bundle does: the fixture's mode and its `ms` argument. */
interface Script {
  readonly mode:
    | 'alive'
    | 'slow-activate'
    | 'activate-fails'
    | 'freeze-after-active'
    | 'exit-before-hello'
    | 'never-hello'
    | 'delay-hello'
    | 'wrong-instance';
  readonly ms?: number;
}

/** A fixture bundle: its script and its version 2 manifest's lists. */
interface FixtureBundle extends Script {
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  readonly optional?: readonly string[];
}

const basics = ['hooks/v1@1.0.0', 'tools/v1@1.0.0', 'skills/v1@1.0.0'];

const coreCandidate = (): CatalogCandidate => {
  const source = manifest('core', { provides: basics });

  return {
    id: 'core',
    source: { kind: 'installed', dir: '/bundles/core' },
    manifest: manifestV1Schema.parse(source),
    descriptor: descriptorFor(source),
    errors: [],
  };
};

const candidateV2 = (id: string, bundle: FixtureBundle): CatalogCandidate => {
  const provides = [...(bundle.provides ?? [])];
  const source: ManifestV2Input = {
    manifestVersion: 2,
    id,
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
    provides,
    host: {
      requires: [...(bundle.requires ?? [])],
      optional: [...(bundle.optional ?? [])],
    },
  };

  return {
    id,
    source: { kind: 'installed', dir: `/bundles/${id}` },
    manifest: manifestV2Schema.parse(source),
    descriptor: descriptorFor(manifest(id, { provides })),
    errors: [],
  };
};

/** The host resolution of `core` (an `alive` fixture) and `bundles`. */
const resolveHost = (
  bundles: Readonly<Record<string, FixtureBundle>>,
): ResolvedEnvironment => {
  const candidates = [
    coreCandidate(),
    ...Object.entries(bundles).map(([id, bundle]) => candidateV2(id, bundle)),
  ];

  return resolveEnvironment(
    {
      candidates,
      composition: {
        core: 'core',
        enabled: candidates.map(({ id }) => id),
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );
};

/** The fixtures' shared log: lines `<bundleId> <event> <pid>`. */
interface FixtureLog {
  readonly path: string;
  lines(): string[];
  /** The `<bundleId> <event>` of every line, in order. */
  events(): string[];
  /** The pid of every process that started. */
  pids(): number[];
  /** The pid of the bundle's first process; fails when it never started. */
  pidOf(bundleId: string): number;
}

const fixtureLog = (t: TestContext): FixtureLog => {
  const dir = mkdtempSync(join(tmpdir(), 'doric-supervisor-'));
  const path = join(dir, 'events.log');
  const lines = (): string[] => {
    try {
      return readFileSync(path, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const log: FixtureLog = {
    path,
    lines,
    events: () => lines().map((line) => line.split(' ').slice(0, 2).join(' ')),
    pids: () =>
      lines()
        .filter((line) => line.split(' ')[1] === 'start')
        .map((line) => Number(line.split(' ')[2])),
    pidOf: (bundleId) => {
      const line = lines().find((entry) =>
        entry.startsWith(`${bundleId} start `),
      );

      assert.ok(line, `${bundleId} started`);

      return Number(line.split(' ')[2]);
    },
  };

  t.after(() => {
    // A safety net only: the supervisor should have ended every process.
    for (const pid of log.pids()) {
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }

    rmSync(dir, { recursive: true, force: true });
  });

  return log;
};

/** `commandOf` for `core` (alive) and `bundles`: `node main.js <mode> <log> <ms>`. */
const commandsOf =
  (bundles: Readonly<Record<string, Script>>, log: FixtureLog) =>
  (bundleId: string): SpawnCommand => {
    const script = bundles[bundleId] ?? { mode: 'alive' };

    return {
      command: process.execPath,
      args: [scripted, script.mode, log.path, String(script.ms ?? 0)],
    };
  };

interface SupervisorEnv {
  readonly supervisor: Supervisor;
  readonly router: Router;
  readonly diagnostics: DiagnosticsStore;
  readonly log: FixtureLog;
  readonly quarantines: string[];
}

/**
 * Starts a router and a supervisor of `core` and `bundles`; shuts both down
 * and ends every fixture process in `after`.
 */
const setupSupervisor = async (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: {
    readonly timings?: Partial<Timings>;
    readonly commandOf?: (bundleId: string) => SpawnCommand;
  } = {},
): Promise<SupervisorEnv> => {
  const log = fixtureLog(t);
  const resolved = resolveHost(bundles);
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const effective = { ...testTimings, ...options.timings };
  const instances = new InstanceTable();
  const relay = createRouterRelay();
  const router = await startRouter({
    index: createCatalogIndex([file_doric_tools_v1_tools]),
    instances,
    timings: effective,
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: (key, reason, message) => relay.onInvalid(key, reason, message),
    onLost: (key, end) => relay.onLost(key, end),
  });

  t.after(() => router.close());

  const quarantines: string[] = [];
  const supervisor = startSupervisor({
    router,
    relay,
    instances,
    resolved,
    commandOf: options.commandOf ?? commandsOf(bundles, log),
    env: { PATH: process.env.PATH },
    timings: effective,
    diagnostics,
    onQuarantine: (bundleId, reason) =>
      quarantines.push(`${bundleId} ${reason.code}`),
  });

  t.after(() => within(supervisor.shutdown(), 'the supervisor to shut down'));

  return { supervisor, router, diagnostics, log, quarantines };
};

const reasonsOf = (
  diagnostics: DiagnosticsStore,
  bundleId: string,
): readonly QuarantineReason[] => diagnostics.reasons(bundleId);

const codesOf = (diagnostics: DiagnosticsStore, bundleId: string): string[] =>
  reasonsOf(diagnostics, bundleId).map(({ code }) => code);

// ---------------------------------------------------------------------------
// instanceEnvironment

describe('instanceEnvironment', () => {
  const instance = {
    bundleId: 'acme.echo',
    version: '1.2.3',
    generation: 3,
    incarnation: 2,
  };

  test('adds the five DORIC_* variables and DORIC_BUNDLE_CACHE, replacing stale ones', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      DORIC_STATE_DIR: '/srv/doric',
      DORIC_ROUTER_URL: 'http://stale',
      DORIC_INSTANCE_TOKEN: 'stale',
    };
    const before = { ...base };

    const env = instanceEnvironment({
      base,
      routerPort: 4567,
      token: 'the-token',
      instance,
    });

    assert.deepEqual(env, {
      PATH: '/usr/bin',
      DORIC_STATE_DIR: '/srv/doric',
      DORIC_ROUTER_URL: 'http://127.0.0.1:4567',
      DORIC_INSTANCE_TOKEN: 'the-token',
      DORIC_BUNDLE_ID: 'acme.echo',
      DORIC_GENERATION: '3',
      DORIC_INCARNATION: '2',
      DORIC_BUNDLE_CACHE: '/srv/doric/bundles/acme.echo/1.2.3',
    });
    assert.deepEqual(base, before);
    assert.notEqual(env, base);
  });

  test('puts the bundle cache under /var/lib/doric without DORIC_STATE_DIR', () => {
    const env = instanceEnvironment({
      base: { PATH: '/usr/bin' },
      routerPort: 1,
      token: 't',
      instance,
    });

    assert.equal(
      env.DORIC_BUNDLE_CACHE,
      '/var/lib/doric/bundles/acme.echo/1.2.3',
    );
  });
});

// ---------------------------------------------------------------------------
// createRouterRelay

describe('createRouterRelay', () => {
  const end: StreamEnd = { cause: 'closed', message: 'gone' };

  test('keeps the events before connect and delivers them in order, then the later ones at once', () => {
    const relay = createRouterRelay();
    const seen: string[] = [];
    const record = {
      onInvalid: (key: InstanceKey, reason: InvalidReason, message: string) =>
        seen.push(`invalid ${key} ${reason} ${message}`),
      onLost: (key: InstanceKey, lost: StreamEnd) =>
        seen.push(`lost ${key} ${lost.cause}`),
    };

    relay.onInvalid('a/1/1', 'invalid_bundle', 'first');
    relay.onLost('b/1/1', end);
    relay.onInvalid('c/1/1', 'health_timeout', 'third');
    assert.deepEqual(seen, []);

    relay.connect(record);
    assert.deepEqual(seen, [
      'invalid a/1/1 invalid_bundle first',
      'lost b/1/1 closed',
      'invalid c/1/1 health_timeout third',
    ]);

    relay.onLost('d/1/1', end);
    assert.equal(seen.at(-1), 'lost d/1/1 closed');
    assert.equal(seen.length, 4);
  });

  test('throws a TypeError when connected a second time', () => {
    const relay = createRouterRelay();
    const target = { onInvalid: () => {}, onLost: () => {} };

    relay.connect(target);
    assert.throws(() => relay.connect(target), TypeError);
  });
});

// ---------------------------------------------------------------------------
// startSupervisor: boot

describe('Supervisor boot', () => {
  test('a valid bundle becomes active, with its activation time', async (t) => {
    const env = await setupSupervisor(t, { echo: { mode: 'alive' } });

    await within(env.supervisor.boot(), 'the boot');

    assert.equal(env.diagnostics.state('core'), 'active');
    assert.equal(env.diagnostics.state('echo'), 'active');
    assert.equal(env.supervisor.state('echo'), 'active');

    const echo = env.diagnostics
      .snapshot()
      .bundles.find(({ id }) => id === 'echo');

    assert.equal(typeof echo?.activationMs, 'number');
    assert.deepEqual(env.quarantines, []);
    await assert.rejects(env.supervisor.boot(), TypeError);
  });

  test('an exit before the Hello quarantines with invalid_bundle', async (t) => {
    const env = await setupSupervisor(t, {
      broken: { mode: 'exit-before-hello' },
    });

    await within(env.supervisor.boot(), 'the boot');

    assert.deepEqual(codesOf(env.diagnostics, 'broken'), ['invalid_bundle']);
    assert.equal(env.diagnostics.state('broken'), 'quarantined');
    assert.equal(env.supervisor.state('broken'), 'invalid');
    assert.deepEqual(env.quarantines, ['broken invalid_bundle']);
    assert.equal(env.diagnostics.state('core'), 'active');
  });

  test('no Hello within the Hello timeout quarantines with invalid_bundle and SIGKILLs the process', async (t) => {
    const env = await setupSupervisor(
      t,
      { mute: { mode: 'never-hello' } },
      { timings: { helloTimeoutMs: 1_500 } },
    );

    await within(env.supervisor.boot(), 'the boot');

    assert.deepEqual(codesOf(env.diagnostics, 'mute'), ['invalid_bundle']);
    assert.equal(env.supervisor.state('mute'), 'invalid');
    assert.deepEqual(env.quarantines, ['mute invalid_bundle']);

    // The fixture ignores SIGTERM: only SIGKILL ends it.
    const pid = env.log.pidOf('mute');

    await until(() => !isAlive(pid), 'the process to be killed');
  });

  test('a mismatched instance, Rejected by the router, quarantines with invalid_bundle and the router message', async (t) => {
    const env = await setupSupervisor(t, {
      impostor: { mode: 'wrong-instance' },
    });

    await within(env.supervisor.boot(), 'the boot');

    const reasons = reasonsOf(env.diagnostics, 'impostor');

    assert.deepEqual(
      reasons.map(({ code }) => code),
      ['invalid_bundle'],
    );
    assert.match(reasons[0]?.message ?? '', /hello_mismatch/);
    assert.equal(env.supervisor.state('impostor'), 'invalid');

    const pid = env.log.pidOf('impostor');

    await until(() => !isAlive(pid), 'the process to end');
  });

  test('a commandOf that throws quarantines with invalid_bundle and its message', async (t) => {
    const log = fixtureLog(t);
    const commands = commandsOf({}, log);
    const env = await setupSupervisor(
      t,
      { broken: { mode: 'alive' } },
      {
        commandOf: (bundleId) => {
          if (bundleId === 'broken') {
            throw new Error('no command for broken');
          }

          return commands(bundleId);
        },
      },
    );

    await within(env.supervisor.boot(), 'the boot');

    const reasons = reasonsOf(env.diagnostics, 'broken');

    assert.deepEqual(
      reasons.map(({ code }) => code),
      ['invalid_bundle'],
    );
    assert.match(reasons[0]?.message ?? '', /no command for broken/);
    assert.deepEqual(env.quarantines, ['broken invalid_bundle']);
    assert.equal(env.diagnostics.state('core'), 'active');
  });

  test('an activation that fails quarantines with activate_failed and the status message, and stops the instance', async (t) => {
    const env = await setupSupervisor(t, {
      failing: { mode: 'activate-fails' },
    });

    await within(env.supervisor.boot(), 'the boot');

    const reasons = reasonsOf(env.diagnostics, 'failing');

    assert.deepEqual(
      reasons.map(({ code }) => code),
      ['activate_failed'],
    );
    assert.match(reasons[0]?.message ?? '', /fixture activation failed/);
    assert.deepEqual(env.quarantines, ['failing activate_failed']);
    await until(
      () => env.supervisor.state('failing') === 'stopped',
      'the instance to be stopped',
    );
  });
});

// ---------------------------------------------------------------------------
// Health

describe('Supervisor health', () => {
  test('a fixture that freezes after active is quarantined with health_timeout, SIGKILLed, and not restarted', async (t) => {
    const env = await setupSupervisor(
      t,
      { frozen: { mode: 'freeze-after-active' } },
      {
        timings: {
          healthIntervalMs: 100,
          healthTimeoutMs: 300,
          stallThresholdMs: 2_000,
        },
      },
    );

    await within(env.supervisor.boot(), 'the boot');
    await until(
      () => codesOf(env.diagnostics, 'frozen').includes('health_timeout'),
      'the health_timeout quarantine',
    );

    assert.deepEqual(codesOf(env.diagnostics, 'frozen'), ['health_timeout']);
    assert.deepEqual(env.quarantines, ['frozen health_timeout']);

    const pid = env.log.pidOf('frozen');

    // Blocked and ignoring SIGTERM: only SIGKILL ends it.
    await until(() => !isAlive(pid), 'the process to be killed');
    // Past every restart delay: no new incarnation.
    await sleep(500);
    assert.equal(env.supervisor.state('frozen'), 'invalid');
    assert.equal(
      env.log.events().filter((event) => event === 'frozen start').length,
      1,
    );
    assert.equal(env.diagnostics.state('core'), 'active');
  });
});

// ---------------------------------------------------------------------------
// Activation order (T2.15, run time)

describe('Supervisor activation order', () => {
  test('Activate goes to a bundle only after the provider its host.requires names is active', async (t) => {
    const env = await setupSupervisor(t, {
      zeta: { mode: 'slow-activate', ms: 600, provides: ['zeta.api/v1@1.0.0'] },
      alpha: { mode: 'alive', requires: ['zeta.api/v1@^1.0.0'] },
    });

    await within(env.supervisor.boot(), 'the boot');

    const events = env.log.events();

    assert.ok(events.includes('alpha activate'), 'alpha was activated');
    assert.ok(
      events.indexOf('alpha activate') > events.indexOf('zeta activated'),
      `alpha activated before zeta was active: ${events.join(', ')}`,
    );
    assert.equal(env.diagnostics.state('zeta'), 'active');
    assert.equal(env.diagnostics.state('alpha'), 'active');
  });

  test('an optional dependency does not make a bundle wait', async (t) => {
    const env = await setupSupervisor(t, {
      aprov: {
        mode: 'slow-activate',
        ms: 1_500,
        provides: ['aprov.api/v1@1.0.0'],
      },
      zcons: { mode: 'alive', optional: ['aprov.api/v1'] },
    });

    await within(env.supervisor.boot(), 'the boot');

    const events = env.log.events();

    assert.ok(events.includes('zcons activate'), 'zcons was activated');
    assert.ok(
      events.indexOf('zcons activate') < events.indexOf('aprov activated'),
      `zcons waited for its optional provider: ${events.join(', ')}`,
    );
    assert.equal(env.diagnostics.state('zcons'), 'active');
  });

  test('a bundle whose dependency is quarantined is never activated', async (t) => {
    const env = await setupSupervisor(t, {
      zeta: { mode: 'activate-fails', provides: ['zeta.api/v1@1.0.0'] },
      alpha: { mode: 'alive', requires: ['zeta.api/v1@^1.0.0'] },
    });

    await within(env.supervisor.boot(), 'the boot');
    await sleep(300);

    assert.deepEqual(codesOf(env.diagnostics, 'zeta'), ['activate_failed']);
    assert.ok(
      !env.log.events().includes('alpha activate'),
      'alpha was activated',
    );
    assert.notEqual(env.supervisor.state('alpha'), 'active');
    assert.equal(env.diagnostics.state('alpha'), 'quarantined');
  });
});

// ---------------------------------------------------------------------------
// Spawn concurrency

describe('Supervisor spawn concurrency', () => {
  test('at most spawnConcurrency instances are spawned at once', async (t) => {
    const bundles: Record<string, FixtureBundle> = {
      b1: { mode: 'delay-hello', ms: 300 },
      b2: { mode: 'delay-hello', ms: 300 },
    };
    const log = fixtureLog(t);
    const scripts: Record<string, Script> = {
      ...bundles,
      core: { mode: 'delay-hello', ms: 300 },
    };
    const env = await setupSupervisor(t, bundles, {
      timings: { spawnConcurrency: 1 },
      commandOf: commandsOf(scripts, log),
    });
    const ids = ['core', 'b1', 'b2'];
    let most = 0;
    let booted = false;
    const boot = env.supervisor.boot().finally(() => {
      booted = true;
    });

    while (!booted) {
      const spawned = ids.filter(
        (id) => env.supervisor.state(id) === 'spawned',
      ).length;

      most = Math.max(most, spawned);
      await sleep(5);
    }

    await within(boot, 'the boot');

    assert.equal(most, 1);

    for (const id of ids) {
      assert.equal(env.diagnostics.state(id), 'active', id);
    }
  });
});

// ---------------------------------------------------------------------------
// startPlatform

describe('startPlatform', () => {
  const platformOf = async (
    t: TestContext,
    bundles: Readonly<Record<string, FixtureBundle>>,
    options: {
      readonly timings?: Partial<Timings>;
      readonly required?: { readonly bundles: readonly string[] };
    } = {},
  ) => {
    const log = fixtureLog(t);
    const resolved = resolveHost(bundles);
    const diagnostics = new DiagnosticsStore({ generation: 1 });

    diagnostics.load(resolved);

    const exits: number[] = [];
    const platform = await within(
      startPlatform({
        index: createCatalogIndex([file_doric_tools_v1_tools]),
        resolved,
        commandOf: commandsOf(bundles, log),
        env: { PATH: process.env.PATH },
        timings: { ...testTimings, ...options.timings },
        diagnostics,
        ...(options.required === undefined
          ? {}
          : { required: { bundles: options.required.bundles, contracts: [] } }),
        exit: (code) => {
          exits.push(code);
        },
      }),
      'the platform to boot',
    );

    t.after(() => within(platform.shutdown(), 'the platform to shut down'));

    return { platform, diagnostics, exits, log };
  };

  test('boots the resolution and answers the router port', async (t) => {
    const { platform, diagnostics, exits } = await platformOf(t, {
      echo: { mode: 'alive' },
    });

    assert.ok(Number.isInteger(platform.routerPort));
    assert.ok(platform.routerPort > 0);
    assert.equal(diagnostics.state('core'), 'active');
    assert.equal(diagnostics.state('echo'), 'active');
    assert.deepEqual(exits, []);
  });

  test('a required bundle quarantined after the boot calls exit(1) once', async (t) => {
    const { diagnostics, exits } = await platformOf(
      t,
      { frozen: { mode: 'freeze-after-active' } },
      {
        timings: {
          healthIntervalMs: 100,
          healthTimeoutMs: 300,
          stallThresholdMs: 2_000,
        },
        required: { bundles: ['frozen'] },
      },
    );

    await until(() => exits.length > 0, 'the host to exit');
    assert.deepEqual(codesOf(diagnostics, 'frozen'), ['health_timeout']);
    await sleep(300);
    assert.deepEqual(exits, [1]);
  });

  test('shutdown stops every process and resolves', async (t) => {
    const { platform, exits, log } = await platformOf(t, {
      echo: { mode: 'alive' },
    });

    await within(platform.shutdown(), 'the shutdown');

    const pids = log.pids();

    assert.equal(pids.length, 2);
    await until(
      () => pids.every((pid) => !isAlive(pid)),
      'every process to exit',
      500,
    );
    assert.deepEqual(exits, []);
    await within(platform.shutdown(), 'a second shutdown');
  });
});
