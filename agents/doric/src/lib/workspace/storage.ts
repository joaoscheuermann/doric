import { Prisma } from '../../generated/prisma/client.js';
import type { Page, ThreadState } from './types.js';

export const terminal = ['FAILED', 'CANCELLED'] as const;

export const states = {
  QUEUED: 'queued',
  READY: 'ready',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export const storedState = {
  queued: 'QUEUED',
  ready: 'READY',
  running: 'RUNNING',
  cancelling: 'CANCELLING',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
} as const;

/**
 * Text PostgreSQL can store. It rejects U+0000 in any string and an unpaired
 * surrogate in jsonb, while tool and model output carry whatever bytes a file
 * or command returned. Replacing those with U+FFFD keeps the conversation
 * persistable instead of failing the whole Thread on one binary match.
 */
export const storable = (text: string): string =>
  Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || (code >= 0xd800 && code <= 0xdfff)
      ? '\uFFFD'
      : character;
  }).join('');

export const json = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null
    ? Prisma.JsonNull
    : (JSON.parse(
        JSON.stringify(value, (_key: string, entry: unknown) =>
          typeof entry === 'string' ? storable(entry) : entry,
        ),
      ) as Prisma.InputJsonValue);

export const timestamps = (stored: {
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
}) => ({
  createdAt: stored.createdAt.toISOString(),
  updatedAt: stored.updatedAt.toISOString(),
  ...(stored.startedAt === null
    ? {}
    : { startedAt: stored.startedAt.toISOString() }),
  ...(stored.finishedAt === null
    ? {}
    : { finishedAt: stored.finishedAt.toISOString() }),
  ...(stored.errorCode === null ? {} : { errorCode: stored.errorCode }),
});

export const excludedStates = (state: ThreadState) =>
  state === 'ready' || state === 'running' || state === 'queued'
    ? [...terminal, 'CANCELLING' as const]
    : [...terminal];

/** Exclusive cursor predicate for newest-first creation-time/id ordering. */
export const before = (anchor: { createdAt: Date; id: string } | undefined) =>
  anchor === undefined
    ? {}
    : {
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      };

export const page = <Value extends { readonly id: string }>(
  records: readonly Value[],
  limit: number,
): Page<Value> => ({
  items: records.slice(0, limit),
  ...(records.length > limit ? { nextCursor: records[limit - 1]?.id } : {}),
});

export const checkLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError('Invalid page limit.');
};
