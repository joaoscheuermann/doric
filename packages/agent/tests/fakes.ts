import type {
  LlmProvider,
  ProviderFinished,
  ProviderRequest,
  ProviderStreamEvent,
} from 'llms';
import type {
  JsonValue,
  ToolCall,
  ToolCallRequest,
  ToolDefinition,
  ToolStorage,
  ToolTurn,
} from 'tool';

import {
  type AgentEvent,
  type AgentOptions,
  createAgent,
  createToolCallStorage,
} from '../src/index.js';

type ProviderFake = {
  readonly provider: LlmProvider;
  readonly requests: ProviderRequest<unknown>[];
};

type ToolFake = {
  readonly storage: ToolStorage;
  readonly calls: ToolCall[];
};

export const createTestAgent = (options: Omit<AgentOptions, 'toolCalls'>) =>
  createAgent({ ...options, toolCalls: createToolCallStorage() });

export const completeFinish = (
  text: string,
  toolCalls: readonly ToolCallRequest[] = [],
): ProviderFinished => ({
  text,
  finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  toolCalls,
});

export const call = (
  name: string,
  payload: JsonValue = {},
  id = `call_${name}`,
): ToolCallRequest => ({
  id,
  name,
  arguments: JSON.stringify(payload),
});

export const createProvider = (options: {
  readonly complete?: (
    request: ProviderRequest<unknown>,
    index: number,
  ) => ProviderFinished<unknown> | Promise<ProviderFinished<unknown>>;
  readonly stream?: (
    request: ProviderRequest<unknown>,
    index: number,
  ) => AsyncIterable<ProviderStreamEvent<unknown>>;
}): ProviderFake => {
  const requests: ProviderRequest<unknown>[] = [];

  return {
    requests,
    provider: {
      metadata: {
        id: 'fake',
        name: 'Fake',
        baseUrl: 'https://fake.invalid',
      },
      capabilities: {
        streaming: true,
        embeddings: false,
        reranking: false,
        tools: true,
        reasoning: true,
        modelListing: true,
        oauth: false,
        serviceTier: false,
        structuredOutputs: true,
      },
      complete: async <Output = JsonValue>(
        request: ProviderRequest<Output>,
      ) => {
        const index = requests.length;

        requests.push(request);

        return (options.complete?.(request, index) ??
          completeFinish('done')) as ProviderFinished<Output>;
      },
      stream: async function* <Output = JsonValue>(
        request: ProviderRequest<Output>,
      ) {
        const index = requests.length;

        requests.push(request);

        yield* (options.stream?.(request, index) ?? []) as AsyncIterable<
          ProviderStreamEvent<Output>
        >;
      },
      embedding: async () => ({ embedding: [] }),
      rerank: async () => ({ results: [] }),
      models: async () => [{ id: 'fake-model' }],
      validateModel: async (model: string) => ({ id: model }),
    } as unknown as LlmProvider,
  };
};

export const createTools = (
  options: {
    readonly definitions?: readonly ToolDefinition[];
    readonly results?: Readonly<Record<string, unknown>>;
    readonly failure?: unknown;
  } = {},
): ToolFake => {
  const calls: ToolCall[] = [];

  const storage: ToolStorage = {
    definitions: () => options.definitions ?? [],
    calls: (turn: ToolTurn) => (turn.toolCalls ?? []).map(parseToolCall),
    validate: (call) => ('payload' in call ? call : parseToolCall(call)),
    get: () => undefined,
    execute: async (toolCall) => {
      const parsed = 'payload' in toolCall ? toolCall : parseToolCall(toolCall);

      calls.push(parsed);

      if (options.failure !== undefined) {
        throw options.failure;
      }

      return options.results?.[parsed.name];
    },
  };

  return { storage, calls };
};

const parseToolCall = (request: ToolCallRequest): ToolCall => ({
  id: request.id,
  name: request.name,
  payload: JSON.parse(request.arguments) as JsonValue,
  ...(request.index !== undefined ? { index: request.index } : {}),
});

export const streamEvents = (
  finish: ProviderFinished<unknown>,
): AsyncIterable<ProviderStreamEvent<unknown>> =>
  (async function* () {
    yield {
      type: 'response.started',
      provider: 'fake',
      model: 'fake-model',
    };

    yield {
      type: 'text.delta',
      delta: finish.text,
    };

    yield {
      type: 'response.finished',
      finish,
    };
  })();

export const collect = async <Output = JsonValue>(
  events: AsyncIterable<AgentEvent<Output>>,
): Promise<readonly AgentEvent<Output>[]> => {
  const output: AgentEvent<Output>[] = [];

  for await (const event of events) {
    output.push(event);
  }

  return output;
};
