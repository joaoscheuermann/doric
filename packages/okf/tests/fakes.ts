import type {
  JsonValue,
  LlmProvider,
  ProviderFinished,
  ProviderRequest,
  ProviderStructuredFinished,
  ProviderStreamEvent,
  StructuredOutputSchema,
  StructuredOutputValue,
} from 'llms';

type Output = (
  system: string,
  input: string,
  index: number,
  request: ProviderRequest<unknown>,
) => unknown | Promise<unknown>;

export type ProviderFake = {
  readonly provider: LlmProvider;
  readonly requests: readonly ProviderRequest<unknown>[];
};

export const createProvider = (
  output: Output = defaultOutput,
): ProviderFake => {
  const requests: ProviderRequest<unknown>[] = [];

  async function complete<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<StructuredOutputValue<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): Promise<ProviderStructuredFinished<StructuredOutputValue<Schema>>>;
  async function complete<Result = JsonValue>(
    request: ProviderRequest<Result>,
  ): Promise<ProviderFinished<Result>>;
  async function complete<Result = JsonValue>(
    request: ProviderRequest<Result>,
  ): Promise<ProviderFinished<Result>> {
    if (request.schema !== undefined) {
      throw new Error('OKF must not request structured output.');
    }

    const index = requests.length;
    requests.push(request);
    const system = text(request, 'system');
    const input = text(request, 'user');
    return finish(
      await output(system, input, index, request),
    ) as ProviderFinished<Result>;
  }

  return {
    requests,
    provider: {
      metadata: {
        id: 'fake',
        name: 'Fake',
        baseUrl: 'https://fake.invalid',
      },
      capabilities: {
        streaming: false,
        embeddings: false,
        reranking: false,
        tools: false,
        reasoning: true,
        modelListing: false,
        oauth: false,
        serviceTier: false,
        structuredOutputs: false,
      },
      complete,
      stream: async function* <Result = JsonValue>() {
        yield* [] as ProviderStreamEvent<Result>[];
      },
      embedding: async () => {
        throw new Error('OKF must not request embeddings.');
      },
      rerank: async () => {
        throw new Error('OKF must not request reranking.');
      },
      models: async () => [],
      validateModel: async (model) => ({ id: model }),
    },
  };
};

const text = (
  request: ProviderRequest<unknown>,
  role: 'system' | 'user',
): string => {
  const content = request.messages.find(
    (message) => message.role === role,
  )?.content;
  if (typeof content !== 'string') throw new Error(`Missing ${role} message`);
  return content;
};

const defaultOutput: Output = (_system, _input, index) =>
  index % 3 === 0
    ? '# Subject\n\nRepository documentation.'
    : index % 3 === 1
      ? 'Documents repository behavior.'
      : 'documentation';

export const evidencePath = (input: string): string => {
  const match = input.match(
    /^## Path\r?\n\r?\n(`{3,}|~{3,})text\r?\n([\s\S]*?)\r?\n\1\r?$/mu,
  );
  if (match?.[2] === undefined) throw new Error('Missing Path evidence');
  return match[2];
};

const finish = (structured: unknown): ProviderFinished<unknown> => ({
  text:
    structured === undefined
      ? ''
      : typeof structured === 'string'
        ? structured
        : JSON.stringify(structured),
  finishReason: 'stop',
  toolCalls: [],
  structured: typeof structured === 'string' ? undefined : structured,
});
