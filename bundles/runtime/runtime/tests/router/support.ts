// The harness of runtime's host part over the router (phase 3, slice S46a;
// spec `docs/designs/grpc-processes.md`, "Storage until phase 4"). The bundle
// under test runs in `createTestRouter` with its routed services
// (`createRuntimeServices`) and the hook handler table, as `main.ts` will list
// them (S48). Its dependencies are fakes that record what they receive, in one
// shared order:
// - `storage/v1` served by `serveStorage` over the memory backend, as core's
//   facade serves it;
// - `events/v1`, `hooks/v1`, `secrets/v1`, `models/v1`, `host-config/v1`,
//   `doric.startup/v1` and `doric.generation/v1`, recording fakes.
// - `sandbox/v1` (S47a), a fake provider by lease id (`./sandbox.ts`) over
//   the domain tests' `SandboxProviderOptions`.
// - `executor/v1` (S48b), a fake provider over the domain tests' scripted
//   executor (`./executor.ts`) that calls back `executor.session/v1`, and
//   `doric.catalog/v1.Get`, naming its provider.
// `core`'s calls to the hook handler service arrive through `router.client`
// with the caller `core`.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  create,
  type DescService,
  fromJson,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { type Any, anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import {
  RegisterRequestSchema as EventsRegisterRequestSchema,
  EventsService,
  SinkRequestSchema,
} from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  HookHandlerService,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  OnHostStartHookInputSchema,
  OnHostStopHookInputSchema,
} from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { GenerationService } from 'bundle/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import {
  LogRequestSchema,
  StageRequestSchema,
  StartupService,
} from 'bundle/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import {
  ajvValidators,
  type BundleInstance,
  createHookHandlers,
  type HostContext,
  type ServiceEntry,
} from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import { OnEventAppendedHookInputSchema } from 'core/contracts/gen/doric/core/event_hooks/v1/event_hooks_pb.js';
import {
  DoricConfigurationSchema,
  HostConfigService,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { serveStorage } from 'storage/rpc';

import type { DoricConfiguration } from '../../src/contracts/configuration.js';
import type { Executor } from '../../src/contracts/executor.js';
import { SessionService } from '../../src/contracts/gen/doric/executor/session/v1/session_pb.js';
import { ExecutorService } from '../../src/contracts/gen/doric/executor/v1/executor_pb.js';
import { AttachmentsService } from '../../src/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { LeaseService } from '../../src/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { ThreadsService } from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { UsageService } from '../../src/contracts/gen/doric/runtime/usage/v1/usage_pb.js';
import { RuntimeService } from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { WorkspaceService } from '../../src/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import { SandboxService } from '../../src/contracts/gen/doric/sandbox/v1/sandbox_pb.js';
import { historyType, threadType } from '../../src/contracts/storage.js';
import { createRuntimeServices } from '../../src/host/service.js';
import { defaultConfiguration, epoch } from '../domain/support/harness.js';
import {
  type Backend,
  memoryBackend,
  snapshot,
  stores,
} from '../store/support.js';
import { testExecution } from '../support/execution.js';
import type { Script } from '../support/executor.js';
import {
  executorCaller,
  type FakeExecutorOptions,
  fakeExecutor,
} from './executor.js';
import {
  type FakeSandboxProviderOptions,
  fakeSandboxProvider,
} from './sandbox.js';

// ---------------------------------------------------------------------------
// Helpers

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
export const within = async <T>(
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

/** Waits until `ready()` holds; fails the test after `timeoutMs`. */
export const eventually = async (
  ready: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!(await ready())) {
    if (performance.now() > deadline)
      assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Lets every pending call run that can run (several macrotasks). */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** The error `promise` rejects with; fails the test when it resolves. */
export const rejectionOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<unknown> => {
  try {
    await within(promise, what);
  } catch (error) {
    return error;
  }

  return assert.fail(`${what} succeeded`);
};

/** The Doric error of a failure: a `ContractError`, or read off a `ConnectError`. */
export const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) return fromConnectError(error);

  assert.ok(isContractError(error), `expected a Doric error: ${String(error)}`);

  return error;
};

/** Asserts `promise` fails with the Doric code `code`; answers the error. */
export const assertFails = async (
  promise: Promise<unknown>,
  code: string,
): Promise<ContractError> => {
  const error = contractErrorOf(await rejectionOf(promise));

  assert.equal(error.code, code, error.message);

  return error;
};

/** A promise a test holds a fake on, and the function that lets it go. */
export interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

export const gate = (): Gate => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, open: () => release() };
};

/** A service entry that only defines the methods a test calls. */
export const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** `value` as JSON, through `JSON.stringify`. */
export const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

/** The items of a stream as they arrive, read in the background. */
export interface Collector<T> {
  readonly items: T[];
  /** Settles once the stream ended, either way. */
  readonly done: Promise<void>;
  /** The stream's failure, once it failed. */
  readonly error: () => unknown;
  readonly ended: () => boolean;
  /** Waits until `count` items arrived. */
  waitFor(count: number, what: string): Promise<void>;
}

export const collect = <T>(stream: AsyncIterable<T>): Collector<T> => {
  const items: T[] = [];
  let failure: unknown;
  let finished = false;
  const done = (async () => {
    try {
      for await (const item of stream) items.push(item);
    } catch (error) {
      failure = error;
    } finally {
      finished = true;
    }
  })();

  return {
    items,
    done,
    error: () => failure,
    ended: () => finished,
    waitFor: (count, what) => eventually(() => items.length >= count, what),
  };
};

/** `core`, as the router stamps it on its calls to the handler services. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

// ---------------------------------------------------------------------------
// The harness

/** One call a fake received, as `service.method` and its request as JSON. */
export interface Recorded {
  readonly method: string;
  readonly request: JsonValue;
}

/** A `hooks/v1.Run` the bundle sent. */
export interface RecordedRun {
  readonly contract: string;
  readonly hook: string;
  readonly input: Any;
}

/** A secret as `secrets/v1` answers it, as JSON. */
export interface SecretJson {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly secret?: string;
}

export interface HarnessOptions {
  /** The memory backend under `storage/v1`; a fresh one by default. */
  readonly backend?: Backend;
  /** The configuration `host-config/v1.Current` answers. */
  readonly configuration?: () => DoricConfiguration;
  /** Awaited by every `storage/v1.DefineType` before it is served. */
  readonly defineTypeGate?: Promise<void>;
  /** The error of the `DefineType` of `type`, if any. */
  readonly defineTypeError?: (type: string) => ContractError | undefined;
  /** The error every `hooks/v1.Run` fails with, if any. */
  readonly runError?: ContractError;
  /** The secrets `secrets/v1.Resolve` knows, by id. */
  readonly secrets?: Readonly<Record<string, SecretJson>>;
  /** `secrets/v1.ResolveByKind`'s answer. */
  readonly byKind?: (
    kind: string,
    exclude: readonly string[],
  ) => SecretJson | undefined;
  readonly redactions?: readonly string[];
  /** `models/v1.Kind`'s descriptor (as JSON) by kind id. */
  readonly kinds?: Readonly<Record<string, JsonValue>>;
  /** `models/v1.Models`'s models (as JSON) by provider id. */
  readonly models?: Readonly<Record<string, readonly JsonValue[]>>;
  /** The fake `sandbox/v1` provider's sandbox, acquisition and hooks. */
  readonly sandbox?: Omit<FakeSandboxProviderOptions, 'record' | 'log'>;
  /** One prompt run of the executor; finishes with 'done' by default. */
  readonly execute?: Script;
  /** What the executor's `Formats` answers; the test format by default. */
  readonly formats?: readonly string[];
  /** The scripted executor's `compact`. */
  readonly compact?: Executor['compact'];
  /** `executor/v1` methods the test answers in place of the scripted executor. */
  readonly executorOverrides?: FakeExecutorOptions['overrides'];
  /**
   * The bundle `doric.catalog/v1.Get` names as the provider of
   * `executor/v1`; `default` by default, `null` for none.
   */
  readonly executorProvider?: string | null;
  /** `absent` serves no `ExecutorService` at all; `routed` (the default) serves the fake. */
  readonly executor?: 'routed' | 'absent';
  /** S51e: the fake executor opens `WatchCancel` in its scripted `Run` and `Compact` (`FakeExecutorOptions`). */
  readonly executorWatchCancel?: boolean;
  /** S51e: awaited before the fake executor opens `WatchCancel`. */
  readonly executorWatchCancelAfter?: () => Promise<void>;
  /** S51e: `RuntimeServicesOptions.executorCancelGraceMs`; the 5 s constant by default. */
  readonly executorCancelGraceMs?: number;
  /** Services the bundle of `contextHarness` serves (it serves none by default). */
  readonly services?: readonly ServiceEntry[];
}

/** Every llms kind names its credential in a `secret` field called `token`. */
const llmsKind = (id: string): JsonValue => ({
  id,
  label: id,
  description: id,
  fields: [{ key: 'token', label: 'Token', kind: 'secret', required: true }],
  lists: ['models', 'reasonings'],
});

/** The services the bundle declares it calls in phase 3 (section D). */
export const requires = [
  StorageService.typeName,
  EventsService.typeName,
  HooksService.typeName,
  LogService.typeName,
  SecretsService.typeName,
  ModelsService.typeName,
  HostConfigService.typeName,
  ExecutorService.typeName,
  SandboxService.typeName,
];

/** One `registrations.track` call the bundle made. */
interface Tracked {
  readonly ref: DescService;
  readonly register: (client: unknown) => Promise<unknown>;
  readonly options:
    | ({ readonly onReplayed?: (result: unknown) => void } & Record<
        string,
        unknown
      >)
    | undefined;
}

/**
 * A memory backend whose storage rejects the calls `fails` picks (method
 * name and first argument), as a failing database write would.
 */
export const failingBackend = (
  fails: (method: string, input: unknown) => boolean,
): Backend => {
  const base = memoryBackend();
  const storage = new Proxy(base.storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (fails(String(property), args[0]))
          return Promise.reject(new Error('The storage write failed.'));
        return (value as (...input: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  return { ...base, name: base.name, storage, close: () => base.close() };
};

/** Whether `batch` (a `storage.commit` argument) puts a document of `type` matching `value`. */
export const putsOf = (
  batch: unknown,
  type: string,
  value: (document: Record<string, unknown>) => boolean,
): boolean =>
  (
    (batch as { put?: readonly { type: string; value: unknown }[] } | undefined)
      ?.put ?? []
  ).some(
    (put) => put.type === type && value(put.value as Record<string, unknown>),
  );

/** The storage types of a Thread record and of its history parts. */
export const storageTypes = {
  thread: threadType.type,
  history: historyType.type,
};

/** The recording fakes of the bundle's dependencies, `storage/v1` included. */
const fakesOf = (
  options: HarnessOptions,
  backend: Backend,
  session: () => Client<typeof SessionService>,
) => {
  const calls: Recorded[] = [];
  const executor = fakeExecutor(
    {
      ...(options.execute === undefined ? {} : { execute: options.execute }),
      ...(options.formats === undefined ? {} : { formats: options.formats }),
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.executorOverrides === undefined
        ? {}
        : { overrides: options.executorOverrides }),
      ...(options.executorWatchCancel === undefined
        ? {}
        : { watchCancel: options.executorWatchCancel }),
      ...(options.executorWatchCancelAfter === undefined
        ? {}
        : { watchCancelAfter: options.executorWatchCancelAfter }),
    },
    session,
  );
  const executorProviderId =
    options.executorProvider === undefined
      ? 'default'
      : options.executorProvider;
  const runs: RecordedRun[] = [];
  const record = (method: string, request: JsonValue) => {
    calls.push({ method, request });
  };
  const sandbox = fakeSandboxProvider({
    ...options.sandbox,
    log: record,
  });
  const configuration =
    options.configuration ??
    (() => ({
      configuration: defaultConfiguration,
      revision: 1,
      updatedAt: epoch,
    }));
  const storage = serveStorage(backend.storage, {
    validators: ajvValidators(),
  });
  const kinds = options.kinds ?? {
    openrouter: llmsKind('openrouter'),
    openai: llmsKind('openai'),
  };

  const fakes: ServiceEntry[] = [
    sandbox.entry,
    ...(options.executor === 'absent' ? [] : [executor.entry]),
    partial(CatalogService, {
      get: () => {
        record('catalog.get', {});

        return {
          catalogSnapshot: {
            generation: 1,
            contracts:
              executorProviderId === null
                ? []
                : [
                    {
                      id: 'executor/v1',
                      environment: 'host',
                      cardinality: 'one',
                      providers: [
                        {
                          bundleId: executorProviderId,
                          version: '1.6.0',
                          bundleVersion: '0.0.0',
                        },
                      ],
                    },
                  ],
          },
        };
      },
    }),
    partial(StorageService, {
      ...storage,
      // A measured disk with room to spare, as the kernel harness answers:
      // the memory backend measures none, which reads as storage low.
      health: () => ({
        storageHealth: {
          status: 'ok',
          writable: true,
          disk: { blocks: 100, availableBlocks: 50 },
        },
      }),
      defineType: async (request, context) => {
        record('storage.defineType', { type: request.type });
        await options.defineTypeGate;
        const error = options.defineTypeError?.(request.type);
        if (error !== undefined) throw error;

        return await storage.defineType(request, context);
      },
    }),
    partial(EventsService, {
      register: (request) => {
        record('events.register', toJson(EventsRegisterRequestSchema, request));

        return { registrationId: `event-${calls.length}` };
      },
      sink: (request) => {
        record('events.sink', toJson(SinkRequestSchema, request));

        return { registrationId: `sink-${calls.length}` };
      },
      unregister: () => ({}),
      unsink: () => ({}),
    }),
    partial(HooksService, {
      define: (request) => {
        record('hooks.define', { contract: request.contract });

        return { registrationId: `definition-${calls.length}` };
      },
      register: (request) => {
        record('hooks.register', {
          contract: request.contract,
          hook: request.hook,
        });

        return { registrationId: `hook-${calls.length}` };
      },
      unregister: () => ({}),
      run: (request) => {
        record('hooks.run', { contract: request.contract, hook: request.hook });
        assert.ok(request.input !== undefined);
        runs.push({
          contract: request.contract,
          hook: request.hook,
          input: request.input,
        });
        if (options.runError !== undefined) throw options.runError;

        return {};
      },
    }),
    partial(SecretsService, {
      resolve: (request) => {
        const id = request.credentialRef?.id ?? '';
        record('secrets.resolve', { id });
        const secret = options.secrets?.[id];
        if (secret === undefined)
          throw new ContractError(
            'credential_missing',
            `Credential ${id} is not stored.`,
          );

        return { secret };
      },
      resolveByKind: (request) => {
        record('secrets.resolveByKind', {
          kind: request.kind,
          exclude: [...request.exclude],
        });
        const secret = options.byKind?.(request.kind, request.exclude);

        return secret === undefined ? {} : { secret };
      },
      redactions: () => {
        record('secrets.redactions', {});

        return { redactions: [...(options.redactions ?? [])] };
      },
    }),
    partial(ModelsService, {
      kind: (request) => {
        record('models.kind', { id: request.id });
        const descriptor = kinds[request.id];

        return descriptor === undefined
          ? {}
          : { modelKindDescriptor: descriptor as never };
      },
      models: (request) => {
        record('models.models', { providerId: request.providerId });

        return {
          models: (options.models?.[request.providerId] ?? []) as never,
        };
      },
    }),
    partial(HostConfigService, {
      current: () => {
        record('hostConfig.current', {});

        return {
          doricConfiguration: fromJson(
            DoricConfigurationSchema,
            asJson(configuration()),
          ),
        };
      },
    }),
    partial(StartupService, {
      stage: (request) => {
        record('startup.stage', toJson(StageRequestSchema, request));

        return {};
      },
      log: (request) => {
        record('startup.log', toJson(LogRequestSchema, request));

        return {};
      },
    }),
    partial(GenerationService, {
      describe: () => {
        record('generation.describe', {});

        return { generation: 1, incarnation: 1, state: 'active' };
      },
      hold: (request) => {
        const holdId = `hold-${calls.length}`;
        record('generation.hold', {
          key: request.key,
          ...(request.label === undefined ? {} : { label: request.label }),
          holdId,
        });

        return { holdId };
      },
      release: (request) => {
        record('generation.release', { holdId: request.holdId });

        return {};
      },
      signal: (request) => {
        record('generation.signal', {
          topic: request.topic,
          payload:
            request.payload === undefined
              ? null
              : toJson(ValueSchema, request.payload),
        });

        return {};
      },
    }),
  ];

  return { calls, runs, fakes, sandbox, executor };
};

/**
 * runtime's host part in a test router, its services listed as `main.ts`
 * will list them, with recording fakes for its dependencies.
 */
export const harness = (options: HarnessOptions = {}) => {
  const backend = options.backend ?? memoryBackend();
  const sessionClient = (caller: Caller = executorCaller) =>
    router.client(SessionService, { caller });
  const { calls, runs, fakes, sandbox, executor } = fakesOf(
    options,
    backend,
    () => sessionClient(),
  );
  const router = createTestRouter({
    fakes,
    requires,
    instance: { bundleId: 'runtime' },
  });
  const hooks = createHookHandlers();
  const runtime = createRuntimeServices({
    // Archive sweeps never fire in these cases.
    archiveSchedule: () => () => undefined,
    ...(options.executorCancelGraceMs === undefined
      ? {}
      : { executorCancelGraceMs: options.executorCancelGraceMs }),
  });
  let context: HostContext | undefined;
  /**
   * The `onGone` handlers the bundle registered, captured by wrapping the
   * activated context's `instances` (the test router sends no `InstanceGone`).
   */
  const goneHandlers = new Set<(instance: BundleInstance) => void>();
  /**
   * The registrations the bundle tracked, captured by wrapping the activated
   * context's `registrations` (the test router never replays them).
   */
  const tracked: Tracked[] = [];
  const definition = {
    services: [
      [RuntimeService, runtime.implementations.runtime],
      [AttachmentsService, runtime.implementations.attachments],
      [UsageService, runtime.implementations.usage],
      [ThreadsService, runtime.implementations.threads],
      [LeaseService, runtime.implementations.lease],
      [WorkspaceService, runtime.implementations.workspace],
      [SessionService, runtime.implementations.session],
      [HookHandlerService, hooks.implementation],
    ] as ServiceEntry[],
    activate: (activated: HostContext) => {
      context = activated;
      const instances: HostContext['instances'] = {
        onGone: (handler) => {
          goneHandlers.add(handler);
          const remove = activated.instances.onGone(handler);

          return () => {
            goneHandlers.delete(handler);
            remove();
          };
        },
      };

      const registrations: HostContext['registrations'] = {
        ...activated.registrations,
        track: (ref, register, trackOptions) => {
          tracked.push({
            ref,
            register: register as Tracked['register'],
            options: trackOptions as Tracked['options'],
          });

          return activated.registrations.track(ref, register, trackOptions);
        },
      };

      return runtime.activate(
        { ...activated, instances, registrations },
        hooks,
      );
    },
    deactivate: () => runtime.deactivate(),
  };
  /** Stores over the same data, as another process writes it. */
  const seed = stores(backend.second());

  return {
    calls,
    runs,
    backend,
    seed,
    sandbox: sandbox.record,
    /** The fake `sandbox/v1` provider: its leases and the operations it ran. */
    sandboxProvider: sandbox,
    /** The fake `executor/v1` provider: the calls it received and made back. */
    executor,
    /** A client of the bundle's `executor.session/v1`; `default` (generation 1) by default. */
    session: (caller?: Caller) => sessionClient(caller),
    /**
     * Replays every registration the bundle tracked with `ref`, as the SDK
     * does on `ProviderChanged`: calls its `register` again with a client of
     * `ref`, then its `onReplayed` with the answer.
     */
    replay: async (ref: DescService) => {
      assert.ok(context !== undefined, 'replay before activate');
      for (const registration of tracked) {
        if (registration.ref.typeName !== ref.typeName) continue;
        const { onReplayed, ...useOptions } = registration.options ?? {};
        const result = await registration.register(
          context.services.use(registration.ref, useOptions),
        );
        onReplayed?.(result);
      }
    },
    /** The context `activate` received, once it ran. */
    context: () => context,
    /** Activates the definition; resolves once `activate` resolved. */
    start: () =>
      within(router.activate<readonly DescService[]>(definition), 'activate'),
    /** `activate` as is, for a test that expects it to fail or holds it. */
    activate: () => router.activate<readonly DescService[]>(definition),
    runtime: (scope?: CallScope) =>
      router.client(RuntimeService, scope === undefined ? {} : { scope }),
    attachments: (scope?: CallScope) =>
      router.client(AttachmentsService, scope === undefined ? {} : { scope }),
    usage: () => router.client(UsageService),
    lease: (scope?: CallScope, caller?: Caller) =>
      router.client(LeaseService, {
        ...(scope === undefined ? {} : { scope }),
        ...(caller === undefined ? {} : { caller }),
      }),
    threads: (scope?: CallScope, caller?: Caller) =>
      router.client(ThreadsService, {
        ...(scope === undefined ? {} : { scope }),
        ...(caller === undefined ? {} : { caller }),
      }),
    workspace: (scope?: CallScope, caller?: Caller) =>
      router.client(WorkspaceService, {
        ...(scope === undefined ? {} : { scope }),
        ...(caller === undefined ? {} : { caller }),
      }),
    /** The service names the definition serves, as `main.ts` will list them. */
    served: () =>
      definition.services.map(([service]) => (service as DescService).typeName),
    /** Delivers `InstanceGone` for `instance`, as the router would (G9). */
    gone: (instance: BundleInstance) => {
      for (const handler of [...goneHandlers]) handler(instance);
    },
    /** `deactivate` of the routed services, without stopping the router. */
    deactivate: () => runtime.deactivate(),
    /** The control frames the router sends (generation events, signals). */
    control: router.control,
    hookHandler: () => router.client(HookHandlerService, { caller: core }),
    logs: router.logs,
    stop: async () => {
      await router.control.stop();
      if (options.backend === undefined) await backend.close();
    },
  };
};

export type Harness = ReturnType<typeof harness>;

/**
 * The same fakes around a bundle that only activates, for the cases that
 * build `routedPorts` over the activated context themselves.
 */
export const contextHarness = async (
  t: TestContext,
  options: HarnessOptions = {},
) => {
  const backend = options.backend ?? memoryBackend();
  const { calls, fakes, sandbox, executor } = fakesOf(options, backend, () =>
    router.client(SessionService, { caller: executorCaller }),
  );
  const router = createTestRouter({
    fakes,
    requires,
    instance: { bundleId: 'runtime' },
  });
  t.after(async () => {
    await router.control.stop();
    if (options.backend === undefined) await backend.close();
  });
  const context = await within(
    router.activate({
      ...(options.services === undefined
        ? {}
        : { services: [...options.services] }),
      activate: () => undefined,
    }),
    'activate',
  );

  return {
    calls,
    context,
    /** The fake `executor/v1` provider. */
    executor,
    /** The fake `sandbox/v1` provider. */
    sandboxProvider: sandbox,
    control: router.control,
    logs: router.logs,
  };
};

/** A started harness, stopped when the test ends. */
export const started = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<Harness> => {
  const h = harness(options);

  t.after(() => h.stop());
  await h.start();

  return h;
};

/** A Project and one Thread in it, written by another process before the test. */
export const seedThread = async (
  h: Pick<Harness, 'seed'>,
  { threadState }: { readonly threadState?: 'running' } = {},
) => {
  const { project } = await h.seed.projects.create(
    'Seeded',
    snapshot(),
    'blue',
  );
  await h.seed.projects.setState(project.id, 'ready');
  const { thread } = await h.seed.threads.create(
    project.id,
    'Thread',
    testExecution,
  );
  if (threadState === 'running')
    await h.seed.threads.setState(thread.id, 'running', crypto.randomUUID());

  return { project, thread };
};

// ---------------------------------------------------------------------------
// `core`'s hook calls

export const handleEventAppended = (h: Harness, stream: string, type: string) =>
  h.hookHandler().handle({
    contract: 'core.event-hooks/v1',
    hook: 'onEventAppendedHook',
    input: anyPack(
      OnEventAppendedHookInputSchema,
      create(OnEventAppendedHookInputSchema, { stream, type }),
    ),
  });

export const handleHostStart = (h: Harness) =>
  h.hookHandler().handle({
    contract: 'doric.app.hooks/v1',
    hook: 'onHostStartHook',
    input: anyPack(
      OnHostStartHookInputSchema,
      create(OnHostStartHookInputSchema),
    ),
  });

export const handleHostStop = (h: Harness) =>
  h.hookHandler().handle({
    contract: 'doric.app.hooks/v1',
    hook: 'onHostStopHook',
    input: anyPack(
      OnHostStopHookInputSchema,
      create(OnHostStopHookInputSchema),
    ),
  });

/** The calls of `method`, in order. */
export const callsOf = (h: Pick<Harness, 'calls'>, method: string) =>
  h.calls
    .filter((call) => call.method === method)
    .map(({ request }) => request);

/** Waits until a Project reads `state` through `runtime/v2.Project`. */
export const projectState = (h: Harness, id: string, state: string) =>
  eventually(
    async () => (await h.runtime().project({ id })).project?.state === state,
    `Project ${id} ${state}`,
  );
