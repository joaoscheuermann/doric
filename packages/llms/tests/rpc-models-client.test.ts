// The routed `LlmProvider` over `models/v1` (spec `docs/designs/grpc-processes.md`,
// "Model providers"; phase 3, slice S51b, contract §4.4, tests B1-B11 and
// coordinator decision 10): `modelsLanguageModel` calls a `ModelsService`
// client of a test router. The router serves `serveProviderKind` over a
// scripted `LlmProvider` and a relaying `ModelsService` that forwards each
// `models/v1` call to it, as `core` does, and records what it received.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  type Client,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
  type ModelKindDescriptor,
} from 'bundle/contracts';
import {
  type ProviderCallHeaderSchema,
  type ProviderMessage as WireMessage,
  type ProviderRequestOptions,
  ProviderService,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type { HostContext } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import { z } from 'zod';

import {
  type LlmProvider,
  type Model,
  type ProviderEmbeddingFinished,
  type ProviderEmbeddingRequest,
  type ProviderError,
  ProviderErrorObject,
  type ProviderFinished,
  type ProviderRequest,
  type ProviderRerankFinished,
  type ProviderRerankRequest,
  type ProviderStreamEvent,
} from '../src/index.js';
import {
  attachmentImageUrl,
  modelsLanguageModel,
  serveProviderKind,
} from '../src/rpc/index.js';

// ---------------------------------------------------------------------------
// The scripted provider behind `models.provider/v1`.
// ---------------------------------------------------------------------------

const fakeKind: ModelKindDescriptor = {
  id: 'fake',
  label: 'Fake',
  description: 'A scripted provider kind.',
  fields: [],
  lists: ['models'],
};

interface Script {
  readonly complete?: (request: ProviderRequest) => Promise<ProviderFinished>;
  readonly stream?: (
    request: ProviderRequest,
  ) => AsyncIterable<ProviderStreamEvent>;
  readonly embedding?: (
    request: ProviderEmbeddingRequest,
  ) => Promise<ProviderEmbeddingFinished>;
  readonly rerank?: (
    request: ProviderRerankRequest,
  ) => Promise<ProviderRerankFinished>;
  readonly models?: () => Promise<readonly Model[]>;
  readonly validateModel?: (model: string) => Promise<Model>;
}

/** What reached the scripted provider. */
interface ProviderRecord {
  readonly requests: ProviderRequest[];
  readonly embeddings: ProviderEmbeddingRequest[];
  readonly reranks: ProviderRerankRequest[];
  readonly validated: string[];
}

async function* noEvents(): AsyncIterable<ProviderStreamEvent> {}

const scriptedProvider = (
  providerId: string,
  script: Script,
  recorded: ProviderRecord,
): LlmProvider =>
  ({
    metadata: { id: providerId, name: providerId, baseUrl: 'https://fake' },
    capabilities: {
      streaming: true,
      embeddings: true,
      reranking: true,
      tools: true,
      reasoning: true,
      modelListing: true,
      oauth: false,
      serviceTier: false,
      structuredOutputs: true,
    },
    complete: async (request: ProviderRequest) => {
      recorded.requests.push(request);

      return script.complete === undefined
        ? { text: 'ok', finishReason: 'stop', toolCalls: [] }
        : await script.complete(request);
    },
    stream: (request: ProviderRequest) => {
      recorded.requests.push(request);

      return script.stream === undefined ? noEvents() : script.stream(request);
    },
    embedding: async (request: ProviderEmbeddingRequest) => {
      recorded.embeddings.push(request);

      return script.embedding === undefined
        ? { embedding: [] }
        : await script.embedding(request);
    },
    rerank: async (request: ProviderRerankRequest) => {
      recorded.reranks.push(request);

      return script.rerank === undefined
        ? { results: [] }
        : await script.rerank(request);
    },
    models: async () =>
      script.models === undefined ? [] : await script.models(),
    validateModel: async (model: string) => {
      recorded.validated.push(model);

      return script.validateModel === undefined
        ? { id: model }
        : await script.validateModel(model);
    },
  }) as unknown as LlmProvider;

// ---------------------------------------------------------------------------
// The relaying `models/v1`, as `core` serves it.
// ---------------------------------------------------------------------------

/** One `models/v1` call the relay received. */
interface RelayCall {
  readonly method: string;
  readonly providerId: string;
  readonly signal: AbortSignal;
}

/** What the relay received, and the failures it is told to answer. */
interface Relay {
  readonly calls: RelayCall[];
  /** The header options of each `Complete` and `Stream`, in order. */
  readonly options: ProviderRequestOptions[];
  /** The messages of each `Complete` and `Stream`, in order. */
  readonly messages: WireMessage[][];
  /** The next call fails with this error, without reaching the provider. */
  failNext?: ContractError;
  /** A `Stream` fails with `error` once it relayed `after` events. */
  streamFailure?: { readonly after: number; readonly error: ContractError };
}

type ProviderItem = {
  readonly item:
    | {
        readonly case: 'header';
        readonly value: MessageInitShape<typeof ProviderCallHeaderSchema>;
      }
    | { readonly case: 'message'; readonly value: WireMessage };
};

async function* itemsOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/** A provider failure as the relay answers it: a Doric error, unchanged. */
const relayed = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

const relayService = (
  relay: Relay,
  provider: () => Client<typeof ProviderService>,
): ServiceImpl<typeof ModelsService> => {
  const target = (providerId: string) => ({ providerId, values: {} });
  const enter = (
    method: string,
    providerId: string,
    context: HandlerContext,
  ) => {
    relay.calls.push({ method, providerId, signal: context.signal });

    const failure = relay.failNext;

    if (failure !== undefined) {
      relay.failNext = undefined;
      throw failure;
    }
  };
  /** Reads a completion's items; answers them as `models.provider/v1` takes them. */
  const forward = async (
    method: string,
    requests: AsyncIterable<{
      readonly item:
        | {
            readonly case: 'header';
            readonly value: {
              readonly providerId: string;
              readonly options?: ProviderRequestOptions;
            };
          }
        | { readonly case: 'message'; readonly value: WireMessage }
        | { readonly case: undefined; readonly value?: undefined };
    }>,
    context: HandlerContext,
  ): Promise<ProviderItem[]> => {
    const items: ProviderItem[] = [];
    const messages: WireMessage[] = [];
    let providerId = '';

    for await (const { item } of requests) {
      if (item.case === 'header') {
        providerId = item.value.providerId;
        if (item.value.options !== undefined) {
          relay.options.push(item.value.options);
        }
        items.push({
          item: {
            case: 'header',
            value: {
              target: target(providerId),
              ...(item.value.options === undefined
                ? {}
                : { options: item.value.options }),
            },
          },
        });
      } else if (item.case === 'message') {
        messages.push(item.value);
        items.push({ item: { case: 'message', value: item.value } });
      }
    }

    relay.messages.push(messages);
    enter(method, providerId, context);

    return items;
  };

  return {
    complete: async (requests, context) => {
      const items = await forward('complete', requests, context);

      try {
        const { providerFinished } = await provider().complete(
          itemsOf(items),
          { signal: context.signal },
        );

        return { providerFinished };
      } catch (error) {
        throw relayed(error);
      }
    },
    stream: async function* (requests, context) {
      const items = await forward('stream', requests, context);
      let relayedEvents = 0;

      try {
        for await (const { providerStreamEvent } of provider().stream(
          itemsOf(items),
          { signal: context.signal },
        )) {
          if (relay.streamFailure?.after === relayedEvents) {
            throw relay.streamFailure.error;
          }

          yield { providerStreamEvent };
          relayedEvents += 1;
        }

        if (relay.streamFailure?.after === relayedEvents) {
          throw relay.streamFailure.error;
        }
      } catch (error) {
        throw relayed(error);
      }
    },
    embedding: async ({ providerId, request }, context) => {
      enter('embedding', providerId, context);

      try {
        const { providerEmbeddingFinished } = await provider().embedding(
          { target: target(providerId), request },
          { signal: context.signal },
        );

        return { providerEmbeddingFinished };
      } catch (error) {
        throw relayed(error);
      }
    },
    rerank: async ({ providerId, request }, context) => {
      enter('rerank', providerId, context);

      try {
        const { providerRerankFinished } = await provider().rerank(
          { target: target(providerId), request },
          { signal: context.signal },
        );

        return { providerRerankFinished };
      } catch (error) {
        throw relayed(error);
      }
    },
    models: async ({ providerId }, context) => {
      enter('models', providerId, context);

      try {
        return await provider().models(
          { target: target(providerId) },
          { signal: context.signal },
        );
      } catch (error) {
        throw relayed(error);
      }
    },
    validateModel: async ({ providerId, model }, context) => {
      enter('validateModel', providerId, context);

      try {
        return await provider().validateModel(
          { target: target(providerId), model },
          { signal: context.signal },
        );
      } catch (error) {
        throw relayed(error);
      }
    },
  } as Partial<ServiceImpl<typeof ModelsService>> as ServiceImpl<
    typeof ModelsService
  >;
};

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

interface Served {
  readonly models: Client<typeof ModelsService>;
  readonly relay: Relay;
  readonly recorded: ProviderRecord;
}

/** The fake attachment every `runtime.attachments/v1.Read` answers. */
async function* attachmentRead() {
  yield {
    item: {
      case: 'head' as const,
      value: { attachment: { mediaType: 'image/png', name: 'image.png' } },
    },
  };
  yield { item: { case: 'chunk' as const, value: new Uint8Array([1, 2, 3]) } };
}

const serve = async (t: TestContext, script: Script = {}): Promise<Served> => {
  const recorded: ProviderRecord = {
    requests: [],
    embeddings: [],
    reranks: [],
    validated: [],
  };
  const relay: Relay = { calls: [], options: [], messages: [] };
  const router = createTestRouter();
  let context: HostContext | undefined;
  const provider = () => {
    if (context === undefined) {
      throw new ContractError('unavailable', 'Not activated yet.');
    }

    return context.services.use(ProviderService);
  };

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(
          {
            kind: fakeKind,
            advertised: true,
            catalogCapacity: false,
            icons: ({ models }) => ({ models: models.map(() => null) }),
            build: ({ providerId }) =>
              scriptedProvider(providerId, script, recorded),
          },
          { readAttachment: () => attachmentRead() },
        ),
      ],
      [ModelsService, relayService(relay, provider)],
    ],
    activate: (activated) => {
      context = activated;
    },
  });

  return { models: router.client(ModelsService), relay, recorded };
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * The value as JSON would carry it, with absent members and empty lists
 * dropped: an llms value with `toolCalls: []` means what one without does.
 */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (_key, member: unknown) =>
    Array.isArray(member) && member.length === 0 ? undefined : member,
  ) as unknown;

/** A request as the provider received it, without its call signal. */
const withoutSignal = (request: ProviderRequest | undefined): unknown => {
  assert.ok(request !== undefined, 'the provider received no request');

  const { signal: _signal, ...rest } = request;

  return plain(rest);
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail('expected a rejection');
};

/** Every event `stream` yields, and the error that ended it, if any. */
const drain = async <T>(
  stream: AsyncIterable<T>,
): Promise<{ readonly events: T[]; readonly error?: unknown }> => {
  const events: T[] = [];

  try {
    for await (const event of stream) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }

  return { events };
};

/** Waits until `signal` aborts, or fails after `ms`. */
const abortedWithin = (signal: AbortSignal, ms: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(
      () => reject(new Error(`The signal did not abort within ${ms} ms.`)),
      ms,
    );

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Resolves once `signal` aborts. */
const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve();

      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** Asserts `error` is the provider error `data`, rebuilt. */
const assertProviderError = (
  error: unknown,
  data: Partial<ProviderError>,
): ProviderErrorObject => {
  assert.ok(
    error instanceof ProviderErrorObject,
    `expected a ProviderErrorObject, got ${String(error)}`,
  );
  for (const [key, value] of Object.entries(data)) {
    assert.deepEqual(error.data[key as keyof ProviderError], value, key);
  }

  return error;
};

const userText = (text: string) => ({ role: 'user' as const, content: text });

// ---------------------------------------------------------------------------
// B1-B2: the request and the answer round trip.
// ---------------------------------------------------------------------------

void test('B1: complete sends the header then each message in order; the provider receives the request given and its answer comes back equal', async (t) => {
  const finished: ProviderFinished = {
    text: 'Done',
    finishReason: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolCalls: [{ id: 'c2', name: 'lookup', arguments: '{"q":"y"}', index: 1 }],
    replay: [{ type: 'reasoning', id: 'r2' }],
  };
  const { models, relay, recorded } = await serve(t, {
    complete: async () => finished,
  });
  const request: ProviderRequest = {
    model: 'fake-model',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Look up x.' }] },
      {
        role: 'assistant',
        content: 'Calling lookup.',
        toolCalls: [
          { id: 'c1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
        ],
        replay: [{ type: 'reasoning', id: 'r1' }],
      },
      {
        role: 'tool',
        name: 'lookup',
        content: 'x means y.',
        toolCallId: 'c1',
        toolResultStatus: 'completed',
      },
    ],
    tools: [
      {
        name: 'lookup',
        description: 'Looks a word up.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        outputSchema: {
          type: 'object',
          properties: { meaning: { type: 'string' } },
        },
      },
    ],
    toolChoice: { name: 'lookup' },
    parallelToolCalls: false,
    effort: 'low',
    temperature: 0.5,
    maxOutputTokens: 256,
    flags: {
      reasoning: { effort: 'high', summary: 'concise' },
      serviceTier: 'priority',
      includeUsage: true,
    },
  };

  const answer = await modelsLanguageModel(models, 'main').complete(request);

  assert.deepEqual(
    relay.calls.map(({ method, providerId }) => ({ method, providerId })),
    [{ method: 'complete', providerId: 'main' }],
  );
  assert.equal(relay.options[0]?.model, 'fake-model');
  assert.deepEqual(
    relay.messages[0]?.map(({ role }) => role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.equal(recorded.requests.length, 1);
  assert.deepEqual(withoutSignal(recorded.requests[0]), plain(request));
  assert.deepEqual(plain(answer), plain(finished));
});

void test('B2: stream yields every event kind the provider yields, equal and in order', async (t) => {
  const events: ProviderStreamEvent[] = [
    {
      type: 'response.started',
      provider: 'main',
      model: 'fake-model',
      contextWindow: 128000,
    },
    { type: 'text.delta', delta: 'Hel' },
    { type: 'reasoning.delta', delta: 'thinking' },
    { type: 'refusal.delta', delta: 'no' },
    {
      type: 'tool_call.delta',
      index: 0,
      id: 'c1',
      name: 'lookup',
      argumentsDelta: '{"q":',
    },
    {
      type: 'tool_call.done',
      call: { id: 'c1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
    },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    {
      type: 'error',
      error: {
        provider: 'main',
        code: 'provider_error',
        message: 'The provider reported an error.',
        retryable: false,
      },
    },
    {
      type: 'response.finished',
      finish: { text: 'Hello', finishReason: 'stop', toolCalls: [] },
    },
  ];
  const { models, relay } = await serve(t, {
    stream: async function* () {
      yield* events;
    },
  });

  const { events: yielded, error } = await drain(
    modelsLanguageModel(models, 'main').stream({
      model: 'fake-model',
      messages: [userText('hi')],
    }),
  );

  assert.equal(error, undefined);
  assert.deepEqual(plain(yielded), plain(events));
  assert.deepEqual(
    relay.calls.map(({ method }) => method),
    ['stream'],
  );
});

// ---------------------------------------------------------------------------
// B3-B5 and decision 10: errors.
// ---------------------------------------------------------------------------

void test('B3: a provider error thrown by the provider rejects complete with an equal ProviderErrorObject, read as a retryable network error', async (t) => {
  const data: ProviderError = {
    provider: 'main',
    code: 'network_error',
    message: 'The connection was dropped.',
    status: 503,
    retryable: true,
    diagnostic: 'ECONNRESET',
    retryAfterMs: 250,
    requestId: 'req-1',
  };
  const { models } = await serve(t, {
    complete: async () => {
      throw new ProviderErrorObject(data);
    },
  });

  const error = await rejection(
    modelsLanguageModel(models, 'main').complete({
      model: 'fake-model',
      messages: [userText('hi')],
    }),
  );

  const rebuilt = assertProviderError(error, {});
  assert.deepEqual(rebuilt.data, data);
  assert.equal(rebuilt.name, 'ProviderError');
  assert.equal(rebuilt.message, data.message);
  // What packages/agent's `isRetryable` and `retryBudget` read.
  assert.equal(rebuilt.data.retryable, true);
  assert.equal(rebuilt.data.code, 'network_error');
});

void test('B4: a stream that yields two events and then throws a provider error yields the two events, then ends with that ProviderErrorObject', async (t) => {
  const data: ProviderError = {
    provider: 'main',
    code: 'incomplete_stream',
    message: 'The stream ended early.',
    retryable: true,
  };
  const { models } = await serve(t, {
    stream: async function* () {
      yield { type: 'text.delta', delta: 'a' };
      yield { type: 'text.delta', delta: 'b' };
      throw new ProviderErrorObject(data);
    },
  });

  const { events, error } = await drain(
    modelsLanguageModel(models, 'main').stream({
      model: 'fake-model',
      messages: [userText('hi')],
    }),
  );

  assert.deepEqual(plain(events), [
    { type: 'text.delta', delta: 'a' },
    { type: 'text.delta', delta: 'b' },
  ]);
  assert.deepEqual(assertProviderError(error, {}).data, data);
});

void test('B5: another failure, and provider_error whose details lack a string code, reject as the ContractError, not a ProviderErrorObject', async (t) => {
  const { models, relay } = await serve(t);
  const provider = modelsLanguageModel(models, 'main');
  const request = { model: 'fake-model', messages: [userText('hi')] };

  relay.failNext = new ContractError('not_found', 'No such model.');
  const notFound = await rejection(provider.complete(request));

  assert.ok(isContractError(notFound), String(notFound));
  assert.ok(!(notFound instanceof ProviderErrorObject));
  assert.equal(notFound.code, 'not_found');
  assert.equal(notFound.message, 'No such model.');

  relay.failNext = new ContractError('provider_error', 'Malformed.', {
    providerError: { provider: 'main', message: 'Malformed.' },
  });
  const malformed = await rejection(provider.complete(request));

  assert.ok(isContractError(malformed), String(malformed));
  assert.ok(!(malformed instanceof ProviderErrorObject));
  assert.equal(malformed.code, 'provider_error');
});

void test('decision 10: a model call failing unavailable or generation_lost between bundles rejects with a retryable network_error ProviderErrorObject of the provider', async (t) => {
  const { models, relay } = await serve(t);
  const provider = modelsLanguageModel(models, 'main');
  const request = { model: 'fake-model', messages: [userText('hi')] };

  for (const code of ['unavailable', 'generation_lost'] as const) {
    relay.failNext = new ContractError(code, `The call failed: ${code}.`);
    assertProviderError(await rejection(provider.complete(request)), {
      provider: 'main',
      code: 'network_error',
      retryable: true,
    });

    relay.failNext = new ContractError(code, `The call failed: ${code}.`);
    const { events, error } = await drain(provider.stream(request));
    assert.deepEqual(events, [], code);
    assertProviderError(error, {
      provider: 'main',
      code: 'network_error',
      retryable: true,
    });

    relay.failNext = new ContractError(code, `The call failed: ${code}.`);
    assertProviderError(await rejection(provider.models()), {
      provider: 'main',
      code: 'network_error',
      retryable: true,
    });
  }
});

void test('decision 10: a stream that fails generation_lost after two events yields them, then ends with a retryable network_error ProviderErrorObject', async (t) => {
  const { models, relay } = await serve(t, {
    stream: async function* () {
      yield { type: 'text.delta', delta: 'a' };
      yield { type: 'text.delta', delta: 'b' };
      yield { type: 'text.delta', delta: 'c' };
    },
  });
  relay.streamFailure = {
    after: 2,
    error: new ContractError('generation_lost', 'The provider restarted.'),
  };

  const { events, error } = await drain(
    modelsLanguageModel(models, 'main').stream({
      model: 'fake-model',
      messages: [userText('hi')],
    }),
  );

  assert.deepEqual(plain(events), [
    { type: 'text.delta', delta: 'a' },
    { type: 'text.delta', delta: 'b' },
  ]);
  assertProviderError(error, {
    provider: 'main',
    code: 'network_error',
    retryable: true,
  });
});

// ---------------------------------------------------------------------------
// B6: image parts.
// ---------------------------------------------------------------------------

void test('B6: attachmentImageUrl spells doric-attachment:<id>?mediaType=…[&name=…] with each value percent-encoded', () => {
  assert.equal(
    attachmentImageUrl({ id: 'sha256-abc', mediaType: 'image/png' }),
    'doric-attachment:sha256-abc?mediaType=image%2Fpng',
  );
  assert.equal(
    attachmentImageUrl({
      id: 'sha256-abc',
      mediaType: 'image/jpeg',
      name: 'cat.jpg',
    }),
    'doric-attachment:sha256-abc?mediaType=image%2Fjpeg&name=cat.jpg',
  );
});

void test('B6: an https: image is sent as url and an attachment URL as attachment {id, mediaType, name}, special characters kept', async (t) => {
  const { models, relay } = await serve(t);
  const id = 'sha256-a b/c?d&e=f#g%';
  const name = 'photo #1 & co?.png';

  await modelsLanguageModel(models, 'main').complete({
    model: 'fake-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look.' },
          { type: 'image', imageUrl: 'https://images.test/a.png' },
          {
            type: 'image',
            imageUrl: attachmentImageUrl({ id, mediaType: 'image/png', name }),
          },
          {
            type: 'image',
            imageUrl: attachmentImageUrl({ id: 'sha256-x', mediaType: 'image/webp' }),
          },
        ],
      },
    ],
  });

  const content = relay.messages[0]?.[0]?.content;
  assert.equal(content?.case, 'parts');
  const parts = content.value.parts.map(({ type }) =>
    type.case === 'text'
      ? { text: type.value.text }
      : type.case === 'image'
        ? type.value.source.case === 'url'
          ? { url: type.value.source.value }
          : type.value.source.case === 'attachment'
            ? {
                attachment: {
                  id: type.value.source.value.id,
                  mediaType: type.value.source.value.mediaType,
                  name: type.value.source.value.name,
                },
              }
            : {}
        : {},
  );

  assert.deepEqual(parts, [
    { text: 'Look.' },
    { url: 'https://images.test/a.png' },
    { attachment: { id, mediaType: 'image/png', name } },
    {
      attachment: { id: 'sha256-x', mediaType: 'image/webp', name: undefined },
    },
  ]);
});

void test('B6: a data: or http: image URL rejects invalid_input before any call', async (t) => {
  const { models, relay } = await serve(t);
  const provider = modelsLanguageModel(models, 'main');

  for (const imageUrl of [
    'data:image/png;base64,iVBORw0KGgo=',
    'http://images.test/a.png',
  ]) {
    const error = await rejection(
      provider.complete({
        model: 'fake-model',
        messages: [{ role: 'user', content: [{ type: 'image', imageUrl }] }],
      }),
    );

    assert.ok(isContractError(error), String(error));
    assert.equal(error.code, 'invalid_input', imageUrl);
    assert.equal(
      error.message,
      'An image part must be an https: URL or an attachment.',
    );
  }

  assert.deepEqual(relay.calls, []);
});

// ---------------------------------------------------------------------------
// B7: structured output.
// ---------------------------------------------------------------------------

void test("B7: the header's schema is the JSON Schema text; structured is parsed with the caller's schema; a mismatch is invalid_structured_output", async (t) => {
  let structured: unknown = { n: 3, word: '  a  ' };
  const { models, relay } = await serve(t, {
    complete: async () => ({
      text: '{}',
      finishReason: 'stop',
      toolCalls: [],
      structured: structured as never,
    }),
  });
  const schema = z.object({
    n: z.number().overwrite((value) => value * 2),
    word: z.string().trim(),
  });
  const provider = modelsLanguageModel(models, 'main');

  const answer = await provider.complete({
    model: 'fake-model',
    messages: [userText('hi')],
    schema,
  });

  const text = relay.options[0]?.schema;
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text as string), z.toJSONSchema(schema));
  assert.deepEqual(answer.structured, { n: 6, word: 'a' });

  structured = { n: 'three', word: 'a' };
  assertProviderError(
    await rejection(
      provider.complete({
        model: 'fake-model',
        messages: [userText('hi')],
        schema,
      }),
    ),
    { provider: 'main', code: 'invalid_structured_output' },
  );
});

// ---------------------------------------------------------------------------
// B8, B11: cancelling a stream.
// ---------------------------------------------------------------------------

void test("B8: aborting request.signal mid-stream cancels the call and ends the iteration", async (t) => {
  const { models, relay } = await serve(t, {
    stream: async function* (request) {
      yield { type: 'text.delta', delta: 'first' };
      await untilAborted(request.signal);
    },
  });
  const controller = new AbortController();
  const events: ProviderStreamEvent[] = [];
  const provider = modelsLanguageModel(models, 'main');

  const iteration = (async () => {
    try {
      for await (const event of provider.stream({
        model: 'fake-model',
        messages: [userText('hi')],
        signal: controller.signal,
      })) {
        events.push(event);
        controller.abort();
      }
    } catch {
      // An aborted call may end the iteration with its abort error.
    }
  })();

  await Promise.race([
    iteration,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('The iteration did not end.')), 2000),
    ),
  ]);

  assert.deepEqual(plain(events), [{ type: 'text.delta', delta: 'first' }]);
  const call = relay.calls[0];
  assert.ok(call !== undefined, 'the relay received the call');
  await abortedWithin(call.signal, 2000);
});

void test('B11: breaking out of a stream loop early cancels the call', async (t) => {
  const { models, relay } = await serve(t, {
    stream: async function* (request) {
      yield { type: 'text.delta', delta: 'first' };
      await untilAborted(request.signal);
    },
  });

  for await (const event of modelsLanguageModel(models, 'main').stream({
    model: 'fake-model',
    messages: [userText('hi')],
  })) {
    assert.equal(event.type, 'text.delta');
    break;
  }

  const call = relay.calls[0];
  assert.ok(call !== undefined, 'the relay received the call');
  await abortedWithin(call.signal, 2000);
});

// ---------------------------------------------------------------------------
// B9-B10: the unary methods and the provider itself.
// ---------------------------------------------------------------------------

void test('B9: embedding, rerank, models and validateModel send the providerId and answer the provider values', async (t) => {
  const listed: Model[] = [
    {
      id: 'm1',
      name: 'Model One',
      contextWindow: 1000,
      inputModalities: ['text', 'image'],
    },
  ];
  const { models, relay, recorded } = await serve(t, {
    embedding: async () => ({
      embedding: [0.5, 0.25],
      usage: { inputTokens: 2 },
    }),
    rerank: async () => ({
      results: [
        { index: 1, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.1 },
      ],
    }),
    models: async () => listed,
    validateModel: async (model) => ({ id: model, name: 'Validated' }),
  });
  const provider = modelsLanguageModel(models, 'main');

  const embedding = await provider.embedding({
    model: 'embed',
    input: 'text',
    dimensions: 2,
  });
  const ranked = await provider.rerank({
    model: 'rank',
    query: 'q',
    documents: ['a', 'b'],
    topN: 2,
  });
  const listedBack = await provider.models();
  const validated = await provider.validateModel('m1');

  assert.deepEqual(plain(embedding), {
    embedding: [0.5, 0.25],
    usage: { inputTokens: 2 },
  });
  assert.deepEqual(plain(ranked), {
    results: [
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.1 },
    ],
  });
  assert.deepEqual(plain(listedBack), plain(listed));
  assert.deepEqual(plain(validated), { id: 'm1', name: 'Validated' });
  assert.deepEqual(
    relay.calls.map(({ method, providerId }) => ({ method, providerId })),
    [
      { method: 'embedding', providerId: 'main' },
      { method: 'rerank', providerId: 'main' },
      { method: 'models', providerId: 'main' },
      { method: 'validateModel', providerId: 'main' },
    ],
  );
  assert.deepEqual(
    recorded.embeddings.map(({ model, input, dimensions }) => ({
      model,
      input,
      dimensions,
    })),
    [{ model: 'embed', input: 'text', dimensions: 2 }],
  );
  assert.deepEqual(
    recorded.reranks.map(({ model, query, documents, topN }) => ({
      model,
      query,
      documents,
      topN,
    })),
    [{ model: 'rank', query: 'q', documents: ['a', 'b'], topN: 2 }],
  );
  assert.deepEqual(recorded.validated, ['m1']);
});

void test('B10: metadata names the providerId, every capability is true, and building the provider makes no call', async (t) => {
  const { models, relay } = await serve(t);

  const provider = modelsLanguageModel(models, 'main');

  assert.deepEqual(provider.metadata, {
    id: 'main',
    name: 'main',
    baseUrl: '',
  });
  assert.ok(
    Object.values(provider.capabilities).every((flag) => flag === true),
    JSON.stringify(provider.capabilities),
  );
  assert.ok(Object.keys(provider.capabilities).length > 0);
  assert.deepEqual(relay.calls, []);
});
