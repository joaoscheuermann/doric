import type { EmbeddedBundle } from 'bundle';
import {
  type CatalogResult,
  defineMethod,
  defineService,
  type HostContext,
  type ModelIconChoice,
  type ModelKindDescriptor,
  type ModelsProviderCreateInput,
  ModelsProviderV1,
  modelsProviderMethods,
  toLanguageModel,
} from 'bundle/contracts';

/** What one fake `models.provider/v1` record answers. */
export interface FakeKindOptions {
  readonly kind: ModelKindDescriptor;
  /** Default true. */
  readonly advertised?: boolean;
  /** Default false. */
  readonly catalogCapacity?: boolean;
  /** Default: `{ status: 'absent' }`. */
  readonly catalog?: (input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  }) => Promise<CatalogResult>;
  /**
   * The object `create` wraps with `toLanguageModel`. Default: a model whose
   * `models()` answers `[]`. A throw refuses the configuration.
   */
  readonly create?: (
    input: ModelsProviderCreateInput,
  ) => object | Promise<object>;
  /** Default: `{ models: input.models.map(() => null) }`. */
  readonly icons?: (input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly models: readonly string[];
  }) => ModelIconChoice;
}

/** Every call the record received, in order. */
export interface FakeKindCalls {
  readonly catalog: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  }[];
  readonly create: ModelsProviderCreateInput[];
}

const CONTRACT_VERSION = '1.3.0';

/**
 * An embedded bundle `bundleId` that provides one `models.provider/v1@1.3.0`
 * record (host, `many`) answering `options`, with the calls it received.
 */
export const fakeKind = (
  bundleId: string,
  options: FakeKindOptions,
): { readonly bundle: EmbeddedBundle; readonly calls: FakeKindCalls } => {
  const calls: FakeKindCalls = { catalog: [], create: [] };
  const create = options.create ?? (() => ({ models: async () => [] }));
  const record = defineService(
    ModelsProviderV1.id,
    {
      kind: defineMethod({
        ...modelsProviderMethods.kind,
        execute: () => Promise.resolve(options.kind),
      }),
      advertised: defineMethod({
        ...modelsProviderMethods.advertised,
        execute: () => Promise.resolve(options.advertised ?? true),
      }),
      catalog: defineMethod({
        ...modelsProviderMethods.catalog,
        execute: (input) => {
          calls.catalog.push(input);

          return (
            options.catalog?.(input) ??
            Promise.resolve({ status: 'absent' as const })
          );
        },
      }),
      create: defineMethod({
        ...modelsProviderMethods.create,
        execute: async (input) => {
          calls.create.push(input);

          return toLanguageModel(await create(input));
        },
      }),
      catalogCapacity: defineMethod({
        ...modelsProviderMethods.catalogCapacity,
        execute: () => Promise.resolve(options.catalogCapacity ?? false),
      }),
      icons: defineMethod({
        ...modelsProviderMethods.icons,
        execute: (input) =>
          Promise.resolve(
            options.icons?.(input) ?? {
              models: input.models.map(() => null),
            },
          ),
      }),
    },
    { cardinality: 'many' },
  );

  return {
    calls,
    bundle: {
      manifest: {
        manifestVersion: 1,
        id: bundleId,
        version: '1.0.0',
        engines: { doric: '^1.0.0' },
        provides: [`${ModelsProviderV1.id}@${CONTRACT_VERSION}`],
        requires: [],
      },
      descriptor: {
        descriptorVersion: 1,
        bundle: { id: bundleId, version: '1.0.0' },
        contracts: [
          {
            id: ModelsProviderV1.id,
            version: CONTRACT_VERSION,
            kind: 'service',
            environment: 'host',
            cardinality: 'many',
            local: true,
            schema: `schemas/${ModelsProviderV1.id}.json`,
          },
        ],
      },
      host: {
        activate: ({ services }: HostContext) => {
          services.provide(record);
        },
      },
    },
  };
};
