import type {
  JsonObject,
  JsonValue,
  ToolCallRequest,
  ToolDefinition,
} from 'tool';
import type { z } from 'zod';

export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from 'tool';

export type ProviderId = string;

export type ProviderMetadata = {
  readonly id: ProviderId;
  readonly name: string;
  readonly baseUrl: string;
};

export type ProviderCapabilities = {
  readonly streaming: boolean;
  readonly embeddings: boolean;
  readonly reranking: boolean;
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly modelListing: boolean;
  readonly oauth: boolean;
  readonly serviceTier: boolean;
  readonly structuredOutputs: boolean;
};

export type Model = {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly provider?: string;
  readonly raw?: unknown;
};

export type ProviderContentPart =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'image';
      readonly imageUrl: string;
    };

/** Opaque provider output item retained only for exact multi-turn replay. */
export type ProviderReplayItem = JsonObject;

export type ProviderToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { readonly name: string };

export type ProviderToolResultStatus = 'completed' | 'incomplete';

export type ProviderMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly ProviderContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolResultStatus?: ProviderToolResultStatus;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly replay?: readonly ProviderReplayItem[];
};

export type ProviderToolCall = ToolCallRequest;

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type ReasoningRequest = {
  readonly effort?: ReasoningEffort;
  readonly summary?: 'auto' | 'concise' | 'detailed';
};

export type StructuredOutputSchema = z.ZodType;
export type StructuredOutputValue<Schema extends StructuredOutputSchema> =
  z.output<Schema>;

export type ProviderCallFlags = {
  readonly reasoning?: boolean | ReasoningRequest;
  readonly serviceTier?: 'auto' | 'default' | 'priority';
  readonly includeUsage?: boolean;
  /** Suppresses operational logs and omits model output from diagnostics. */
  readonly sensitiveOutput?: boolean;
  /** Adds the structured output JSON Schema to the model's system prompt. */
  readonly includeStructuredSchemaOnSystemPrompt?: boolean;
};

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled'
  | 'unknown';

export type UsageMetadata = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly searchUnits?: number;
  readonly cost?: {
    readonly amount: number;
    readonly unit?: string;
    readonly upstreamAmount?: number;
  };
};

export type ReasoningMetadata = {
  readonly text?: string;
  readonly effort?: ReasoningEffort;
  readonly summary?: string;
};

export type ProviderFinished<Output = JsonValue> = {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: UsageMetadata;
  readonly reasoning?: ReasoningMetadata;
  readonly refusal?: string;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly replay?: readonly ProviderReplayItem[];
  readonly structured?: Output;
};

/** A completion that was parsed and validated against its requested schema. */
export type ProviderStructuredFinished<Output> = Omit<
  ProviderFinished<Output>,
  'structured'
> & {
  readonly structured: Output;
};

export type ProviderError = {
  readonly provider: ProviderId;
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly diagnostic?: string;
};

export type ProviderStreamEvent<Output = JsonValue> =
  | {
      readonly type: 'response.started';
      readonly provider: ProviderId;
      readonly model: string;
    }
  | {
      readonly type: 'text.delta';
      readonly delta: string;
    }
  | {
      readonly type: 'reasoning.delta';
      readonly delta: string;
    }
  | {
      readonly type: 'refusal.delta';
      readonly delta: string;
    }
  | {
      readonly type: 'tool_call.delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | {
      readonly type: 'tool_call.done';
      readonly call: ProviderToolCall;
    }
  | {
      readonly type: 'usage';
      readonly usage: UsageMetadata;
    }
  | {
      readonly type: 'response.finished';
      readonly finish: ProviderFinished<Output>;
    }
  | {
      readonly type: 'error';
      readonly error: ProviderError;
    };

export type ProviderRequest<
  Output = JsonValue,
  Schema extends StructuredOutputSchema = StructuredOutputSchema,
> = {
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ProviderToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly schema?: Schema;
  readonly effort?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly flags?: ProviderCallFlags;
  readonly signal?: AbortSignal;
};

/** A single-text embedding request supported by OpenAI-compatible providers. */
export type ProviderEmbeddingRequest = {
  readonly model: string;
  readonly input: string;
  readonly dimensions?: number;
  readonly flags?: ProviderCallFlags;
  readonly signal?: AbortSignal;
};

/** A text-document rerank request supported by compatible providers. */
export type ProviderRerankRequest = {
  readonly model: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN?: number;
  readonly flags?: ProviderCallFlags;
  readonly signal?: AbortSignal;
};

export type ProviderRerankResult = {
  readonly index: number;
  readonly relevanceScore: number;
};

export type ProviderEmbeddingFinished = {
  readonly embedding: readonly number[];
  readonly usage?: UsageMetadata;
};

export type ProviderRerankFinished = {
  readonly results: readonly ProviderRerankResult[];
  readonly usage?: UsageMetadata;
};

/** Provider-neutral completion and streaming contract for agent-core callers. */
export interface LlmProvider {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;

  complete<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<z.output<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): Promise<ProviderStructuredFinished<z.output<Schema>>>;

  complete<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderFinished<Output>>;

  stream<Schema extends StructuredOutputSchema, Output = z.output<Schema>>(
    request: ProviderRequest<Output, Schema> & {
      readonly schema: Schema;
    },
  ): AsyncIterable<ProviderStreamEvent<Output>>;

  stream<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): AsyncIterable<ProviderStreamEvent<Output>>;

  embedding(
    request: ProviderEmbeddingRequest,
  ): Promise<ProviderEmbeddingFinished>;

  rerank(request: ProviderRerankRequest): Promise<ProviderRerankFinished>;

  models(signal?: AbortSignal): Promise<readonly Model[]>;

  validateModel(model: string, signal?: AbortSignal): Promise<Model>;
}
