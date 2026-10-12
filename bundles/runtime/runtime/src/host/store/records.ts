import type { Page, ThreadState } from '../../contracts/model.js';

/*
 * The store's shared rules, ported from agents/doric/src/lib/workspace/storage.ts
 * without Prisma: the states a write may not leave, the newest-first page,
 * the page limit and the text sanitizing PostgreSQL needs.
 */

/** The states nothing reopens. */
export const terminalStates: readonly ThreadState[] = ['failed', 'cancelled'];

export const isTerminalState = (state: ThreadState): boolean =>
  terminalStates.includes(state);

/** A list index's `open` field: neither failed nor cancelled. */
export const isOpenState = (state: ThreadState): boolean =>
  !isTerminalState(state);

/** The current states a `setState` to `state` leaves untouched. */
export const excludedStates = (state: ThreadState): readonly ThreadState[] =>
  state === 'ready' || state === 'running' || state === 'queued'
    ? [...terminalStates, 'cancelling']
    : terminalStates;

/**
 * Text PostgreSQL can store. It rejects U+0000 in any string and an unpaired
 * surrogate in jsonb, while tool and model output carry whatever bytes a file
 * or command returned. Replacing those with U+FFFD keeps the conversation
 * persistable instead of failing the whole Thread on one binary match.
 */
export const storable = (text: string): string =>
  Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0 || (code >= 0xd800 && code <= 0xdfff) ? '�' : character;
  }).join('');

/**
 * The JSON value a jsonb column held for `value` (the former `json()`): a
 * JSON copy with every string made storable. It throws where
 * `JSON.stringify` throws (a BigInt, a cycle) and for `undefined`, which has
 * no JSON, before anything is written.
 */
export const storableJson = (value: unknown): unknown =>
  value === null
    ? null
    : (JSON.parse(
        JSON.stringify(value, (_key: string, entry: unknown) =>
          typeof entry === 'string' ? storable(entry) : entry,
        ) as string,
      ) as unknown);

/** The optional timestamp and error fields every record carries. */
export const timestamps = (stored: {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}) => ({
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
  ...(stored.startedAt === null ? {} : { startedAt: stored.startedAt }),
  ...(stored.finishedAt === null ? {} : { finishedAt: stored.finishedAt }),
  ...(stored.errorCode === null ? {} : { errorCode: stored.errorCode }),
});

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

/** The write time of a document field, as `Date.toISOString()`. */
export const now = (): string => new Date().toISOString();
