// The in-memory router of `bundle/testing` (spec
// `docs/designs/grpc-processes.md`, section 10, A61; slice S22): a bundle's
// tests activate its host part with `createTestRouter`, call its services
// through `client`, fake its dependencies, and stop it through `control`.
// The bundle under test serves `doric.conformance.v1.ConformanceService` (and
// `settings/v1` where a test needs protovalidate rules); its dependency is
// `settings/v1`, faked. The last test spawns `node` to check that importing
// `bundle/testing` loads no `node:http2`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { create, type DescMethod, type DescService } from '@bufbuild/protobuf';
import { type Any, anyPack, EmptySchema } from '@bufbuild/protobuf/wkt';
import { createValidator } from '@bufbuild/protovalidate';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import { type Call, deadlineOf } from '../../src/contracts/call.js';
import { ContractError, isContractError } from '../../src/contracts/error.js';
import { ConformanceService } from '../../src/contracts/gen/doric/conformance/v1/conformance_pb.js';
import {
  ModelsService,
  type StreamRequest,
  StreamResponseSchema,
} from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import { StartupService } from '../../src/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import {
  GetRequestSchema,
  SettingsService,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { ToolsService } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { callOf } from '../../src/contracts/metadata.js';
import { fromConnectError } from '../../src/contracts/status.js';
import type {
  HostContext,
  InputViolation,
  InvalidInputAnswer,
  ServiceEntry,
} from '../../src/sdk/host/index.js';
import { currentCall } from '../../src/sdk/host/serve.js';
import { createTestRouter } from '../../src/testing/index.js';
import { manifest, withRoot, writeBundle } from '../support/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 3_000,
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

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<ConnectError> => {
  try {
    await within(promise, what);
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail(`${what} succeeded`);
};

/** Asserts a call failed with `grpc` and the Doric code `code`. */
const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

/** Asserts `run` throws a `ContractError` with `code`. */
const assertContractThrow = (run: () => unknown, code: string): void => {
  assert.throws(run, (error: unknown) => {
    assert.ok(isContractError(error), `expected a ContractError: ${error}`);
    assert.equal(error.code, code);

    return true;
  });
};

/** An implementation that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** What a handler saw of one call. */
interface Seen {
  readonly caller: Call['caller'];
  readonly scope: Call['scope'];
  readonly deadline: number;
  readonly traceparent: string;
}

const seenOf = (call: Call): Seen => ({
  caller: { ...call.caller },
  scope: call.scope === undefined ? undefined : { ...call.scope },
  deadline: deadlineOf(call),
  traceparent: call.trace.traceparent,
});

const seen = (context: HandlerContext): Seen => seenOf(callOf(context));

const traceIdOf = (traceparent: string): string | undefined =>
  traceparent.split('-')[1];

/** A settings value: `GetResponse.value` is required. */
const someValue = (): Any => anyPack(EmptySchema, create(EmptySchema));

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** A bundle serving `Echo`, which records what its handler saw. */
const echoBundle = (record: Seen[]): ServiceEntry =>
  partial(ConformanceService, {
    echo: (request, context) => {
      record.push(seen(context));

      return { text: request.text };
    },
  });

const defaultCaller = { bundleId: 'test', version: '0.0.0', generation: 1 };

// ---------------------------------------------------------------------------
// Tests

describe('createTestRouter: activation and clients', () => {
  test('activate resolves with a context of the default instance; the service answers', async () => {
    const router = createTestRouter();
    const record: Seen[] = [];
    let received: HostContext | undefined;

    const context = await within(
      router.activate<readonly DescService[]>({
        services: [echoBundle(record)],
        activate: (given) => {
          received = given;
        },
      }),
      'activate',
    );

    assert.equal(context, received);
    assert.deepEqual(
      { ...context.instance },
      { bundleId: 'test-bundle', generation: 1, incarnation: 1 },
    );
    assert.equal(context.signal.aborted, false);

    const response = await within(
      router.client(ConformanceService).echo({ text: 'hello' }),
      'echo',
    );

    assert.equal(response.text, 'hello');
    assert.equal(record.length, 1);
  });

  test('instance fields left out take their default', async () => {
    const router = createTestRouter({
      instance: { bundleId: 'acme.echo', generation: 4 },
    });
    const context = await within(
      router.activate<readonly DescService[]>({ activate: () => {} }),
      'activate',
    );

    assert.deepEqual(
      { ...context.instance },
      { bundleId: 'acme.echo', generation: 4, incarnation: 1 },
    );
  });

  test('a handler sees the default caller {test, 0.0.0, 1}, no scope, and a fresh trace', async () => {
    const router = createTestRouter();
    const record: Seen[] = [];

    await router.activate<readonly DescService[]>({
      services: [echoBundle(record)],
      activate: () => {},
    });
    await within(router.client(ConformanceService).echo({ text: 'a' }), 'echo');

    const [first] = record;
    assert.ok(first !== undefined);
    assert.deepEqual(first.caller, defaultCaller);
    assert.equal(first.scope, undefined);
    assert.equal(first.deadline, 0);
    assert.match(first.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  test('router-level caller and scope reach the handler; a client overrides them', async () => {
    const caller = { bundleId: 'acme.shell', version: '2.0.0', generation: 7 };
    const router = createTestRouter({ caller, scope: { windowKey: 'w1' } });
    const record: Seen[] = [];

    await router.activate<readonly DescService[]>({
      services: [echoBundle(record)],
      activate: () => {},
    });

    await within(
      router.client(ConformanceService).echo({ text: 'a' }),
      'echo (router options)',
    );

    const other = { bundleId: 'acme.other', version: '3.1.0', generation: 2 };
    await within(
      router
        .client(ConformanceService, {
          caller: other,
          scope: { windowKey: 'w2', tab: 't' },
        })
        .echo({ text: 'b' }),
      'echo (client options)',
    );

    assert.deepEqual(record[0]?.caller, caller);
    assert.deepEqual(record[0]?.scope, { windowKey: 'w1' });
    assert.deepEqual(record[1]?.caller, other);
    assert.deepEqual(record[1]?.scope, { windowKey: 'w2', tab: 't' });
  });

  test('timeoutMs gives the handler the call deadline', async () => {
    const router = createTestRouter();
    const record: Seen[] = [];

    await router.activate<readonly DescService[]>({
      services: [echoBundle(record)],
      activate: () => {},
    });

    const before = Date.now();
    await within(
      router
        .client(ConformanceService)
        .echo({ text: 'a' }, { timeoutMs: 2_000 }),
      'echo',
    );
    const after = Date.now();

    const deadline = record[0]?.deadline ?? 0;
    assert.ok(
      deadline >= before + 2_000 && deadline <= after + 2_000,
      `deadline ${deadline} outside [${before + 2_000}, ${after + 2_000}]`,
    );
  });

  test('context.log records into logs, in order', async () => {
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      activate: (context) => {
        context.log.info('hello', { a: 1 });
        context.log.warn('careful');
      },
    });

    assert.equal(router.logs.length, 2);
    assert.deepEqual(
      { ...router.logs[0] },
      { level: 'info', message: 'hello', fields: { a: 1 } },
    );
    assert.equal(router.logs[1]?.level, 'warn');
    assert.equal(router.logs[1]?.message, 'careful');
  });

  test('activate rejects with what activate threw, unchanged; the services stay served', async () => {
    const router = createTestRouter();
    const thrown = new ContractError('not_found', 'no such thing');

    const rejection = await within(
      router
        .activate<readonly DescService[]>({
          services: [echoBundle([])],
          activate: () => {
            throw thrown;
          },
        })
        .then(
          () => assert.fail('activate resolved'),
          (error: unknown) => error,
        ),
      'activate',
    );

    assert.equal(rejection, thrown);

    const response = await within(
      router.client(ConformanceService).echo({ text: 'still' }),
      'echo',
    );
    assert.equal(response.text, 'still');
  });
});

describe('createTestRouter: fakes and context.services.use', () => {
  test('a handler reaches a fake through use; the fake sees the bundle as caller and the inherited scope and trace', async () => {
    const fakeSeen: Seen[] = [];
    const handlerSeen: Seen[] = [];
    const current: (Call | undefined)[] = [];
    const router = createTestRouter({
      instance: { bundleId: 'acme.echo', generation: 3, incarnation: 2 },
      fakes: [
        partial(SettingsService, {
          get: (request, context) => {
            fakeSeen.push(seen(context));
            assert.equal(request.id, 'space/v1');

            return { value: someValue() };
          },
        }),
      ],
    });
    let host: HostContext | undefined;

    await router.activate<readonly DescService[]>({
      services: [
        partial(ConformanceService, {
          echo: async (request, context) => {
            handlerSeen.push(seen(context));
            current.push(currentCall());
            assert.ok(host !== undefined);
            await host.services.use(SettingsService).get({ id: 'space/v1' });

            return { text: request.text };
          },
        }),
      ],
      activate: (context) => {
        host = context;
      },
    });

    const response = await within(
      router
        .client(ConformanceService, { scope: { windowKey: 'w1' } })
        .echo({ text: 'via fake' }, { timeoutMs: 2_000 }),
      'echo',
    );

    assert.equal(response.text, 'via fake');

    const [handler] = handlerSeen;
    const [fake] = fakeSeen;
    assert.ok(handler !== undefined && fake !== undefined);

    const inside = current[0];
    assert.ok(inside !== undefined, 'currentCall() answered nothing');
    assert.deepEqual(seenOf(inside), handler);

    assert.deepEqual(fake.caller, {
      bundleId: 'acme.echo',
      version: '0.0.0',
      generation: 3,
    });
    assert.deepEqual(fake.scope, { windowKey: 'w1' });
    assert.equal(traceIdOf(fake.traceparent), traceIdOf(handler.traceparent));
    assert.equal(fake.deadline, handler.deadline);
    assert.ok(fake.deadline > 0);
  });

  test('a fake called outside a handler sees no scope and no deadline', async () => {
    const fakeSeen: Seen[] = [];
    const router = createTestRouter({
      scope: { windowKey: 'w1' },
      fakes: [
        partial(SettingsService, {
          get: (_request, context) => {
            fakeSeen.push(seen(context));

            return { value: someValue() };
          },
        }),
      ],
    });

    await router.activate<readonly DescService[]>({
      activate: async (context) => {
        await context.services.use(SettingsService).get({ id: 'space/v1' });
      },
    });

    assert.deepEqual(fakeSeen[0]?.caller, {
      bundleId: 'test-bundle',
      version: '0.0.0',
      generation: 1,
    });
    assert.equal(fakeSeen[0]?.scope, undefined);
    assert.equal(fakeSeen[0]?.deadline, 0);
  });

  test('use with a scope, outside a handler, gives the fake that scope; without one the fake sees none', async () => {
    const fakeSeen: Seen[] = [];
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          get: (_request, context) => {
            fakeSeen.push(seen(context));

            return { value: someValue() };
          },
        }),
      ],
    });
    const scope = { projectId: 'p1', threadId: 't1', promptId: 'r1' };

    await router.activate<readonly DescService[]>({
      activate: async (context) => {
        await context.services
          .use(SettingsService, { scope })
          .get({ id: 'space/v1' });
        await context.services.use(SettingsService).get({ id: 'space/v1' });
      },
    });

    assert.equal(fakeSeen.length, 2);
    assert.deepEqual(fakeSeen[0]?.scope, scope);
    assert.equal(fakeSeen[1]?.scope, undefined);
  });

  test("use with a scope inside a handler replaces the handler's scope; the deadline and the cancellation still come from the handler's call", async () => {
    const fakeSeen: Seen[] = [];
    const handlerSeen: Seen[] = [];
    let fakeSignal: AbortSignal | undefined;
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          get: async (_request, context) => {
            fakeSeen.push(seen(context));
            fakeSignal = callOf(context).signal;
            await aborted(fakeSignal);
            throw new ContractError('unavailable', 'cancelled');
          },
        }),
      ],
    });
    const replaced = { projectId: 'p1', threadId: 't1', promptId: 'r1' };
    let host: HostContext | undefined;

    await router.activate<readonly DescService[]>({
      services: [
        partial(ConformanceService, {
          echo: async (request, context) => {
            handlerSeen.push(seen(context));
            assert.ok(host !== undefined);
            await host.services
              .use(SettingsService, { scope: replaced })
              .get({ id: 'space/v1' })
              .catch(() => undefined);

            return { text: request.text };
          },
        }),
      ],
      activate: (context) => {
        host = context;
      },
    });

    const cancel = new AbortController();
    const inFlight = router
      .client(ConformanceService, { scope: { windowKey: 'w1' } })
      .echo({ text: 'a' }, { timeoutMs: 2_000, signal: cancel.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await until(() => fakeSignal !== undefined, 'the fake to be called');

    const [handler] = handlerSeen;
    const [fake] = fakeSeen;
    assert.ok(handler !== undefined && fake !== undefined);
    assert.deepEqual(handler.scope, { windowKey: 'w1' });
    assert.deepEqual(fake.scope, replaced);
    assert.ok(handler.deadline > 0);
    assert.equal(fake.deadline, handler.deadline);
    assert.equal(fakeSignal?.aborted, false);

    cancel.abort();

    await until(() => fakeSignal?.aborted === true, 'the fake to be cancelled');
    await within(inFlight, 'the cancelled call to settle');
  });

  test('use with an out-of-bounds scope throws ContractError invalid_scope and makes no call', async () => {
    let reached = false;
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          get: () => {
            reached = true;

            return { value: someValue() };
          },
        }),
      ],
    });
    let host: HostContext | undefined;

    await router.activate<readonly DescService[]>({
      activate: (context) => {
        host = context;
      },
    });

    assert.ok(host !== undefined);
    const services = host.services;
    assertContractThrow(
      () => services.use(SettingsService, { scope: { '1bad': 'x' } }),
      'invalid_scope',
    );
    await sleep(20);
    assert.equal(reached, false);
  });

  test('with requires given, an undeclared use fails PERMISSION_DENIED undeclared_requirement, even when faked', async () => {
    let reached = false;
    const router = createTestRouter({
      requires: [],
      fakes: [
        partial(SettingsService, {
          get: () => {
            reached = true;

            return { value: someValue() };
          },
        }),
      ],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });

    const error = await failureOf(
      context.services.use(SettingsService).get({ id: 'space/v1' }),
    );

    assertFailure(error, Code.PermissionDenied, 'undeclared_requirement');
    assert.equal(reached, false);
  });

  test('a declared service no fake serves fails UNAVAILABLE unavailable', async () => {
    const router = createTestRouter({
      requires: [SettingsService.typeName],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });

    const error = await failureOf(
      context.services.use(SettingsService).get({ id: 'space/v1' }),
    );

    assertFailure(error, Code.Unavailable, 'unavailable');
  });

  test('a declared and faked service is reached', async () => {
    const router = createTestRouter({
      requires: [SettingsService.typeName],
      fakes: [
        partial(SettingsService, { get: () => ({ value: someValue() }) }),
      ],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });

    const response = await within(
      context.services.use(SettingsService).get({ id: 'space/v1' }),
      'get',
    );

    assert.ok(response.value !== undefined);
  });

  test('with requires given, a doric.* platform contract is declared without being listed; a doric.-named non-platform service is not', async () => {
    const stages: string[] = [];
    let toolsReached = false;
    const router = createTestRouter({
      requires: [],
      fakes: [
        partial(StartupService, {
          stage: (request) => {
            stages.push(request.name);

            return {};
          },
        }),
        partial(ToolsService, {
          list: () => {
            toolsReached = true;

            return { tools: [] };
          },
        }),
      ],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });

    // `doric.startup/v1` is a platform contract: `routeCall` skips step 3.
    await within(
      context.services.use(StartupService).stage({ name: 'boot' }),
      'stage',
    );
    assert.deepEqual(stages, ['boot']);

    // `doric.tools.v1.ToolsService` belongs to `tools/v1`, not a platform
    // contract, whatever its package name.
    const error = await failureOf(context.services.use(ToolsService).list({}));

    assertFailure(error, Code.PermissionDenied, 'undeclared_requirement');
    assert.equal(toolsReached, false);
  });

  test("the bundle's own services are always declared", async () => {
    const router = createTestRouter({ requires: [] });
    const context = await router.activate<readonly DescService[]>({
      services: [echoBundle([])],
      activate: () => {},
    });

    const response = await within(
      context.services.use(ConformanceService).echo({ text: 'self' }),
      'echo to self',
    );

    assert.equal(response.text, 'self');
  });

  test("a fake's resumable stream ending with generation_lost is opened again with the resume request", async () => {
    const requests: string[] = [];
    let openings = 0;
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          watch: async function* (request) {
            openings += 1;
            requests.push(request.id);
            yield {
              settingsEntry: { value: someValue(), version: `v${openings}` },
            };

            if (openings === 1) {
              throw new ContractError('generation_lost', 'The fake drained.');
            }
          },
        }),
      ],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });
    const watch = context.services
      .use(SettingsService, {
        resume: {
          watch: (last) => ({ id: `after-${last.settingsEntry?.version}` }),
        },
      })
      .watch({ id: 'space/v1' });
    const versions = await within(
      (async () => {
        const seenVersions: (string | undefined)[] = [];

        for await (const item of watch) {
          seenVersions.push(item.settingsEntry?.version);
        }

        return seenVersions;
      })(),
      'the watch to end',
    );

    assert.deepEqual(versions, ['v1', 'v2']);
    assert.deepEqual(requests, ['space/v1', 'after-v1']);
  });
});

describe('createTestRouter: validation and errors', () => {
  test('an invalid request fails invalid_input before the handler runs', async () => {
    let reached = false;
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      services: [
        partial(SettingsService, {
          get: () => {
            reached = true;

            return { value: someValue() };
          },
        }),
      ],
      activate: () => {},
    });

    // `GetRequest.id` has `string.min_len = 1`.
    const error = await failureOf(
      router.client(SettingsService).get({ id: '' }),
    );

    assertFailure(error, Code.InvalidArgument, 'invalid_input');
    assert.equal(reached, false);
  });

  test("a handler's ContractError crosses with its code and message", async () => {
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      services: [
        partial(ConformanceService, {
          fail: () => {
            throw new ContractError('not_found', 'the thing is gone');
          },
        }),
      ],
      activate: () => {},
    });

    const error = await failureOf(router.client(ConformanceService).fail({}));

    assertFailure(error, Code.NotFound, 'not_found');
    assert.equal(fromConnectError(error).message, 'the thing is gone');
  });

  test("a handler's other error fails the call as internal", async () => {
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      services: [
        partial(ConformanceService, {
          fail: () => {
            throw new Error('boom');
          },
        }),
      ],
      activate: () => {},
    });

    const error = await failureOf(router.client(ConformanceService).fail({}));

    assertFailure(error, Code.Internal, 'internal');
  });

  test("a fake's ContractError crosses with its code; any other error as internal", async () => {
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          get: (request) => {
            if (request.id === 'contract/v1') {
              throw new ContractError('settings_missing', 'never set');
            }

            throw new Error('the fake broke');
          },
        }),
      ],
    });
    const context = await router.activate<readonly DescService[]>({
      activate: () => {},
    });
    const settings = context.services.use(SettingsService);

    const contract = await failureOf(settings.get({ id: 'contract/v1' }));
    assertFailure(contract, Code.NotFound, 'settings_missing');
    assert.equal(fromConnectError(contract).message, 'never set');

    const other = await failureOf(settings.get({ id: 'other/v1' }));
    assertFailure(other, Code.Internal, 'internal');
  });

  test('a client call before activate fails UNAVAILABLE unavailable', async () => {
    const router = createTestRouter();

    const error = await failureOf(
      router.client(ConformanceService).echo({ text: 'early' }),
    );

    assertFailure(error, Code.Unavailable, 'unavailable');
  });

  test('a service the definition does not serve fails UNIMPLEMENTED unknown_contract, a faked one included', async () => {
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, { get: () => ({ value: someValue() }) }),
      ],
    });

    await router.activate<readonly DescService[]>({
      services: [echoBundle([])],
      activate: () => {},
    });

    const unknown = await failureOf(router.client(ToolsService).list({}));
    assertFailure(unknown, Code.Unimplemented, 'unknown_contract');

    const faked = await failureOf(
      router.client(SettingsService).get({ id: 'space/v1' }),
    );
    assertFailure(faked, Code.Unimplemented, 'unknown_contract');
  });
});

describe('createTestRouter: invalidInput (S60a V5)', () => {
  /** One call of a definition's `invalidInput`, as it received it. */
  interface HookCall {
    readonly method: DescMethod;
    readonly violations: readonly InputViolation[];
  }

  /** `settings/v1` (`id` has `string.min_len = 1`) whose handlers record that they ran. */
  const settingsBundle = (reached: string[]): ServiceEntry =>
    partial(SettingsService, {
      get: () => {
        reached.push('get');

        return { value: someValue() };
      },
      watch: async function* () {
        reached.push('watch');
        yield {};
      },
    });

  /** Activates `settings/v1` with `invalidInput`; answers the router and the recorded hook calls. */
  const activated = async (
    answer: () => ContractError | undefined,
    reached: string[],
  ) => {
    const calls: HookCall[] = [];
    const invalidInput: InvalidInputAnswer = (method, violations) => {
      calls.push({
        method,
        violations: violations.map((violation) => ({
          field: [...violation.field],
          ruleId: violation.ruleId,
          message: violation.message,
        })),
      });

      return answer();
    };
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      services: [settingsBundle(reached)],
      activate: () => {},
      invalidInput,
    });

    return { router, calls };
  };

  /** protovalidate's message for a settings request with an empty id. */
  const emptyIdMessage = (): string => {
    const result = createValidator().validate(
      GetRequestSchema,
      create(GetRequestSchema, { id: '' }),
    );

    return result.kind === 'invalid' ? result.error.message : '';
  };

  const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
    for await (const _item of stream) {
      // reads the stream to its end
    }
  };

  test("a violating unary request fails with the hook's ContractError; the handler does not run", async () => {
    const reached: string[] = [];
    const { router } = await activated(
      () => new ContractError('not_found', 'The space is unknown.'),
      reached,
    );

    const error = await failureOf(
      router.client(SettingsService).get({ id: '' }),
    );

    assertFailure(error, Code.NotFound, 'not_found');
    assert.equal(fromConnectError(error).message, 'The space is unknown.');
    assert.deepEqual(reached, []);
  });

  test("a violating server-stream request fails with the hook's ContractError; the handler does not run", async () => {
    const reached: string[] = [];
    const { router } = await activated(
      () => new ContractError('invalid_scope', 'The id is empty.'),
      reached,
    );

    const error = await failureOf(
      drain(router.client(SettingsService).watch({ id: '' })),
    );

    assertFailure(error, Code.InvalidArgument, 'invalid_scope');
    assert.equal(fromConnectError(error).message, 'The id is empty.');
    assert.deepEqual(reached, []);
  });

  test("a hook answering undefined keeps invalid_input with protovalidate's message (unary and server stream)", async () => {
    const reached: string[] = [];
    const { router, calls } = await activated(() => undefined, reached);

    const unary = await failureOf(
      router.client(SettingsService).get({ id: '' }),
    );
    const stream = await failureOf(
      drain(router.client(SettingsService).watch({ id: '' })),
    );

    for (const error of [unary, stream]) {
      assertFailure(error, Code.InvalidArgument, 'invalid_input');
      assert.equal(fromConnectError(error).message, emptyIdMessage());
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(reached, []);
  });

  test("a hook that throws keeps invalid_input with protovalidate's message", async () => {
    const reached: string[] = [];
    const { router, calls } = await activated(() => {
      throw new Error('the hook broke');
    }, reached);

    const error = await failureOf(
      router.client(SettingsService).get({ id: '' }),
    );

    assertFailure(error, Code.InvalidArgument, 'invalid_input');
    assert.equal(fromConnectError(error).message, emptyIdMessage());
    assert.equal(calls.length, 1);
    assert.deepEqual(reached, []);
  });

  test('the hook receives the method and each violation: field names from the root and the rule id', async () => {
    const { router, calls } = await activated(() => undefined, []);

    await failureOf(router.client(SettingsService).get({ id: '' }));
    await failureOf(drain(router.client(SettingsService).watch({ id: '' })));

    // Compared by identity: a descriptor is too large for a deepEqual diff.
    assert.deepEqual(
      calls.map((call) => call.method.name),
      ['Get', 'Watch'],
    );
    assert.ok(calls[0]?.method === SettingsService.method.get);
    assert.ok(calls[1]?.method === SettingsService.method.watch);

    for (const call of calls) {
      assert.deepEqual(call.violations, [
        {
          field: ['id'],
          ruleId: 'string.min_len',
          message: 'must be at least 1 characters',
        },
      ]);
    }
  });

  test('a valid request does not reach the hook', async () => {
    const reached: string[] = [];
    const { router, calls } = await activated(
      () => new ContractError('not_found', 'unexpected'),
      reached,
    );

    await within(router.client(SettingsService).get({ id: 'space/v1' }), 'get');

    assert.deepEqual(reached, ['get']);
    assert.equal(calls.length, 0);
  });
});

describe('createTestRouter: argument checks', () => {
  test('fakes listing a service twice make createTestRouter throw a TypeError', () => {
    assert.throws(
      () =>
        createTestRouter({
          fakes: [partial(SettingsService, {}), partial(SettingsService, {})],
        }),
      TypeError,
    );
  });

  test('an out-of-bounds scope fails invalid_scope, at createTestRouter and at client', () => {
    assertContractThrow(
      () => createTestRouter({ scope: { '1bad': 'x' } }),
      'invalid_scope',
    );

    const router = createTestRouter();
    assertContractThrow(
      () => router.client(ConformanceService, { scope: { '1bad': 'x' } }),
      'invalid_scope',
    );
  });

  test('creating a client makes no call and does not throw before activate', () => {
    const router = createTestRouter();

    assert.doesNotThrow(() => router.client(ConformanceService));
  });

  test('activate twice rejects with a TypeError without running activate again', async () => {
    const router = createTestRouter();
    let runs = 0;
    const definition = {
      activate: () => {
        runs += 1;
      },
    };

    await router.activate<readonly DescService[]>(definition);
    await assert.rejects(
      router.activate<readonly DescService[]>(definition),
      TypeError,
    );
    assert.equal(runs, 1);
  });

  test('a definition listing a service twice rejects with a TypeError without running activate', async () => {
    const router = createTestRouter();
    let ran = false;

    await assert.rejects(
      router.activate<readonly DescService[]>({
        services: [echoBundle([]), echoBundle([])],
        activate: () => {
          ran = true;
        },
      }),
      TypeError,
    );
    assert.equal(ran, false);
  });

  test('a definition serving a faked service rejects with a TypeError without running activate', async () => {
    const router = createTestRouter({
      fakes: [partial(ConformanceService, {})],
    });
    let ran = false;

    await assert.rejects(
      router.activate<readonly DescService[]>({
        services: [echoBundle([])],
        activate: () => {
          ran = true;
        },
      }),
      TypeError,
    );
    assert.equal(ran, false);
  });
});

describe('createTestRouter: control', () => {
  test('stop aborts context.signal, then runs deactivate once; later calls fail unavailable', async () => {
    const router = createTestRouter();
    const order: string[] = [];
    let deactivations = 0;
    let signalAbortedInDeactivate = false;
    let deactivateContext: HostContext | undefined;

    const context = await router.activate<readonly DescService[]>({
      services: [echoBundle([])],
      activate: (given) => {
        given.signal.addEventListener('abort', () => order.push('abort'));
      },
      deactivate: (given) => {
        deactivations += 1;
        deactivateContext = given;
        signalAbortedInDeactivate = given.signal.aborted;
        order.push('deactivate');
      },
    });

    await within(router.control.stop(), 'stop');
    await within(router.control.stop(), 'second stop');

    assert.equal(deactivations, 1);
    assert.equal(deactivateContext, context);
    assert.equal(signalAbortedInDeactivate, true);
    assert.deepEqual(order, ['abort', 'deactivate']);

    const error = await failureOf(
      router.client(ConformanceService).echo({ text: 'late' }),
    );
    assertFailure(error, Code.Unavailable, 'unavailable');

    await assert.rejects(
      router.activate<readonly DescService[]>({ activate: () => {} }),
      TypeError,
    );
  });

  test('stop aborts the signals of calls in flight, to the bundle and to the fakes', async () => {
    let fakeSignal: AbortSignal | undefined;
    let handlerSignal: AbortSignal | undefined;
    const router = createTestRouter({
      fakes: [
        partial(SettingsService, {
          get: async (_request, context) => {
            fakeSignal = callOf(context).signal;
            await aborted(fakeSignal);
            throw new ContractError('unavailable', 'stopped');
          },
        }),
      ],
    });
    let host: HostContext | undefined;

    await router.activate<readonly DescService[]>({
      services: [
        partial(ConformanceService, {
          wait: async (request, context) => {
            handlerSignal = callOf(context).signal;
            assert.ok(host !== undefined);
            await host.services
              .use(SettingsService)
              .get({ id: 'space/v1' })
              .catch(() => undefined);
            await aborted(handlerSignal);

            return { key: request.key };
          },
        }),
      ],
      activate: (context) => {
        host = context;
      },
    });

    const inFlight = router
      .client(ConformanceService)
      .wait({ key: 'k', holdMs: 0 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await until(() => fakeSignal !== undefined, 'the fake to be called');
    assert.equal(handlerSignal?.aborted, false);
    assert.equal(fakeSignal?.aborted, false);

    await within(router.control.stop(), 'stop');

    assert.equal(handlerSignal?.aborted, true);
    assert.equal(fakeSignal?.aborted, true);
    await within(inFlight, 'the in-flight call to settle');
  });

  test('a failing deactivate is logged as `deactivate failed`; stop still resolves', async () => {
    const router = createTestRouter();

    await router.activate<readonly DescService[]>({
      activate: () => {},
      deactivate: () => {
        throw new Error('cleanup broke');
      },
    });

    await within(router.control.stop(), 'stop');

    assert.ok(
      router.logs.some(
        (record) =>
          record.level === 'error' && record.message === 'deactivate failed',
      ),
      `logs: ${JSON.stringify(router.logs)}`,
    );
  });

  test('deactivate does not run when activate rejected', async () => {
    const router = createTestRouter();
    let deactivated = false;

    await assert.rejects(
      router.activate<readonly DescService[]>({
        activate: () => {
          throw new Error('no');
        },
        deactivate: () => {
          deactivated = true;
        },
      }),
    );
    await within(router.control.stop(), 'stop');

    assert.equal(deactivated, false);
  });

  test('stop before activate resolves; activate afterwards rejects with a TypeError', async () => {
    const router = createTestRouter();
    let ran = false;

    await within(router.control.stop(), 'stop');
    await assert.rejects(
      router.activate<readonly DescService[]>({
        activate: () => {
          ran = true;
        },
      }),
      TypeError,
    );
    assert.equal(ran, false);
  });

  test('generationChanged resolves before activate, after it and after stop', async () => {
    const router = createTestRouter();

    await within(router.control.generationChanged({}), 'before activate');
    await router.activate<readonly DescService[]>({ activate: () => {} });
    await within(router.control.generationChanged({}), 'after activate');
    await router.control.stop();
    await within(router.control.generationChanged({}), 'after stop');
  });
});

/** What a handler of a cancelled call saw: its signal, and whether it ended. */
interface Held {
  signal?: AbortSignal;
  /** The handler's `finally` ran. */
  finished: boolean;
  /** The request messages the handler read. */
  read: number;
}

const held = (): Held => ({ finished: false, read: 0 });

/**
 * A bundle whose `Count` answers one item, then waits for its call to be
 * cancelled; `state` records what it saw.
 */
const holdingCount = (state: Held): ServiceEntry =>
  partial(ConformanceService, {
    count: async function* (_request, context) {
      state.signal = context.signal;

      try {
        yield { index: 0 };
        await aborted(context.signal);
      } finally {
        state.finished = true;
      }
    },
  });

/** A promise that never settles: a request stream the caller keeps open. */
const never = (): Promise<never> => new Promise<never>(() => undefined);

/** Asserts the handler saw its call cancelled and ended, within a short bound. */
const assertCancelled = async (state: Held): Promise<void> => {
  await until(
    () => state.signal?.aborted === true,
    "the handler's context.signal to abort",
    1_000,
  );
  await until(() => state.finished, "the handler's finally to run", 1_000);
};

/** A router serving `entry`, activated. */
const serving = async (entry: ServiceEntry) => {
  const router = createTestRouter();
  await router.activate<readonly DescService[]>({
    services: [entry],
    activate: () => {},
  });

  return router;
};

describe('createTestRouter: a cancelled call reaches the handler', () => {
  test('server streaming: one item read, then the signal aborted with no read pending', async () => {
    const state = held();
    const router = await serving(holdingCount(state));
    const controller = new AbortController();
    const iterator = router
      .client(ConformanceService)
      .count({ n: 2 }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = await within(iterator.next(), 'the first item');
    assert.equal(first.done, false);
    assert.equal(first.value?.index, 0);

    controller.abort();

    await assertCancelled(state);
    await router.control.stop();
  });

  test('server streaming: one item read, a read pending, then the signal aborted', async () => {
    const state = held();
    const router = await serving(holdingCount(state));
    const controller = new AbortController();
    const iterator = router
      .client(ConformanceService)
      .count({ n: 2 }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await within(iterator.next(), 'the first item');
    const pending = iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    );
    await sleep(20);
    controller.abort();

    await within(pending, 'the pending read to settle');
    await assertCancelled(state);
    await router.control.stop();
  });

  test('server streaming: one item read, then return() on the iterator', async () => {
    const state = held();
    const router = await serving(holdingCount(state));
    const iterator = router
      .client(ConformanceService)
      .count({ n: 2 })
      [Symbol.asyncIterator]();

    await within(iterator.next(), 'the first item');
    await within(
      iterator.return?.() ?? Promise.resolve(undefined),
      'return() to settle',
    );

    await assertCancelled(state);
    await router.control.stop();
  });

  test('server streaming: one item read, the signal aborted, then return() on the iterator', async () => {
    const state = held();
    const router = await serving(holdingCount(state));
    const controller = new AbortController();
    const iterator = router
      .client(ConformanceService)
      .count({ n: 2 }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await within(iterator.next(), 'the first item');
    controller.abort();
    await within(
      (iterator.return?.() ?? Promise.resolve(undefined)).catch(
        () => undefined,
      ),
      'return() to settle',
    );

    await assertCancelled(state);
    await router.control.stop();
  });

  test('client streaming: one message read, then the signal aborted', async () => {
    const state = held();
    const router = await serving(
      partial(ConformanceService, {
        sum: async (requests, context) => {
          state.signal = context.signal;

          try {
            await requests[Symbol.asyncIterator]().next();
            state.read += 1;
            await aborted(context.signal);

            return { total: 0, count: state.read };
          } finally {
            state.finished = true;
          }
        },
      }),
    );
    const controller = new AbortController();
    const requests = async function* () {
      yield { value: 1 };
      await never();
    };
    const response = router
      .client(ConformanceService)
      .sum(requests(), { signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await until(() => state.read === 1, 'the handler to read one message');
    controller.abort();

    await within(response, 'the call to settle');
    await assertCancelled(state);
    await router.control.stop();
  });

  /** A bundle whose bidi `Stream` answers one event, then waits for cancel. */
  const holdingStream = (state: Held): ServiceEntry =>
    partial(ModelsService, {
      stream: async function* (_requests, context) {
        state.signal = context.signal;

        try {
          yield create(StreamResponseSchema);
          await aborted(context.signal);
        } finally {
          state.finished = true;
        }
      },
    });

  /** A request stream the caller keeps open without sending. */
  const openRequests = (): AsyncIterable<StreamRequest> => ({
    [Symbol.asyncIterator]: () => ({ next: never }),
  });

  test('bidi streaming: one item read, then the signal aborted with no read pending', async () => {
    const state = held();
    const router = await serving(holdingStream(state));
    const controller = new AbortController();
    const iterator = router
      .client(ModelsService)
      .stream(openRequests(), { signal: controller.signal })
      [Symbol.asyncIterator]();

    const first = await within(iterator.next(), 'the first item');
    assert.equal(first.done, false);

    controller.abort();

    await assertCancelled(state);
    await router.control.stop();
  });

  test('bidi streaming: one item read, then return() on the iterator', async () => {
    const state = held();
    const router = await serving(holdingStream(state));
    const iterator = router
      .client(ModelsService)
      .stream(openRequests())
      [Symbol.asyncIterator]();

    await within(iterator.next(), 'the first item');
    await within(
      iterator.return?.() ?? Promise.resolve(undefined),
      'return() to settle',
    );

    await assertCancelled(state);
    await router.control.stop();
  });
});

describe('bundle/testing at import', () => {
  // Only the import is checked: on Node 22 the global `Headers` that
  // Connect's in-memory transport uses loads Node's bundled undici, which
  // loads `node:http2` on the first call.
  test('importing bundle/testing loads no node:http2', () => {
    const dist = (path: string): string =>
      fileURLToPath(new URL(`../../../dist/${path}`, import.meta.url));
    const script = `
      const { createTestRouter } = await import(${JSON.stringify(dist('testing/index.js'))});
      const { ConformanceService } = await import(${JSON.stringify(dist('contracts/gen/doric/conformance/v1/conformance_pb.js'))});
      const http2 = process.moduleLoadList.filter((name) => name.includes('http2'));
      const router = createTestRouter();
      await router.activate({
        services: [[ConformanceService, { echo: (request) => ({ text: request.text }) }]],
        activate: () => {},
      });
      const response = await router.client(ConformanceService).echo({ text: 'ok' });
      await router.control.stop();
      process.stdout.write(JSON.stringify({
        text: response.text,
        http2,
      }));
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 20_000 },
    );

    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout) as {
      text: string;
      http2: string[];
    };
    assert.equal(output.text, 'ok');
    assert.deepEqual(output.http2, []);
  });
});

describe('createTestRouter: context.assets', () => {
  /** A bundle directory whose manifest lists `src/host/skills/*.md`. */
  const writeAssetsBundle = (root: string): Promise<string> =>
    writeBundle(root, 'assets-demo', {
      manifest: {
        ...manifest('assets-demo'),
        host: { assets: ['src/host/skills/*.md'] },
      },
      files: {
        'src/host/skills/a.md': 'hello',
        'src/host/other.md': 'not an asset',
      },
    });

  /** The message of the `Error` `promise` rejects with. */
  const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await within(promise, 'the read');
    } catch (error) {
      assert.ok(error instanceof Error, `expected an Error: ${error}`);

      return error.message;
    }

    return assert.fail('the read resolved');
  };

  test('with bundleDir, read answers a listed file and refuses an unlisted one, without a build', async () => {
    await withRoot(async (root) => {
      const bundleDir = await writeAssetsBundle(root);
      const router = createTestRouter({
        bundleDir,
        instance: { bundleId: 'assets-demo' },
      });
      const context = await router.activate({ activate: () => {} });

      const bytes = await within(
        context.assets.read('src/host/skills/a.md'),
        'the read',
      );

      assert.equal(new TextDecoder().decode(bytes), 'hello');

      const message = await rejectionOf(
        context.assets.read('src/host/other.md'),
      );

      assert.ok(message.includes('src/host/other.md'), message);
      assert.ok(message.includes('assets-demo'), message);
      assert.match(message, /not listed/i);
      await router.control.stop();
    });
  });

  test('without bundleDir, activation succeeds and read and require fail naming the bundle', async () => {
    const router = createTestRouter({
      instance: { bundleId: 'no-dir-bundle' },
    });
    const context = await router.activate({ activate: () => {} });

    const message = await rejectionOf(
      context.assets.read('src/host/skills/a.md'),
    );

    assert.ok(message.includes('no-dir-bundle'), message);
    assert.throws(
      () => context.assets.require('native-ish'),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error: ${error}`);
        assert.ok(error.message.includes('no-dir-bundle'), error.message);

        return true;
      },
    );
    await router.control.stop();
  });
});
