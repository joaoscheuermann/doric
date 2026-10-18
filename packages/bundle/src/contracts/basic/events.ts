import { z } from 'zod';

import { type CallArg, SCOPE_MAX_KEYS, scopeKeyPattern } from '../call.js';
import type { Disposable } from '../context.js';
import { type EventDefinition, ref } from '../define.js';
import {
  disposableSchema,
  eventDefinitionSchema,
  type MethodSpecs,
} from './common.js';

// Error codes raised by events/v1: `unknown_event` (the definition is not
// registered), `invalid_scope` (the call scope lacks a key the sink names, or
// no sink is registered), `not_owner` (only the owner appends, and a sink
// writes only the streams its owner names), `invalid_input` (a payload or a
// sink that breaks its schema) and `registration_conflict`.

/**
 * Where the rows of appended events go. The owner of the events registers it
 * once with `sink`; the platform keeps no stream name, scope key or row shape
 * of its own.
 */
export interface EventSinkSpec {
  /**
   * The call-scope keys a row carries, in row order. Every key is required:
   * an append whose scope lacks one is `invalid_scope`.
   */
  readonly scopeKeys: readonly string[];
  /**
   * The stream a row is appended to. A `{key}` placeholder names one of
   * `scopeKeys` and is replaced by that key's value in the call's scope.
   */
  readonly stream: string;
  /** What a call must carry, named in the `invalid_scope` message. */
  readonly scopeDescription?: string;
}

/** A sink spec: keys from the scope grammar, unique, and every placeholder among them. */
export const eventSinkSpecSchema = z
  .object({
    scopeKeys: z
      .array(z.string().regex(scopeKeyPattern))
      .min(1)
      .max(SCOPE_MAX_KEYS)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: 'Scope keys of an event sink must be unique.',
      }),
    stream: z.string().min(1).max(256),
    scopeDescription: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    for (const match of spec.stream.matchAll(/\{([^{}]*)\}/g)) {
      if (!spec.scopeKeys.includes(match[1] ?? '')) {
        context.addIssue({
          code: 'custom',
          message: `Stream placeholder {${match[1] ?? ''}} is not a scope key of the sink.`,
          path: ['stream'],
        });
      }
    }
  });

export interface Events {
  register(definition: EventDefinition): Disposable;
  /** Registers where the rows of appended events go: one sink per provider. */
  sink(spec: EventSinkSpec): Disposable;
  append<D extends EventDefinition>(
    definition: D,
    payload: z.input<D['payload']>,
    call?: CallArg,
  ): Promise<void>;
}

export const EventsV1 = ref<Events>('events/v1');

export const eventsMethods = {
  register: { input: eventDefinitionSchema, output: disposableSchema },
  sink: { input: eventSinkSpecSchema, output: disposableSchema },
  append: {
    input: z.tuple([eventDefinitionSchema, z.record(z.string(), z.unknown())]),
    output: z.void(),
  },
} as const satisfies MethodSpecs;
