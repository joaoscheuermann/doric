import type {
  JsonValue,
  LlmProvider,
  ProviderFinished,
  ProviderRequest,
  ProviderStreamEvent,
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
        tools: false,
        reasoning: true,
        modelListing: false,
        oauth: false,
        serviceTier: false,
        structuredOutputs: true,
      },
      complete: async <Result = JsonValue>(
        request: ProviderRequest<Result>,
      ) => {
        const index = requests.length;

        requests.push(request);

        const system = text(request, 'system');
        const input = text(request, 'user');
        const structured = await output(system, input, index, request);

        return finish(structured) as ProviderFinished<Result>;
      },
      stream: async function* <Result = JsonValue>() {
        yield* [] as ProviderStreamEvent<Result>[];
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

  if (typeof content !== 'string') {
    throw new Error(`Missing ${role} message`);
  }

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

  if (match?.[2] === undefined) {
    throw new Error('Missing Path evidence');
  }

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
