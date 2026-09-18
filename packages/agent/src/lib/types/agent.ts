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

export type AgentOptions = {
  readonly provider: LlmProvider;
  readonly tools: ToolStorage;
  readonly messages: MessageStorage;
  readonly toolCalls: ToolCallStorage;
  readonly system: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly flags?: ProviderCallFlags;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
};

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

export type AgentRunOptions<
  Output = JsonValue,
  Schema extends StructuredOutputSchema = StructuredOutputSchema,
> = {
  readonly maxTurns?: number;
  readonly maxToolCallRepairs?: number;
  readonly signal?: AbortSignal;
  readonly schema?: Schema;
  readonly onStructuredAttempt?: (
    event: AgentStructuredAttemptEvent,
  ) => void | Promise<void>;
  readonly onToolCallRepair?: (
    event: AgentToolCallRepairEvent,
  ) => void | Promise<void>;
  readonly onToolEvent?: (event: AgentToolEvent) => void | Promise<void>;
};

export type Agent = {
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
};

export type AgentComplete = Agent['complete'];

export type AgentStream = Agent['stream'];

export type AgentResponse<Output = JsonValue> = {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: UsageMetadata;
  readonly reasoning?: ReasoningMetadata;
  readonly refusal?: string;
  readonly structured?: Output;
  readonly finish: ProviderFinished<Output>;
};

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
  | AgentToolEvent;

export type AgentErrorCode =
  | 'concurrent_run'
  | 'invalid_structured_output'
  | 'missing_provider_finish'
  | 'tool_call_id_collision'
  | 'tool_call_id_invalid'
  | 'tool_input_serialization_failed'
  | 'turn_limit_exceeded'
  | 'tool_result_serialization_failed';

export type AgentError = {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly diagnostic?: string;
};
