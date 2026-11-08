// The error types of validation feedback (openui.md D18): what an owner's
// element reports for one fence, for both tags.

/** The two fence tags whose programs report errors. */
export const PROGRAM_TAGS = ['openui-lang', 'papercraft'] as const;

export type ProgramTag = (typeof PROGRAM_TAGS)[number];

/**
 * lang-core 1.0.2's `OpenUIErrorCode`, as a value: lang-core exports the type
 * only. `tests/error-codes.test.ts` keeps the two equal (B20).
 */
export const OPENUI_ERROR_CODES = [
  'missing-required',
  'null-required',
  'unknown-component',
  'inline-reserved',
  'excess-args',
  'type-mismatch',
  'unknown-function',
  'no-root',
  'runtime-error',
  'render-error',
  'parse-exception',
  'parse-failed',
  'tool-not-found',
  'tool-error',
  'mcp-error',
] as const;

export type OpenUIErrorCodeName = (typeof OPENUI_ERROR_CODES)[number];

/** A statement name of a program. */
export const STATEMENT_ID_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** A chat fence key, `<promptId>/<turnSequence>/<index>` (D2). */
export const FENCE_KEY_PATTERN = /^[^/]+\/\d+\/\d+$/;

/** The most errors one report carries. */
export const MAX_REPORTED_ERRORS = 50;

/** The longest `ReportedError.message`, in UTF-16 code units. */
export const MAX_ERROR_MESSAGE = 300;

/** One error of a fence's program, as reported to the host. */
export interface ReportedError {
  readonly code: OpenUIErrorCodeName;
  /** A statement name of the reported program; matches `STATEMENT_ID_PATTERN`. */
  readonly statementId?: string;
  /** Only for an error the shell's own code computed; 1 to 300 characters. */
  readonly message?: string;
}

/** The errors of one fence revision, reported once it is `closed` or `unterminated`. */
export interface ProgramErrorsInput {
  readonly tag: ProgramTag;
  /** The chat's fence key (D2); matches `FENCE_KEY_PATTERN`. */
  readonly key: string;
  /** The revision's identity (D3). */
  readonly identity: string;
  /** An integer from 1. */
  readonly revision: number;
  readonly state: 'closed' | 'unterminated';
  /** At most 50. */
  readonly errors: readonly ReportedError[];
}

/** `OpenUIError`'s fields that D18 reads (lang-core 1.0.2 `dist/index.d.mts:220-239`). */
export interface OpenUIErrorLike {
  readonly code: string;
  readonly message: string;
  readonly statementId?: string;
  readonly component?: string;
  /** OpenUI's fix context, which D7 appends to the message. */
  readonly hint?: string;
  readonly severity?: 'warning';
}
