import { Prisma } from '../generated/prisma/client.js';
import type { Page, ThreadState } from './workspace.js';

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

export const json = (
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null
    ? Prisma.JsonNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

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
