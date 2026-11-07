// The shell side of validation feedback (openui.md D18): one reporter per
// element, key and revision, so both owners follow the same rules (B15).

import {
  MAX_ERROR_MESSAGE,
  MAX_REPORTED_ERRORS,
  OPENUI_ERROR_CODES,
  type OpenUIErrorCodeName,
  type OpenUIErrorLike,
  type ProgramErrorsInput,
  type ProgramTag,
  type ReportedError,
  STATEMENT_ID_PATTERN,
} from './errors.js';

export interface ErrorReporter {
  /**
   * Pass every `onError` call of the element's `Renderer`; `state` is the
   * fence's state at that call. Never throws and never awaits.
   *
   * The reporter calls `send` at most once: at the first call whose `state` is
   * `closed` or `unterminated`, and only when there is something to report (a
   * `closed` fence with no error sends nothing; an `unterminated` one always
   * sends, with `errors: []` when it has none). The input carries, in order: a
   * `parse-exception` for a failed merge, `check()`'s errors, then each error
   * `map` keeps, without warnings and without codes outside
   * `OPENUI_ERROR_CODES`; at most 50 errors, a `statementId` that fails its
   * pattern removed, a `message` over 300 characters cut to 299 and `…`.
   * A rejected `send` is caught and dropped.
   */
  onError(
    errors: readonly OpenUIErrorLike[],
    state: 'streaming' | 'closed' | 'unterminated',
  ): void;

  /**
   * True once `onError` has called `send` for this revision, whatever `send`'s
   * promise does; false before, after `streaming` calls and after a `closed`
   * call with nothing to report. The card's footer reads it. Never throws.
   */
  sent(): boolean;
}

/**
 * One line of the reader's card (D18, U49). `code` is absent for a note that
 * is not an OpenUI error, such as papercraft's library failure; the card never
 * shows it, and papercraft's "Nothing to draw" notice reads it.
 */
export interface ShownError {
  readonly code?: string;
  /** Present only when it matches `STATEMENT_ID_PATTERN`. */
  readonly statementId?: string;
  /** 1 to 300 characters. */
  readonly message: string;
}

/**
 * The card's lines for one fence revision, in order:
 * - D18's merge error when `mergeFailed`;
 * - then `owned`, the owner's own check, each with its `message`, or its code
 *   when it has none;
 * - then each error of `rendered` that is not a warning, with the renderer's
 *   own message; codes outside `OPENUI_ERROR_CODES` are kept.
 *
 * Of two lines with the same code and statement the first is kept; then the
 * first 50 lines; a `statementId` that fails `STATEMENT_ID_PATTERN` is removed
 * (the line stays); a message over 300 characters is cut to its first 299 and
 * `…`. Returns `[]` when there is nothing to show. Pure and total: never
 * throws, never mutates its input. Imports no OpenUI and no React.
 */
export const shownErrors = (input: {
  readonly mergeFailed: boolean;
  readonly owned: readonly ReportedError[];
  readonly rendered: readonly OpenUIErrorLike[];
}): readonly ShownError[] => {
  const lines: ShownError[] = [
    ...[...(input.mergeFailed ? [MERGE_FAILED] : []), ...input.owned].map(
      ({ code, statementId, message }) => ({
        code,
        ...(statementId === undefined ? {} : { statementId }),
        message: message === undefined || message.length === 0 ? code : message,
      }),
    ),
    ...input.rendered
      .filter(({ severity }) => severity !== 'warning')
      .map(({ code, statementId, message }) => ({
        code,
        ...(statementId === undefined ? {} : { statementId }),
        message,
      })),
  ];
  const seen = new Set<string>();
  const unique = lines.filter(({ code, statementId }) => {
    const key = JSON.stringify([code, statementId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .slice(0, MAX_REPORTED_ERRORS)
    .map(({ code, statementId, message }) => ({
      ...(code === undefined ? {} : { code }),
      ...(statementId !== undefined && STATEMENT_ID_PATTERN.test(statementId)
        ? { statementId }
        : {}),
      message: clampMessage(message),
    }));
};

export interface ErrorReporterInput {
  readonly tag: ProgramTag;
  readonly key: string;
  readonly identity: string;
  readonly revision: number;
  /** The revision's `mergeFailed` (D4). */
  readonly mergeFailed: boolean;
  /** The owner's own check of the merged program (D7), run once, at the report. */
  readonly check: () => readonly ReportedError[];
  /** Turns one `onError` error into a `ReportedError`, or `undefined` to drop it. */
  readonly map: (error: OpenUIErrorLike) => ReportedError | undefined;
  /** Calls `openui.programs/v1.reportErrors` in the fence's scope. */
  readonly send: (input: ProgramErrorsInput) => Promise<void>;
}

/** A reporter for one fence revision. Pure until `onError` is called. */
export const createErrorReporter = (
  input: ErrorReporterInput,
): ErrorReporter => {
  let reported = false;
  let sent = false;

  return {
    onError: (errors, state) => {
      if (reported || state === 'streaming') return;
      reported = true;
      const found: ReportedError[] = [
        ...(input.mergeFailed ? [MERGE_FAILED] : []),
        ...input.check(),
      ];
      for (const error of errors) {
        if (error.severity === 'warning' || !isErrorCode(error.code)) continue;
        const mapped = input.map(error);
        if (mapped !== undefined) found.push(mapped);
      }
      const kept = found
        .filter(({ code }) => isErrorCode(code))
        .slice(0, MAX_REPORTED_ERRORS)
        .map(clamp);
      if (state === 'closed' && kept.length === 0) return;
      sent = true;
      input
        .send({
          tag: input.tag,
          key: input.key,
          identity: input.identity,
          revision: input.revision,
          state,
          errors: kept,
        })
        .catch(() => undefined);
    },
    sent: () => sent,
  };
};

/** D18's error for a patch `merge` threw on. */
const MERGE_FAILED: ReportedError = {
  code: 'parse-exception',
  message:
    'This patch could not be merged into the previous revision; write the whole program again.',
};

const isErrorCode = (code: string): code is OpenUIErrorCodeName =>
  (OPENUI_ERROR_CODES as readonly string[]).includes(code);

/** `error` without a `statementId` that fails its pattern and with a `message` of at most 300 characters. */
const clamp = (error: ReportedError): ReportedError => {
  const { code, statementId, message } = error;
  return {
    code,
    ...(statementId !== undefined && STATEMENT_ID_PATTERN.test(statementId)
      ? { statementId }
      : {}),
    ...(message === undefined || message.length === 0
      ? {}
      : { message: clampMessage(message) }),
  };
};

/** `message` cut to its first 299 characters and `…` when over 300. */
const clampMessage = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE
    ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…`
    : message;
