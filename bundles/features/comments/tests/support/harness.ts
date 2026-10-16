// The harness the registry's tests run against: the bundle's own `activate`
// over `createTestServices`, with a fake `events/v1` that records what `append`
// was called with instead of writing a stream.

import {
  type AnyServiceDefinition,
  type Call,
  type CallScope,
  type Disposable,
  defineMethod,
  defineService,
  type EventDefinition,
  EventsV1,
  eventsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  type Comments,
  CommentsV1,
  type CommentTarget,
} from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';

export type { CommentTarget };

const inert: Disposable = { dispose: () => undefined };

export interface AppendedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly call: Call;
}

export interface EventsRecord {
  readonly appended: AppendedEvent[];
  readonly registered: string[];
}

/** `events/v1` for a test: it records appends instead of writing a stream. */
export const fakeEvents = (): {
  readonly definition: AnyServiceDefinition;
  readonly record: EventsRecord;
} => {
  const record: EventsRecord = { appended: [], registered: [] };

  const definition = defineService(EventsV1.id, {
    register: defineMethod({
      ...eventsMethods.register,
      execute: (event: EventDefinition) => {
        record.registered.push(event.type);

        return inert;
      },
    }),
    sink: defineMethod({ ...eventsMethods.sink, execute: () => inert }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async (
        [event, payload]: readonly [EventDefinition, Record<string, unknown>],
        call: Call,
      ) => {
        record.appended.push({ type: event.type, payload, call });
      },
    }),
  });

  return { definition, record };
};

export interface CommentsHarness {
  readonly events: EventsRecord;
  /** A hop call into the bundle, scoped as a prompt's call is. */
  readonly call: (scope?: CallScope) => Call;
  readonly comments: Comments;
  close(): Promise<void>;
}

/** The prompt scope every registry call in these tests runs under. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

export const commentsHarness = async (): Promise<CommentsHarness> => {
  const events = fakeEvents();
  const harness = createTestServices({
    bundle: { id: 'comments' },
    provide: [events.definition],
  });

  await activate({ services: harness.services });

  return {
    events: events.record,
    call: (scope: CallScope = promptScope) => harness.call(scope),
    comments: harness.services.use(CommentsV1),
    close: async () => {
      await harness.dispose();
    },
  } satisfies CommentsHarness;
};
