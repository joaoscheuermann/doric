import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { type EventDefinition, ref } from '../define.js';
import {
  disposableSchema,
  eventDefinitionSchema,
  type MethodSpecs,
} from './common.js';

/** First provider in stage 2; shapes may be refined before a provider publishes. */
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
