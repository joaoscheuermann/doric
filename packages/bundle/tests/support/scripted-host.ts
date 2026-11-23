// A host of fixture bundle processes for the supervision tests
// (`tests/platform/crash.test.ts`, `shutdown.test.ts`; spec
// `docs/designs/grpc-processes.md`, section 7, A64, A67): each bundle runs
// the fixture `tests/fixtures/scripted` with the arguments of its `Script`,
// against a real router listener whose routes come from the real host
// resolution, with `startSupervisor` or `startPlatform`. Everything a setup
// starts is shut down, and every fixture process ended, in `after`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  type CatalogIndex,
  createCatalogIndex,
} from '../../src/platform/catalog-index.js';
import { type Platform, startPlatform } from '../../src/platform/index.js';
import { InstanceTable } from '../../src/platform/router/instances.js';
import { startRouter } from '../../src/platform/router/listener.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import { createRouterRelay } from '../../src/platform/supervisor/router-relay.js';
import type { SpawnCommand } from '../../src/platform/supervisor/spawn.js';
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
import { descriptorFor, manifest } from './fixtures.js';

/** Timings short enough for tests; each test overrides what it exercises. */
export const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 3_000,
  spawnConcurrency: 4,
  activationTimeoutMs: 3_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  restartDelaysMs: [50, 100, 200],
  restartWindowMs: 60_000,
  stopTimeoutMs: 1_000,
  shutdownDeadlineMs: 3_000,
  activeWaitMs: 3_000,
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` until it holds; fails the test after `timeoutMs`. */
export const until = async (
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
export const within = async <T>(
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
export const isAlive = (pid: number): boolean => {
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

/** What a fixture bundle does: the fixture's mode and its arguments. */
export interface Script {
  readonly mode:
    | 'alive'
    | 'slow-activate'
    | 'activate-fails'
    | 'crash-after-active'
    | 'crash-in-activate'
    | 'serve-settings'
    | 'crash-in-call'
    | 'call-provider'
    | 'call-in-deactivate'
    | 'ignore-stop'
    | 'generations'
    | 'hold-on-drain'
    | 'call-repeat'
    | 'serve-models'
    | 'http-prefix'
    | 'http-server'
    | 'serve-demo'
    | 'watch-demo'
    | 'describe-platform'
    | 'serve-storage-identity'
    | 'identity-fails';
  readonly ms?: number;
  readonly count?: number;
}

/** A fixture bundle: its script and its version 2 manifest's lists. */
export interface FixtureBundle extends Script {
  /** The manifest's version; `1.0.0` when undefined. */
  readonly version?: string;
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  /** The manifest's `host.httpPrefix`; none when undefined. */
  readonly httpPrefix?: string;
  /** The manifest's `client.requires`; empty when undefined. */
  readonly clientRequires?: readonly string[];
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
    version: bundle.version ?? '1.0.0',
    engines: { doric: '^1.0.0' },
    provides,
    host: {
      requires: [...(bundle.requires ?? [])],
      optional: [],
      ...(bundle.httpPrefix === undefined
        ? {}
        : { httpPrefix: bundle.httpPrefix }),
    },
    client: { requires: [...(bundle.clientRequires ?? [])], optional: [] },
  };

  return {
    id,
    source: { kind: 'installed', dir: `/bundles/${id}` },
    manifest: manifestV2Schema.parse(source),
    descriptor: descriptorFor(manifest(id, { provides })),
    errors: [],
  };
};

/**
 * The host resolution of `core` (an `alive` fixture) and `bundles`, every
 * one enabled but those in `options.disabled`.
 */
export const resolveHost = (
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: { readonly disabled?: readonly string[] } = {},
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
        enabled: candidates
          .map(({ id }) => id)
          .filter((id) => !(options.disabled ?? []).includes(id)),
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );
};

/** The fixtures' shared log: lines `<bundleId> <event> <pid>`. */
export interface FixtureLog {
  readonly path: string;
  lines(): string[];
  /** The `<bundleId> <event>` of every line, in order. */
  events(): string[];
  /** The events of `bundleId`'s lines, in order, without the bundle id. */
  eventsOf(bundleId: string): string[];
  /** How many lines `<bundleId> <event>` there are. */
  countOf(bundleId: string, event: string): number;
  /** The pid of every process that started. */
  pids(): number[];
  /** The pids of the bundle's processes, in start order. */
  pidsOf(bundleId: string): number[];
}

export const fixtureLog = (t: TestContext): FixtureLog => {
  const dir = mkdtempSync(join(tmpdir(), 'doric-supervision-'));
  const path = join(dir, 'events.log');
  const lines = (): string[] => {
    try {
      return readFileSync(path, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const fields = (): string[][] => lines().map((line) => line.split(' '));
  const starts = (bundleId?: string): number[] =>
    fields()
      .filter(
        ([id, event]) =>
          event === 'start' && (bundleId === undefined || id === bundleId),
      )
      .map(([, , pid]) => Number(pid));
  const log: FixtureLog = {
    path,
    lines,
    events: () => fields().map(([id, event]) => `${id} ${event}`),
    eventsOf: (bundleId) =>
      fields()
        .filter(([id]) => id === bundleId)
        .map(([, event]) => event ?? ''),
    countOf: (bundleId, event) =>
      fields().filter(([id, seen]) => id === bundleId && seen === event).length,
    pids: () => starts(),
    pidsOf: (bundleId) => starts(bundleId),
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

/** `commandOf` for `core` (alive) and `bundles`: `node main.js <mode> <log> <ms> [count]`. */
export const commandsOf =
  (bundles: Readonly<Record<string, Script>>, log: FixtureLog) =>
  (bundleId: string): SpawnCommand => {
    const script = bundles[bundleId] ?? { mode: 'alive' };

    return {
      command: process.execPath,
      args: [
        scripted,
        script.mode,
        log.path,
        String(script.ms ?? 0),
        ...(script.count === undefined ? [] : [String(script.count)]),
      ],
    };
  };

/** The contracts the fixtures serve and call. */
export const fixtureIndex = () =>
  createCatalogIndex([
    file_doric_tools_v1_tools,
    file_doric_settings_v1_settings,
  ]);

export interface SupervisorHost {
  readonly supervisor: Supervisor;
  readonly diagnostics: DiagnosticsStore;
  readonly log: FixtureLog;
  /** `<bundleId> <code>` of every quarantine passed to `onQuarantine`. */
  readonly quarantines: string[];
}

/**
 * Starts a router, with the routes of the resolution, and a supervisor of
 * `core` and `bundles`, without booting; shuts both down in `after`.
 */
export const setupSupervisor = async (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  overrides: Partial<Timings> = {},
): Promise<SupervisorHost> => {
  const log = fixtureLog(t);
  const resolved = resolveHost(bundles);
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const effective = { ...testTimings, ...overrides };
  const instances = new InstanceTable();
  const relay = createRouterRelay();
  const router = await startRouter({
    index: fixtureIndex(),
    routes: callRoutesOf(resolved),
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
  const quarantines: string[] = [];
  const supervisor = startSupervisor({
    router,
    relay,
    instances,
    resolved,
    commandOf: commandsOf(bundles, log),
    env: { PATH: process.env.PATH },
    timings: effective,
    diagnostics,
    onQuarantine: (bundleId, reason) =>
      quarantines.push(`${bundleId} ${reason.code}`),
  });

  t.after(async () => {
    await within(supervisor.shutdown(), 'the supervisor to shut down');
    await router.close();
  });

  return { supervisor, diagnostics, log, quarantines };
};

export interface PlatformHost {
  readonly platform: Platform;
  readonly diagnostics: DiagnosticsStore;
  readonly log: FixtureLog;
  /** Every code `exit` was called with. */
  readonly exits: number[];
  /**
   * The script of each bundle, `core` included, read at each spawn: a test
   * changes it before a publish to give the next generation another one.
   */
  readonly scripts: Record<string, Script>;
  /**
   * The executable digest of each bundle, read by `digestOf` (`''` for a
   * bundle not in the map): a test changes it before a publish.
   */
  readonly digests: Map<string, string>;
}

export interface PlatformSetupOptions {
  readonly timings?: Partial<Timings>;
  readonly requiredBundles?: readonly string[];
  /** Scripts of bundles not in `bundles`, `core` for one. */
  readonly scripts?: Readonly<Record<string, Script>>;
  /** `PlatformOptions.publicAddress`; no gateway when undefined. */
  readonly publicAddress?: string;
  /** `PlatformOptions.index`; {@link fixtureIndex} when undefined. */
  readonly index?: CatalogIndex;
}

/** A platform whose `startPlatform` has been called, settled or not. */
export interface BootingPlatform extends Omit<PlatformHost, 'platform'> {
  /** What `startPlatform` answered. */
  readonly booting: Promise<Platform>;
}

/**
 * Calls `startPlatform` for `core` and `bundles` without waiting for it; a
 * platform it resolves with is shut down in `after`.
 */
export const bootPlatform = (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: PlatformSetupOptions = {},
): BootingPlatform => {
  const log = fixtureLog(t);
  const resolved = resolveHost(bundles);
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const exits: number[] = [];
  const scripts: Record<string, Script> = {
    ...bundles,
    ...options.scripts,
  };
  const digests = new Map<string, string>();
  const booting = startPlatform({
    index: options.index ?? fixtureIndex(),
    ...(options.publicAddress === undefined
      ? {}
      : { publicAddress: options.publicAddress }),
    resolved,
    commandOf: commandsOf(scripts, log),
    digestOf: (bundleId) => digests.get(bundleId) ?? '',
    env: { PATH: process.env.PATH },
    timings: { ...testTimings, ...options.timings },
    diagnostics,
    ...(options.requiredBundles === undefined
      ? {}
      : { required: { bundles: options.requiredBundles, contracts: [] } }),
    exit: (code) => {
      exits.push(code);
    },
    writeLog: () => {},
  });

  t.after(async () => {
    const platform = await booting.catch(() => undefined);

    if (platform !== undefined) {
      await within(platform.shutdown(), 'the platform to shut down');
    }
  });

  return { booting, diagnostics, log, exits, scripts, digests };
};

/** Boots a platform of `core` and `bundles`; shuts it down in `after`. */
export const setupPlatform = async (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: PlatformSetupOptions = {},
): Promise<PlatformHost> => {
  const { booting, ...host } = bootPlatform(t, bundles, options);
  const platform = await within(booting, 'the platform to boot');

  return { platform, ...host };
};

/** The quarantine codes the diagnostics hold for `bundleId`. */
export const codesOf = (
  diagnostics: DiagnosticsStore,
  bundleId: string,
): string[] => diagnostics.reasons(bundleId).map(({ code }) => code);

/** The instances of `bundleId`'s `generation_lost` reports, in order. */
export const lossesOf = (
  diagnostics: DiagnosticsStore,
  bundleId: string,
): {
  readonly generation: number;
  readonly incarnation: number;
}[] =>
  diagnostics
    .snapshot()
    .errors.filter(
      (error) =>
        error.bundleId === bundleId && error.kind === 'generation_lost',
    )
    .map((error) => {
      const details = error.details as {
        generation: number;
        incarnation: number;
      };

      return {
        generation: details.generation,
        incarnation: details.incarnation,
      };
    });
