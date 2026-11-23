// `models.provider/v1` 1.4.0 over an llms provider kind (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43):
// the one service implementation the four provider bundles serve from their
// `src/host/main.ts`.

import { createHash } from 'node:crypto';

import {
  fromJson,
  type MessageInitShape,
  type JsonObject as WireJsonObject,
  type JsonValue as WireJsonValue,
} from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import { ConnectError, type ServiceImpl } from '@connectrpc/connect';
import {
  type CatalogResult,
  ContractError,
  fromConnectError,
  isContractError,
  type ModelKindDescriptor,
} from 'bundle/contracts';
import type {
  AttachmentRef,
  CompleteRequest,
  ModelSchema,
  ProviderCallFlags as WireCallFlags,
  ProviderContentPart as WireContentPart,
  ProviderFinishedSchema,
  ProviderMessage as WireMessage,
  ProviderRequestOptions,
  ProviderService,
  ProviderStreamEventSchema,
  ProviderTarget,
  ProviderToolCall as WireToolCall,
  ToolDefinition as WireToolDefinition,
  UsageMetadataSchema,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import type { ToolDefinition } from 'tool';
import { fromJSONSchema } from 'zod';

import { ProviderErrorObject } from '../lib/classes/provider-error.js';
import type { ModelIconName } from '../lib/icons/index.js';
import type { SecretSource } from '../lib/providers/auth.js';
import {
  type LlmProvider,
  type Model,
  type ProviderCallFlags,
  type ProviderContentPart,
  type ProviderFinished,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderToolCall,
  type ReasoningRequest,
  reasoningEfforts,
  type StructuredOutputSchema,
  type UsageMetadata,
} from '../lib/types/provider.js';

/**
 * One provider kind as the service serves it. Each operation already holds
 * its transport and logger (the bundle closes over them), so the service
 * needs only data.
 */
export interface ProviderKindSource {
  /** The kind's descriptor; `Kind` answers it. */
  readonly kind: ModelKindDescriptor;
  /** Whether `GET /providers/kinds` lists the kind; `Advertised` answers it. */
  readonly advertised: boolean;
  /** Whether a built provider's `models()` reports context capacity; `CatalogCapacity` answers it. */
  readonly catalogCapacity: boolean;
  /**
   * Reads the kind's live catalog. Absent for a kind without one, whose
   * `Catalog` answers `{ status: 'absent' }`. A rejection fails `Catalog`
   * (`internal` unless it is a `ContractError`).
   */
  readonly catalog?: (input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  }) => Promise<CatalogResult>;
  /**
   * The icons the kind chooses. Pure and with no I/O. A throw fails `Icons`
   * (`internal`). `models` has the input's length and order; `null` is no icon.
   */
  readonly icons: (input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly models: readonly string[];
  }) => {
    readonly provider?: ModelIconName;
    readonly models: readonly (ModelIconName | null)[];
  };
  /**
   * Builds the configured provider. `values` are the target's values, plus the
   * target's `secret` under the kind's first field of kind `"secret"`, as a
   * source that answers the secret. Throws (synchronously) when a required
   * value is missing; the service answers that throw with `invalid_input`.
   */
  readonly build: (input: {
    readonly providerId: string;
    readonly values: Readonly<Record<string, SecretSource>>;
  }) => LlmProvider;
}

/**
 * One item of `runtime.attachments/v1.Read`, in the shape its generated
 * client yields. llms does not import `runtime`'s generated code, which a
 * package may not.
 */
export interface AttachmentReadItem {
  readonly item:
    | {
        readonly case: 'head';
        readonly value: {
          readonly attachment?: {
            readonly mediaType: string;
            readonly name: string;
          };
        };
      }
    | { readonly case: 'chunk'; readonly value: Uint8Array }
    | { readonly case: undefined; readonly value?: undefined };
}

/**
 * Opens `runtime.attachments/v1.Read({ id })` for the call being served (the
 * bundle passes `(id, signal) => context.services.use(AttachmentsService).read({ id }, { signal })`),
 * so the read inherits the served call's scope, trace and deadline. Rejects or
 * throws as that client does: a `ConnectError`.
 */
export type ReadAttachment = (
  id: string,
  signal: AbortSignal,
) => AsyncIterable<AttachmentReadItem>;

export interface ProviderServiceOptions {
  /** Reads an image part's bytes; see {@link ReadAttachment}. */
  readonly readAttachment: ReadAttachment;
}

// ---------------------------------------------------------------------------
// Values from the wire.
// ---------------------------------------------------------------------------

const invalid = (message: string): ContractError =>
  new ContractError('invalid_input', message);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `value` as one of `allowed`; anything else is `invalid_input`. */
const oneOf = <T extends string>(
  allowed: readonly T[],
  value: string,
  field: string,
): T => {
  const found = allowed.find((candidate) => candidate === value);

  if (found === undefined) {
    throw invalid(`${field} must be one of ${allowed.join(', ')}.`);
  }

  return found;
};

const optionalOneOf = <T extends string>(
  allowed: readonly T[],
  value: string | undefined,
  field: string,
): T | undefined =>
  value === undefined ? undefined : oneOf(allowed, value, field);

const roles = ['system', 'user', 'assistant', 'tool'] as const;
const toolResultStatuses = ['completed', 'incomplete'] as const;
const toolChoiceModes = ['auto', 'required', 'none'] as const;
const reasoningSummaries = ['auto', 'concise', 'detailed'] as const;
const serviceTiers = ['auto', 'default', 'priority'] as const;

const toolCallOf = (call: WireToolCall): ProviderToolCall => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
  index: call.index,
});

const toolOf = (tool: WireToolDefinition): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema ?? {},
  outputSchema: tool.outputSchema ?? {},
  strict: tool.strict,
});

const reasoningOf = (
  reasoning: WireCallFlags['reasoning'],
): ProviderCallFlags['reasoning'] => {
  switch (reasoning.case) {
    case 'reasoningEnabled':
      return reasoning.value;
    case 'reasoningRequest':
      return {
        effort: optionalOneOf(
          reasoningEfforts,
          reasoning.value.effort,
          'reasoning effort',
        ),
        summary: optionalOneOf(
          reasoningSummaries,
          reasoning.value.summary,
          'reasoning summary',
        ),
      } satisfies ReasoningRequest;
    default:
      return undefined;
  }
};

const flagsOf = (
  flags: WireCallFlags | undefined,
): ProviderCallFlags | undefined =>
  flags === undefined
    ? undefined
    : {
        reasoning: reasoningOf(flags.reasoning),
        serviceTier: optionalOneOf(
          serviceTiers,
          flags.serviceTier,
          'service tier',
        ),
        includeUsage: flags.includeUsage,
        includeStructuredSchemaOnSystemPrompt:
          flags.includeStructuredSchemaOnSystemPrompt,
      };

const toolChoiceOf = (
  choice: ProviderRequestOptions['toolChoice'],
): ProviderRequest['toolChoice'] => {
  switch (choice?.choice.case) {
    case 'mode':
      return oneOf(toolChoiceModes, choice.choice.value, 'tool choice');
    case 'name':
      return { name: choice.choice.value };
    default:
      return undefined;
  }
};

/** The JSON Schema text as the llms schema; not JSON or unreadable is `invalid_input`. */
const schemaOf = (
  text: string | undefined,
): StructuredOutputSchema | undefined => {
  if (text === undefined) {
    return undefined;
  }

  let parsed: Parameters<typeof fromJSONSchema>[0];

  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('The output schema is not JSON.');
  }

  try {
    return fromJSONSchema(parsed);
  } catch (error) {
    throw invalid(`The output schema cannot be read: ${messageOf(error)}`);
  }
};

// ---------------------------------------------------------------------------
// Values to the wire.
// ---------------------------------------------------------------------------

/** A value as JSON carries it; what JSON cannot carry is left out. */
const jsonOf = (value: unknown): WireJsonValue | undefined => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => jsonOf(item) ?? null);
  }

  if (typeof value === 'object') {
    return jsonObjectOf(value);
  }

  return undefined;
};

const jsonObjectOf = (value: object): WireJsonObject => {
  const object: WireJsonObject = {};

  for (const [key, member] of Object.entries(value)) {
    const json = jsonOf(member);

    if (json !== undefined) {
      object[key] = json;
    }
  }

  return object;
};

/** A value as a `google.protobuf.Value`; absent when JSON cannot carry it. */
const wireValue = (value: unknown): Value | undefined => {
  const json = jsonOf(value);

  return json === undefined ? undefined : fromJson(ValueSchema, json);
};

const wireUsage = (
  usage: UsageMetadata,
): MessageInitShape<typeof UsageMetadataSchema> => ({
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

const wireToolCall = (call: ProviderToolCall) => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
  index: call.index,
});

const wireFinished = (
  finished: ProviderFinished<unknown>,
): MessageInitShape<typeof ProviderFinishedSchema> => ({
  text: finished.text,
  finishReason: finished.finishReason,
  usage: finished.usage === undefined ? undefined : wireUsage(finished.usage),
  reasoning:
    finished.reasoning === undefined
      ? undefined
      : {
          text: finished.reasoning.text,
          effort: finished.reasoning.effort,
          summary: finished.reasoning.summary,
        },
  refusal: finished.refusal,
  toolCalls: finished.toolCalls.map(wireToolCall),
  replay: (finished.replay ?? []).map(jsonObjectOf),
  structured: wireValue(finished.structured),
});

const wireEvent = (
  event: ProviderStreamEvent<unknown>,
): MessageInitShape<typeof ProviderStreamEventSchema> => {
  switch (event.type) {
    case 'response.started':
      return {
        type: {
          case: 'responseStarted',
          value: {
            provider: event.provider,
            model: event.model,
            contextWindow: event.contextWindow,
          },
        },
      };
    case 'text.delta':
      return { type: { case: 'textDelta', value: { delta: event.delta } } };
    case 'reasoning.delta':
      return {
        type: { case: 'reasoningDelta', value: { delta: event.delta } },
      };
    case 'refusal.delta':
      return { type: { case: 'refusalDelta', value: { delta: event.delta } } };
    case 'tool_call.delta':
      return {
        type: {
          case: 'toolCallDelta',
          value: {
            index: event.index,
            id: event.id,
            name: event.name,
            argumentsDelta: event.argumentsDelta,
          },
        },
      };
    case 'tool_call.done':
      return {
        type: {
          case: 'toolCallDone',
          value: { call: wireToolCall(event.call) },
        },
      };
    case 'usage':
      return {
        type: { case: 'usage', value: { usage: wireUsage(event.usage) } },
      };
    case 'response.finished':
      return {
        type: {
          case: 'responseFinished',
          value: { finish: wireFinished(event.finish) },
        },
      };
    case 'error':
      return {
        type: {
          case: 'error',
          value: {
            error: {
              provider: event.error.provider,
              code: event.error.code,
              message: event.error.message,
              status: event.error.status,
              retryable: event.error.retryable,
              diagnostic: event.error.diagnostic,
              retryAfterMs: event.error.retryAfterMs,
              requestId: event.error.requestId,
            },
          },
        },
      };
  }
};

const wireModel = (model: Model): MessageInitShape<typeof ModelSchema> => ({
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  inputModalities: [...(model.inputModalities ?? [])],
  provider: model.provider,
  raw: wireValue(model.raw),
});

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** A thrown llms provider error as `provider_error`; any other value as it is. */
const failureOf = (error: unknown): unknown =>
  error instanceof ProviderErrorObject
    ? new ContractError('provider_error', error.data.message, {
        providerError: error.data,
      })
    : error;

const calling = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw failureOf(error);
  }
};

/** The codes of a `runtime.attachments/v1` that no provider answers. */
const absentAttachments: ReadonlySet<string> = new Set([
  'unavailable',
  'undeclared_requirement',
  'unknown_contract',
]);

const readFailureOf = (error: unknown): unknown => {
  const contractError =
    error instanceof ConnectError
      ? fromConnectError(error)
      : isContractError(error)
        ? error
        : undefined;

  if (contractError === undefined) {
    return error;
  }

  return absentAttachments.has(contractError.code)
    ? new ContractError(
        'unavailable',
        'No provider of runtime.attachments/v1 is available.',
      )
    : contractError;
};

/**
 * The `models.provider/v1` service of one kind.
 *
 * Descriptor RPCs. `Kind`, `Advertised` and `CatalogCapacity` answer
 * `source`'s fields; `Catalog` answers `source.catalog(...)` or `absent`;
 * `Icons` answers `source.icons(...)` with `null` written as `""`. These
 * build nothing and never see a `ProviderTarget`.
 *
 * Built providers. Every model RPC (`Complete`, `Stream`, `Embedding`,
 * `Rerank`, `Models`, `ValidateModel`) runs on the provider built for its
 * `target`. The service keeps at most one built provider per `providerId`,
 * keyed by the SHA-256 of the target's `values` (keys sorted) and `secret`
 * (absent and `""` differ). A target with the same `providerId`, values and
 * secret reuses the built provider; any change rebuilds it and drops the old
 * one, so a rotated secret reaches the next request and an old secret is not
 * kept. A build that throws caches nothing and fails the call with
 * `invalid_input` and the build's message.
 *
 * `Complete` (client streaming) and `Stream` (bidirectional) read every
 * request item before calling the provider. The first item must be `header`
 * and no later item may be one; otherwise the call fails with `invalid_input`
 * ("A completion starts with its header." / "A completion has one header.")
 * and the provider is not called. Each later `message` is one conversation
 * message, in order. `options.schema` is a JSON Schema text, turned into the
 * llms schema with zod's `fromJSONSchema`. Text that is not JSON, or a schema
 * zod cannot read, fails the call with `invalid_input`. `Complete` answers the
 * provider's `ProviderFinished`, with `structured` set when a schema was given.
 * `Stream` answers one item per llms stream event, in order (an llms `error`
 * event included), and ends when the provider's stream ends. The served call's
 * `signal` is the provider request's `signal`, so cancelling the call aborts
 * the provider's HTTP request.
 *
 * Images by reference. Before calling the provider, each image part with an
 * `attachment` is read with `options.readAttachment(id, call.signal)`. The
 * chunks are concatenated in memory and passed to the provider as a
 * `data:<mediaType>;base64,…` URL. The media type is the `Read` head's,
 * else the ref's `mediaType`. The parts are read one at a time, in message
 * order. An image part with a `url` is passed as that URL. The read fails
 * the call:
 * - with `unavailable` when no provider of `runtime.attachments/v1` answers
 *   (`unavailable`, `undeclared_requirement` or `unknown_contract`);
 * - with `not_found` "Attachment <id> is not available." when the head holds
 *   no attachment;
 * - otherwise with the read's own error.
 * In each case the model provider is not called. No byte of an image is
 * logged, and no image is cached beyond the call.
 *
 * Errors. A thrown llms `ProviderErrorObject` fails the call with
 * `ContractError('provider_error', data.message, { providerError: data })`:
 * every field of the llms `ProviderError` as JSON, so `models/v1`'s caller
 * can rebuild it. A `ContractError` passes unchanged; any other value becomes
 * `internal` with its message (the SDK's rule). `ValidateModel` of an unknown
 * model fails as the provider's `validateModel` does.
 *
 * Secrets. `target.secret` and `CatalogRequest.secret` never appear in a log,
 * an error or a diagnostic. Holds no state other than the built-provider
 * cache, so one service may serve several calls at once.
 */
export const serveProviderKind = (
  source: ProviderKindSource,
  options: ProviderServiceOptions,
): ServiceImpl<typeof ProviderService> => {
  const secretKey = source.kind.fields.find(
    (field) => field.kind === 'secret',
  )?.key;
  /** The provider built per `providerId`, with the key of its target. */
  const built = new Map<
    string,
    { readonly key: string; readonly provider: LlmProvider }
  >();

  const providerFor = (target: ProviderTarget | undefined): LlmProvider => {
    if (target === undefined) {
      throw invalid('A provider target is required.');
    }

    const { providerId, values, secret } = target;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          Object.entries(values).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
          secret ?? null,
        ]),
      )
      .digest('hex');
    const cached = built.get(providerId);

    if (cached?.key === key) {
      return cached.provider;
    }

    built.delete(providerId);

    const sources: Record<string, SecretSource> = { ...values };

    if (secret !== undefined && secretKey !== undefined) {
      sources[secretKey] = () => secret;
    }

    let provider: LlmProvider;

    try {
      provider = source.build({ providerId, values: sources });
    } catch (error) {
      throw invalid(messageOf(error));
    }

    built.set(providerId, { key, provider });

    return provider;
  };

  /** The image as a `data:` URL, read through `runtime.attachments/v1`. */
  const dataUrlOf = async (
    ref: AttachmentRef,
    signal: AbortSignal,
  ): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let mediaType: string | undefined;

    try {
      for await (const { item } of options.readAttachment(ref.id, signal)) {
        if (item.case === 'head') {
          if (item.value.attachment === undefined) {
            break;
          }

          mediaType = item.value.attachment.mediaType;
        } else if (item.case === 'chunk' && mediaType !== undefined) {
          chunks.push(item.value);
        }
      }
    } catch (error) {
      throw readFailureOf(error);
    }

    if (mediaType === undefined) {
      throw new ContractError(
        'not_found',
        `Attachment ${ref.id} is not available.`,
      );
    }

    return `data:${mediaType === '' ? ref.mediaType : mediaType};base64,${Buffer.concat(chunks).toString('base64')}`;
  };

  const partOf = async (
    part: WireContentPart,
    signal: AbortSignal,
  ): Promise<ProviderContentPart> => {
    switch (part.type.case) {
      case 'text':
        return { type: 'text', text: part.type.value.text };
      case 'image': {
        const image = part.type.value.source;

        switch (image.case) {
          case 'url':
            return { type: 'image', imageUrl: image.value };
          case 'attachment':
            return {
              type: 'image',
              imageUrl: await dataUrlOf(image.value, signal),
            };
          default:
            throw invalid('An image part has no source.');
        }
      }
      default:
        throw invalid('A content part has no type.');
    }
  };

  const messageFrom = async (
    message: WireMessage,
    signal: AbortSignal,
  ): Promise<ProviderMessage> => {
    let content: ProviderMessage['content'];

    if (message.content.case === 'text') {
      content = message.content.value;
    } else if (message.content.case === 'parts') {
      const parts: ProviderContentPart[] = [];

      for (const part of message.content.value.parts) {
        parts.push(await partOf(part, signal));
      }

      content = parts;
    }

    return {
      role: oneOf(roles, message.role, 'role'),
      content,
      name: message.name,
      toolCallId: message.toolCallId,
      toolResultStatus: optionalOneOf(
        toolResultStatuses,
        message.toolResultStatus,
        'tool result status',
      ),
      toolCalls: message.toolCalls.map(toolCallOf),
      replay: message.replay,
    };
  };

  /**
   * Reads a completion's items: the header, then the messages. Builds the
   * provider and reads the images before any provider call.
   */
  const completionOf = async (
    requests: AsyncIterable<Pick<CompleteRequest, 'item'>>,
    signal: AbortSignal,
  ): Promise<{
    readonly provider: LlmProvider;
    readonly request: ProviderRequest;
  }> => {
    let header:
      | Extract<CompleteRequest['item'], { case: 'header' }>['value']
      | undefined;
    const messages: WireMessage[] = [];

    for await (const { item } of requests) {
      if (header === undefined) {
        if (item.case !== 'header') {
          throw invalid('A completion starts with its header.');
        }

        header = item.value;
      } else if (item.case === 'header') {
        throw invalid('A completion has one header.');
      } else if (item.case === 'message') {
        messages.push(item.value);
      }
    }

    if (header === undefined) {
      throw invalid('A completion starts with its header.');
    }

    const { options: callOptions } = header;

    if (callOptions === undefined) {
      throw invalid('A completion header carries its options.');
    }

    const schema = schemaOf(callOptions.schema);
    const provider = providerFor(header.target);
    const conversation: ProviderMessage[] = [];

    for (const message of messages) {
      conversation.push(await messageFrom(message, signal));
    }

    return {
      provider,
      request: {
        model: callOptions.model,
        messages: conversation,
        tools: callOptions.tools.map(toolOf),
        toolChoice: toolChoiceOf(callOptions.toolChoice),
        parallelToolCalls: callOptions.parallelToolCalls,
        schema,
        effort: optionalOneOf(reasoningEfforts, callOptions.effort, 'effort'),
        temperature: callOptions.temperature,
        maxOutputTokens: callOptions.maxOutputTokens,
        flags: flagsOf(callOptions.flags),
        signal,
      },
    };
  };

  return {
    kind: () => ({ modelKindDescriptor: source.kind }),
    advertised: () => ({ advertised: source.advertised }),
    catalogCapacity: () => ({ catalogCapacity: source.catalogCapacity }),
    catalog: async ({ configuration, secret }) => ({
      catalogResult:
        source.catalog === undefined
          ? { status: 'absent' }
          : await source.catalog({
              configuration,
              ...(secret === undefined ? {} : { secret }),
            }),
    }),
    icons: ({ configuration, models }) => {
      const choice = source.icons({ configuration, models });

      return {
        modelIconChoice: {
          provider: choice.provider,
          models: choice.models.map((icon) => icon ?? ''),
        },
      };
    },
    complete: async (requests, context) => {
      const { provider, request } = await completionOf(
        requests,
        context.signal,
      );
      const finished = await calling(() => provider.complete(request));

      return { providerFinished: wireFinished(finished) };
    },
    async *stream(requests, context) {
      const { provider, request } = await completionOf(
        requests,
        context.signal,
      );

      try {
        for await (const event of provider.stream(request)) {
          yield { providerStreamEvent: wireEvent(event) };
        }
      } catch (error) {
        throw failureOf(error);
      }
    },
    embedding: async ({ target, request }, context) => {
      if (request === undefined) {
        throw invalid('An embedding request is required.');
      }

      const provider = providerFor(target);
      const finished = await calling(() =>
        provider.embedding({
          model: request.model,
          input: request.input,
          dimensions: request.dimensions,
          signal: context.signal,
        }),
      );

      return {
        providerEmbeddingFinished: {
          embedding: [...finished.embedding],
          usage:
            finished.usage === undefined
              ? undefined
              : wireUsage(finished.usage),
        },
      };
    },
    rerank: async ({ target, request }, context) => {
      if (request === undefined) {
        throw invalid('A rerank request is required.');
      }

      const provider = providerFor(target);
      const finished = await calling(() =>
        provider.rerank({
          model: request.model,
          query: request.query,
          documents: request.documents,
          topN: request.topN,
          signal: context.signal,
        }),
      );

      return {
        providerRerankFinished: {
          results: finished.results.map(({ index, relevanceScore }) => ({
            index,
            relevanceScore,
          })),
          usage:
            finished.usage === undefined
              ? undefined
              : wireUsage(finished.usage),
        },
      };
    },
    models: async ({ target }, context) => {
      const provider = providerFor(target);
      const models = await calling(() => provider.models(context.signal));

      return { models: models.map(wireModel) };
    },
    validateModel: async ({ target, model }, context) => {
      const provider = providerFor(target);
      const validated = await calling(() =>
        provider.validateModel(model, context.signal),
      );

      return { model: wireModel(validated) };
    },
  };
};
