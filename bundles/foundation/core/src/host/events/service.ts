// The core's `events/v1` over the router: the rules of `createEvents`
// (`./facade.ts`) with `google.protobuf.Any` payloads, the router's stamp for
// the generation view and `core`'s storage facade reached in process.

import type { DescMessage, Registry } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  defineEvent,
  type EventDefinition,
  type EventSinkSpec,
  eventsMethods,
} from 'bundle/contracts';
import type { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { stampedCallerOf } from 'bundle/host';
import { parseStreamId } from 'storage';
import type { StorageFacade } from 'storage/rpc';
import { z } from 'zod';

import { describeIssues } from '../../shared/issues.js';
import { routedViewOf } from '../../shared/partition.js';
import { redactJson } from '../../shared/redact.js';
import { assertDefinitionOwnerIn, PLATFORM } from '../../shared/state.js';
import type { CoreBinding } from '../binding.js';
import { jsonOfAny, optionMessage } from '../messages.js';
import { createRegistrations, type Registrations } from '../registrations.js';

import { createEventRegistry } from './registry.js';
import { createEventSinks, streamOf } from './sinks.js';

/** Told once after each committed `Append`; not awaited, its failure ignored. */
export type EventAppended = (
  input: { readonly stream: string; readonly type: string },
  call: Call,
) => void | Promise<void>;

/**
 * `events/v1` as `createCoreServices` serves it. `Register` looks up
 * `messageType` in `types()` with the `event` option; `Sink` keeps today's
 * owner check and one sink per provider; `Append` validates its `Any`,
 * redacts `{ type, ...json }` with `redactions(call)`, commits the row
 * through `storage` as `core`, then calls `onAppended({ stream, type },
 * call)` without awaiting it or letting it fail the append.
 */
export const createEventsService = (
  bind: () => CoreBinding,
  storage: StorageFacade,
  redactions: (call: Call) => Promise<readonly string[]>,
  types: () => Registry,
  onAppended: EventAppended,
): {
  readonly implementation: ServiceImpl<typeof EventsService>;
  readonly registrations: Registrations;
} => {
  const events = createEventRegistry();
  const sinks = createEventSinks();
  const registrations = createRegistrations('events-');
  const messages = new WeakMap<EventDefinition, DescMessage>();

  const viewOf = async (call: Call) =>
    routedViewOf(call, await bind().catalog(call));

  const implementation: ServiceImpl<typeof EventsService> = {
    register: async ({ type, messageType }, context) => {
      const call = callOf(context);
      const catalog = await bind().catalog(call);

      assertDefinitionOwnerIn(catalog, call, type, 'event');

      const desc = optionMessage(types(), messageType, 'event', type);

      if (
        desc.fields.some(
          (field) => field.name === 'type' || field.jsonName === 'type',
        )
      ) {
        throw new ContractError(
          'invalid_input',
          `The payload of event ${type} declares "type", which the stored body carries.`,
          { type },
        );
      }

      let definition: EventDefinition;

      try {
        definition = defineEvent({
          type: type as EventDefinition['type'],
          payload: z.object({}),
        });
      } catch (error) {
        throw new ContractError(
          'invalid_input',
          error instanceof Error ? error.message : String(error),
          { type },
        );
      }

      messages.set(definition, desc);

      const disposable = events.register(
        definition,
        call.caller.bundleId,
        routedViewOf(call, catalog),
      );

      return {
        registrationId: registrations.add(stampedCallerOf(context), disposable),
      };
    },
    unregister: ({ registrationId }, context) => {
      bind();
      registrations.remove(registrationId, callOf(context).caller);

      return {};
    },
    sink: async (input, context) => {
      const call = callOf(context);
      const parsed = eventsMethods.sink.input.safeParse({
        scopeKeys: input.scopeKeys,
        stream: input.stream,
        ...(input.scopeDescription === undefined
          ? {}
          : { scopeDescription: input.scopeDescription }),
      });

      if (!parsed.success) {
        throw new ContractError(
          'invalid_input',
          `Invalid event sink: ${describeIssues(parsed.error)}`,
        );
      }

      const spec: EventSinkSpec = parsed.data;
      const caller = call.caller.bundleId;
      // A sink writes only streams its owner names. This early check uses a
      // placeholder value; append checks the real stream of every row, since
      // a placeholder in the owner segment is filled only per call.
      const sample = Object.fromEntries(
        spec.scopeKeys.map((key) => [key, 'x']),
      );
      const { owner } = parseStreamId(streamOf(spec, sample));

      if (caller !== PLATFORM && caller !== owner) {
        throw new ContractError(
          'not_owner',
          `Bundle "${caller}" cannot write stream ${spec.stream}, owned by "${owner}".`,
          { stream: spec.stream, owner },
        );
      }

      const disposable = sinks.register(spec, caller, await viewOf(call));

      return {
        registrationId: registrations.add(stampedCallerOf(context), disposable),
      };
    },
    unsink: ({ registrationId }, context) => {
      bind();
      registrations.remove(registrationId, callOf(context).caller);

      return {};
    },
    append: async ({ type, payload }, context) => {
      const call = callOf(context);
      const view = await viewOf(call);
      const entry = events.require(type, view);
      const caller = call.caller.bundleId;

      if (caller !== PLATFORM && caller !== entry.owner) {
        throw new ContractError(
          'not_owner',
          `Bundle "${caller}" cannot append event ${type}, owned by "${entry.owner}".`,
          { type, owner: entry.owner },
        );
      }

      const sink = sinks.require(type, view);
      const scope: Readonly<Record<string, string>> = call.scope ?? {};
      const scopeKeys = sink.spec.scopeKeys;

      if (scopeKeys.some((key) => scope[key] === undefined)) {
        throw new ContractError(
          'invalid_scope',
          `Event ${type} needs a call scope with ${sink.spec.scopeDescription ?? scopeKeys.join(', ')}.`,
          { type },
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
          { type, stream, owner: streamOwner },
        );
      }

      const desc = messages.get(entry.definition);

      if (desc === undefined) {
        throw new ContractError('unknown_event', `Event ${type} is not registered.`, {
          type,
        });
      }

      const json = jsonOfAny(payload, desc, types(), 'payload');
      const event = redactJson(
        { type, ...(json as object) },
        await redactions(call),
      ) as Record<string, unknown>;

      // The scope keys of the sink, in its order, then the type and body.
      const row: Record<string, unknown> = {};

      for (const key of scopeKeys) {
        row[key] = scope[key];
      }

      row.type = type;
      row.event = event;

      await storage.commit(
        { append: [{ stream, events: [row] }] },
        bind().own(call),
      );

      // After the commit, never failing it: the sink's owner reads the
      // stream itself, so the callback names only where the row went.
      if (onAppended !== undefined) {
        try {
          void Promise.resolve(onAppended({ stream, type }, call)).catch(
            () => undefined,
          );
        } catch {
          // A throwing callback is its own problem.
        }
      }

      return {};
    },
  };

  return { implementation, registrations };
};
