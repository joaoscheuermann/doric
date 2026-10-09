import { z } from 'zod';

import type { Call } from './call.js';
import type { Services } from './context.js';
import {
  type ContractId,
  contractIdPattern,
  isPlatformContract,
} from './ids.js';
import { bindRegistrant, type Registrable } from './registrable.js';
import type {
  AnyServiceRef,
  ApiFrom,
  ImplementationOf,
  ImplFrom,
  RefId,
  ServiceRef,
} from './types.js';

/** Brand on every definition object; the value is the definition kind. */
export const definitionBrand: unique symbol = Symbol.for('doric.definition');

export type DefinitionKind =
  | 'hook'
  | 'hooks'
  | 'method'
  | 'service'
  | 'event'
  | 'command'
  | 'settings'
  | 'storage-type'
  | 'ref';

const brandOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? (value as { [definitionBrand]?: unknown })[definitionBrand]
    : undefined;

const brand = <T extends object>(kind: DefinitionKind, value: T): T => {
  Object.defineProperty(value, definitionBrand, { value: kind });

  return Object.freeze(value);
};

const assertContractId = (id: unknown, what: string): void => {
  if (typeof id !== 'string' || !contractIdPattern.test(id)) {
    throw new TypeError(`Invalid ${what} contract ID "${String(id)}".`);
  }
};

const assertBundleContractId = (id: unknown, what: string): void => {
  assertContractId(id, what);

  if (isPlatformContract(id as string)) {
    throw new TypeError(
      `The ${what} contract ID "${String(id)}" is reserved for the platform.`,
    );
  }
};

// Hooks ---------------------------------------------------------------------

export type HookKind = 'observe' | 'transform' | 'decide';

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export const decisionSchema: z.ZodType<Decision> = z.union([
  z.object({ allow: z.literal(true) }).strict(),
  z.object({ allow: z.literal(false), reason: z.string() }).strict(),
]);

export interface HookDefinition<
  K extends HookKind = HookKind,
  I extends z.ZodType = z.ZodType,
> {
  readonly kind: K;
  readonly input: I;
}

export const defineHook = <
  K extends HookKind,
  I extends z.ZodType,
>(definition: {
  readonly kind: K;
  readonly input: I;
}): HookDefinition<K, I> => {
  if (!['observe', 'transform', 'decide'].includes(definition.kind)) {
    throw new TypeError(`Invalid hook kind "${String(definition.kind)}".`);
  }

  return brand('hook', { kind: definition.kind, input: definition.input });
};

export interface HooksContract<
  Id extends ContractId = ContractId,
  H extends Record<string, HookDefinition> = Record<string, HookDefinition>,
> {
  readonly type: 'hooks';
  readonly id: Id;
  readonly hooks: H;
}

const hooksContract = <
  Id extends ContractId,
  H extends Record<string, HookDefinition>,
>(
  id: Id,
  hooks: H,
): HooksContract<Id, H> => {
  for (const [name, hook] of Object.entries(hooks)) {
    if (brandOf(hook) !== 'hook') {
      throw new TypeError(
        `Hook "${name}" of "${id}" must be created with defineHook.`,
      );
    }
  }

  return brand('hooks', {
    type: 'hooks' as const,
    id,
    hooks: Object.freeze({ ...hooks }),
  });
};

/** Groups hooks under a versioned contract ID owned by the declaring bundle. */
export const defineHooks = <
  const Id extends ContractId,
  H extends Record<string, HookDefinition>,
>(
  id: Id,
  hooks: H,
): HooksContract<Id, H> => {
  assertBundleContractId(id, 'hooks');

  return hooksContract(id, hooks);
};

/** Internal variant for `doric.*` hooks contracts; not exported to bundles. */
export const definePlatformHooks = <
  const Id extends ContractId,
  H extends Record<string, HookDefinition>,
>(
  id: Id,
  hooks: H,
): HooksContract<Id, H> => {
  assertContractId(id, 'hooks');

  if (!isPlatformContract(id)) {
    throw new TypeError(`"${id}" is not a platform contract ID.`);
  }

  return hooksContract(id, hooks);
};

export const isHooksContract = (value: unknown): value is HooksContract =>
  brandOf(value) === 'hooks';

// Services ------------------------------------------------------------------

/**
 * One method of a service. Output schemas must be descriptive (no default,
 * transform or pipe): the runtime validates the result and forwards the
 * original value, never the parsed copy.
 */
export interface MethodDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  R = unknown,
> {
  readonly input: I;
  readonly output: O;
  execute(input: z.output<I>, call: Call, services: Services): R;
}

export type AnyMethodDefinition = MethodDefinition<z.ZodType, z.ZodType>;

/** Accepts readonly variants of a schema type (contract interfaces are readonly). */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export const defineMethod = <
  I extends z.ZodType,
  O extends z.ZodType,
  R extends DeepReadonly<z.input<O>> | Promise<DeepReadonly<z.input<O>>>,
>(method: {
  readonly input: I;
  readonly output: O;
  readonly execute: (input: z.output<I>, call: Call, services: Services) => R;
}): MethodDefinition<I, O, R> => {
  if (typeof method.execute !== 'function') {
    throw new TypeError('A method needs an execute function.');
  }

  const execute = method.execute;

  return brand('method', {
    input: method.input,
    output: method.output,
    execute: (input: z.output<I>, call: Call, services: Services): R =>
      execute(input, call, services),
  });
};

export type Cardinality = 'one' | 'many';

export interface ServiceDefinition<
  Id extends ContractId = ContractId,
  M extends Record<string, AnyMethodDefinition> = Record<
    string,
    AnyMethodDefinition
  >,
> {
  readonly type: 'service';
  readonly id: Id;
  readonly cardinality: Cardinality;
  readonly methods: M;
}

export type AnyServiceDefinition = ServiceDefinition<
  ContractId,
  Record<string, AnyMethodDefinition>
>;

export interface ServiceOptions {
  readonly cardinality: 'many';
}

const serviceDefinition = <
  Id extends ContractId,
  M extends Record<string, AnyMethodDefinition>,
>(
  id: Id,
  methods: M,
  options: ServiceOptions | undefined,
): ServiceDefinition<Id, M> => {
  for (const [name, method] of Object.entries(methods)) {
    if (brandOf(method) !== 'method') {
      throw new TypeError(
        `Method "${name}" of "${id}" must be created with defineMethod.`,
      );
    }
  }

  if (options !== undefined && options.cardinality !== 'many') {
    throw new TypeError('The only service option is { cardinality: "many" }.');
  }

  return brand('service', {
    type: 'service' as const,
    id,
    cardinality: options?.cardinality ?? 'one',
    methods: Object.freeze({ ...methods }),
  });
};

const idOf = (idOrRef: unknown): ContractId =>
  (typeof idOrRef === 'string'
    ? idOrRef
    : (idOrRef as { id?: unknown } | null)?.id) as ContractId;

/** Defines a service by contract ID, or by ref so methods are checked against it. */
export function defineService<
  const Id extends ContractId,
  M extends Record<string, AnyMethodDefinition>,
>(id: Id, methods: M, options?: ServiceOptions): ServiceDefinition<Id, M>;
export function defineService<
  R extends AnyServiceRef,
  M extends ImplementationOf<R> & Record<string, AnyMethodDefinition>,
>(
  contract: R,
  methods: M,
  options?: ServiceOptions,
): ServiceDefinition<RefId<R>, M>;
export function defineService(
  idOrRef: ContractId | AnyServiceRef,
  methods: Record<string, AnyMethodDefinition>,
  options?: ServiceOptions,
): AnyServiceDefinition {
  const id = idOf(idOrRef);

  assertBundleContractId(id, 'service');

  return serviceDefinition(id, methods, options);
}

/** Internal variant for `doric.*` services provided by the platform. */
export const definePlatformService = <
  M extends Record<string, AnyMethodDefinition>,
>(
  idOrRef: ContractId | AnyServiceRef,
  methods: M,
): ServiceDefinition<ContractId, M> => {
  const id = idOf(idOrRef);

  assertContractId(id, 'service');

  if (!isPlatformContract(id)) {
    throw new TypeError(`"${id}" is not a platform contract ID.`);
  }

  return serviceDefinition(id, methods, undefined);
};

export const isServiceDefinition = (
  value: unknown,
): value is AnyServiceDefinition => brandOf(value) === 'service';

// Events, commands, settings, storage types --------------------------------

export interface EventDefinition<
  T extends ContractId = ContractId,
  P extends z.ZodObject = z.ZodObject,
> {
  readonly kind: 'event';
  readonly type: T;
  readonly payload: P;
}

export const defineEvent = <
  const T extends ContractId,
  P extends z.ZodObject,
>(definition: {
  readonly type: T;
  readonly payload: P;
}): EventDefinition<T, P> => {
  assertBundleContractId(definition.type, 'event');

  return brand('event', {
    kind: 'event' as const,
    type: definition.type,
    payload: definition.payload,
  });
};

export interface BoundCommand<
  Id extends ContractId = ContractId,
  I extends z.ZodType = z.ZodType,
> {
  readonly id: Id;
  readonly input: I;
  execute(input: z.output<I>, call: Call): Promise<void>;
}

export interface CommandDefinition<
  Id extends ContractId = ContractId,
  I extends z.ZodType = z.ZodType,
> extends Registrable<BoundCommand<Id, I>> {
  readonly kind: 'command';
  readonly id: Id;
  readonly input: I;
  execute(
    input: z.output<I>,
    call: Call,
    services: Services,
  ): void | Promise<void>;
}

export const defineCommand = <
  const Id extends ContractId,
  I extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly input: I;
  readonly execute: (
    input: z.output<I>,
    call: Call,
    services: Services,
  ) => void | Promise<void>;
}): CommandDefinition<Id, I> => {
  assertBundleContractId(definition.id, 'command');

  const run = definition.execute;

  return brand('command', {
    kind: 'command' as const,
    id: definition.id,
    input: definition.input,
    execute: (input: z.output<I>, call: Call, services: Services) =>
      run(input, call, services),
    [bindRegistrant]: (services: Services): BoundCommand<Id, I> =>
      Object.freeze({
        id: definition.id,
        input: definition.input,
        execute: async (input: z.output<I>, call: Call): Promise<void> => {
          await run(input, call, services);
        },
      }),
  });
};

export interface SettingsDefinition<
  Id extends ContractId = ContractId,
  S extends z.ZodType = z.ZodType,
> {
  readonly kind: 'settings';
  readonly id: Id;
  readonly schema: S;
}

export const defineSettings = <
  const Id extends ContractId,
  S extends z.ZodType,
>(definition: {
  readonly id: Id;
  readonly schema: S;
}): SettingsDefinition<Id, S> => {
  assertBundleContractId(definition.id, 'settings');

  return brand('settings', {
    kind: 'settings' as const,
    id: definition.id,
    schema: definition.schema,
  });
};

export interface StorageIndex {
  readonly name: string;
  readonly fields: readonly string[];
  readonly unique?: boolean;
}

export interface StorageTypeDefinition<
  T extends ContractId = ContractId,
  S extends z.ZodObject = z.ZodObject,
> {
  readonly kind: 'storage-type';
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[];
}

export const defineStorageType = <
  const T extends ContractId,
  S extends z.ZodObject,
>(definition: {
  readonly type: T;
  readonly schema: S;
  readonly indexes: readonly StorageIndex[];
}): StorageTypeDefinition<T, S> => {
  assertBundleContractId(definition.type, 'storage type');

  return brand('storage-type', {
    kind: 'storage-type' as const,
    type: definition.type,
    schema: definition.schema,
    indexes: Object.freeze(
      definition.indexes.map((index) =>
        Object.freeze({ ...index, fields: Object.freeze([...index.fields]) }),
      ),
    ),
  });
};

export const definitionKindOf = (
  value: unknown,
): DefinitionKind | undefined => {
  const kind = brandOf(value);

  return typeof kind === 'string' ? (kind as DefinitionKind) : undefined;
};

// Refs ----------------------------------------------------------------------

/** A typed reference to a contract; the runtime value holds only the ID. */
export const ref = <T, Impl = ImplFrom<T>>(
  id: ContractId,
): ServiceRef<ApiFrom<T>, Impl> => {
  assertContractId(id, 'ref');

  return brand('ref', { kind: 'ref' as const, id });
};

export const isServiceRef = (value: unknown): value is AnyServiceRef =>
  typeof value === 'object' &&
  value !== null &&
  (value as { kind?: unknown }).kind === 'ref' &&
  typeof (value as { id?: unknown }).id === 'string';
