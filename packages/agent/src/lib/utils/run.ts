import type {
  JsonValue,
  ProviderError,
  ProviderFinished,
  ProviderMessage,
} from 'llms';

import { AgentErrorObject } from '../classes/agent-error.js';
import type {
  AgentResponse,
  AgentRunOptions,
  AgentStructuredAttemptEvent,
  AgentToolCallRepairEvent,
  AgentToolEvent,
} from '../types/agent.js';
import type { ToolCallRecord } from '../types/tool-call-storage.js';

const defaultMaxToolCallRepairs = 2;

/** Counts provider turns against an optional run budget. */
export interface TurnGuard {
  /** Claims one turn, or throws once the budget is spent. */
  readonly begin: () => void;
  /** Whether another turn may still begin. */
  readonly available: () => boolean;
}

export const turnGuard = (maxTurns: number | undefined): TurnGuard => {
  if (
    maxTurns !== undefined &&
    (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)
  ) {
    throw new TypeError('Agent maxTurns must be a positive safe integer.');
  }

  let turns = 0;
  const available = (): boolean => maxTurns === undefined || turns < maxTurns;
  return {
    begin: (): void => {
      if (!available()) {
        throw new AgentErrorObject({
          code: 'turn_limit_exceeded',
          message: `Agent exceeded its ${maxTurns}-turn limit.`,
        });
      }
      turns += 1;
    },
    available,
  };
};

export const repairLimit = (value: number | undefined): number => {
  const limit = value ?? defaultMaxToolCallRepairs;

  if (Number.isSafeInteger(limit) && limit >= 0) {
    return limit;
  }

  throw new TypeError(
    'Agent maxToolCallRepairs must be a non-negative safe integer.',
  );
};

/** How often, and how patiently, a failed provider turn is asked again. */
export interface RetryPolicy {
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const defaultRetry: RetryPolicy = {
  retries: 2,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export const retryPolicy = (
  value: Partial<RetryPolicy> | undefined,
): RetryPolicy => {
  const policy = { ...defaultRetry, ...value };
  if (
    !Number.isSafeInteger(policy.retries) ||
    policy.retries < 0 ||
    !(policy.baseDelayMs >= 0) ||
    !(policy.maxDelayMs >= 0)
  ) {
    throw new TypeError('Agent retry needs non-negative retries and delays.');
  }
  return policy;
};

/**
 * The provider error a thrown value carries, read by shape rather than by
 * class: a provider built against another copy of `llms` still throws one.
 */
const providerErrorOf = (
  error: unknown,
): Partial<ProviderError> | undefined => {
  const data =
    typeof error === 'object' && error !== null && 'data' in error
      ? (error as { readonly data: unknown }).data
      : undefined;
  return typeof data === 'object' && data !== null
    ? (data as Partial<ProviderError>)
    : undefined;
};

/** The provider error a thrown value or a stream `error` event carries. */
const errorData = (
  error: unknown,
): (Partial<ProviderError> & { readonly retryAfterMs?: unknown }) | undefined =>
  providerErrorOf(error) ??
  (typeof error === 'object' && error !== null
    ? (error as Partial<ProviderError>)
    : undefined);

/** Whether a provider failure says that asking again may succeed. */
export const isRetryable = (error: unknown): boolean =>
  errorData(error)?.retryable === true;

/**
 * How long to wait before attempt `attempt + 1`: the provider's own
 * `retryAfterMs` when it named one, else an exponential backoff, both capped.
 */
export const retryDelay = (
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
): number => {
  const named = errorData(error)?.retryAfterMs;
  const delay =
    typeof named === 'number' && Number.isFinite(named) && named >= 0
      ? named
      : policy.baseDelayMs * 2 ** attempt;
  return Math.min(delay, policy.maxDelayMs);
};

/** Waits, or rejects with the signal's reason as soon as it aborts. */
export const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The text of a stored message, its text parts joined. */
const messageText = (message: ProviderMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : (message.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');

/**
 * The answer a history already ends with: a final assistant turn that calls
 * no tool. A resumed run that finds one is finished, and asking the model
 * again would send that turn last, which current models refuse as prefill.
 */
export const answeredTurn = (
  messages: readonly ProviderMessage[],
): ProviderFinished | undefined => {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || (last.toolCalls?.length ?? 0) > 0)
    return undefined;
  return { text: messageText(last), finishReason: 'stop', toolCalls: [] };
};

/** The refusal of a turn the model declined, never one to repair or run. */
export const refusalError = (
  finish: ProviderFinished<unknown>,
): AgentErrorObject =>
  new AgentErrorObject({
    code: 'provider_refusal',
    message:
      finish.refusal === undefined || finish.refusal === ''
        ? 'The model declined to answer.'
        : `The model declined to answer: ${finish.refusal}`,
  });

/** The failure of a turn whose tool call the output limit cut short. */
export const truncatedError = (cause: unknown): AgentErrorObject =>
  new AgentErrorObject(
    {
      code: 'output_truncated',
      message:
        'The model reached its output limit in the middle of a tool call, so the call was not run.',
    },
    { cause },
  );

export const toolCallCorrection = [
  '# Tool call correction',
  '',
  'The previous tool-call response was rejected before any tool ran.',
  'Call only available tools and pass valid JSON arguments matching their schemas.',
].join('\n');

export const pushIncompleteToolResults = (
  finish: ProviderFinished<unknown>,
  push: (callId: string, content: string, status: 'incomplete') => void,
): void => {
  for (const call of finish.toolCalls) {
    push(
      call.id,
      'Tool call rejected before execution. Correct the call and try again.',
      'incomplete',
    );
  }
};

export const notifyToolCallRepair = async <Output>(
  options: AgentRunOptions<Output>,
  event: Omit<AgentToolCallRepairEvent, 'schemaVersion'>,
): Promise<void> => {
  await options.onToolCallRepair?.({ schemaVersion: 1, ...event });
};

export const notifyStructuredAttempt = async <Output>(
  options: AgentRunOptions<Output>,
  event: Omit<AgentStructuredAttemptEvent, 'schemaVersion'>,
): Promise<void> => {
  await options.onStructuredAttempt?.({ schemaVersion: 1, ...event });
};

export const notifyToolEvent = async <Output>(
  options: AgentRunOptions<Output>,
  event: AgentToolEvent,
): Promise<void> => {
  await options.onToolEvent?.(event);
};

/**
 * Trims a tool result to the model-facing cap. The full output is still stored
 * on the record, so this only limits what reaches the next turn.
 */
const capOutput = (value: string, maxChars?: number): string => {
  if (maxChars === undefined || value.length <= maxChars) return value;

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n… [truncated ${omitted} of ${value.length} characters]`;
};

export const toolResultEnvelope = (
  record: ToolCallRecord,
  maxChars?: number,
): string =>
  [
    '# Tool Result',
    '',
    '## Observation ID',
    '',
    fenced(record.id),
    '',
    '## Output',
    '',
    fenced(capOutput(record.output, maxChars)),
  ].join('\n');

/**
 * What the model reads for a call whose handler threw: no observation, only
 * the failure, so it can correct the call, work around it or report it.
 */
export const toolFailureEnvelope = (
  failure: string,
  maxChars?: number,
): string =>
  [
    '# Tool Failure',
    '',
    'The tool call failed and returned no result.',
    '',
    '## Error',
    '',
    fenced(capOutput(failure, maxChars)),
  ].join('\n');

const fenced = (value: string): string => {
  const longest = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = value.endsWith('\n') ? value : `${value}\n`;

  return `${fence}text\n${body}${fence}`;
};

export const responseFromFinish = <Output = JsonValue>(
  finish: ProviderFinished<Output>,
): AgentResponse<Output> => ({
  text: finish.text,
  finishReason: finish.finishReason,
  usage: finish.usage,
  reasoning: finish.reasoning,
  refusal: finish.refusal,
  structured: finish.structured,
  finish,
});
