import type { ProviderMessage } from 'llms';

/*
 * The stable summary marker (the compaction contract's checkpoint marker):
 * the first line of every summary message, so any consumer — persistence,
 * another process, a future executor — recognizes condensed history without
 * knowing which run wrote it. Text survives storage, serialization and every
 * provider, and the summary stays human-readable for the model (HC-010).
 */

/** The exact first line of a compaction summary message. */
export const checkpointMarker = '[Context summary]';

/** The summary a conversation carries instead of the condensed span. */
export interface CompactionCheckpoint {
  /** Where the condensed span began and ended in the pre-rewrite history. */
  readonly start: number;
  readonly end: number;
  /** What the trigger wrote: how the condensation was asked for. */
  readonly trigger: 'automatic' | 'manual';
}

/** The summary message text: marker line, provenance, then the model's body. */
export const checkpointMessage = (
  summary: string,
  checkpoint: CompactionCheckpoint,
): string =>
  [
    checkpointMarker,
    `Condensed: ${checkpoint.trigger} compaction replaced messages ${checkpoint.start}..${checkpoint.end} of this Thread's history with this summary.`,
    '',
    summary,
  ].join('\n');

/** Whether a message is a compaction summary, by its marker line. */
export const isCompactionCheckpoint = (message: ProviderMessage): boolean =>
  message.role === 'user' &&
  typeof message.content === 'string' &&
  message.content.startsWith(checkpointMarker);

/** The message that follows the summary marker line, or undefined. */
export const summaryBody = (message: ProviderMessage): string | undefined => {
  if (!isCompactionCheckpoint(message)) return undefined;
  const content = message.content as string;
  const separator = content.indexOf('\n\n');
  return separator === -1 ? undefined : content.slice(separator + 2);
};
