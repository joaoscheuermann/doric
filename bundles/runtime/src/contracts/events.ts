import { defineEvent } from 'bundle/contracts';
import { z } from 'zod';

import { inputSourceSchema } from './model.js';

/*
 * The qualified alias of the durable `prompt.finished` event (design 57 §2.12
 * as revised). The payload declares no `type`, as `events/v1.register`
 * requires; writes keep the durable `type: 'prompt.finished'` and stored
 * events are never rewritten.
 */
export const promptFinishedEvent = defineEvent({
  type: 'runtime.prompt-finished/v1',
  payload: z.looseObject({
    status: z.enum(['completed', 'failed', 'cancelled']),
    text: z.string(),
    source: inputSourceSchema,
    reason: z.literal('queue_removed').optional(),
  }),
});

/** Legacy durable type → the qualified type it is also read as. */
export const legacyEventTypes: Readonly<Record<string, string>> = Object.freeze(
  { 'prompt.finished': 'runtime.prompt-finished/v1' },
);

export const qualifiedType = (type: string): string | undefined =>
  Object.hasOwn(legacyEventTypes, type) ? legacyEventTypes[type] : undefined;
