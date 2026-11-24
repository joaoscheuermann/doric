// The platform's boot pieces (spec `docs/designs/grpc-processes.md`, Flows →
// "Boot", section 7 "Host shutdown"; slice S61a): `doric.startup/v1` served
// in process over `PlatformOptions.startup`, the `doric` caller and
// `runHostHook`, `beforeListen` and `beforeStop`, `hostPart`,
// `structuralFault`, and the `database_client` stage before the storage
// identity read. Each test boots a platform of fixture processes
// (`tests/support/scripted-host.ts`, at most four alive at once, A67) over a
// real router; `core` runs the `serve-hooks` fixture where a test runs a
// hook. Every platform is shut down in `after`.

import assert from 'node:assert/strict';
import { type AddressInfo, connect, createServer } from 'node:net';
import test, { describe } from 'node:test';

import { ContractError } from '../../src/contracts/error.js';
import { file_doric_hooks_v1_hooks } from '../../src/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_storage_backend_v1_backend } from '../../src/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import { runHostHook, type StartupSink } from '../../src/platform/index.js';
import {
  type BootingPlatform,
  bootPlatform,
  type FixtureBundle,
  isAlive,
  type Script,
  setupPlatform,
  until,
  within,
} from '../support/scripted-host.js';

/** The fixtures' contracts, `hooks/v1` and `storage.backend/v1`. */
const bootIndex = () =>
  createCatalogIndex([
    file_doric_tools_v1_tools,
    file_doric_settings_v1_settings,
    file_doric_hooks_v1_hooks,
    file_doric_storage_backend_v1_backend,
  ]);

/** `core` as the `serve-hooks` provider of `hooks/v1`. */
const hooksCore: Readonly<Record<string, Script>> = {
  core: { mode: 'serve-hooks' },
};

const startStep: FixtureBundle = {
  mode: 'start-step',
  requires: ['hooks/v1@^1.0.0'],
};

const storageProvider: FixtureBundle = {
  mode: 'serve-storage-identity',
  provides: ['storage.backend/v1@1.0.0'],
};

/** What a {@link StartupSink} was told, in order. */
type SinkRecord =
  | { readonly stage: string }
  | {
      readonly level: string;
      readonly message: string;
      readonly fields: Readonly<Record<string, unknown>>;
    };

const recordingSink = (
  onStage: (name: string) => void = () => {},
): { readonly sink: StartupSink; readonly records: SinkRecord[] } => {
  const records: SinkRecord[] = [];

  return {
    records,
    sink: {
      stage: (name) => {
        records.push({ stage: name });
        onStage(name);
      },
      log: ({ level, message, fields }) => {
        records.push({ level, message, fields: { ...fields } });
      },
    },
  };
};

/** A port no listener holds now. */
const freePort = async (): Promise<number> => {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
};

/** Whether `127.0.0.1:<port>` accepts a TCP connection. */
const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/** What `promise` rejected with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
  what: string,
): Promise<unknown> => {
  const outcome = await within(
    promise.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    ),
    what,
  );

  if (outcome.resolved) {
    return assert.fail(`${what} resolved`);
  }

  return outcome.error;
};

function assertContractError(
  error: unknown,
  code: string,
): asserts error is ContractError {
  assert.ok(
    error instanceof ContractError,
    `expected a ContractError: ${String(error)}`,
  );
  assert.equal(error.code, code, error.message);
}

// ---------------------------------------------------------------------------
// doric.startup/v1 and runHostHook

describe('doric.startup/v1 and runHostHook through beforeListen', () => {
  test("a start step's Stage and Log reach the sink in order, with level, message and fields; an invalid Stage fails invalid_input and reaches the sink not at all", async (t) => {
    const { sink, records } = recordingSink();
    const env = await setupPlatform(
      t,
      { step: startStep },
      {
        index: bootIndex(),
        scripts: hooksCore,
        startup: sink,
        beforeListen: (doric) => runHostHook(doric, 'onHostStartHook'),
      },
    );

    assert.equal(env.log.countOf('step', 'step-ran'), 1);
    assert.equal(env.log.countOf('step', 'invalid-stage:invalid_input'), 1);
    assert.deepEqual(records, [
      { stage: 'fixture_step' },
      {
        level: 'info',
        message: 'fixture step',
        fields: { bundleId: 'step', count: 2 },
      },
    ]);
  });

  test('runHostHook reaches the hooks/v1 provider as doric/0/0 for Define and Run and the handler runs; a second run defines again with the same stamped caller', async (t) => {
    const env = await setupPlatform(
      t,
      { step: startStep },
      {
        index: bootIndex(),
        scripts: hooksCore,
        beforeListen: async (doric) => {
          await runHostHook(doric, 'onHostStartHook');
          await runHostHook(doric, 'onHostStartHook');
        },
      },
    );

    assert.deepEqual(
      env.log.eventsOf('core').filter((event) => /^(define|run):/.test(event)),
      [
        'define:doric/0/0',
        'run:doric/0/0:onHostStartHook',
        'define:doric/0/0',
        'run:doric/0/0:onHostStartHook',
      ],
    );
    assert.equal(env.log.countOf('step', 'step-ran'), 2);
  });

  test("runHostHook rejects with a failing sequence handler's code, and a later handler does not run", async (t) => {
    let failure: unknown;
    let settled = false;

    const env = await setupPlatform(
      t,
      {
        first: { mode: 'start-step-fails', requires: ['hooks/v1@^1.0.0'] },
        second: startStep,
      },
      {
        index: bootIndex(),
        scripts: hooksCore,
        beforeListen: async (doric) => {
          try {
            await runHostHook(doric, 'onHostStartHook');
          } catch (error) {
            failure = error;
          }

          settled = true;
        },
      },
    );

    assert.ok(settled, 'beforeListen did not run');
    assertContractError(failure, 'limit_exceeded');
    assert.equal(env.log.countOf('first', 'step-failed'), 1);
    assert.equal(env.log.countOf('second', 'step-ran'), 0);
  });
});

// ---------------------------------------------------------------------------
// beforeListen

describe('beforeListen', () => {
  test('runs after every scheduled bundle is active and the identity was read, before the public port accepts a connection', async (t) => {
    const port = await freePort();
    const seen: {
      states: Record<string, string | undefined>;
      identityReads: number;
      accepting: boolean;
    }[] = [];
    let host: BootingPlatform | undefined;
    const bundles = {
      storage: storageProvider,
      app: { mode: 'alive' } as const,
    };

    host = bootPlatform(t, bundles, {
      index: bootIndex(),
      publicAddress: `127.0.0.1:${port}`,
      beforeListen: async () => {
        const diagnostics = host?.diagnostics;

        seen.push({
          states: Object.fromEntries(
            ['core', 'storage', 'app'].map((id) => [
              id,
              diagnostics?.state(id),
            ]),
          ),
          identityReads: host?.log.countOf('storage', 'identity:doric') ?? -1,
          accepting: await accepts(port),
        });
      },
    });

    const platform = await within(host.booting, 'the platform to boot');

    assert.deepEqual(seen, [
      {
        states: { core: 'active', storage: 'active', app: 'active' },
        identityReads: 1,
        accepting: false,
      },
    ]);
    assert.equal(platform.publicPort, port);
    assert.equal(await accepts(port), true);
  });

  test('its rejection rejects startPlatform with that same error and leaves no process running', async (t) => {
    const failure = new Error('fixture beforeListen failed');
    const env = bootPlatform(
      t,
      { app: { mode: 'alive' } },
      {
        index: bootIndex(),
        publicAddress: '127.0.0.1:0',
        beforeListen: () => Promise.reject(failure),
      },
    );

    const outcome = await rejectionOf(env.booting, 'startPlatform to settle');

    assert.equal(outcome, failure);
    await until(
      () => env.log.pids().every((pid) => !isAlive(pid)),
      'every fixture process to end',
    );
  });
});

// ---------------------------------------------------------------------------
// beforeStop

describe('beforeStop', () => {
  test('runs after the public port stopped accepting and before any instance gets Stop; its rejection does not fail shutdown; its signal aborts at the shutdown deadline, by which every process has ended', async (t) => {
    const deadlineMs = 1_500;
    const seen: {
      accepting: boolean;
      deactivations: number;
      abortedAfterMs?: number;
    }[] = [];
    let shutdownAt = 0;
    let port = 0;
    let logOf: (() => string[]) | undefined;

    const env = await setupPlatform(
      t,
      { app: { mode: 'alive' } },
      {
        index: bootIndex(),
        publicAddress: '127.0.0.1:0',
        timings: { shutdownDeadlineMs: deadlineMs },
        beforeStop: async (_doric, signal) => {
          const entry: (typeof seen)[number] = {
            accepting: await accepts(port),
            deactivations: (logOf?.() ?? []).filter((event) =>
              event.endsWith(' deactivate'),
            ).length,
          };

          seen.push(entry);
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
            }

            signal.addEventListener('abort', () => resolve());
          });
          entry.abortedAfterMs = performance.now() - shutdownAt;
          throw new Error('fixture beforeStop failed');
        },
      },
    );

    port = env.platform.publicPort ?? 0;
    logOf = () => env.log.events();
    assert.equal(await accepts(port), true);

    shutdownAt = performance.now();
    await within(env.platform.shutdown(), 'the platform to shut down');

    const tookMs = performance.now() - shutdownAt;

    assert.equal(seen.length, 1, 'beforeStop ran once');
    assert.equal(seen[0]?.accepting, false);
    assert.equal(seen[0]?.deactivations, 0);
    assert.ok(
      (seen[0]?.abortedAfterMs ?? 0) >= deadlineMs - 100,
      `the signal aborted after ${seen[0]?.abortedAfterMs} ms`,
    );
    assert.ok(tookMs < deadlineMs + 1_000, `shutdown took ${tookMs} ms`);
    assert.ok(
      env.log.pids().every((pid) => !isAlive(pid)),
      'a fixture process outlived the shutdown',
    );
  });
});

// ---------------------------------------------------------------------------
// hostPart

describe('hostPart', () => {
  test('a bundle without a host part is not spawned, is active in the diagnostics, its dependent activates, and it gets no Stop at shutdown', async (t) => {
    const env = await setupPlatform(
      t,
      {
        ui: { mode: 'alive', provides: ['base.api/v1@1.0.0'] },
        app: { mode: 'alive', requires: ['base.api/v1@^1.0.0'] },
      },
      { hostPart: (bundleId) => bundleId !== 'ui' },
    );

    assert.deepEqual(env.log.pidsOf('ui'), []);
    assert.equal(env.diagnostics.state('ui'), 'active');
    assert.equal(env.diagnostics.state('app'), 'active');
    assert.equal(env.diagnostics.state('core'), 'active');

    await within(env.platform.shutdown(), 'the platform to shut down');

    assert.deepEqual(env.log.eventsOf('ui'), []);
    assert.equal(env.log.countOf('app', 'deactivate'), 1);
  });
});

// ---------------------------------------------------------------------------
// structuralFault

describe('structuralFault', () => {
  test('a required bundle and the provider of a required contract quarantined at the boot: the fault names them, no identity read, no beforeListen, no public port, and startPlatform resolves', async (t) => {
    let listened = false;
    const env = bootPlatform(
      t,
      {
        storage: storageProvider,
        settings: { mode: 'activate-fails', provides: ['settings/v1@1.0.0'] },
        broken: { mode: 'activate-fails' },
      },
      {
        index: bootIndex(),
        publicAddress: '127.0.0.1:0',
        requiredBundles: ['broken'],
        requiredContracts: ['settings/v1'],
        beforeListen: async () => {
          listened = true;
        },
      },
    );

    const platform = await within(env.booting, 'the platform to boot');

    assert.equal(
      platform.structuralFault,
      'structural providers unavailable: settings/v1, broken',
    );
    assert.equal(env.log.countOf('storage', 'identity:doric'), 0);
    assert.equal(listened, false);
    assert.equal(platform.publicPort, undefined);
    assert.deepEqual(env.exits, []);
  });
});

// ---------------------------------------------------------------------------
// database_client

describe('the database_client stage', () => {
  test('is told to the sink before the identity read; a failing Identity rejects startPlatform after it, with the call code', async (t) => {
    let host: BootingPlatform | undefined;
    const readsAtStage: number[] = [];
    const { sink, records } = recordingSink((name) => {
      if (name === 'database_client') {
        readsAtStage.push(host?.log.countOf('storage', 'identity:doric') ?? -1);
      }
    });

    host = bootPlatform(
      t,
      {
        storage: { ...storageProvider, mode: 'identity-fails' },
        app: { mode: 'alive' },
      },
      { index: bootIndex(), startup: sink },
    );

    const outcome = await rejectionOf(host.booting, 'startPlatform to settle');

    assertContractError(outcome, 'limit_exceeded');
    assert.deepEqual(records, [{ stage: 'database_client' }]);
    assert.deepEqual(readsAtStage, [0]);
    assert.equal(host.log.countOf('storage', 'identity:doric'), 1);
  });
});
