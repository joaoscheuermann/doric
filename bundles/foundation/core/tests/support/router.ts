// `core`'s data services on one `createTestRouter`, over the memory backends
// of `storage` (spec `docs/designs/grpc-processes.md`, "Files, phase 3": the
// host code is tested with `createTestRouter` until S62).

import { readFile } from 'node:fs/promises';

import {
  create,
  createFileRegistry,
  type DescService,
  type MessageInitShape,
  type Registry,
  setExtension,
} from '@bufbuild/protobuf';
import {
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FieldOptionsSchema,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  MessageOptionsSchema,
  OneofDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import { createTestServices } from 'bundle';
import {
  type CallScope,
  ContractError,
  callOf,
  type SecretsBackend,
  SecretsBackendV1,
  StorageBackendV1,
  toConnectError,
} from 'bundle/contracts';
import {
  DoubleRulesSchema,
  FieldRulesSchema,
  field as validateField,
  file_buf_validate_validate,
  StringRulesSchema,
} from 'bundle/contracts/gen/buf/validate/validate_pb.js';
import { HookHandlerService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ProviderService } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  DiagnosticsService,
  type ReportRequest,
} from 'bundle/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import {
  LogService as PlatformLogService,
  type WriteRequest as PlatformWriteRequest,
} from 'bundle/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  EventOptionSchema,
  event as eventOption,
  file_doric_platform_v1_options,
  HookKind,
  HookOptionSchema,
  HookOrder,
  HooksOptionSchema,
  hook as hookOption,
  hooks as hooksOption,
  SettingsOptionSchema,
  settings as settingsOption,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { ReferenceSourceService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  ajvValidators,
  type BundleInstance,
  type UseOptions,
} from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  createMemoryStore,
  type MemorySecretsOptions,
  type MemoryStorageOptions,
  type MemoryStore,
  memorySecretsBackend,
  memoryStorageBackend,
} from 'storage/memory';
import {
  type StorageClient,
  serveSecretsBackend,
  serveStorageBackend,
  storageClient,
} from 'storage/rpc';

import {
  type CoreServicesOptions,
  createCoreServices,
} from '../../src/host/services.js';

/** `core`'s instance on the test router. */
export const CORE_INSTANCE: BundleInstance = {
  bundleId: 'core',
  generation: 1,
  incarnation: 1,
};

/** The generation the catalog fake answers as active. */
export const ACTIVE_GENERATION = 1;

/** The handler services one fake registering instance serves. */
export interface InstanceHandlers {
  readonly tools?: Partial<ServiceImpl<typeof ToolHandlerService>>;
  readonly hooks?: Partial<ServiceImpl<typeof HookHandlerService>>;
}

/** One handler call core made through a `target`ed client. */
export interface HandlerCall {
  readonly target: string;
  readonly method: string;
  readonly request: unknown;
}

/** A fake provider bundle's `models.provider/v1`; a method left out is `unimplemented`. */
export type ModelProviderFake = Partial<ServiceImpl<typeof ProviderService>>;

/** One `models.provider/v1` call core made, as the fake received it. */
export interface ProviderCall {
  /** The bundle named by `UseOptions.provider`. */
  readonly provider: string;
  /** The method's local name (`kind`, `complete`, `validateModel`, …). */
  readonly method: string;
  /**
   * The request, or, for `Complete` and `Stream`, every item the fake has
   * received so far (the array grows while the call runs).
   */
  readonly request: unknown;
}

/** `core`'s data services on one `createTestRouter`, over the memory backends. */
export interface RoutedCore {
  readonly router: TestRouter;
  /** The memory store the storage backend writes (reuse it for a restart). */
  readonly store: MemoryStore;
  /**
   * `storageClient(router.client(StorageService, { caller }))` for
   * `bundleId` (generation 1 unless given; `doric` is the platform, give it
   * generation 0).
   */
  storage(bundleId: string, generation?: number): StorageClient;
  /** A raw client of `ref` as `bundleId`, with an optional call scope. */
  client<S extends DescService>(
    ref: S,
    bundleId: string,
    options?: { readonly generation?: number; readonly scope?: CallScope },
  ): Client<S>;
  /** The storage-backend calls core made, in order (method names). */
  readonly backendCalls: readonly string[];
  /**
   * The credential ids the `ReferenceSourceService` fake answers, by source
   * name (none for a source not in the map). The test router ignores
   * `target`, so every registrant's source is answered from here.
   */
  readonly references: Map<string, string[]>;
  /**
   * Source names whose `ReferenceSourceService.List` fails with
   * `ContractError('unavailable')`, as an unreachable instance would.
   */
  readonly failingSources: Set<string>;
  /** The `ReferenceSourceService.List` requests core made (source names). */
  readonly referenceCalls: readonly string[];
  /**
   * The memory secrets backend behind the `secrets.backend/v1` fake, read
   * directly (fakes are not reachable through a router client).
   */
  readonly secretsBackend: SecretsBackend;
  /**
   * The handler services of the fake registering instances, by target
   * `<bundleId>/<generation>/<incarnation>` (incarnation 1 for a caller of
   * `client`). `serveCore` wraps `context.services.use`: a `use` of
   * `ToolHandlerService` or `HookHandlerService` with a `target` answers an
   * in-memory client of this map's entry (`createRouterTransport`). A target
   * with no entry, or no implementation for the method, fails with
   * `ContractError('unavailable')`, as a gone instance would.
   */
  readonly handlers: Map<string, InstanceHandlers>;
  /** Every handler call core made, in order: `{ target, method, request }`. */
  readonly handlerCalls: readonly HandlerCall[];
  /** The `doric.log/v1.Write` requests core made (fake), in order. */
  readonly platformLogs: readonly PlatformWriteRequest[];
  /**
   * The trace id of the call each `doric.log/v1.Write` arrived on, in the
   * order of `platformLogs` (the second field of its `traceparent`).
   */
  readonly platformLogTraceIds: readonly string[];
  /** When set, the `doric.log/v1.Write` fake throws it. */
  failLog: ContractError | undefined;
  /** The `doric.diagnostics/v1.Report` requests core made (fake), in order. */
  readonly reports: readonly ReportRequest[];
  /**
   * The provider bundles of `models.provider/v1`, live: the catalog fake
   * answers the entries present at each `Get` (a caller generation core has
   * not seen yet reads a fresh snapshot), and a call reaches the entry
   * present when it starts. Starts as `ServeCoreOptions.modelProviders`.
   */
  readonly modelProviders: Map<string, ModelProviderFake>;
  /** Every `models.provider/v1` call, in the order the calls started. */
  readonly providerCalls: readonly ProviderCall[];
  /**
   * Delivers `InstanceGone` of `instance` to the handlers `core` gave
   * `context.instances.onGone`, as the router would (the test router sends
   * none). Incarnation 1 unless given.
   */
  instanceGone(instance: {
    readonly bundleId: string;
    readonly generation: number;
    readonly incarnation?: number;
  }): void;
  /** Stops the router and disposes the memory backends. */
  close(): Promise<void>;
}

export interface ServeCoreOptions {
  /** Bundle id → manifest `provides` (`id@version`), besides `core`'s own. */
  readonly bundles?: Readonly<Record<string, readonly string[]>>;
  /** Reused for a restart; a new store by default. */
  readonly store?: MemoryStore;
  /** Limits and health of the memory storage backend. */
  readonly storageOptions?: MemoryStorageOptions;
  readonly secretsOptions?: MemorySecretsOptions;
  readonly now?: () => number;
  /** Default: {@link testMessages}. */
  readonly types?: Registry;
  /** `CoreServicesOptions.hookDeadlineMs`; the default is 10,000. */
  readonly hookDeadlineMs?: CoreServicesOptions['hookDeadlineMs'];
  /**
   * Provider bundle id → its fake `models.provider/v1`. The catalog fake
   * lists them, in this key order, as the host providers of
   * `models.provider/v1` (bundle version '1.2.3'), adds them to `bundles`
   * and `order` after the other bundles, and lists `core` as the provider
   * of `models/v1`. `core`'s `context.services.use(ProviderService,
   * { provider })` answers an in-memory client of the entry, recording each
   * call in `providerCalls`; a provider with no entry fails with
   * `ContractError('unknown_provider')`, a method a fake leaves out with
   * `unimplemented`.
   */
  readonly modelProviders?: Readonly<Record<string, ModelProviderFake>>;
}

const coreManifest = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile('bundles/foundation/core/dist/manifest.json', 'utf8'),
  ) as Record<string, unknown>;

/** Each method of `implementation`, recording its name in `calls` first. */
const recorded = <S extends DescService>(
  implementation: ServiceImpl<S>,
  calls: string[],
): ServiceImpl<S> =>
  Object.fromEntries(
    Object.entries(implementation).map(([name, method]) => [
      name,
      (...args: unknown[]) => {
        calls.push(name);

        return (method as (...rest: unknown[]) => unknown)(...args);
      },
    ]),
  ) as ServiceImpl<S>;

const notServed = (): never => {
  throw new ContractError('unknown_contract', 'Not served by the fake.');
};

/**
 * `createCoreServices({ types, validators: ajvValidators(), now,
 * hookDeadlineMs })` served
 * on a fresh `createTestRouter` (instance {@link CORE_INSTANCE}) with these
 * fakes, then activated:
 * - `[StorageBackendService, serveStorageBackend(memory)]`, every call
 *   recorded in `backendCalls`;
 * - `[SecretsBackendService, serveSecretsBackend(memory)]`;
 * - `[CatalogService, …]`, whose `Get` answers generation
 *   {@link ACTIVE_GENERATION}, the bundles `core` (its built manifest) and
 *   `bundles`, and `core` as the host provider of `events/v1`;
 * - `[ReferenceSourceService, …]`, answering `references` (failing for
 *   `failingSources`);
 * - `[PlatformLogService, …]`, whose `Write` records into `platformLogs`
 *   (throwing `failLog` when set);
 * - `[DiagnosticsService, …]`, whose `Report` records into `reports`.
 *
 * `core`'s `context.services.use` answers a `target`ed `ToolHandlerService`
 * or `HookHandlerService` from `handlers`, recording each call in
 * `handlerCalls`; every other `use` reaches the test router.
 */
export const serveCore = async (
  options: ServeCoreOptions = {},
): Promise<RoutedCore> => {
  const store = options.store ?? createMemoryStore();
  const backendCalls: string[] = [];
  const backends = createTestServices({
    bundle: { id: 'core-backends' },
    provide: [
      memoryStorageBackend(store, options.storageOptions ?? {}),
      memorySecretsBackend(options.secretsOptions ?? {}),
    ],
  });
  const manifest = await coreManifest();
  const modelProviders = new Map(Object.entries(options.modelProviders ?? {}));
  const providerCalls: ProviderCall[] = [];
  const catalog: ServiceImpl<typeof CatalogService> = {
    get: () => {
      const providerIds = [...modelProviders.keys()];
      const bundles = [
        ...Object.entries(options.bundles ?? {}),
        ...providerIds.map((id) => [id, ['models.provider/v1@1.4.0']] as const),
      ];

      return {
        catalogSnapshot: {
          generation: ACTIVE_GENERATION,
          composition: { core: 'core', enabled: [], providers: {} },
          bundles: [
            {
              id: 'core',
              version: String(manifest.version),
              state: 'active',
              manifest: manifest as never,
            },
            ...bundles.map(([id, provides]) => ({
              id,
              version: '1.2.3',
              state: 'active',
              manifest: {
                manifestVersion: 1,
                id,
                version: '1.2.3',
                provides: [...provides],
              },
            })),
          ],
          order: ['core', ...bundles.map(([id]) => id)],
          contracts: [
            {
              id: 'events/v1',
              environment: 'host',
              cardinality: 'one',
              providers: [
                {
                  bundleId: 'core',
                  version: '1.0.0',
                  bundleVersion: String(manifest.version),
                },
              ],
            },
            {
              id: 'models/v1',
              environment: 'host',
              cardinality: 'one',
              providers: [
                {
                  bundleId: 'core',
                  version: '1.5.0',
                  bundleVersion: String(manifest.version),
                },
              ],
            },
            ...(providerIds.length === 0
              ? []
              : [
                  {
                    id: 'models.provider/v1',
                    environment: 'host',
                    cardinality: 'many',
                    providers: providerIds.map((bundleId) => ({
                      bundleId,
                      version: '1.4.0',
                      bundleVersion: '1.2.3',
                    })),
                  },
                ]),
          ],
        },
      };
    },
    distribution: notServed,
    descriptors: notServed,
    readArtifact: notServed,
    watch: notServed,
    disable: notServed,
    resetComposition: notServed,
  };
  const references = new Map<string, string[]>();
  const failingSources = new Set<string>();
  const referenceCalls: string[] = [];
  const referenceSource: ServiceImpl<typeof ReferenceSourceService> = {
    list: ({ source }) => {
      referenceCalls.push(source);

      if (failingSources.has(source)) {
        throw new ContractError(
          'unavailable',
          `The reference source ${source} is unreachable.`,
        );
      }

      return { credentialIds: [...(references.get(source) ?? [])] };
    },
  };
  const handlers = new Map<string, InstanceHandlers>();
  const handlerCalls: HandlerCall[] = [];
  const handlerClient = <S extends DescService>(
    ref: S,
    target: string,
  ): Client<S> => {
    const kind =
      ref.typeName === ToolHandlerService.typeName ? 'tools' : 'hooks';
    const implementation = Object.fromEntries(
      ref.methods.map((method) => [
        method.localName,
        async (request: unknown, context: unknown) => {
          handlerCalls.push({ target, method: method.localName, request });

          const served = handlers.get(target)?.[kind] as
            | Record<string, (request: unknown, context: unknown) => unknown>
            | undefined;
          const handle = served?.[method.localName];

          if (handle === undefined) {
            throw toConnectError(
              new ContractError(
                'unavailable',
                `No instance ${target} serves ${ref.typeName}.${method.name}.`,
              ),
            );
          }

          try {
            return await handle(request, context);
          } catch (error) {
            throw error instanceof ContractError
              ? toConnectError(error)
              : error;
          }
        },
      ]),
    ) as ServiceImpl<S>;

    return createClient(
      ref,
      createRouterTransport((router) => {
        router.service(ref, implementation);
      }),
    );
  };
  /** An in-memory client of the live fake of `provider`, recording calls. */
  const providerClient = (provider: string): Client<typeof ProviderService> => {
    const fakeOf = (method: string) => {
      const fake = modelProviders.get(provider) as
        | Record<string, (...args: unknown[]) => unknown>
        | undefined;

      if (fake === undefined) {
        throw toConnectError(
          new ContractError(
            'unknown_provider',
            `${provider} is not a live provider of models.provider/v1.`,
          ),
        );
      }

      const handle = fake[method];

      if (handle === undefined) {
        throw new ConnectError(
          `The fake ${provider} does not serve ${method}.`,
          Code.Unimplemented,
        );
      }

      return handle;
    };
    const contractError = (error: unknown) =>
      error instanceof ContractError ? toConnectError(error) : error;
    const implementation = Object.fromEntries(
      ProviderService.methods.map((method) => {
        const name = method.localName;

        if (method.methodKind === 'unary') {
          return [
            name,
            async (request: unknown, context: HandlerContext) => {
              providerCalls.push({ provider, method: name, request });

              try {
                return await fakeOf(name)(request, context);
              } catch (error) {
                throw contractError(error);
              }
            },
          ];
        }

        // `Complete` (client streaming) and `Stream` (bidi): the items are
        // recorded as the fake reads them.
        const recordedItems = (
          request: AsyncIterable<unknown>,
        ): AsyncIterable<unknown> => {
          const items: unknown[] = [];

          providerCalls.push({ provider, method: name, request: items });

          return (async function* () {
            for await (const item of request) {
              items.push(item);
              yield item;
            }
          })();
        };

        if (method.methodKind === 'client_streaming') {
          return [
            name,
            async (
              request: AsyncIterable<unknown>,
              context: HandlerContext,
            ) => {
              const items = recordedItems(request);

              try {
                return await fakeOf(name)(items, context);
              } catch (error) {
                throw contractError(error);
              }
            },
          ];
        }

        return [
          name,
          async function* (
            request: AsyncIterable<unknown>,
            context: HandlerContext,
          ) {
            const items = recordedItems(request);

            try {
              yield* fakeOf(name)(items, context) as AsyncIterable<unknown>;
            } catch (error) {
              throw contractError(error);
            }
          },
        ];
      }),
    ) as ServiceImpl<typeof ProviderService>;

    return createClient(
      ProviderService,
      createRouterTransport((router) => {
        router.service(ProviderService, implementation);
      }),
    );
  };
  const platformLogs: PlatformWriteRequest[] = [];
  const platformLogTraceIds: string[] = [];
  const reports: ReportRequest[] = [];
  const sinks = { failLog: undefined as ContractError | undefined };
  const platformLog: ServiceImpl<typeof PlatformLogService> = {
    write: (request, context) => {
      if (sinks.failLog !== undefined) {
        throw sinks.failLog;
      }

      platformLogs.push(request);
      platformLogTraceIds.push(
        callOf(context).trace.traceparent.split('-')[1] ?? '',
      );

      return {};
    },
  };
  const diagnostics: ServiceImpl<typeof DiagnosticsService> = {
    get: notServed,
    report: (request) => {
      reports.push(request);

      return {};
    },
  };
  const core = createCoreServices({
    types: options.types ?? testMessages(),
    validators: ajvValidators(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.hookDeadlineMs === undefined
      ? {}
      : { hookDeadlineMs: options.hookDeadlineMs }),
  });
  const goneHandlers: ((instance: BundleInstance) => void)[] = [];
  const router = createTestRouter({
    instance: CORE_INSTANCE,
    fakes: [
      [
        StorageBackendService,
        recorded(
          serveStorageBackend(backends.services.use(StorageBackendV1)),
          backendCalls,
        ),
      ],
      [
        SecretsBackendService,
        serveSecretsBackend(backends.services.use(SecretsBackendV1)),
      ],
      [CatalogService, catalog],
      [ReferenceSourceService, referenceSource],
      [PlatformLogService, platformLog],
      [DiagnosticsService, diagnostics],
    ],
  });

  await router.activate({
    services: core.services,
    activate: (context) => {
      const use = context.services.use.bind(context.services);

      core.activate({
        ...context,
        services: {
          use: <S extends DescService>(ref: S, useOptions?: UseOptions<S>) =>
            useOptions?.provider !== undefined &&
            ref.typeName === ProviderService.typeName
              ? (providerClient(useOptions.provider) as unknown as Client<S>)
              : useOptions?.target !== undefined &&
                  (ref.typeName === ToolHandlerService.typeName ||
                    ref.typeName === HookHandlerService.typeName)
                ? handlerClient(ref, useOptions.target)
                : use(ref, useOptions),
        },
        instances: {
          onGone: (handler) => {
            goneHandlers.push(handler);

            return context.instances.onGone(handler);
          },
        },
      });
    },
  });

  const callerOf = (bundleId: string, generation: number) => ({
    bundleId,
    version: bundleId === 'doric' ? '1.0.0' : '1.2.3',
    generation,
  });

  return {
    router,
    store,
    backendCalls,
    references,
    failingSources,
    referenceCalls,
    secretsBackend: backends.services.use(SecretsBackendV1),
    handlers,
    handlerCalls,
    platformLogs,
    platformLogTraceIds,
    get failLog() {
      return sinks.failLog;
    },
    set failLog(error: ContractError | undefined) {
      sinks.failLog = error;
    },
    reports,
    modelProviders,
    providerCalls,
    storage: (bundleId, generation = bundleId === 'doric' ? 0 : 1) =>
      storageClient(
        router.client(StorageService, {
          caller: callerOf(bundleId, generation),
        }),
      ),
    client: (ref, bundleId, clientOptions = {}) =>
      router.client(ref, {
        caller: callerOf(
          bundleId,
          clientOptions.generation ?? (bundleId === 'doric' ? 0 : 1),
        ),
        ...(clientOptions.scope === undefined
          ? {}
          : { scope: clientOptions.scope }),
      }),
    instanceGone: ({ bundleId, generation, incarnation = 1 }) => {
      for (const handler of goneHandlers) {
        handler({ bundleId, generation, incarnation });
      }
    },
    close: async () => {
      await router.control.stop();
      await backends.dispose();
    },
  };
};

// --- Test messages ---------------------------------------------------------

const scalar = (
  name: string,
  number: number,
  type: FieldDescriptorProto_Type,
  rules?: MessageInitShape<typeof FieldRulesSchema>,
  oneofIndex?: number,
) => {
  const options = create(FieldOptionsSchema);

  if (rules !== undefined) {
    setExtension(options, validateField, create(FieldRulesSchema, rules));
  }

  return create(FieldDescriptorProtoSchema, {
    name,
    jsonName: name.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    ),
    number,
    type,
    label: FieldDescriptorProto_Label.OPTIONAL,
    ...(oneofIndex === undefined ? {} : { oneofIndex, proto3Optional: true }),
    options,
  });
};

const settingsMessage = (id: string) => {
  const options = create(MessageOptionsSchema);

  setExtension(options, settingsOption, create(SettingsOptionSchema, { id }));

  return options;
};

const eventMessage = (type: string) => {
  const options = create(MessageOptionsSchema);

  setExtension(options, eventOption, create(EventOptionSchema, { type }));

  return options;
};

/**
 * A registry of test messages built in code, since no settings or event
 * message is in `core`'s dependencies (file `notes/test.proto`, package
 * `notes`):
 * - `notes.Prefs`, `(settings).id = "notes.prefs/v1"`: `string theme = 1`,
 *   `optional double size = 2` with `gte: 1` (so the empty message is
 *   valid and `size: 0` is not).
 * - `notes.Strict`, `(settings).id = "notes.strict/v1"`: `string name = 1`
 *   `required`, so the empty message breaks its rules.
 * - `notes.Added`, `(event).type = "notes.added/v1"`: `string note_id = 1`
 *   (`min_len 1`), `string token = 2`.
 * - `notes.Typed`, `(event).type = "notes.typed/v1"`: `string type = 1`.
 * - `notes.XSent`, `(event).type = "x.sent/v1"`: `string text = 1` (the
 *   event of a bundle named `x`, for sinks whose owner is a placeholder).
 *
 * And the hooks contract `notes.hooks/v1` (file `test/notes_hooks.proto`,
 * package `notes.hooks`, `(hooks).id = "notes.hooks/v1"`), one hook per
 * kind, each input `string text = 1`:
 * - `notes.hooks.SeenInput`: `onSeenHook`, observe.
 * - `notes.hooks.ShapeInput`: `onShapeHook`, transform.
 * - `notes.hooks.AllowInput`: `onAllowHook`, decide.
 * - `notes.hooks.StepInput`: `onStepHook`, sequence.
 * - `notes.hooks.UnwindInput`: `onUnwindHook`, sequence,
 *   `HOOK_ORDER_REVERSE`.
 */
export const testMessages = (): Registry => {
  const STRING = FieldDescriptorProto_Type.STRING;
  const proto = create(FileDescriptorProtoSchema, {
    name: 'notes/test.proto',
    package: 'notes',
    syntax: 'proto3',
    dependency: [
      file_doric_platform_v1_options.proto.name,
      file_buf_validate_validate.proto.name,
    ],
    messageType: [
      create(DescriptorProtoSchema, {
        name: 'Prefs',
        field: [
          scalar('theme', 1, STRING),
          scalar(
            'size',
            2,
            FieldDescriptorProto_Type.DOUBLE,
            {
              type: {
                case: 'double',
                value: create(DoubleRulesSchema, {
                  greaterThan: { case: 'gte', value: 1 },
                }),
              },
            },
            0,
          ),
        ],
        oneofDecl: [create(OneofDescriptorProtoSchema, { name: '_size' })],
        options: settingsMessage('notes.prefs/v1'),
      }),
      create(DescriptorProtoSchema, {
        name: 'Strict',
        field: [scalar('name', 1, STRING, { required: true })],
        options: settingsMessage('notes.strict/v1'),
      }),
      create(DescriptorProtoSchema, {
        name: 'Added',
        field: [
          scalar('note_id', 1, STRING, {
            type: {
              case: 'string',
              value: create(StringRulesSchema, { minLen: 1n }),
            },
          }),
          scalar('token', 2, STRING),
        ],
        options: eventMessage('notes.added/v1'),
      }),
      create(DescriptorProtoSchema, {
        name: 'Typed',
        field: [scalar('type', 1, STRING)],
        options: eventMessage('notes.typed/v1'),
      }),
      create(DescriptorProtoSchema, {
        name: 'XSent',
        field: [scalar('text', 1, STRING)],
        options: eventMessage('x.sent/v1'),
      }),
    ],
  });

  const resolve = (name: string) =>
    name === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : name === file_buf_validate_validate.proto.name
        ? file_buf_validate_validate
        : undefined;

  return createFileRegistry(
    createFileRegistry(proto, resolve),
    createFileRegistry(notesHooksFile(), resolve),
  );
};

const hookMessage = (
  name: string,
  hook: string,
  kind: HookKind,
  order: HookOrder = HookOrder.UNSPECIFIED,
) => {
  const options = create(MessageOptionsSchema);

  setExtension(
    options,
    hookOption,
    create(HookOptionSchema, { name: hook, kind, order }),
  );

  return create(DescriptorProtoSchema, {
    name,
    field: [scalar('text', 1, FieldDescriptorProto_Type.STRING)],
    options,
  });
};

/** The `notes.hooks/v1` hooks file of {@link testMessages}. */
const notesHooksFile = () => {
  const options = create(FileOptionsSchema);

  setExtension(
    options,
    hooksOption,
    create(HooksOptionSchema, { id: 'notes.hooks/v1' }),
  );

  return create(FileDescriptorProtoSchema, {
    name: 'test/notes_hooks.proto',
    package: 'notes.hooks',
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    options,
    messageType: [
      hookMessage('SeenInput', 'onSeenHook', HookKind.OBSERVE),
      hookMessage('ShapeInput', 'onShapeHook', HookKind.TRANSFORM),
      hookMessage('AllowInput', 'onAllowHook', HookKind.DECIDE),
      hookMessage('StepInput', 'onStepHook', HookKind.SEQUENCE),
      hookMessage(
        'UnwindInput',
        'onUnwindHook',
        HookKind.SEQUENCE,
        HookOrder.REVERSE,
      ),
    ],
  });
};
