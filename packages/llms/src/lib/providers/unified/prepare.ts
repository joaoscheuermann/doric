import { ProviderErrorObject } from '../../classes/provider-error.js';
import type { ProviderMessage, ProviderRequest } from '../../types/provider.js';
import { requestReasoningEffort } from '../common.js';
import type { PreparedOpenRouterRequest } from '../openrouter.js';
import type { OpenRouterModelSupport } from './catalog.js';
import { unifiedProfileForModel } from './profiles.js';

type SupportResolver = (
  model: string,
  signal?: AbortSignal,
) => Promise<OpenRouterModelSupport>;

const curatedSupport: OpenRouterModelSupport = {
  known: false,
  parameters: new Set(),
};

export const createUnifiedRequestPreparer =
  (resolve: SupportResolver, upstreamModel?: string) =>
  async (
    request: ProviderRequest<unknown>,
  ): Promise<PreparedOpenRouterRequest> => {
    const hasTools = (request.tools?.length ?? 0) > 0;

    if (hasTools && request.schema !== undefined) {
      throw new ProviderErrorObject({
        provider: 'unified',
        code: 'unsupported_structured_tools',
        message:
          'Unified direct structured output cannot be combined with tools. Use the agent terminal-tool contract for tool-enabled structured runs.',
      });
    }

    const needsSupport = hasTools || request.schema !== undefined;
    const support =
      needsSupport && upstreamModel === undefined
        ? await resolve(request.model, request.signal)
        : curatedSupport;
    const profile = unifiedProfileForModel(upstreamModel ?? request.model);

    requireToolSupport(request, support, profile.tools);
    requireCompatibleChoice(request, support, profile);

    const structuredOutput = structuredStrategy(request, support);
    const normalized = normalizeParallelToolCalls(
      normalizeToolChoice(request, support),
      support,
    );
    const normalizedHasTools = (normalized.tools?.length ?? 0) > 0;
    const preparedRequest =
      request.parallelToolCalls === false && normalizedHasTools
        ? {
            ...normalized,
            messages: withSequentialToolInstruction(normalized.messages),
          }
        : normalized;

    return {
      request: preparedRequest,
      bodyOptions: {
        structuredOutput,
        replay: profile.replay,
        strictTools: profile.strictTools,
        requireParameters:
          normalizedHasTools ||
          (request.schema !== undefined && structuredOutput !== 'prompt'),
      },
    };
  };

const requireToolSupport = (
  request: ProviderRequest<unknown>,
  support: OpenRouterModelSupport,
  profileTools: boolean,
): void => {
  if ((request.tools?.length ?? 0) === 0) return;
  if (support.known ? support.parameters.has('tools') : profileTools) return;

  throw new ProviderErrorObject({
    provider: 'unified',
    code: 'unsupported_model_feature',
    message: `Model ${request.model} does not advertise tool calling through OpenRouter.`,
  });
};

const requireCompatibleChoice = (
  request: ProviderRequest<unknown>,
  support: OpenRouterModelSupport,
  profile: ReturnType<typeof unifiedProfileForModel>,
): void => {
  const forced =
    request.toolChoice === 'required' || typeof request.toolChoice === 'object';

  if (!forced) return;

  if (hasReasoning(request) && !profile.forcedToolChoiceWithReasoning) {
    throw new ProviderErrorObject({
      provider: 'unified',
      code: 'incompatible_model_request',
      message: `${profile.lab} models cannot combine forced tool choice with the requested reasoning mode.`,
    });
  }

  const supported = support.known
    ? support.parameters.has('tool_choice')
    : profile.forcedToolChoice === 'full';

  const curatedRestriction =
    profile.lab !== 'unknown' && profile.forcedToolChoice !== 'full';

  if (!supported || curatedRestriction) {
    throw new ProviderErrorObject({
      provider: 'unified',
      code: 'unsupported_model_feature',
      message: `Model ${request.model} does not support forced tool choice through OpenRouter.`,
    });
  }
};

const hasReasoning = (request: ProviderRequest<unknown>): boolean => {
  const effort = requestReasoningEffort(request);
  if (effort !== undefined) return effort !== 'none';

  return (
    request.flags?.reasoning === true ||
    typeof request.flags?.reasoning === 'object'
  );
};

const structuredStrategy = (
  request: ProviderRequest<unknown>,
  support: OpenRouterModelSupport,
): 'json_schema' | 'json_object' | 'prompt' => {
  if (request.schema === undefined) return 'json_schema';
  if (support.parameters.has('structured_outputs')) return 'json_schema';
  if (support.parameters.has('response_format')) return 'json_object';
  return 'prompt';
};

const normalizeToolChoice = (
  request: ProviderRequest<unknown>,
  support: OpenRouterModelSupport,
): ProviderRequest<unknown> => {
  if (!support.known || support.parameters.has('tool_choice')) return request;

  if (request.toolChoice === 'none') {
    const { tools: _tools, toolChoice: _choice, ...withoutTools } = request;
    return withoutTools;
  }

  if (request.toolChoice === 'auto') {
    const { toolChoice: _choice, ...withoutChoice } = request;
    return withoutChoice;
  }

  return request;
};

const normalizeParallelToolCalls = (
  request: ProviderRequest<unknown>,
  support: OpenRouterModelSupport,
): ProviderRequest<unknown> => {
  if (
    request.parallelToolCalls === undefined ||
    support.parameters.has('parallel_tool_calls')
  ) {
    return request;
  }

  const { parallelToolCalls: _parallel, ...withoutParallelControl } = request;
  return withoutParallelControl;
};

const sequentialToolInstruction: ProviderMessage = {
  role: 'system',
  content: [
    '# Tool use',
    '',
    'Call at most one available tool in each response.',
    'This limit applies only to the current response, not to the task or node.',
    'After receiving the result, call another tool in a later response when more work or recovery is needed.',
  ].join('\n'),
};

const withSequentialToolInstruction = (
  messages: readonly ProviderMessage[],
): readonly ProviderMessage[] => [
  ...messages.filter(({ role }) => role === 'system'),
  sequentialToolInstruction,
  ...messages.filter(({ role }) => role !== 'system'),
];
