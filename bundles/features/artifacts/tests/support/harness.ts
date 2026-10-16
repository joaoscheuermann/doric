// The harness the registry's tests run against: the bundle's own `activate`
// over `createTestServices`, with a fake lease on a temporary sandbox and
// fakes of the two basic contracts the host part uses — `events/v1`, which
// refuses what the real facade refuses (a call scope without the Thread log
// sink's `projectId`, `threadId` and `promptId`, or a payload its event
// schema rejects) and records what it accepted, and `settings/v1`, which
// holds a value per space and answers a space's own default when it was
// never written.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AnyServiceDefinition,
  type Call,
  type CallScope,
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
  type EventDefinition,
  EventsV1,
  eventsMethods,
  type SettingsDefinition,
  SettingsV1,
  settingsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  type ArtifactKindRegistry,
  ArtifactKindV1,
  type Artifacts,
  ArtifactsV1,
  artifactReviewPolicy,
} from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';
import { type FakeLeaseState, fakeLease } from './lease.js';

export type { ArtifactTarget } from '../../src/contracts/index.js';

const inert: Disposable = { dispose: () => undefined };

export interface AppendedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly call: Call;
}

export interface EventsRecord {
  readonly appended: AppendedEvent[];
  readonly registered: string[];
  /** Set, the next append fails with this error (once), after validation. */
  failNext?: Error;
}

/** The scope keys of the runtime's Thread log sink, `runtime.thread.events/{threadId}`. */
const sinkScopeKeys = ['projectId', 'threadId', 'promptId'] as const;

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
        const scope = call.scope ?? {};

        if (sinkScopeKeys.some((key) => scope[key] === undefined)) {
          throw new ContractError(
            'invalid_scope',
            `Event ${event.type} needs a call scope with ${sinkScopeKeys.join(', ')}.`,
            { type: event.type },
          );
        }

        if (!event.payload.safeParse(payload).success) {
          throw new ContractError(
            'invalid_input',
            `Invalid ${event.type} payload.`,
            { type: event.type },
          );
        }

        const failure = record.failNext;

        if (failure !== undefined) {
          record.failNext = undefined;
          throw failure;
        }

        record.appended.push({ type: event.type, payload, call });
      },
    }),
  });

  return { definition, record };
};

export interface SettingsRecord {
  readonly registered: string[];
  readonly values: Map<string, unknown>;
}

/** `settings/v1` for a test: one value per space, with the space's own default. */
export const fakeSettings = (): {
  readonly definition: AnyServiceDefinition;
  readonly record: SettingsRecord;
} => {
  const record: SettingsRecord = { registered: [], values: new Map() };

  const valueOfSpace = (definition: SettingsDefinition): unknown =>
    record.values.has(definition.id)
      ? record.values.get(definition.id)
      : definition.schema.parse({});

  const written = (definition: SettingsDefinition) =>
    record.values.has(definition.id) ? 1 : 0;

  const definition = defineService(SettingsV1.id, {
    register: defineMethod({
      ...settingsMethods.register,
      execute: (space: SettingsDefinition) => {
        record.registered.push(space.id);

        return inert;
      },
    }),
    get: defineMethod({
      ...settingsMethods.get,
      execute: async (space: SettingsDefinition) => valueOfSpace(space),
    }),
    entry: defineMethod({
      ...settingsMethods.entry,
      execute: async (space: SettingsDefinition) => ({
        value: valueOfSpace(space),
        revision: written(space),
        version: '1.0.0',
        updatedAt: new Date(0).toISOString(),
        generation: written(space),
      }),
    }),
    set: defineMethod({
      ...settingsMethods.set,
      execute: async (
        input: readonly [
          SettingsDefinition,
          unknown,
          ({ readonly expectedRevision?: number } | undefined)?,
        ],
      ) => {
        const [space, next] = input;

        record.values.set(space.id, next);

        return {
          value: next,
          revision: 1,
          version: '1.0.0',
          updatedAt: new Date().toISOString(),
          generation: 1,
        };
      },
    }),
    subscribe: defineMethod({
      ...settingsMethods.subscribe,
      execute: () => inert,
    }),
  });

  return { definition, record };
};

export interface ArtifactsHarness {
  /** The sandbox root on this machine (`/workspace` inside the fake lease). */
  readonly root: string;
  readonly events: EventsRecord;
  readonly settings: SettingsRecord;
  /** A hop call into the bundle, scoped as a prompt's call is. */
  readonly call: (scope?: CallScope) => Call;
  readonly artifacts: Artifacts;
  readonly kinds: ArtifactKindRegistry;
  /** Moves the Project's lease to another state, as the runtime would. */
  setLease(state: FakeLeaseState): void;
  close(): Promise<void>;
}

/** The prompt scope every registry call in these tests runs under. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

export const artifactsHarness = async (
  options: { policy?: 'proceed' | 'request' } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), 'doric-artifacts-'));
  const events = fakeEvents();
  const settings = fakeSettings();
  let lease: FakeLeaseState = 'ready';

  if (options.policy !== undefined) {
    settings.record.values.set(artifactReviewPolicy.id, {
      policy: options.policy,
    });
  }

  const harness = createTestServices({
    bundle: { id: 'artifacts' },
    provide: [
      fakeLease(root, () => lease),
      events.definition,
      settings.definition,
    ],
  });

  await activate({ services: harness.services });

  return {
    root,
    events: events.record,
    settings: settings.record,
    call: (scope: CallScope = promptScope) => harness.call(scope),
    artifacts: harness.services.use(ArtifactsV1),
    kinds: harness.services.use(ArtifactKindV1),
    setLease: (state: FakeLeaseState) => {
      lease = state;
    },
    close: async () => {
      await harness.dispose();
      await rm(root, { recursive: true, force: true });
    },
  } satisfies ArtifactsHarness;
};
