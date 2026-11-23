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
  MessageOptionsSchema,
  OneofDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { createTestServices } from 'bundle';
import {
  type CallScope,
  ContractError,
  type SecretsBackend,
  SecretsBackendV1,
  StorageBackendV1,
} from 'bundle/contracts';
import {
  DoubleRulesSchema,
  FieldRulesSchema,
  field as validateField,
  file_buf_validate_validate,
  StringRulesSchema,
} from 'bundle/contracts/gen/buf/validate/validate_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  EventOptionSchema,
  event as eventOption,
  file_doric_platform_v1_options,
  SettingsOptionSchema,
  settings as settingsOption,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { ReferenceSourceService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { ajvValidators, type BundleInstance } from 'bundle/host';
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
  readonly onEventAppended?: CoreServicesOptions['onEventAppended'];
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
 * onEventAppended })` served
 * on a fresh `createTestRouter` (instance {@link CORE_INSTANCE}) with these
 * fakes, then activated:
 * - `[StorageBackendService, serveStorageBackend(memory)]`, every call
 *   recorded in `backendCalls`;
 * - `[SecretsBackendService, serveSecretsBackend(memory)]`;
 * - `[CatalogService, …]`, whose `Get` answers generation
 *   {@link ACTIVE_GENERATION}, the bundles `core` (its built manifest) and
 *   `bundles`, and `core` as the host provider of `events/v1`;
 * - `[ReferenceSourceService, …]`, answering `references` (failing for
 *   `failingSources`).
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
  const bundles = Object.entries(options.bundles ?? {});
  const catalog: ServiceImpl<typeof CatalogService> = {
    get: () => ({
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
        ],
      },
    }),
    distribution: notServed,
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
  const core = createCoreServices({
    types: options.types ?? testMessages(),
    validators: ajvValidators(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onEventAppended === undefined
      ? {}
      : { onEventAppended: options.onEventAppended }),
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
    ],
  });

  await router.activate({
    services: core.services,
    activate: (context) => {
      core.activate({
        ...context,
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

  return createFileRegistry(proto, (name) =>
    name === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : name === file_buf_validate_validate.proto.name
        ? file_buf_validate_validate
        : undefined,
  );
};
