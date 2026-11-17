// The error value every desktop surface renders, and the error catalog types
// each bundle titles its own codes with. Plain data only: an `ErrorInfo` is
// JSON and an `ErrorCatalog` a record of strings and flags, so the copies of
// this module that each client part compiles exchange them freely. Nothing
// here reads `instanceof`, and nothing names a bundle's concept.

/**
 * One level of a cause chain, as the notice's details show it.
 *
 * Plain JSON: a value survives `JSON.stringify`/`JSON.parse` unchanged and is
 * safe to keep in a store or a stored event.
 */
export interface ErrorCause {
  /** The level's code; absent when the level names none. */
  readonly code?: string;
  /** A provider id, from a provider error (`ProviderError.provider`). */
  readonly provider?: string;
  /** An HTTP status, from a provider error. */
  readonly status?: number;
  /** The level's own `retryable` flag, when it states one. */
  readonly retryable?: boolean;
  /** The level's message, trimmed. */
  readonly message: string;
}

/**
 * The value every surface renders: plain JSON, safe to keep in a store.
 *
 * Built by `errorInfo` or `errorFrom`, which never throw. It never holds the
 * original error's `stack`, `details`, `diagnostic` or `name` (D17).
 */
export interface ErrorInfo {
  /** The outermost code; `''` when the error names none. */
  readonly code: string;
  /** The outermost level's provider id, when it states one. */
  readonly provider?: string;
  /** The outermost level's HTTP status, when it states one. */
  readonly status?: number;
  /** The outermost message, trimmed; `''` when there is none. */
  readonly message: string;
  /** The outermost level's own `retryable` flag, when it states one. */
  readonly retryable?: boolean;
  /**
   * The causes below the outermost level, outermost first; at most 7. A cause
   * whose message is empty or repeats an outer message, and whose code is
   * absent or repeats an outer code, is left out (§1.2 step 3).
   */
  readonly causes: readonly ErrorCause[];
  /**
   * When the failure happened, ISO 8601; absent only where nothing records
   * the time (§1.2). A notice with no `at` has no `Time:` line.
   */
  readonly at?: string;
}

/**
 * A rejection the desktop adapters throw: a code, their message, and the
 * original error as the standard ES2022 `cause`.
 *
 * `errorInfo` reads it by its fields (`code`, `message`, `retryable`,
 * `cause`), never by `instanceof`, so a `ClientError` built by one bundle's
 * copy of this module reads the same in any other copy.
 */
export class ClientError extends Error {
  override readonly name: string = 'ClientError';
  /** The code the thrower names, kept as given. */
  readonly code: string;
  /**
   * Present only when the thrower passed `options.retryable`; a thrower sets
   * it only when it knows whether a repeat fails the same way (§6.4).
   */
  declare readonly retryable?: boolean;

  /**
   * Keeps `code` and `message` as given. Sets `cause` only when
   * `options.cause` is given and `retryable` only when `options.retryable` is
   * given. Never throws.
   */
  constructor(
    code: string,
    message: string,
    options?: { readonly cause?: unknown; readonly retryable?: boolean },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    if (options?.retryable !== undefined) this.retryable = options.retryable;
  }
}

/** The most levels a chain is read to; it also ends a cyclic chain. */
const MAX_LEVELS = 8;

/** One level as read, with the value its next level comes from. */
interface Level extends ErrorCause {
  readonly next: unknown;
}

/** A property of `value`, or `undefined` when reading it throws. */
const field = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

/** The field `key` of the guarded type, at the top or else under `data`. */
const pick = <T>(
  value: object,
  key: string,
  guard: (candidate: unknown) => candidate is T,
): T | undefined => {
  const top = field(value, key);
  if (guard(top)) return top;
  const data = field(value, 'data');
  if (typeof data !== 'object' || data === null) return undefined;
  const inner = field(data, key);
  return guard(inner) ? inner : undefined;
};

const isString = (candidate: unknown): candidate is string =>
  typeof candidate === 'string';
const isNumber = (candidate: unknown): candidate is number =>
  typeof candidate === 'number';
const isBoolean = (candidate: unknown): candidate is boolean =>
  typeof candidate === 'boolean';

/** Reads one level of a chain (§1.2). */
const readLevel = (value: unknown): Level => {
  if (typeof value === 'string')
    return { message: value.trim(), next: undefined };
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return { message: '', next: undefined };
  }
  const code = pick(value, 'code', isString);
  const provider = pick(value, 'provider', isString);
  const status = pick(value, 'status', isNumber);
  const retryable = pick(value, 'retryable', isBoolean);
  return {
    ...(code === undefined ? {} : { code }),
    ...(provider === undefined ? {} : { provider }),
    ...(status === undefined ? {} : { status }),
    ...(retryable === undefined ? {} : { retryable }),
    message: pick(value, 'message', isString)?.trim() ?? '',
    next: field(value, 'cause'),
  };
};

/** The levels of `value`'s chain, outermost first, the `handler_failed` wrapper skipped. */
const readChain = (value: unknown): [Level, ...Level[]] => {
  let level = readLevel(value);
  if (level.code === 'handler_failed' && level.next !== undefined) {
    level = readLevel(level.next);
  }
  const levels: [Level, ...Level[]] = [level];
  while (levels.length < MAX_LEVELS && level.next !== undefined) {
    level = readLevel(level.next);
    levels.push(level);
  }
  return levels;
};

/** The cause fields of a level, without its link to the next one. */
const causeOf = ({ next: _next, ...cause }: Level): ErrorCause => cause;

/** The causes kept below `outer` (§1.2 step 3), at most 7. */
const keptCauses = (
  outer: { readonly code?: string; readonly message: string },
  candidates: readonly Level[],
): ErrorCause[] => {
  const above: { readonly code?: string; readonly message: string }[] = [outer];
  const kept: ErrorCause[] = [];
  for (const candidate of candidates) {
    const repeatsMessage =
      candidate.message === '' ||
      above.some((level) => level.message.includes(candidate.message));
    const repeatsCode =
      candidate.code === undefined ||
      above.some((level) => level.code === candidate.code);
    if (!(repeatsMessage && repeatsCode)) kept.push(causeOf(candidate));
    above.push(candidate);
  }
  return kept.slice(0, MAX_LEVELS - 1);
};

/** `at` as `options.at` asks (§1.2 step 4). */
const atFrom = (options?: {
  readonly at?: string | null;
}): { readonly at?: string } => {
  if (options?.at === null) return {};
  if (typeof options?.at === 'string') return { at: options.at };
  return { at: new Date().toISOString() };
};

/**
 * Reads any thrown or stored value into an `ErrorInfo`.
 *
 * Accepts anything: a live `Error`, a `ClientError`, a `ContractError`, the
 * JSON of a stored event, a string, or `undefined`, `null` or a number (a
 * level with no code and the message `''`). Each level reads only `code`,
 * `provider`, `status`, `retryable` and `message`, at the top or else under
 * `data`; the next level is `cause`. An outermost `handler_failed` level with
 * a `cause` is skipped, so the tool's own error is the outermost level. At
 * most 8 levels are read, so a cyclic chain ends.
 *
 * `options.at`: a string becomes `at`; `null` leaves `at` absent; omitted,
 * `at` is the current time.
 *
 * Never throws, also when a getter throws (that field reads as absent). The
 * result is plain JSON.
 */
export const errorInfo = (
  value: unknown,
  options?: { readonly at?: string | null },
): ErrorInfo => {
  const [outer, ...rest] = readChain(value);
  return {
    ...causeOf(outer),
    code: outer.code ?? '',
    causes: keptCauses(outer, rest),
    ...atFrom(options),
  };
};

/**
 * An `ErrorInfo` with the given outer `code` and `message` whose causes are
 * `cause`'s chain as `errorInfo` reads it, its outermost level included, with
 * the omission rule of `ErrorInfo.causes` applied against the new outer
 * level. With `cause === undefined`, `causes` is empty. `options.at` works as
 * in `errorInfo`.
 *
 * The result has no `provider`, `status` or `retryable` of its own. Never
 * throws.
 */
export const errorFrom = (
  code: string,
  message: string,
  cause?: unknown,
  options?: { readonly at?: string | null },
): ErrorInfo => ({
  code,
  message,
  causes:
    cause === undefined ? [] : keptCauses({ code, message }, readChain(cause)),
  ...atFrom(options),
});

/** Whether two levels carry the same fields. */
const sameLevel = (left: ErrorCause, right: ErrorCause): boolean =>
  left.code === right.code &&
  left.provider === right.provider &&
  left.status === right.status &&
  left.message === right.message &&
  left.retryable === right.retryable;

/**
 * Whether two values carry the same `code`, `provider`, `status`, `message`,
 * `retryable` and causes, every cause field compared by value; `at` is
 * ignored. Two `undefined` values are the same; `undefined` and a value are
 * not. Never throws.
 */
export const sameErrorInfo = (
  left: ErrorInfo | undefined,
  right: ErrorInfo | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return (
    sameLevel(left, right) &&
    left.causes.length === right.causes.length &&
    left.causes.every((cause, index) => {
      const other = right.causes[index];
      return other !== undefined && sameLevel(cause, other);
    })
  );
};

/** How one code is shown: its title, its explanation, whether Retry may show. */
export interface ErrorCatalogEntry {
  /** One line, English. */
  readonly title: string;
  /**
   * One sentence. `{provider}` in it is replaced by the headline level's
   * provider (§2.3). Absent: the error's own message is the explanation.
   */
  readonly explanation?: string;
  /** Whether Retry may show for this code; the level's own flag can still veto it (D5). */
  readonly retryable: boolean;
  /** Default `'error'`. */
  readonly tone?: 'error' | 'warning';
}

/**
 * An error catalog: entries keyed by code. A bundle's catalog holds its own
 * codes and its own wording for shared codes; it is merged over the shared
 * entries, so the bundle's entry wins for a code both list (§2.1).
 */
export type ErrorCatalog = Readonly<Record<string, ErrorCatalogEntry>>;
