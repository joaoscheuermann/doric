import type { ProviderMessage } from 'llms';
import type { HistoryPatch, HistoryReader } from 'runtime/contracts';

/*
 * default.history/v1 (design 57 §5.2): the Thread's provider history in two
 * parts, so a checkpoint write stays small. Before the bundle was renamed it
 * wrote the same parts as `direct.history/v1`, which it still reads.
 *
 * - `messages`: the provider-ready messages (the runtime redacts and
 *   sanitizes them on write), formerly `thread.messages`.
 * - `meta`: the turn boundaries by prompt ID and the length of the stored
 *   `messages`, formerly `thread.checkpoints` and
 *   `jsonb_array_length(messages)`, and the retained messages: the index of
 *   each standing instruction by its key (`<bundleId>:<reason>`), which every
 *   compaction keeps verbatim and every rewrite re-bases like a boundary.
 */

export const historyFormat = 'default.history/v1';

/** The format the bundle wrote as `direct`: the same parts, read as they are. */
export const legacyHistoryFormat = 'direct.history/v1';

export interface HistoryMeta {
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly messageCount: number;
  readonly retained: Readonly<Record<string, number>>;
}

/** The key a standing instruction is retained under in the history's meta. */
export const retainedKey = (bundleId: string, why: string): string =>
  `${bundleId}:${why}`;

/** The entries of a stored index map whose values are whole indexes. */
const indexes = (value: unknown): Readonly<Record<string, number>> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, number] =>
          Number.isInteger(entry[1]),
        ),
      )
    : {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The stored messages; a Thread with no history yet has none. */
export const readMessages = async (
  history: HistoryReader,
): Promise<readonly ProviderMessage[]> => {
  const value = await history.read('messages');

  return Array.isArray(value) ? (value as readonly ProviderMessage[]) : [];
};

/**
 * The stored turn boundaries, message count and retained messages. A Thread
 * with no `meta` part has no boundary or retained message yet, and its
 * message count is the length of whatever `messages` it holds, as the
 * database's `jsonb_array_length` was.
 */
export const readMeta = async (
  history: HistoryReader,
): Promise<HistoryMeta> => {
  const value = await history.read('meta');

  if (isRecord(value)) {
    const checkpoints = isRecord(value.checkpoints)
      ? (value.checkpoints as Readonly<Record<string, number>>)
      : {};
    const messageCount =
      typeof value.messageCount === 'number'
        ? value.messageCount
        : (await readMessages(history)).length;

    return { checkpoints, messageCount, retained: indexes(value.retained) };
  }

  return {
    checkpoints: {},
    messageCount: (await readMessages(history)).length,
    retained: {},
  };
};

/**
 * The turn boundary of one prompt, recorded once: the boundary a resumed turn
 * already has wins over the length it would read now, exactly like the SQL
 * `jsonb_build_object(promptId, length) || checkpoints`.
 */
export const checkpoint = async ({
  history,
  promptId,
}: {
  readonly history: HistoryReader;
  readonly promptId: string;
}): Promise<HistoryPatch> => {
  const meta = await readMeta(history);

  return {
    format: historyFormat,
    parts: {
      meta: {
        checkpoints: { [promptId]: meta.messageCount, ...meta.checkpoints },
        messageCount: meta.messageCount,
        retained: meta.retained,
      },
    },
  };
};

/**
 * The history a rewind to `promptId` leaves: the messages before its
 * boundary, every boundary of a removed prompt dropped, and every retained
 * message past the boundary forgotten, so its instruction can be given
 * again. A prompt with no boundary cannot be rewound, and gives undefined.
 */
export const rewind = async ({
  history,
  promptId,
  removedPromptIds,
}: {
  readonly history: HistoryReader;
  readonly promptId: string;
  readonly removedPromptIds: readonly string[];
}): Promise<HistoryPatch | undefined> => {
  const meta = await readMeta(history);
  const boundary = meta.checkpoints[promptId];

  if (boundary === undefined) return undefined;

  const messages = (await readMessages(history)).slice(0, boundary);
  const removed = new Set(removedPromptIds);

  return {
    format: historyFormat,
    parts: {
      messages,
      meta: {
        checkpoints: Object.fromEntries(
          Object.entries(meta.checkpoints).filter(([id]) => !removed.has(id)),
        ),
        messageCount: messages.length,
        retained: Object.fromEntries(
          Object.entries(meta.retained).filter(([, index]) => index < boundary),
        ),
      },
    },
  };
};

/**
 * The history a run writes: its messages, with the boundaries and retained
 * messages that match them.
 */
export const saved = (
  messages: readonly ProviderMessage[],
  checkpoints: Readonly<Record<string, number>>,
  retained: Readonly<Record<string, number>>,
): HistoryPatch => ({
  format: historyFormat,
  parts: {
    messages,
    meta: { checkpoints, messageCount: messages.length, retained },
  },
});
