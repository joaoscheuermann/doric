// The routed `LlmProvider` over `models/v1` (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S51b):
// the caller side of `serveProviderKind`, used by a host part that runs model
// calls through the router.

import {
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type {
  Model as WireModel,
  ProviderContentPartSchema,
  ProviderFinished as WireFinished,
  ProviderMessageSchema,
  ProviderRequestOptionsSchema,
  ProviderStreamEvent as WireEvent,
  UsageMetadata as WireUsage,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import type {
  CompleteRequestSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { z } from 'zod';

import { ProviderErrorObject } from '../lib/classes/provider-error.js';
import type {
  FinishReason,
  JsonObject,
  JsonValue,
  LlmProvider,
  Model,
  ProviderContentPart,
  ProviderError,
  ProviderFinished,
  ProviderMessage,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderStructuredFinished,
  ReasoningEffort,
  StructuredOutputSchema,
  StructuredOutputValue,
  UsageMetadata,
} from '../lib/types/provider.js';
import { jsonObjectOf, toolCallOf, wireToolCall } from './wire.js';

/** An attachment of the Thread's Project, as `executor.session/v1.DescribeAttachment` names it. */
export interface AttachmentImage {
  readonly id: string;
  readonly mediaType: string;
  readonly name?: string;
}

const attachmentScheme = 'doric-attachment:';

/**
 * The `imageUrl` of an image part that refers to an attachment instead of carrying it:
 * `doric-attachment:<id>?mediaType=<mediaType>[&name=<name>]`, each value percent-encoded. Only
 * {@link modelsLanguageModel} reads it (as `AttachmentRef`); an in-process llms provider does not. Pure; never throws.
 */
export const attachmentImageUrl = (image: AttachmentImage): string =>
  `${attachmentScheme}${encodeURIComponent(image.id)}?mediaType=${encodeURIComponent(image.mediaType)}${
    image.name === undefined ? '' : `&name=${encodeURIComponent(image.name)}`
  }`;

// ---------------------------------------------------------------------------
// Values to the wire.
// ---------------------------------------------------------------------------

const invalidImage = (): ContractError =>
  new ContractError(
    'invalid_input',
    'An image part must be an https: URL or an attachment.',
  );

/** The attachment an `attachmentImageUrl` names; `undefined` for any other URL. */
const attachmentOf = (imageUrl: string): AttachmentImage | undefined => {
  if (!imageUrl.startsWith(attachmentScheme)) {
    return undefined;
  }

  const rest = imageUrl.slice(attachmentScheme.length);
  const query = rest.indexOf('?');

  if (query <= 0) {
    return undefined;
  }

  try {
    const params = new URLSearchParams(rest.slice(query + 1));
    const mediaType = params.get('mediaType');
    const name = params.get('name');

    if (mediaType === null) {
      return undefined;
    }

    return {
      id: decodeURIComponent(rest.slice(0, query)),
      mediaType,
      ...(name === null ? {} : { name }),
    };
  } catch {
    return undefined;
  }
};

const isHttpsUrl = (imageUrl: string): boolean => {
  try {
    return new URL(imageUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

const wirePart = (
  part: ProviderContentPart,
): MessageInitShape<typeof ProviderContentPartSchema> => {
  if (part.type === 'text') {
    return { type: { case: 'text', value: { text: part.text } } };
  }

  if (isHttpsUrl(part.imageUrl)) {
    return {
      type: {
        case: 'image',
        value: { source: { case: 'url', value: part.imageUrl } },
      },
    };
  }

  const attachment = attachmentOf(part.imageUrl);

  if (attachment === undefined) {
    throw invalidImage();
  }

  return {
    type: {
      case: 'image',
      value: { source: { case: 'attachment', value: attachment } },
    },
  };
};

const wireMessage = (
  message: ProviderMessage,
): MessageInitShape<typeof ProviderMessageSchema> => ({
  role: message.role,
  content:
    message.content === undefined
      ? { case: undefined }
      : typeof message.content === 'string'
        ? { case: 'text', value: message.content }
        : {
            case: 'parts',
            value: { parts: message.content.map(wirePart) },
          },
  name: message.name,
  toolCallId: message.toolCallId,
  toolResultStatus: message.toolResultStatus,
  toolCalls: (message.toolCalls ?? []).map(wireToolCall),
  replay: (message.replay ?? []).map(jsonObjectOf),
});

const wireOptions = (
  request: ProviderRequest<unknown>,
): MessageInitShape<typeof ProviderRequestOptionsSchema> => {
  const { toolChoice, flags, schema } = request;

  return {
    model: request.model,
    tools: (request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: jsonObjectOf(tool.inputSchema),
      outputSchema: jsonObjectOf(tool.outputSchema),
      strict: tool.strict,
    })),
    toolChoice:
      toolChoice === undefined
        ? undefined
        : typeof toolChoice === 'string'
          ? { choice: { case: 'mode', value: toolChoice } }
          : { choice: { case: 'name', value: toolChoice.name } },
    parallelToolCalls: request.parallelToolCalls,
    schema:
      schema === undefined
        ? undefined
        : JSON.stringify(z.toJSONSchema(schema)),
    effort: request.effort,
    temperature: request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    flags:
      flags === undefined
        ? undefined
        : {
            reasoning:
              flags.reasoning === undefined
                ? { case: undefined }
                : typeof flags.reasoning === 'boolean'
                  ? { case: 'reasoningEnabled', value: flags.reasoning }
                  : {
                      case: 'reasoningRequest',
                      value: {
                        effort: flags.reasoning.effort,
                        summary: flags.reasoning.summary,
                      },
                    },
            serviceTier: flags.serviceTier,
            includeUsage: flags.includeUsage,
            includeStructuredSchemaOnSystemPrompt:
              flags.includeStructuredSchemaOnSystemPrompt,
          },
  };
};

/** One item of a `Complete` or `Stream` request. */
type CompletionItem = NonNullable<
  MessageInitShape<typeof CompleteRequestSchema>['item']
>;

/** A completion's items: the header, then one per message. Throws before any call on an unsendable image. */
const completionItems = (
  providerId: string,
  request: ProviderRequest<unknown>,
): CompletionItem[] => [
  {
    case: 'header',
    value: { providerId, options: wireOptions(request) },
  },
  ...request.messages.map(
    (message): CompletionItem => ({
      case: 'message',
      value: wireMessage(message),
    }),
  ),
];

/** The items as the request stream of `Complete` or `Stream`. */
const itemsOf = (
  items: readonly CompletionItem[],
): AsyncIterable<{ readonly item: CompletionItem }> =>
  createAsyncIterable(items.map((item) => ({ item })));

// ---------------------------------------------------------------------------
// Values from the wire.
// ---------------------------------------------------------------------------

const jsonValueOf = (value: Value | undefined): JsonValue | undefined =>
  value === undefined ? undefined : (toJson(ValueSchema, value) as JsonValue);

const usageOf = (usage: WireUsage): UsageMetadata => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
  reasoningTokens: usage.reasoningTokens,
  cachedInputTokens: usage.cachedInputTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  searchUnits: usage.searchUnits,
  cost:
    usage.cost === undefined
      ? undefined
      : {
          amount: usage.cost.amount,
          unit: usage.cost.unit,
          upstreamAmount: usage.cost.upstreamAmount,
        },
});

const finishedOf = (finished: WireFinished): ProviderFinished => ({
  text: finished.text,
  // `models.provider/v1` validates the reason against llms' list.
  finishReason: finished.finishReason as FinishReason,
  usage: finished.usage === undefined ? undefined : usageOf(finished.usage),
  reasoning:
    finished.reasoning === undefined
      ? undefined
      : {
          text: finished.reasoning.text,
          effort: finished.reasoning.effort as ReasoningEffort | undefined,
          summary: finished.reasoning.summary,
        },
  refusal: finished.refusal,
  toolCalls: finished.toolCalls.map(toolCallOf),
  replay: finished.replay.map((item): JsonObject => ({ ...item })),
  structured: jsonValueOf(finished.structured),
});

/** An answered stream item as llms' event; `undefined` for an item without a case. */
const eventOf = (event: WireEvent): ProviderStreamEvent | undefined => {
  const { type } = event;

  switch (type.case) {
    case 'responseStarted':
      return {
        type: 'response.started',
        provider: type.value.provider,
        model: type.value.model,
        contextWindow: type.value.contextWindow,
      };
    case 'textDelta':
      return { type: 'text.delta', delta: type.value.delta };
    case 'reasoningDelta':
      return { type: 'reasoning.delta', delta: type.value.delta };
    case 'refusalDelta':
      return { type: 'refusal.delta', delta: type.value.delta };
    case 'toolCallDelta':
      return {
        type: 'tool_call.delta',
        index: type.value.index,
        id: type.value.id,
        name: type.value.name,
        argumentsDelta: type.value.argumentsDelta,
      };
    case 'toolCallDone':
      return type.value.call === undefined
        ? undefined
        : { type: 'tool_call.done', call: toolCallOf(type.value.call) };
    case 'usage':
      return type.value.usage === undefined
        ? undefined
        : { type: 'usage', usage: usageOf(type.value.usage) };
    case 'responseFinished':
      return type.value.finish === undefined
        ? undefined
        : { type: 'response.finished', finish: finishedOf(type.value.finish) };
    case 'error': {
      const { error } = type.value;

      return error === undefined
        ? undefined
        : {
            type: 'error',
            error: {
              provider: error.provider,
              code: error.code,
              message: error.message,
              status: error.status,
              retryable: error.retryable,
              diagnostic: error.diagnostic,
              retryAfterMs: error.retryAfterMs,
              requestId: error.requestId,
            },
          };
    }
    default:
      return undefined;
  }
};

const modelOf = (model: WireModel): Model => ({
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  inputModalities: [...model.inputModalities],
  provider: model.provider,
  raw: jsonValueOf(model.raw),
});

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** The codes of a model call that failed between bundles, not at the provider. */
const lostCalls: ReadonlySet<string> = new Set([
  'unavailable',
  'generation_lost',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `details.providerError` when it is an llms provider error's data. */
const providerErrorData = (details: unknown): ProviderError | undefined => {
  const data = isRecord(details) ? details.providerError : undefined;

  return isRecord(data) &&
    typeof data.provider === 'string' &&
    typeof data.code === 'string' &&
    typeof data.message === 'string'
    ? (data as unknown as ProviderError)
    : undefined;
};

/** A failed call as the caller reads it (see {@link modelsLanguageModel}). */
const failureOf = (providerId: string, error: unknown): unknown => {
  const contractError =
    error instanceof ConnectError
      ? fromConnectError(error)
      : isContractError(error)
        ? error
        : undefined;

  if (contractError === undefined) {
    return error;
  }

  if (contractError.code === 'provider_error') {
    const data = providerErrorData(contractError.details);

    return data === undefined ? contractError : new ProviderErrorObject(data);
  }

  if (lostCalls.has(contractError.code)) {
    return new ProviderErrorObject({
      provider: providerId,
      code: 'network_error',
      retryable: true,
      message: contractError.message,
    });
  }

  return contractError;
};

/**
 * An `LlmProvider` whose every operation is a `models/v1` call for the configured provider `providerId`, through
 * `models` (a client of the calling host part, so each call inherits the handler call's scope, deadline and trace).
 * Makes no call until an operation is used; holds no state.
 *
 * - `complete(request)`: `Complete` — a first item `{header: {providerId, options}}`, then one `{message}` per
 *   `request.messages` item, in order. `options` holds every request field but `messages` and `signal`: `tools` as
 *   definitions with JSON Schema text, `schema` as `JSON.stringify(z.toJSONSchema(schema))`, `flags`, `effort`, …
 *   Answers `providerFinished` as llms' `ProviderFinished`. With `request.schema`, `structured` is
 *   `request.schema.parse`d; a mismatch rejects with `ProviderErrorObject({provider: providerId, code:
 *   'invalid_structured_output', message})`.
 * - `stream(request)`: `Stream` with the same items; yields one llms `ProviderStreamEvent` per answered item, in
 *   order; an `error` item is yielded as `{type: 'error', error}` (not thrown). Ending the iteration early cancels
 *   the call.
 * - `embedding`, `rerank`, `models(signal?)`, `validateModel(model, signal?)`: the unary methods with `providerId`.
 * - Each call's `signal` is `request.signal` (or the argument), so aborting it cancels the call.
 * - Content parts: text as text; an image whose `imageUrl` is an `https:` URL as `url`; one made by
 *   {@link attachmentImageUrl} as `attachment {id, mediaType, name?}`. Any other image URL (`data:`, `http:`, …)
 *   rejects with `ContractError('invalid_input', 'An image part must be an https: URL or an attachment.')` before
 *   any call.
 * - Errors: a call failing `provider_error` whose `details.providerError` is an object with string `provider`,
 *   `code` and `message` rejects (or ends the stream) with `new ProviderErrorObject(details.providerError)` — every
 *   field kept, so `packages/agent`'s retry and `isContextOverflowError` read it as in process. A call failing
 *   between bundles (`unavailable`, `generation_lost`) rejects (or ends the stream) with a retryable
 *   `ProviderErrorObject({provider: providerId, code: 'network_error', retryable: true, message})` (coordinator
 *   decision 10). Any other failure, `provider_error` with malformed details included, rejects as
 *   `fromConnectError` reads it (a `ContractError`).
 * - `metadata`: `{ id: providerId, name: providerId, baseUrl: '' }`; `capabilities`: every flag `true` (an
 *   operation the provider lacks fails as the provider's own error).
 */
export const modelsLanguageModel = (
  models: Client<typeof ModelsService>,
  providerId: string,
): LlmProvider => {
  const calling = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw failureOf(providerId, error);
    }
  };

  /** `finished` with `structured` parsed by the request's schema, when it has one. */
  const structuredOf = <Output>(
    request: ProviderRequest<Output>,
    finished: ProviderFinished,
  ): ProviderFinished<Output> => {
    if (request.schema === undefined) {
      return finished as ProviderFinished<Output>;
    }

    const parsed = request.schema.safeParse(finished.structured);

    if (!parsed.success) {
      throw new ProviderErrorObject({
        provider: providerId,
        code: 'invalid_structured_output',
        message: `${providerId} returned structured output that does not match the schema: ${parsed.error.message}`,
      });
    }

    return { ...finished, structured: parsed.data as Output };
  };

  function complete<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<StructuredOutputValue<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): Promise<ProviderStructuredFinished<StructuredOutputValue<Schema>>>;
  function complete<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderFinished<Output>>;
  async function complete<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): Promise<ProviderFinished<Output>> {
    const items = completionItems(providerId, request);
    const { providerFinished } = await calling(() =>
      models.complete(itemsOf(items), { signal: request.signal }),
    );

    if (providerFinished === undefined) {
      throw new ContractError(
        'invalid_output',
        'A completion answered no result.',
      );
    }

    return structuredOf(request, finishedOf(providerFinished));
  }

  function stream<Schema extends StructuredOutputSchema>(
    request: ProviderRequest<StructuredOutputValue<Schema>, Schema> & {
      readonly schema: Schema;
    },
  ): AsyncIterable<ProviderStreamEvent<StructuredOutputValue<Schema>>>;
  function stream<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): AsyncIterable<ProviderStreamEvent<Output>>;
  async function* stream<Output = JsonValue>(
    request: ProviderRequest<Output>,
  ): AsyncIterable<ProviderStreamEvent<Output>> {
    const items = completionItems(providerId, request);
    const cancel = new AbortController();
    const signal =
      request.signal === undefined
        ? cancel.signal
        : AbortSignal.any([request.signal, cancel.signal]);

    try {
      for await (const { providerStreamEvent } of models.stream(
        itemsOf(items),
        { signal },
      )) {
        const event =
          providerStreamEvent === undefined
            ? undefined
            : eventOf(providerStreamEvent);

        if (event !== undefined) {
          // The wire carries JSON; `Output` is what the caller's schema reads.
          yield event as ProviderStreamEvent<Output>;
        }
      }
    } catch (error) {
      throw failureOf(providerId, error);
    } finally {
      cancel.abort();
    }
  }

  return {
    metadata: { id: providerId, name: providerId, baseUrl: '' },
    capabilities: {
      streaming: true,
      embeddings: true,
      reranking: true,
      tools: true,
      reasoning: true,
      modelListing: true,
      oauth: true,
      serviceTier: true,
      structuredOutputs: true,
    },
    complete,
    stream,
    embedding: async ({ signal, ...request }) => {
      const { providerEmbeddingFinished: finished } = await calling(() =>
        models.embedding(
          { providerId, request: { ...request } },
          { signal },
        ),
      );

      return {
        embedding: [...(finished?.embedding ?? [])],
        usage:
          finished?.usage === undefined ? undefined : usageOf(finished.usage),
      };
    },
    rerank: async ({ signal, ...request }) => {
      const { providerRerankFinished: finished } = await calling(() =>
        models.rerank(
          {
            providerId,
            request: { ...request, documents: [...request.documents] },
          },
          { signal },
        ),
      );

      return {
        results: (finished?.results ?? []).map(({ index, relevanceScore }) => ({
          index,
          relevanceScore,
        })),
        usage:
          finished?.usage === undefined ? undefined : usageOf(finished.usage),
      };
    },
    models: async (signal) => {
      const answer = await calling(() =>
        models.models({ providerId }, { signal }),
      );

      return answer.models.map(modelOf);
    },
    validateModel: async (model, signal) => {
      const answer = await calling(() =>
        models.validateModel({ providerId, model }, { signal }),
      );

      if (answer.model === undefined) {
        throw new ContractError('invalid_output', 'No model was answered.');
      }

      return modelOf(answer.model);
    },
  };
};
