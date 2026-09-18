import { randomUUID } from 'node:crypto';

import type { ProviderMessage } from 'llms';

import {
  Prisma,
  type Session as StoredSession,
  type SessionEvent as StoredEvent,
  SessionState as StoredState,
} from '../generated/prisma/client.js';
import type { DoricConfig } from './config.js';
import type { Database } from './database.js';

export type SessionState =
  | 'queued'
  | 'ready'
  | 'running'
  | 'cancelling'
  | 'failed'
  | 'cancelled';

export type Session = {
  readonly id: string;
  readonly state: SessionState;
  readonly configRevision: number;
  readonly errorCode?: string;
  readonly lastSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
};

export type SessionEvent = {
  readonly sessionId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
};

export type SessionRecord = {
  readonly session: Session;
  readonly snapshot: DoricConfig;
  readonly messages: readonly ProviderMessage[];
};

export type PromptAcceptance =
  | { readonly status: 'accepted'; readonly event: SessionEvent }
  | { readonly status: 'inactive' }
  | { readonly status: 'missing' };

export type SessionStore = ReturnType<typeof createSessionStore>;

const terminal = new Set<StoredState>([
  StoredState.FAILED,
  StoredState.CANCELLED,
]);

const accepting = new Set<StoredState>([
  StoredState.QUEUED,
  StoredState.READY,
  StoredState.RUNNING,
]);

/** Owns generic session state, persisted messages, and contiguous events. */
export const createSessionStore = (database: Database) => {
  const eventTails = new Map<string, Promise<void>>();

  const serialized = async <Value>(
    id: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = eventTails.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;

    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    eventTails.set(id, current);

    await previous;

    try {
      return await operation();
    } finally {
      release();

      if (eventTails.get(id) === current) {
        eventTails.delete(id);
      }
    }
  };

  const append = async (
    id: string,
    promptId: string,
    value: unknown,
  ): Promise<SessionEvent> =>
    serialized(id, () =>
      database.$transaction(async (transaction) => {
        const current = await transaction.session.findUniqueOrThrow({
          where: { id },
          select: { lastSequence: true },
        });
        const sequence = current.lastSequence + 1;

        await transaction.session.update({
          where: { id },
          data: { lastSequence: sequence },
        });

        const event = value as { readonly type?: unknown };

        const stored = await transaction.sessionEvent.create({
          data: {
            sessionId: id,
            promptId,
            sequence,
            type: typeof event.type === 'string' ? event.type : 'unknown',
            event: json(value),
          },
        });

        return sessionEvent(stored);
      }),
    );

  return {
    async reconcile(): Promise<number> {
      const result = await database.session.updateMany({
        where: { state: { notIn: [...terminal] } },
        data: {
          state: StoredState.FAILED,
          errorCode: 'process_interrupted',
          finishedAt: new Date(),
        },
      });

      return result.count;
    },

    async create(snapshot: DoricConfig): Promise<SessionRecord> {
      const stored = await database.session.create({
        data: {
          id: randomUUID(),
          configRevision: snapshot.revision,
          configSnapshot: json(snapshot),
          messages: [],
        },
      });

      return { session: session(stored), snapshot, messages: [] };
    },

    async find(id: string): Promise<SessionRecord | undefined> {
      const stored = await database.session.findUnique({ where: { id } });

      return stored === null ? undefined : record(stored);
    },

    async list(limit: number, cursor?: string) {
      const records = await database.session.findMany({
        take: limit + 1,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const hasMore = records.length > limit;
      const page = records.slice(0, limit).map(session);

      return {
        sessions: page,
        nextCursor: hasMore ? page.at(-1)?.id : undefined,
      };
    },

    async markReady(id: string): Promise<Session | undefined> {
      await database.session.updateMany({
        where: { id, state: StoredState.QUEUED },
        data: { state: StoredState.READY, startedAt: new Date() },
      });

      const stored = await database.session.findUnique({ where: { id } });

      return stored === null ? undefined : session(stored);
    },

    async markRunning(id: string): Promise<Session | undefined> {
      await database.session.updateMany({
        where: { id, state: StoredState.READY },
        data: { state: StoredState.RUNNING },
      });

      const stored = await database.session.findUnique({ where: { id } });

      return stored === null ? undefined : session(stored);
    },

    async finishPrompt(
      id: string,
      messages: readonly ProviderMessage[],
    ): Promise<Session | undefined> {
      await database.session.updateMany({
        where: { id, state: StoredState.RUNNING },
        data: { messages: json(messages), state: StoredState.READY },
      });

      const stored = await database.session.findUnique({ where: { id } });

      if (stored === null) {
        return undefined;
      }

      if (stored.state !== StoredState.RUNNING) {
        const updated = await database.session.update({
          where: { id },
          data: { messages: json(messages) },
        });

        return session(updated);
      }

      return session(stored);
    },

    async acceptPrompt(
      id: string,
      promptId: string,
    ): Promise<PromptAcceptance> {
      return serialized(id, () =>
        database.$transaction(async (transaction) => {
          const current = await transaction.session.findUnique({
            where: { id },
          });

          if (current === null) {
            return { status: 'missing' as const };
          }

          if (!accepting.has(current.state)) {
            return { status: 'inactive' as const };
          }

          const sequence = current.lastSequence + 1;

          await transaction.session.update({
            where: { id },
            data: { lastSequence: sequence },
          });

          const stored = await transaction.sessionEvent.create({
            data: {
              sessionId: id,
              promptId,
              sequence,
              type: 'prompt.accepted',
              event: { type: 'prompt.accepted' },
            },
          });

          return { status: 'accepted' as const, event: sessionEvent(stored) };
        }),
      );
    },

    async requestCancellation(id: string): Promise<Session | undefined> {
      const current = await database.session.findUnique({ where: { id } });

      if (current === null || terminal.has(current.state)) {
        return current === null ? undefined : session(current);
      }

      if (current.state === StoredState.CANCELLING) {
        return session(current);
      }

      return session(
        await database.session.update({
          where: { id },
          data: { state: StoredState.CANCELLING },
        }),
      );
    },

    async finish(
      id: string,
      target: 'failed' | 'cancelled',
      errorCode?: string,
    ): Promise<Session | undefined> {
      const current = await database.session.findUnique({ where: { id } });

      if (current === null) {
        return undefined;
      }

      if (terminal.has(current.state)) {
        return session(current);
      }

      const state =
        current.state === StoredState.CANCELLING
          ? StoredState.CANCELLED
          : target === 'failed'
            ? StoredState.FAILED
            : StoredState.CANCELLED;

      return session(
        await database.session.update({
          where: { id },
          data: {
            state,
            finishedAt: new Date(),
            errorCode:
              state === StoredState.FAILED
                ? (errorCode ?? 'execution_failed')
                : null,
          },
        }),
      );
    },

    appendEvent: append,

    async eventsAfter(
      id: string,
      sequence: number,
    ): Promise<readonly SessionEvent[]> {
      return (
        await database.sessionEvent.findMany({
          where: { sessionId: id, sequence: { gt: sequence } },
          orderBy: { sequence: 'asc' },
        })
      ).map(sessionEvent);
    },

    async delete(id: string): Promise<'deleted' | 'active' | 'missing'> {
      const current = await database.session.findUnique({
        where: { id },
        select: { state: true },
      });

      if (current === null) {
        return 'missing';
      }

      if (!terminal.has(current.state)) {
        return 'active';
      }

      await database.session.delete({ where: { id } });

      return 'deleted';
    },
  };
};

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const states: Record<StoredState, SessionState> = {
  QUEUED: 'queued',
  READY: 'ready',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const session = (stored: StoredSession): Session => ({
  id: stored.id,
  state: states[stored.state],
  configRevision: stored.configRevision,
  ...(stored.errorCode === null ? {} : { errorCode: stored.errorCode }),
  lastSequence: stored.lastSequence,
  createdAt: stored.createdAt.toISOString(),
  updatedAt: stored.updatedAt.toISOString(),
  ...(stored.startedAt === null
    ? {}
    : { startedAt: stored.startedAt.toISOString() }),
  ...(stored.finishedAt === null
    ? {}
    : { finishedAt: stored.finishedAt.toISOString() }),
});

const record = (stored: StoredSession): SessionRecord => ({
  session: session(stored),
  snapshot: stored.configSnapshot as unknown as DoricConfig,
  messages: stored.messages as unknown as readonly ProviderMessage[],
});

const sessionEvent = (stored: StoredEvent): SessionEvent => ({
  sessionId: stored.sessionId,
  promptId: stored.promptId,
  sequence: stored.sequence,
  type: stored.type,
  event: stored.event,
  createdAt: stored.createdAt.toISOString(),
});
