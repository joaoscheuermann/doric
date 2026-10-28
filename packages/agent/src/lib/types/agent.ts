import type {
  FinishReason,
  JsonValue,
  LlmProvider,
  ProviderCallFlags,
  ProviderFinished,
  ProviderStreamEvent,
  ReasoningEffort,
  ReasoningMetadata,
  StructuredOutputSchema,
  StructuredOutputValue,
  UsageMetadata,
} from 'llms';
import type { MessageStorage } from 'messages';
import type { ToolCall, ToolStorage } from 'tool';

import type { ToolCallRecord, ToolCallStorage } from './tool-call-storage.js';

export interface AgentOptions {
  readonly provider: LlmProvider;
  readonly tools: ToolStorage;
  readonly messages: MessageStorage;
  readonly toolCalls: ToolCallStorage;
  /**
   * The system prompt, or a function that gives it. A function runs before
   * every provider request, so the prompt can follow state that changes
   * during a run.
   */
  readonly system: string | (() => string | Promise<string>);
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly flags?: ProviderCallFlags;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * How a provider turn that failed before it produced anything is asked
   * again: only a failure the provider marks `retryable` (rate limits,
   * overload, a dropped stream), at most `retries` times (2), waiting the
   * provider's `retryAfterMs` or `baseDelayMs` (1000) doubled per attempt,
   * never longer than `maxDelayMs` (30000). A turn that already streamed
   * output is never asked again.
   */
  readonly retry?: {
    readonly retries?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
}

/** Safe runtime evidence for one terminal structured-output submission. */
export interface AgentStructuredAttemptEvent {
  readonly schemaVersion: 1;
  readonly attempt: number;
  readonly runtimeAccepted: boolean;
  readonly feedbackSent: boolean;
  readonly diagnostic?: string;
}

/** Safe evidence that one provider tool-call turn was rejected and retried. */
export interface AgentToolCallRepairEvent {
  readonly schemaVersion: 1;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Awaited lifecycle event for one validated executable-tool call. */
export type AgentToolEvent =
  | { readonly type: 'tool.started'; readonly call: ToolCall }
  | {
      readonly type: 'tool.finished';
      readonly call: ToolCall;
      readonly result: unknown;
      readonly content: string;
      readonly record: ToolCallRecord;
    }
  | {
      readonly type: 'tool.failed';
      readonly call: ToolCall;
      readonly error: unknown;
    };

export interface AgentRunOptions<
  _Output = JsonValue,
  Schema extends StructuredOutputSchema = StructuredOutputSchema,
> {
  /** Continue the supplied message history without appending input again. */
  readonly resume?: boolean;
  readonly maxTurns?: number;
  readonly maxToolCallRepairs?: number;
  /**
   * The most characters one tool answer may carry into the model.
   * A number caps every tool. A function is called each time a call is answered, with the tool's
   * name: `ToolCallRecord.toolName` for a result, `ToolCall.name` for a failure.
   * Absent, or `undefined` from the function, means no cap for that call.
   * Over the cap, the text keeps its first `cap` characters and then
   * `\n… [truncated <omitted> of <total> characters]`.
   * The full output is always kept on the record, so this only limits what the next turn reads.
   * A function that throws ends the run with its error.
   */
  readonly maxToolResultChars?:
    | number
    | ((toolName: string) => number | undefined);
  readonly signal?: AbortSignal;
  /**
   * Takes the messages a caller sent the running loop since it last asked.
   * The loop asks before the first turn of a resumed run, after every executed
   * tool batch, and once more before an ordinary run would finish, so a
   * message that arrives while the model answers continues the run instead. Each message is stored as a user
   * message before the next provider turn. The loop does not ask when no turn
   * is left or when a structured run submits its result, so those messages
   * stay with the caller.
   */
  readonly steering?: () => readonly string[] | Promise<readonly string[]>;

  /**
   * User messages the caller adds right before a provider request.
   *
   * When it is called:
   * - once before every provider request of a `complete` or `stream` run, the first one included,
   *   and also before repair turns (structured output or tool calls);
   * - after the turn is counted and the signal is checked;
   * - before the loop reads the tool definitions, the system prompt and the history for that
   *   request. So a tool that becomes visible because of the message is offered in that same request.
   *
   * What it returns: each string is stored in order as a `role: 'user'` message at the end of the
   * history. `[]` adds nothing.
   *
   * What the caller can rely on:
   * - Every tool call in the history already has its result at that point, so a message never sits
   *   between a call and its result.
   * - Unlike `steering`, it emits no `agent.steered` event, uses no turn, and does not change
   *   `steering`'s schedule.
   * - It is never called when no request follows: a finished answer, a resumed history that is
   *   already answered, an accepted structured result, or a used-up turn budget (`turns.begin()`
   *   throws first). So it never makes a finished run continue.
   *
   * Failure: a rejection ends the run with that error. Messages already stored stay.
   */
  readonly beforeRequest?: () => readonly string[] | Promise<readonly string[]>;
  readonly schema?: Schema;
  readonly onStructuredAttempt?: (
    event: AgentStructuredAttemptEvent,
  ) => void | Promise<void>;
  readonly onToolCallRepair?: (
    event: AgentToolCallRepairEvent,
  ) => void | Promise<void>;
  readonly onToolEvent?: (event: AgentToolEvent) => void | Promise<void>;
}

export interface Agent {
  readonly complete: {
    <
      Schema extends StructuredOutputSchema,
      Output = StructuredOutputValue<Schema>,
    >(
      input: string,
      options: AgentRunOptions<Output, Schema> & {
        readonly schema: Schema;
      },
    ): Promise<AgentResponse<Output>>;

    <Output = JsonValue>(
      input: string,
      options?: AgentRunOptions<Output>,
    ): Promise<AgentResponse<Output>>;
  };
  readonly stream: {
    <
      Schema extends StructuredOutputSchema,
      Output = StructuredOutputValue<Schema>,
    >(
      input: string,
      options: AgentRunOptions<Output, Schema> & {
        readonly schema: Schema;
      },
    ): AsyncIterable<AgentEvent<Output>>;

    <Output = JsonValue>(
      input: string,
      options?: AgentRunOptions<Output>,
    ): AsyncIterable<AgentEvent<Output>>;
  };
}

export type AgentComplete = Agent['complete'];

export type AgentStream = Agent['stream'];

export interface AgentResponse<Output = JsonValue> {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: UsageMetadata;
  readonly reasoning?: ReasoningMetadata;
  readonly refusal?: string;
  readonly structured?: Output;
  readonly finish: ProviderFinished<Output>;
}

export type AgentEvent<Output = JsonValue> =
  | ProviderStreamEvent<Output>
  | {
      readonly type: 'agent.started';
      readonly model: string;
      readonly input: string;
    }
  | {
      readonly type: 'agent.finished';
      readonly response: AgentResponse<Output>;
    }
  | {
      /** One steering message the loop stored for its next provider turn. */
      readonly type: 'agent.steered';
      readonly input: string;
    }
  | AgentToolEvent;

export type AgentErrorCode =
  | 'concurrent_run'
  | 'invalid_structured_output'
  | 'missing_provider_finish'
  | 'output_truncated'
  | 'provider_refusal'
  | 'tool_call_id_collision'
  | 'tool_call_id_invalid'
  | 'tool_input_serialization_failed'
  | 'turn_limit_exceeded'
  | 'tool_result_serialization_failed';

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly diagnostic?: string;
}
