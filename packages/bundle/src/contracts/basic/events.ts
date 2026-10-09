import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { type EventDefinition, ref } from '../define.js';
import {
  disposableSchema,
  eventDefinitionSchema,
  type MethodSpecs,
} from './common.js';

// Error codes raised by events/v1: `unknown_event` (the definition is not
// registered), `invalid_scope` (the call scope lacks a project, Thread or
// prompt), `not_owner` (only the owner appends) and `registration_conflict`.

export interface Events {
  register(definition: EventDefinition): Disposable;
  append<D extends EventDefinition>(
    definition: D,
    payload: z.input<D['payload']>,
    call?: CallArg,
  ): Promise<void>;
}

export const EventsV1 = ref<Events>('events/v1');

export const eventsMethods = {
  register: { input: eventDefinitionSchema, output: disposableSchema },
  append: {
    input: z.tuple([eventDefinitionSchema, z.record(z.string(), z.unknown())]),
    output: z.void(),
  },
} as const satisfies MethodSpecs;

/** The Thread log stream events/v1 appends to; the runtime adopts it in stage 5. */
export const threadEventsStream = (threadId: string): string =>
  `runtime.thread.events/${threadId}`;

/**
 * The value of every entry of a Thread log stream. The sequence and
 * `createdAt` are the protocol entry's.
 */
export const threadEventEnvelopeSchema = z
  .object({
    projectId: z.string(),
    threadId: z.string(),
    promptId: z.string(),
    type: z.string(),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ThreadEventEnvelope = z.output<typeof threadEventEnvelopeSchema>;
