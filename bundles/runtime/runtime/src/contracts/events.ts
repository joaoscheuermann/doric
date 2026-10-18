import { defineEvent, type EventSinkSpec } from 'bundle/contracts';
import { z } from 'zod';

import { inputSourceSchema } from './model.js';
import { threadEventsStreamPrefix } from './storage.js';

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

/**
 * Where the runtime's events go: the Thread log of their scope, one stream per
 * Thread. The core writes each row with the keys in this order, so the stored
 * rows keep the stage-2 shape `{ projectId, threadId, promptId, type, event }`.
 */
export const threadEventSink: EventSinkSpec = Object.freeze({
  scopeKeys: Object.freeze(['projectId', 'threadId', 'promptId']),
  stream: `${threadEventsStreamPrefix}{threadId}`,
  scopeDescription: 'a project, a Thread and a prompt',
});

/** Legacy durable type → the qualified type it is also read as. */
export const legacyEventTypes: Readonly<Record<string, string>> = Object.freeze(
  { 'prompt.finished': 'runtime.prompt-finished/v1' },
);

export const qualifiedType = (type: string): string | undefined =>
  Object.hasOwn(legacyEventTypes, type) ? legacyEventTypes[type] : undefined;
