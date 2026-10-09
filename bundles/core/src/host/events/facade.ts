import {
  ContractError,
  defineMethod,
  defineService,
  type EventDefinition,
  EventsV1,
  eventsMethods,
  SecretsV1,
  StorageV1,
  threadEventsStream,
} from 'bundle/contracts';

import { describeIssues } from '../issues.js';
import { redactJson } from '../redact.js';
import { assertDefinitionOwner, type CoreState, PLATFORM } from '../state.js';
import { createEventRegistry } from './registry.js';

/**
 * The core's `events/v1`: the owner of a registered event type appends it to
 * the Thread log stream `runtime.thread.events/<threadId>` of the call's
 * scope, with the body validated by the registered payload, carrying `type`,
 * redacted and made storable before it is written (decision S-10).
 */
export const createEvents = (state: CoreState) => {
  const events = createEventRegistry();

  return defineService(EventsV1, {
    register: defineMethod({
      ...eventsMethods.register,
      execute: (definition: EventDefinition, call, services) => {
        assertDefinitionOwner(state, call, services, definition.type, 'event');

        if (Object.hasOwn(definition.payload.shape, 'type')) {
          throw new ContractError(
            'invalid_input',
            `The payload of event ${definition.type} declares "type", which the stored body carries.`,
            { type: definition.type },
          );
        }

        return events.register(definition, call.caller.bundleId);
      },
    }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async (
        [definition, payload]: [EventDefinition, Record<string, unknown>],
        call,
        services,
      ) => {
        const entry = events.require(definition.type);
        const caller = call.caller.bundleId;

        if (caller !== PLATFORM && caller !== entry.owner) {
          throw new ContractError(
            'not_owner',
            `Bundle "${caller}" cannot append event ${definition.type}, owned by "${entry.owner}".`,
            { type: definition.type, owner: entry.owner },
          );
        }

        const { projectId, threadId, promptId } = call.scope ?? {};

        if (
          projectId === undefined ||
          threadId === undefined ||
          promptId === undefined
        ) {
          throw new ContractError(
            'invalid_scope',
            `Event ${definition.type} needs a call scope with a project, a Thread and a prompt.`,
            { type: definition.type },
          );
        }

        const parsed = entry.definition.payload.safeParse(payload);

        if (!parsed.success) {
          throw new ContractError(
            'invalid_input',
            `Invalid ${definition.type} payload: ${describeIssues(parsed.error)}`,
            { type: definition.type },
          );
        }

        const redactions = await services.use(SecretsV1).redactions(call);
        const event = redactJson(
          { type: definition.type, ...(parsed.data as object) },
          redactions,
        ) as Record<string, unknown>;

        await services.use(StorageV1).commit(
          {
            append: [
              {
                stream: threadEventsStream(threadId),
                events: [
                  {
                    projectId,
                    threadId,
                    promptId,
                    type: definition.type,
                    event,
                  },
                ],
              },
            ],
          },
          call,
        );
      },
    }),
  });
};
