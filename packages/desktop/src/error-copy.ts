// The shared error catalog and the rule that turns an `ErrorInfo` into the
// words a notice shows. Not exported by `package.json`: only
// `./error-notice.tsx` imports it, so its entries exist once per window, in
// the platform's `error-notice.js` (§2.1).
import type { ErrorCatalog, ErrorCause, ErrorInfo } from './reads/errors.js';
import { messageFrom } from './reads/messages.js';

const entry = (
  title: string,
  retryable: boolean,
  explanation?: string,
): ErrorCatalog[string] =>
  explanation === undefined
    ? { title, retryable }
    : { title, explanation, retryable };

const each = (
  codes: readonly string[],
  value: ErrorCatalog[string],
): ErrorCatalog => Object.fromEntries(codes.map((code) => [code, value]));

/**
 * The entries of the codes that `packages/bundle`, `packages/llms`,
 * `packages/agent` and `packages/tool` define (§2.2). Their words name no
 * bundle. A code that more than one package defines has a title true for
 * every source and no explanation.
 */
export const sharedErrorCatalog: ErrorCatalog = {
  unknown: entry('Something went wrong', true),
  internal: entry('Something went wrong', true),
  ...each(
    ['unavailable', 'disconnected', 'generation_lost', 'protocol_error'],
    entry(
      'Doric host unavailable',
      true,
      'This window lost its connection to the Doric host.',
    ),
  ),
  invalid_output: entry('Unexpected output', true),
  invalid_input: entry('Request refused', false),
  not_found: entry('Not found', false),
  conflict: entry('Not possible right now', false),
  revision_conflict: entry(
    'Changed elsewhere',
    true,
    'Something else changed this first. Retry to use the latest version.',
  ),
  limit_exceeded: entry('Limit reached', false),
  credential_missing: entry('Credential not found', false),
  credential_invalid: entry('Credential rejected', false),
  credential_name_taken: entry(
    'Name already used',
    false,
    'Another credential already has this name.',
  ),
  credential_kind_immutable: entry(
    'Kind cannot change',
    false,
    'A stored credential keeps its kind; create a new credential instead.',
  ),
  credential_storage_unavailable: entry(
    'Secret storage unavailable',
    true,
    'The host cannot store credential secrets right now.',
  ),
  network_error: entry(
    'Provider unreachable',
    true,
    'Doric could not reach {provider}.',
  ),
  incomplete_stream: entry(
    'Response cut off',
    true,
    '{provider} ended the response before it finished.',
  ),
  rate_limit_error: entry(
    'Rate limit reached',
    true,
    '{provider} is limiting requests; wait a moment, then retry.',
  ),
  overloaded_error: entry(
    'Provider overloaded',
    true,
    '{provider} is overloaded; wait a moment, then retry.',
  ),
  ...each(
    ['api_error', 'provider_error'],
    entry(
      'Provider error',
      true,
      '{provider} reported an error while answering.',
    ),
  ),
  http_error: entry(
    'Provider request failed',
    true,
    '{provider} answered with an error status.',
  ),
  auth_failed: entry(
    'Sign-in rejected',
    false,
    '{provider} refused the credentials.',
  ),
  auth_missing: entry(
    'Credentials missing',
    false,
    '{provider} needs a credential.',
  ),
  auth_ambiguous: entry(
    'Credentials ambiguous',
    false,
    'More than one credential matches {provider}.',
  ),
  ...each(
    ['malformed_stream_event', 'missing_stream_finish'],
    entry(
      'Unreadable response',
      true,
      '{provider} sent a response Doric could not read.',
    ),
  ),
  invalid_json: entry('Unreadable data', true),
  missing_model: entry('No model chosen', false),
  ...each(
    ['unsupported_model_feature', 'incompatible_model_request'],
    entry('Not supported by the model', false),
  ),
  output_truncated: entry(
    'Response too long',
    true,
    'The model stopped at its output limit.',
  ),
  provider_refusal: entry('The model refused', false),
  turn_limit_exceeded: entry(
    'Turn limit reached',
    true,
    'The agent stopped after its maximum number of turns.',
  ),
  missing_provider_finish: entry(
    'Response ended early',
    true,
    "The model's response ended without a finish.",
  ),
  invalid_structured_output: entry('Unexpected model output', true),
  concurrent_run: entry(
    'Already running',
    false,
    'A run is already in progress.',
  ),
  ...each(
    [
      'tool_call_id_collision',
      'tool_call_id_invalid',
      'tool_input_serialization_failed',
      'tool_result_serialization_failed',
    ],
    entry('Invalid tool call', true),
  ),
  handler_failed: entry('Tool failed', false),
  invalid_payload: entry('Invalid tool input', false),
  unknown_tool: entry('Unknown tool', false),
  invalid_schema: entry('Invalid tool definition', false),
};

/** The words a notice shows for one error. */
export interface ErrorCopy {
  /** The headline entry's title. */
  readonly title: string;
  /** One line, at most 200 characters; never `''`. */
  readonly explanation: string;
  /** Whether Retry may show; the surface still decides by passing `onRetry` (D5). */
  readonly retryable: boolean;
  readonly tone: 'error' | 'warning';
}

/**
 * The title, explanation, Retry flag and tone a notice shows for `info`.
 *
 * Accepts any `ErrorInfo`. `options.catalog` is merged over
 * `sharedErrorCatalog`, its entry winning for a code both list. The headline
 * level is the first level of `[info, ...info.causes]` whose code has an entry
 * and is not `internal`; else `options.fallbackCode`'s entry titles the
 * outermost level; else the first `internal` level; else the `unknown` entry
 * titles the outermost level.
 *
 * `explanation` is the entry's explanation with `{provider}` replaced (the
 * headline level's provider, else `info.provider`, else `the provider`); else
 * the first line of the headline level's message, else of `info.message`,
 * else `messageFrom(undefined)`; a first line over 200 characters is cut to
 * 199 and ends with `…`. `retryable` is the entry's flag unless the headline
 * level says `retryable: false`; for the `unknown` fallback it is the
 * headline level's flag, default `true`. `tone` defaults to `'error'`.
 *
 * Never throws; the same input gives the same result.
 */
export const describeError = (
  info: ErrorInfo,
  options?: {
    readonly catalog?: ErrorCatalog;
    readonly fallbackCode?: string;
  },
): ErrorCopy => {
  const merged: ErrorCatalog = { ...sharedErrorCatalog, ...options?.catalog };
  const entryOf = (code: string | undefined) =>
    code !== undefined && Object.hasOwn(merged, code)
      ? merged[code]
      : undefined;
  const levels: readonly ErrorCause[] = [
    info,
    ...(Array.isArray(info.causes) ? info.causes : []),
  ];

  let headline = levels.find(
    (level) => level.code !== 'internal' && entryOf(level.code) !== undefined,
  );
  let entry = entryOf(headline?.code);
  if (headline === undefined || entry === undefined) {
    entry = entryOf(options?.fallbackCode);
    headline = info;
  }
  if (entry === undefined) {
    const internal = levels.find((level) => level.code === 'internal');
    if (internal !== undefined) {
      headline = internal;
      entry = entryOf('internal');
    }
  }
  const unknown = entry === undefined;
  if (unknown) entry = entryOf('unknown');

  const provider = headline.provider ?? info.provider ?? 'the provider';
  const explanation =
    entry?.explanation?.replaceAll('{provider}', provider) ??
    (firstLine(headline.message) ||
      firstLine(info.message) ||
      messageFrom(undefined));

  return {
    title: entry?.title ?? '',
    explanation,
    retryable: unknown
      ? (headline.retryable ?? true)
      : entry?.retryable === true && headline.retryable !== false,
    tone: entry?.tone ?? 'error',
  };
};

/** The first line of `text`, cut to 199 characters and `…` when over 200. */
const firstLine = (text: string | undefined): string => {
  const line = (text ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};
