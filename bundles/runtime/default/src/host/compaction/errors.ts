/*
 * The compaction contract's closed failure vocabulary. Refusals a caller can
 * decide on before the bracket opens (nothing gets recorded); post-bracket
 * failures carry a stable code the `compaction.failed` event records.
 */

export type CompactionRefusal =
  | 'disabled'
  | 'missing_history'
  | 'nothing_to_compact';

export type CompactionFailureCode = 'summarizer_failed' | 'unsafe_boundary';

/** Structured failure thrown only for compaction-owned lifecycle failures. */
export class CompactionError extends Error {
  readonly code: CompactionFailureCode;

  constructor(code: CompactionFailureCode, message: string) {
    super(message);

    this.name = 'CompactionError';

    this.code = code;
  }
}
