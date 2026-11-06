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
}

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
      : {
          message:
            message.length > MAX_ERROR_MESSAGE
              ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…`
              : message,
        }),
  };
};
