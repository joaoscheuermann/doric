import { z } from 'zod';

import { isCall } from '../call.js';
import type { Disposable } from '../context.js';
import {
  type CommandDefinition,
  definitionKindOf,
  type EventDefinition,
  type HooksContract,
  isHooksContract,
  type SettingsDefinition,
  type StorageTypeDefinition,
} from '../define.js';
import type { ContractError } from '../error.js';

/** One method of a platform specification: what a provider must accept and return. */
export interface MethodSpec {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

export type MethodSpecs = Readonly<Record<string, MethodSpec>>;

export const isDisposable = (value: unknown): value is Disposable =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { dispose?: unknown }).dispose === 'function';

/** A registration result; local to the process (holds a function). */
export const disposableSchema = z.custom<Disposable>(isDisposable, {
  message: 'Expected a Disposable.',
});

/** A function argument (handler, callback, factory); local to the process. */
export const functionSchema = <T>() =>
  z.custom<T>((value) => typeof value === 'function', {
    message: 'Expected a function.',
  });

/** A call argument passed inside a payload (local). */
export const callSchema = z.custom((value) => isCall(value));

export const hooksContractSchema = z.custom<HooksContract>(isHooksContract, {
  message: 'Expected a hooks contract created with defineHooks.',
});

export const eventDefinitionSchema = z.custom<EventDefinition>(
  (value) => definitionKindOf(value) === 'event',
  { message: 'Expected an event created with defineEvent.' },
);

export const settingsDefinitionSchema = z.custom<SettingsDefinition>(
  (value) => definitionKindOf(value) === 'settings',
  { message: 'Expected settings created with defineSettings.' },
);

export const storageTypeDefinitionSchema = z.custom<StorageTypeDefinition>(
  (value) => definitionKindOf(value) === 'storage-type',
  { message: 'Expected a storage type created with defineStorageType.' },
);

export const commandDefinitionSchema = z.custom<CommandDefinition>(
  (value) => definitionKindOf(value) === 'command',
  { message: 'Expected a command created with defineCommand.' },
);

export const noInput = z.tuple([]);

// Stream methods ------------------------------------------------------------

/** What a stream method delivers: items, then at most one end. */
export interface StreamObserver<T> {
  next(item: T): void;
  /** The stream ended: without an error when the provider closed it. */
  end?(error?: ContractError): void;
}

/** A stream listener: a bare function is treated as `{ next }`. */
export type StreamListener<T> = ((item: T) => void) | StreamObserver<T>;

const streamItems = new WeakMap<z.ZodType, z.ZodType>();

const isStreamListener = (value: unknown): boolean =>
  typeof value === 'function' ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    ((value as { end?: unknown }).end === undefined ||
      typeof (value as { end?: unknown }).end === 'function'));

/**
 * The listener argument of a stream method (a callback-codec local value).
 * Its JSON Schema records the item schema under `x-doric-stream`, so a
 * descriptor tells stream methods apart and a boundary can validate items.
 */
export const streamListener = <T extends z.ZodType>(
  item: T,
): z.ZodType<StreamListener<z.output<T>>> => {
  const schema = z
    .custom<StreamListener<z.output<T>>>(isStreamListener, {
      message: 'Expected a stream listener.',
    })
    .meta({ 'x-doric-local': 'callback' });

  streamItems.set(schema, item);

  return schema;
};

/** The item schema of a `streamListener` schema, else undefined. */
export const streamItemOf = (schema: z.ZodType): z.ZodType | undefined =>
  streamItems.get(schema);

/** A listener as an observer (a function becomes `{ next }`). */
export const toStreamObserver = <T>(
  listener: StreamListener<T>,
): StreamObserver<T> =>
  typeof listener === 'function' ? { next: listener } : listener;
