// `context.log` of a running bundle (spec `docs/designs/grpc-processes.md`,
// "`log/v1` and the other synchronous commands", A7, section 15; slice S42):
// records reach `log/v1.WriteBatch` of the provider through a real router,
// stamped by the router with the bundle and carrying the trace and scope of
// the call they were written in; what is not sent reaches the bundle's
// `logOutput`, redacted with the list `secrets/v1.WatchRedactions` streamed.
// Bundles run in this process with `startBundle`; the provider is a fake
// `core` serving `LogService` and `SecretsService.WatchRedactions`. The last
// tests spawn `tests/fixtures/scripted` (`runBundle`) without a running
// `log/v1` provider and read the child's stdout.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import test, { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { DescService, JsonObject } from '@bufbuild/protobuf';
import {
  createClient,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import type { Call, CallScope } from '../../src/contracts/call.js';
import {
  file_doric_log_v1_log,
  LogService,
} from '../../src/contracts/gen/doric/log/v1/log_pb.js';
import {
  file_doric_secrets_v1_secrets,
  SecretsService,
} from '../../src/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  file_doric_settings_v1_settings,
  SettingsService,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { callOf, scopeHeaderValue } from '../../src/contracts/metadata.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InstanceKey,
  InstanceTable,
  instanceKey,
} from '../../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../../src/platform/router/listener.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import {
  type HostContext,
  type LogSink,
  type ServiceEntry,
  startBundle,
} from '../../src/sdk/host/index.js';
import type { LogOutput, LogTimings } from '../../src/sdk/host/log.js';
import { resolveLogHost } from '../support/call-routes.js';

// ---------------------------------------------------------------------------
// Helpers

const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  stopTimeoutMs: 5_000,
  activeWaitMs: 5_000,
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
  timeoutMs = 5_000,
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

const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const traceIdOf = (traceparent: string): string | undefined =>
  traceparent.split('-')[1];

/** One stdout line, parsed. */
type Line = Record<string, unknown>;

interface RecordingOutput extends LogOutput {
  readonly written: Line[];
  readonly synced: Line[];
}

const recordingOutput = (): RecordingOutput => {
  const written: Line[] = [];
  const synced: Line[] = [];

  return {
    written,
    synced,
    write: (line) => written.push(JSON.parse(line) as Line),
    writeSync: (line) => synced.push(JSON.parse(line) as Line),
  };
};

const messagesOf = (lines: readonly Line[]): unknown[] =>
  lines.map((line) => line.message);

/** One `WriteBatch` the fake provider answered. */
interface ProviderBatch {
  readonly caller: Call['caller'];
  readonly traceId: string | undefined;
  readonly scope: CallScope | undefined;
  readonly messages: readonly string[];
  readonly fields: readonly (JsonObject | undefined)[];
}

/** The fake `log/v1` and `secrets/v1` of `core`. */
interface Provider {
  readonly services: readonly ServiceEntry[];
  readonly batches: ProviderBatch[];
  /** How many `WatchRedactions` streams it opened. */
  readonly watches: () => number;
  /** When set, `WriteBatch` never answers before the call ends. */
  stall: boolean;
}

/** A provider whose `WatchRedactions` streams `redactions`, then stays open. */
const logProvider = (redactions: readonly string[] = []): Provider => {
  const batches: ProviderBatch[] = [];
  let watches = 0;
  const provider: Provider = {
    batches,
    watches: () => watches,
    stall: false,
    services: [
      partial(LogService, {
        writeBatch: async (requests, context) => {
          const call = callOf(context);
          const messages: string[] = [];
          const fields: (JsonObject | undefined)[] = [];

          for await (const { record } of requests) {
            messages.push(record?.message ?? '');
            fields.push(record?.fields);
          }

          if (provider.stall) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );

            return {};
          }

          batches.push({
            caller: { ...call.caller },
            traceId: traceIdOf(call.trace.traceparent),
            scope: call.scope === undefined ? undefined : { ...call.scope },
            messages,
            fields,
          });

          return {};
        },
      }),
      partial(SecretsService, {
        watchRedactions: async function* (_request, context) {
          watches += 1;
          yield { redactions: [...redactions] };
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        },
      }),
    ],
  };

  return provider;
};

const messagesFrom = (
  provider: Provider,
  bundleId: string,
): readonly string[] =>
  provider.batches
    .filter(({ caller }) => caller.bundleId === bundleId)
    .flatMap(({ messages }) => messages);

/** Short queue limits; each test overrides what it exercises. */
const shortLog: Partial<LogTimings> = {
  intervalMs: 20,
  deadlineMs: 2_000,
  stopBudgetMs: 1_000,
  finalDeadlineMs: 1_000,
  redactionRetryMs: 100,
};

/** One bundle started in this process. */
interface Started {
  readonly key: InstanceKey;
  readonly token: string;
  readonly output: RecordingOutput;
  /** Resolves with the code the SDK passed to `exit`. */
  readonly exited: Promise<number>;
  /** The context `activate` received; fails before the activation. */
  context(): HostContext;
}

interface StartOptions {
  readonly services?: readonly ServiceEntry[];
  readonly onActivate?: (context: HostContext) => void;
  readonly deactivate?: (context: HostContext) => Promise<void> | void;
  readonly logSink?: (context: HostContext) => LogSink;
  readonly logTimings?: Partial<LogTimings>;
  /** Default true: the router activates the instance before `start` resolves. */
  readonly activate?: boolean;
}

interface Env {
  readonly router: Router;
  readonly table: InstanceTable;
  start(bundleId: string, options?: StartOptions): Promise<Started>;
  /** A raw client of `service` with `token` and `headers` on every call. */
  raw<S extends DescService>(
    service: S,
    token: string,
    headers?: Record<string, string>,
  ): ReturnType<typeof createClient<S>>;
}

const index = createCatalogIndex([
  file_doric_log_v1_log,
  file_doric_secrets_v1_secrets,
  file_doric_settings_v1_settings,
]);

/** A router of `resolveLogHost()`; everything closes in `after`. */
const setup = async (t: TestContext): Promise<Env> => {
  const table = new InstanceTable();
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolveLogHost()),
    instances: table,
    timings: testTimings,
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: () => {},
    onLost: () => {},
  });
  const baseUrl = `http://127.0.0.1:${router.port}`;
  const sessions: Http2SessionManager[] = [];

  t.after(async () => {
    await router.close();

    for (const session of sessions) {
      session.abort();
    }
  });

  return {
    router,
    table,
    start: async (bundleId, options = {}) => {
      const instance = { bundleId, generation: 1, incarnation: 1 };
      const { token } = table.issue({ ...instance, version: '1.0.0' });
      const key = instanceKey(instance);
      const output = recordingOutput();
      let context: HostContext | undefined;

      const running = await startBundle<readonly DescService[]>(
        {
          services: options.services ?? [],
          activate: (received) => {
            context = received;
            options.onActivate?.(received);
          },
          ...(options.deactivate === undefined
            ? {}
            : { deactivate: options.deactivate }),
          ...(options.logSink === undefined
            ? {}
            : { logSink: options.logSink }),
        },
        {
          env: {
            DORIC_ROUTER_URL: baseUrl,
            DORIC_INSTANCE_TOKEN: token,
            DORIC_BUNDLE_ID: bundleId,
            DORIC_GENERATION: '1',
            DORIC_INCARNATION: '1',
          },
          exit: () => {},
          logTimings: { ...shortLog, ...options.logTimings },
          logOutput: output,
        },
      );

      if (options.activate !== false) {
        const status = await router.sendActivate(key);

        assert.equal(status.code, 0, `activating ${key}: ${status.message}`);
      }

      return {
        key,
        token,
        output,
        exited: running.exited,
        context: () => {
          assert.ok(context !== undefined, `${key} is not activated`);

          return context;
        },
      };
    },
    raw: (service, token, headers = {}) => {
      const session = new Http2SessionManager(baseUrl);
      const stamp: Interceptor = (next) => (request) => {
        request.header.set('authorization', `Bearer ${token}`);

        for (const [name, value] of Object.entries(headers)) {
          request.header.set(name, value);
        }

        return next(request);
      };

      sessions.push(session);

      return createClient(
        service,
        createGrpcTransport({
          baseUrl,
          sessionManager: session,
          interceptors: [stamp],
        }),
      );
    },
  };
};

const register = { id: 'acme.thing/v1', messageType: 'acme.Thing' };

// ---------------------------------------------------------------------------
// startBundle in this process

describe('context.log of a running bundle', () => {
  test('a record of activate reaches log/v1 in a WriteBatch whose caller is the bundle; nothing reaches stdout', async (t) => {
    const env = await setup(t);
    const provider = logProvider();

    await env.start('core', { services: provider.services });
    const app = await env.start('app', {
      onActivate: (context) => context.log.info('activated', { step: 1 }),
    });

    await until(
      () => messagesFrom(provider, 'app').includes('activated'),
      'the record at the provider',
    );

    const batch = provider.batches.find(({ messages }) =>
      messages.includes('activated'),
    );

    assert.deepEqual(batch?.caller, {
      bundleId: 'app',
      version: '1.0.0',
      generation: 1,
    });
    assert.deepEqual(batch?.fields, [{ step: 1 }]);
    assert.deepEqual(app.output.written, []);
    assert.deepEqual(app.output.synced, []);
  });

  test('a record of a served call reaches log/v1 with the trace id and scope of that call', async (t) => {
    const env = await setup(t);
    const provider = logProvider();
    let served: Call | undefined;
    let appContext: HostContext | undefined;

    await env.start('core', { services: provider.services });
    await env.start('app', {
      services: [
        partial(SettingsService, {
          register: (_request, context) => {
            served = callOf(context);
            appContext?.log.info('in register');

            return { registrationId: 'ok' };
          },
        }),
      ],
      onActivate: (context) => {
        appContext = context;
      },
    });
    const caller = await env.start('caller');

    await within(
      env
        .raw(SettingsService, caller.token, {
          'doric-scope-bin': scopeHeaderValue({ tenant: 't1' }),
        })
        .register(register),
      'register',
    );
    await until(
      () => messagesFrom(provider, 'app').includes('in register'),
      'the record at the provider',
    );

    const batch = provider.batches.find(({ messages }) =>
      messages.includes('in register'),
    );

    assert.ok(served !== undefined, 'the call was served');
    assert.equal(batch?.traceId, traceIdOf(served.trace.traceparent));
    assert.deepEqual(batch?.scope, { tenant: 't1' });
  });

  test('a provider slower than deadlineMs: the records reach logOutput after the deadline, redacted with the list it streamed', async (t) => {
    const env = await setup(t);
    const provider = logProvider(['sk-secret']);

    await env.start('core', { services: provider.services });
    const app = await env.start('app', {
      logTimings: { deadlineMs: 300 },
    });

    await until(() => provider.watches() > 0, 'the redaction watch');
    await sleep(100);
    provider.stall = true;

    const loggedAt = performance.now();

    app.context().log.info('token sk-secret leaked');
    await until(
      () => app.output.written.length > 0,
      'the record on logOutput',
    );

    assert.ok(
      performance.now() - loggedAt >= 250,
      'the record waited for the deadline',
    );
    assert.deepEqual(messagesOf(app.output.written), [
      'token [REDACTED] leaked',
    ]);
  });

  test('no active log/v1 provider: the records reach logOutput after the deadline', async (t) => {
    const env = await setup(t);
    const app = await env.start('app', { logTimings: { deadlineMs: 300 } });
    const loggedAt = performance.now();

    app.context().log.warn('nobody listens');
    await until(
      () => app.output.written.length > 0,
      'the record on logOutput',
    );

    assert.ok(
      performance.now() - loggedAt >= 250,
      'the record waited for the deadline',
    );
    assert.deepEqual(messagesOf(app.output.written), ['nobody listens']);
  });

  test('a bundle that does not declare log/v1: records go to logOutput, and once refused every later record goes there at once', async (t) => {
    const env = await setup(t);
    const provider = logProvider();

    await env.start('core', { services: provider.services });
    const stranger = await env.start('stranger', {
      logTimings: { intervalMs: 50 },
      onActivate: (context) => context.log.info('first'),
    });

    await until(
      () => messagesOf(stranger.output.written).includes('first'),
      'the refused record on logOutput',
    );

    stranger.context().log.info('second');

    assert.deepEqual(messagesOf(stranger.output.written), ['first', 'second']);
    assert.deepEqual(messagesFrom(provider, 'stranger'), []);
  });

  test('Stop: a record of deactivate reaches log/v1 before StopResult, then exit(0)', async (t) => {
    const env = await setup(t);
    const provider = logProvider();

    await env.start('core', { services: provider.services });
    const app = await env.start('app', {
      logTimings: { intervalMs: 60_000 },
      deactivate: (context) => context.log.info('deactivating'),
    });

    await env.router.sendStop(app.key);

    assert.deepEqual(messagesFrom(provider, 'app'), ['deactivating']);
    assert.equal(await within(app.exited, 'the exit'), 0);
    assert.deepEqual(app.output.written, []);
    assert.deepEqual(app.output.synced, []);
  });

  test('the host gone: exit(70), and every queued record is on logOutput.writeSync', async (t) => {
    const env = await setup(t);
    const app = await env.start('app', {
      logTimings: { intervalMs: 60_000 },
      onActivate: (context) => {
        context.log.info('queued 1');
        context.log.info('queued 2');
      },
    });

    await env.router.close();

    assert.equal(await within(app.exited, 'the exit'), 70);
    assert.deepEqual(messagesOf(app.output.synced), ['queued 1', 'queued 2']);
  });

  test('definition.logSink is used instead of the router', async (t) => {
    const env = await setup(t);
    const provider = logProvider();
    const own: string[] = [];
    const sink: LogSink = {
      writeBatch: async (records) => {
        own.push(...records.map(({ message }) => message));
      },
      watchRedactions: (signal) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        },
      }),
    };

    await env.start('core', { services: provider.services });
    const app = await env.start('app', {
      logSink: () => sink,
      onActivate: (context) => context.log.info('own sink'),
    });

    await until(() => own.includes('own sink'), 'the record at the own sink');
    await sleep(100);

    assert.deepEqual(messagesFrom(provider, 'app'), []);
    assert.deepEqual(app.output.written, []);
  });
});

// ---------------------------------------------------------------------------
// runBundle in its own process, without a running log/v1 provider

const scripted = fileURLToPath(
  new URL('../fixtures/scripted/main.js', import.meta.url),
);

interface Spawned {
  readonly child: ChildProcess;
  /** Resolves with the exit code and signal. */
  readonly ended: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  /** The JSON lines of its stdout so far. */
  lines(): Line[];
}

/** Spawns the scripted fixture as `app` in `mode`; killed in `after`. */
const spawnScripted = (
  t: TestContext,
  env: Env,
  mode: string,
  count = 1,
): Spawned => {
  const { token } = env.table.issue({
    bundleId: 'app',
    version: '1.0.0',
    generation: 1,
    incarnation: 1,
  });
  const child = spawn(
    process.execPath,
    [scripted, mode, '', '0', String(count)],
    {
      env: {
        PATH: process.env.PATH,
        DORIC_ROUTER_URL: `http://127.0.0.1:${env.router.port}`,
        DORIC_INSTANCE_TOKEN: token,
        DORIC_BUNDLE_ID: 'app',
        DORIC_GENERATION: '1',
        DORIC_INCARNATION: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  let stdout = '';

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });

  const ended = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  return {
    child,
    ended,
    lines: () =>
      stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Line),
  };
};

const appKey: InstanceKey = 'app/1/1';

/**
 * Waits until the process connected, then sends `Activate`; `activation`
 * settles with its answer (or the stream's end).
 */
const activateSpawned = async (
  env: Env,
  spawned: Spawned,
): Promise<{ readonly activation: Promise<unknown> }> => {
  await until(
    () =>
      env.table.get(appKey)?.state === 'connected' ||
      spawned.child.exitCode !== null,
    'the process to connect',
    5_000,
  );
  assert.equal(spawned.child.exitCode, null, 'the process exited early');

  return {
    activation: env.router.sendActivate(appKey).catch(() => undefined),
  };
};

describe('runBundle: the queue at the end of the process', () => {
  test('process.exit(0) writes every queued record to stdout, in order, with the instance', async (t) => {
    const env = await setup(t);
    const spawned = spawnScripted(t, env, 'log-exit', 5);

    await activateSpawned(env, spawned);

    const { code } = await within(spawned.ended, 'the exit');

    assert.equal(code, 0);
    assert.deepEqual(
      spawned.lines().map(({ message, bundleId, generation, incarnation }) => ({
        message,
        bundleId,
        generation,
        incarnation,
      })),
      [0, 1, 2, 3, 4].map((index) => ({
        message: `record ${index}`,
        bundleId: 'app',
        generation: 1,
        incarnation: 1,
      })),
    );
  });

  test('an uncaught exception: exit code 1, the record and an error line uncaught exception on stdout', async (t) => {
    const env = await setup(t);
    const spawned = spawnScripted(t, env, 'log-uncaught');

    await activateSpawned(env, spawned);

    const { code } = await within(spawned.ended, 'the exit');
    const lines = spawned.lines();

    assert.equal(code, 1);
    assert.ok(
      messagesOf(lines).includes('before the throw'),
      'the record is on stdout',
    );

    const error = lines.find(({ message }) => message === 'uncaught exception');

    assert.equal(error?.level, 'error');
    assert.equal(error?.error, 'fixture uncaught');
  });

  test('an unhandled rejection: exit code 1, the record and an error line unhandled rejection on stdout', async (t) => {
    const env = await setup(t);
    const spawned = spawnScripted(t, env, 'log-rejection');

    await activateSpawned(env, spawned);

    const { code } = await within(spawned.ended, 'the exit');
    const lines = spawned.lines();

    assert.equal(code, 1);
    assert.ok(
      messagesOf(lines).includes('before the rejection'),
      'the record is on stdout',
    );

    const error = lines.find(
      ({ message }) => message === 'unhandled rejection',
    );

    assert.equal(error?.level, 'error');
    assert.equal(error?.error, 'fixture rejection');
  });

  test('SIGTERM writes every queued record to stdout and still ends the process by the signal', async (t) => {
    const env = await setup(t);
    const spawned = spawnScripted(t, env, 'log-sigterm', 3);

    const { activation } = await activateSpawned(env, spawned);

    await within(activation, 'the activation');
    spawned.child.kill('SIGTERM');

    const { code, signal } = await within(spawned.ended, 'the exit');

    assert.equal(code, null);
    assert.equal(signal, 'SIGTERM');
    assert.deepEqual(messagesOf(spawned.lines()), [
      'record 0',
      'record 1',
      'record 2',
    ]);
  });
});
