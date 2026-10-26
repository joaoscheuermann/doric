import {
  type CatalogResult,
  defineMethod,
  defineService,
  type ModelField,
  type ModelKindDescriptor,
  ModelsProviderV1,
  modelsProviderMethods,
  toLanguageModel,
} from 'bundle/contracts';
import {
  createFetchTransport,
  type HttpTransport,
  type LlmProvider,
  type SecretSource,
} from 'llms';
import type { Logger } from 'pino';

/** The values one provider carries: a literal per field, or a source for its secret. */
export type KindValues = Readonly<Record<string, SecretSource>>;

/** What a kind's factory needs besides its values. */
export interface KindDeps {
  readonly transport: HttpTransport;
  readonly logger: Logger;
  /** The provider's own id, which a compatible factory reports as its identity. */
  readonly identity: { readonly id: string; readonly name: string };
}

/** One provider kind: its descriptor, its traits and how it is built and listed. */
export interface KindDefinition {
  readonly kind: ModelKindDescriptor;
  /** Whether `models/v1.kinds()` lists it (GET /providers/kinds). */
  readonly advertised: boolean;
  /** Whether the built provider's `models()` reports context capacity. */
  readonly catalogCapacity: boolean;
  readonly build: (values: KindValues, deps: KindDeps) => LlmProvider;
  /** The live catalog read; a kind without one answers `absent`. */
  readonly catalog?: (
    input: {
      readonly configuration: Readonly<Record<string, string>>;
      readonly secret?: string;
    },
    deps: { readonly transport: HttpTransport; readonly logger: Logger },
  ) => Promise<CatalogResult>;
}

/** A provider built for a kind answers the kind and the fields it was built from. */
export type ConfiguredProvider = LlmProvider & {
  readonly kind: string;
  readonly configuration: readonly ModelField[];
};

export interface KindProviderOptions {
  readonly logger: () => Logger;
  readonly transport?: () => HttpTransport;
}

/** A declared value the factory can use: a source, or a literal with something in it. */
const hasValue = (value: SecretSource | undefined): boolean =>
  typeof value === 'function' || (value ?? '').trim() !== '';

/** A required field a provider omits or blanks cannot build its kind. */
const requireValues = (kind: ModelKindDescriptor, values: KindValues): void => {
  for (const field of kind.fields)
    if (field.required && !hasValue(values[field.key]))
      throw new Error(
        `Provider kind ${kind.id} requires a ${field.key} value.`,
      );
};

/**
 * Builds a configured provider exactly as the llms kind catalog did: the
 * required fields first, then the kind's factory, answering its kind and fields.
 */
export const buildConfigured = (
  definition: KindDefinition,
  values: KindValues,
  deps: KindDeps,
): ConfiguredProvider => {
  requireValues(definition.kind, values);

  return {
    ...definition.build(values, deps),
    kind: definition.kind.id,
    configuration: definition.kind.fields,
  };
};

/**
 * The kind as a `models.provider/v1` record. `create` builds the provider with
 * the kind's values; the secret field reads the `secret` callback, which llms
 * awaits before every request, so a rotated credential reaches the next
 * request of a provider built before the rotation.
 */
export const createKindProvider = (
  definition: KindDefinition,
  options: KindProviderOptions,
) => {
  const { kind } = definition;
  const transport = () => options.transport?.() ?? createFetchTransport();
  const secretField = kind.fields.find((field) => field.kind === 'secret');

  // By id: the llms kind and catalog shapes are readonly, which the typed
  // overload's mutable zod outputs refuse.
  return defineService(
    ModelsProviderV1.id,
    {
      kind: defineMethod({
        ...modelsProviderMethods.kind,
        execute: () => Promise.resolve(kind),
      }),
      advertised: defineMethod({
        ...modelsProviderMethods.advertised,
        execute: () => Promise.resolve(definition.advertised),
      }),
      catalog: defineMethod({
        ...modelsProviderMethods.catalog,
        execute: (input) =>
          definition.catalog === undefined
            ? Promise.resolve({ status: 'absent' as const })
            : definition.catalog(input, {
                transport: transport(),
                logger: options.logger(),
              }),
      }),
      create: defineMethod({
        ...modelsProviderMethods.create,
        execute: ({ providerId, values, secret }) => {
          const sources: Record<string, SecretSource> = { ...values };

          if (secret !== undefined && secretField !== undefined) {
            sources[secretField.key] = secret;
          }

          return toLanguageModel(
            buildConfigured(definition, sources, {
              transport: transport(),
              logger: options.logger(),
              identity: { id: providerId, name: providerId },
            }),
          );
        },
      }),
      catalogCapacity: defineMethod({
        ...modelsProviderMethods.catalogCapacity,
        execute: () => Promise.resolve(definition.catalogCapacity),
      }),
    },
    { cardinality: 'many' },
  );
};

/**
 * A value a kind does not call `secret` is the literal string it reads as: a
 * source belongs to the fields whose value is a credential.
 */
export const literalValue = (
  key: string,
  value: SecretSource | undefined,
): string | undefined => {
  if (typeof value === 'function')
    throw new Error(`Provider value ${key} is a literal, not a source.`);

  return value;
};

/** A dependency the factory defaults is passed only when a value names one. */
export const baseUrl = (values: KindValues): { readonly baseUrl?: string } => {
  const endpoint = literalValue('endpoint', values.endpoint);

  return endpoint === undefined ? {} : { baseUrl: endpoint };
};

/**
 * A base URL field. Absent means the factory's own endpoint, so the default
 * travels as the placeholder a settings surface shows.
 */
export const endpointField = (defaultBaseUrl: string): ModelField => ({
  key: 'endpoint',
  label: 'Endpoint',
  kind: 'url',
  required: false,
  advanced: true,
  description: 'Overrides the base URL requests are sent to.',
  placeholder: defaultBaseUrl,
});

/**
 * The stored credential a kind authenticates with: the id of a stored
 * `API_TOKEN` credential, which the host resolves.
 */
export const tokenField = (options: {
  readonly required: boolean;
  readonly description: string;
}): ModelField => ({
  key: 'token',
  label: 'Token',
  kind: 'secret',
  required: options.required,
  description: options.description,
});
