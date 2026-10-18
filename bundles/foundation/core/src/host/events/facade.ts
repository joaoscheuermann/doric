import {
  ContractError,
  defineMethod,
  defineService,
  type EventDefinition,
  type EventSinkSpec,
  EventsV1,
  eventsMethods,
  type HookHandle,
  SecretsV1,
  StorageV1,
} from 'bundle/contracts';
import { parseStreamId } from 'storage';

import type { CoreEventHooksV1 } from '../../contracts/hooks.js';
import { describeIssues } from '../../shared/issues.js';
import { viewOf } from '../../shared/partition.js';
import { redactJson } from '../../shared/redact.js';
import {
  assertDefinitionOwner,
  type CoreState,
  PLATFORM,
} from '../../shared/state.js';
import { createEventRegistry } from './registry.js';
import { createEventSinks, streamOf } from './sinks.js';

/**
 * The core's `events/v1`. The owner of a registered event type appends it to
 * the stream of the event sink its provider registered, with the scope keys
 * that sink names, and the body validated by the registered payload, carrying
 * `type`, redacted and made storable before it is written (decision S-10).
 * The core knows no stream name, scope key or row shape of any bundle: the
 * sink owner supplies them through `sink`.
 */
export const createEvents = (
  state: CoreState,
  /**
   * `core.event-hooks/v1` as the core defined it, when it could: every
   * committed append fires `onEventAppendedHook` without waiting for it.
   */
  hooks: () => HookHandle<typeof CoreEventHooksV1> | undefined = () =>
    undefined,
) => {
  const events = createEventRegistry();
  const sinks = createEventSinks();

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

        return events.register(
          definition,
          call.caller.bundleId,
          viewOf(call, services),
        );
      },
    }),
    sink: defineMethod({
      ...eventsMethods.sink,
      execute: (spec: EventSinkSpec, call, services) => {
        const caller = call.caller.bundleId;
        // A sink writes only streams its owner names. This early check uses a
        // placeholder value; append checks the real stream of every row, since
        // a placeholder in the owner segment is filled only per call.
        const sample = Object.fromEntries(
          spec.scopeKeys.map((key) => [key, 'x']),
        );
        const stream = streamOf(spec, sample);
        const { owner } = parseStreamId(stream);

        if (caller !== PLATFORM && caller !== owner) {
          throw new ContractError(
            'not_owner',
            `Bundle "${caller}" cannot write stream ${spec.stream}, owned by "${owner}".`,
            { stream: spec.stream, owner },
          );
        }

        return sinks.register(spec, caller, viewOf(call, services));
      },
    }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async (
        [definition, payload]: [EventDefinition, Record<string, unknown>],
        call,
        services,
      ) => {
        const view = viewOf(call, services);
        const entry = events.require(definition.type, view);
        const caller = call.caller.bundleId;

        if (caller !== PLATFORM && caller !== entry.owner) {
          throw new ContractError(
            'not_owner',
            `Bundle "${caller}" cannot append event ${definition.type}, owned by "${entry.owner}".`,
            { type: definition.type, owner: entry.owner },
          );
        }

        const sink = sinks.require(definition.type, view);
        const scope: Readonly<Record<string, string>> = call.scope ?? {};
        const scopeKeys = sink.spec.scopeKeys;

        if (scopeKeys.some((key) => scope[key] === undefined)) {
          throw new ContractError(
            'invalid_scope',
            `Event ${definition.type} needs a call scope with ${sink.spec.scopeDescription ?? scopeKeys.join(', ')}.`,
            { type: definition.type },
          );
        }

        // The stream of this row, from the call's own values: its owner must
        // be the sink's registrant, whatever the placeholders filled in.
        const stream = streamOf(sink.spec, scope);
        const { owner: streamOwner } = parseStreamId(stream);

        if (streamOwner !== sink.owner) {
          throw new ContractError(
            'not_owner',
            `The event sink of "${sink.owner}" cannot write stream ${stream}, owned by "${streamOwner}".`,
            { type: definition.type, stream, owner: streamOwner },
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

        // The scope keys of the sink, in its order, then the type and body.
        const row: Record<string, unknown> = {};

        for (const key of scopeKeys) {
          row[key] = scope[key];
        }

        row.type = definition.type;
        row.event = event;

        await services.use(StorageV1).commit(
          {
            append: [
              {
                stream,
                events: [row],
              },
            ],
          },
          call,
        );

        // After the commit, never failing it: the sink's owner reads the
        // stream itself, so the hook names only where the row went.
        hooks()
          ?.onEventAppendedHook.execute({ stream, type: definition.type }, call)
          .catch(() => undefined);
      },
    }),
  });
};
