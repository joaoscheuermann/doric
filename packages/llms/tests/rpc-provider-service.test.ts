// `models.provider/v1` 1.4.0 over an llms provider kind (spec
// `docs/designs/grpc-processes.md`, "Model providers"; phase 3, slice S43;
// T3.7 at unit level, AC3.9's unit half): `serveProviderKind` served through
// `createTestRouter` and called through the router's Connect client. The kind
// source is a fake whose `build` returns a scripted `LlmProvider` that records
// every request (no HTTP); `runtime.attachments/v1` is a fake service.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  create,
  equals,
  type MessageInitShape,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import {
  type Client,
  ConnectError,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type CallScope,
  type CatalogResult,
  ContractError,
  callOf,
  fromConnectError,
  type ModelKindDescriptor,
} from 'bundle/contracts';
import {
  CatalogResponseSchema,
  CompleteResponseSchema,
  EmbeddingResponseSchema,
  IconsResponseSchema,
  ModelKindDescriptorSchema,
  ModelsResponseSchema,
  ProviderService,
  RerankResponseSchema,
  StreamRequestSchema,
  StreamResponseSchema,
  ValidateModelResponseSchema,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import type { HostContext } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';

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
  type SecretSource,
} from '../src/index.js';
import {
  type ProviderKindSource,
  serveProviderKind,
} from '../src/rpc/index.js';
import {
  AttachmentsService,
  ReadResponseSchema,
} from './support/attachments_pb.js';

const KiB = 1024;
const MiB = 1024 * KiB;

// ---------------------------------------------------------------------------
// The fake kind and its scripted provider.
// ---------------------------------------------------------------------------

const fakeKind: ModelKindDescriptor = {
  id: 'fake',
  label: 'Fake',
  description: 'A scripted provider kind.',
  fields: [
    { key: 'region', label: 'Region', kind: 'text', required: true },
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'url',
      required: false,
      advanced: true,
      placeholder: 'https://fake.test/v1',
    },
    {
      key: 'token',
      label: 'Token',
      kind: 'secret',
      required: false,
      description: 'The stored token.',
    },
  ],
  lists: ['models', 'reasonings'],
  modelsFromCatalog: true,
  site: { url: 'https://fake.test', label: 'Open Fake' },
};

/** What the scripted provider answers; each default is a plain success. */
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
  readonly models?: (signal?: AbortSignal) => Promise<readonly Model[]>;
  readonly validateModel?: (
    model: string,
    signal?: AbortSignal,
  ) => Promise<Model>;
}

/** What reached the fake kind and its providers. */
interface Recorded {
  readonly builds: {
    readonly providerId: string;
    readonly values: Readonly<Record<string, SecretSource>>;
  }[];
  /** Every `complete` and `stream` request, in order. */
  readonly requests: ProviderRequest[];
  readonly embeddings: ProviderEmbeddingRequest[];
  readonly reranks: ProviderRerankRequest[];
  readonly validated: string[];
  /** The signal of every `models` and `validateModel` call. */
  readonly signals: (AbortSignal | undefined)[];
  readonly catalogs: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  }[];
}

const secretOf = async (source: SecretSource | undefined): Promise<string> =>
  source === undefined
    ? '<none>'
    : typeof source === 'function'
      ? await source()
      : source;

async function* noEvents(): AsyncIterable<ProviderStreamEvent> {}

/** A provider that records what it is asked and answers `script`. */
const scriptedProvider = (
  providerId: string,
  values: Readonly<Record<string, SecretSource>>,
  script: Script,
  recorded: Recorded,
): LlmProvider =>
  ({
    metadata: {
      id: providerId,
      name: providerId,
      baseUrl: 'https://fake.test/v1',
    },
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
    // By default the token the provider reads now, so a test sees which
    // secret the built provider holds.
    models: async (signal?: AbortSignal) => {
      recorded.signals.push(signal);

      return script.models === undefined
        ? [{ id: 'fake-model', name: `token:${await secretOf(values.token)}` }]
        : await script.models(signal);
    },
    validateModel: async (model: string, signal?: AbortSignal) => {
      recorded.validated.push(model);
      recorded.signals.push(signal);

      return script.validateModel === undefined
        ? { id: model }
        : await script.validateModel(model, signal);
    },
  }) as unknown as LlmProvider;

/**
 * The fake kind as a source. `build` records each call and throws, as
 * `buildConfigured` does, when the required `region` is missing.
 */
const fakeSource = (
  script: Script = {},
  overrides: Partial<ProviderKindSource> = {},
): { readonly source: ProviderKindSource; readonly recorded: Recorded } => {
  const recorded: Recorded = {
    builds: [],
    requests: [],
    embeddings: [],
    reranks: [],
    validated: [],
    signals: [],
    catalogs: [],
  };
  const source: ProviderKindSource = {
    kind: fakeKind,
    advertised: true,
    catalogCapacity: true,
    catalog: (input) => {
      recorded.catalogs.push(input);

      return Promise.resolve<CatalogResult>({
        status: 'read',
        models: [
          {
            id: 'm1',
            name: 'Model One',
            reasonings: ['low', 'high'],
            parameters: [],
            defaultEffort: 'low',
            mandatory: false,
          },
        ],
      });
    },
    icons: ({ models }) => ({
      provider: 'openai',
      models: models.map((model) => (model === 'known' ? 'openai' : null)),
    }),
    build: ({ providerId, values }) => {
      recorded.builds.push({ providerId, values });

      const region = values.region;

      if (typeof region !== 'string' || region.trim() === '') {
        throw new Error('Provider kind fake requires a region value.');
      }

      return scriptedProvider(providerId, values, script, recorded);
    },
    ...overrides,
  };

  return { source, recorded };
};

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

interface Served {
  readonly client: Client<typeof ProviderService>;
  readonly router: TestRouter;
}

/**
 * `serveProviderKind(source)` on a fresh test router, its `readAttachment`
 * reading `runtime.attachments/v1` through the activated context, as each
 * bundle's `main.ts` does.
 */
const serve = async (
  t: TestContext,
  source: ProviderKindSource,
  options: {
    readonly fakes?: readonly (readonly [
      typeof AttachmentsService,
      ServiceImpl<typeof AttachmentsService>,
    ])[];
    readonly requires?: readonly string[];
    readonly scope?: CallScope;
  } = {},
): Promise<Served> => {
  const router = createTestRouter({
    ...(options.fakes === undefined ? {} : { fakes: options.fakes }),
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  let context: HostContext | undefined;
  const contextOf = (): HostContext => {
    if (context === undefined) {
      throw new ContractError('unavailable', 'Not activated yet.');
    }

    return context;
  };

  t.after(() => router.control.stop());

  await router.activate({
    services: [
      [
        ProviderService,
        serveProviderKind(source, {
          readAttachment: (id, signal) =>
            contextOf()
              .services.use(AttachmentsService)
              .read({ id }, { signal }),
        }),
      ],
    ],
    activate: (activated) => {
      context = activated;
    },
  });

  return { client: router.client(ProviderService), router };
};

/** Asserts `promise` failed with a ConnectError of the Doric code `code`. */
const rejectsWithCode = async (
  promise: Promise<unknown>,
  code: string,
): Promise<ContractError> => {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  assert.ok(
    caught instanceof ConnectError,
    `expected a ConnectError, got ${String(caught)}`,
  );

  const error = fromConnectError(caught);

  assert.equal(error.code, code, error.message);

  return error;
};

const drain = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
};

async function* itemsOf<T>(...items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * The value as JSON would carry it, with absent members and empty lists
 * dropped: an llms value with `toolCalls: []` means what one without does.
 */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (_key, member: unknown) =>
    Array.isArray(member) && member.length === 0 ? undefined : member,
  ) as unknown;

type Values = Readonly<Record<string, string>>;

const target = (
  init: {
    readonly providerId?: string;
    readonly values?: Values;
    readonly secret?: string;
  } = {},
) => ({
  providerId: init.providerId ?? 'main',
  values: init.values ?? { region: 'eu' },
  ...(init.secret === undefined ? {} : { secret: init.secret }),
});

type ItemInit = NonNullable<
  MessageInitShape<typeof StreamRequestSchema>['item']
>;
type HeaderInit = Extract<ItemInit, { case: 'header' }>['value'];
type MessageInit = Extract<ItemInit, { case: 'message' }>['value'];

/** A `Complete` or `Stream` request item, as both RPCs take it. */
interface RequestItem {
  readonly item:
    | { readonly case: 'header'; readonly value: HeaderInit }
    | { readonly case: 'message'; readonly value: MessageInit };
}

const header = (value: HeaderInit) =>
  ({ item: { case: 'header', value } }) as const satisfies RequestItem;

const message = (value: MessageInit) =>
  ({ item: { case: 'message', value } }) as const satisfies RequestItem;

const userText = (text: string) =>
  message({ role: 'user', content: { case: 'text', value: text } });

const simpleHeader = (secret?: string) =>
  header({
    target: target(secret === undefined ? {} : { secret }),
    options: { model: 'fake-model' },
  });

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

// ---------------------------------------------------------------------------
// The fake `runtime.attachments/v1`.
// ---------------------------------------------------------------------------

interface StoredImage {
  readonly mediaType: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface AttachmentReads {
  /** Each `Read`: its id and the scope of the call that carried it. */
  readonly reads: { readonly id: string; readonly scope?: CallScope }[];
  /** The encoded size of every item the fake answered. */
  readonly answeredSizes: number[];
}

/** Serves `images` by id: a head, then chunks of at most 1 MiB. */
const fakeAttachments = (
  images: ReadonlyMap<string, StoredImage>,
): {
  readonly entry: readonly [
    typeof AttachmentsService,
    ServiceImpl<typeof AttachmentsService>,
  ];
  readonly seen: AttachmentReads;
} => {
  const seen: AttachmentReads = { reads: [], answeredSizes: [] };
  const answer = (init: MessageInitShape<typeof ReadResponseSchema>) => {
    const item = create(ReadResponseSchema, init);

    seen.answeredSizes.push(toBinary(ReadResponseSchema, item).length);

    return item;
  };

  return {
    seen,
    entry: [
      AttachmentsService,
      {
        attach: () => {
          throw new ContractError('internal', 'Attach is not used here.');
        },
        async *read(request, context) {
          const { scope } = callOf(context);

          seen.reads.push({
            id: request.id,
            ...(scope === undefined ? {} : { scope }),
          });

          const image = images.get(request.id);

          if (image === undefined) {
            yield answer({ item: { case: 'head', value: {} } });

            return;
          }

          yield answer({
            item: {
              case: 'head',
              value: {
                attachment: {
                  id: request.id,
                  name: image.name,
                  mediaType: image.mediaType,
                  size: image.bytes.length,
                },
              },
            },
          });

          for (let start = 0; start < image.bytes.length; start += MiB) {
            yield answer({
              item: {
                case: 'chunk',
                value: image.bytes.subarray(start, start + MiB),
              },
            });
          }
        },
      },
    ],
  };
};

const attachmentId = `sha256-${'a'.repeat(64)}`;

/** A user message whose second part is the image `source`. */
const imageMessage = (
  source:
    | { readonly case: 'url'; readonly value: string }
    | {
        readonly case: 'attachment';
        readonly value: { readonly id: string; readonly mediaType: string };
      },
) =>
  message({
    role: 'user',
    content: {
      case: 'parts',
      value: {
        parts: [
          { type: { case: 'text', value: { text: 'What is this?' } } },
          { type: { case: 'image', value: { source } } },
        ],
      },
    },
  });

// ---------------------------------------------------------------------------
// 1. Descriptor RPCs.
// ---------------------------------------------------------------------------

void test('Kind, Advertised and CatalogCapacity answer the source’s descriptor and traits', async (t) => {
  const { source } = fakeSource(
    {},
    { advertised: false, catalogCapacity: true },
  );
  const { client } = await serve(t, source);

  const kind = await client.kind({});

  assert.ok(kind.modelKindDescriptor !== undefined);
  assert.ok(
    equals(
      ModelKindDescriptorSchema,
      kind.modelKindDescriptor,
      create(ModelKindDescriptorSchema, fakeKind),
    ),
    'Kind answers a descriptor other than the source’s',
  );
  assert.equal((await client.advertised({})).advertised, false);
  assert.equal((await client.catalogCapacity({})).catalogCapacity, true);
});

void test('Icons answers the source’s choice, with no icon written as ""', async (t) => {
  const { source } = fakeSource();
  const { client } = await serve(t, source);

  const icons = await client.icons({
    configuration: { region: 'eu' },
    models: ['known', 'other'],
  });

  assert.deepEqual(toJson(IconsResponseSchema, icons), {
    modelIconChoice: { provider: 'openai', models: ['openai', ''] },
  });
});

void test('Catalog passes configuration and secret to the source’s catalog and answers its result', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  const catalog = await client.catalog({
    configuration: { region: 'eu' },
    secret: 'sk-catalog',
  });

  assert.deepEqual(plain(recorded.catalogs), [
    { configuration: { region: 'eu' }, secret: 'sk-catalog' },
  ]);
  assert.deepEqual(toJson(CatalogResponseSchema, catalog), {
    catalogResult: {
      status: 'read',
      models: [
        {
          id: 'm1',
          name: 'Model One',
          reasonings: ['low', 'high'],
          defaultEffort: 'low',
        },
      ],
    },
  });
});

void test('a kind without a catalog answers Catalog with absent', async (t) => {
  const { source: withCatalog } = fakeSource();
  const { catalog: _catalog, ...source } = withCatalog;
  const { client } = await serve(t, source);

  const catalog = await client.catalog({ configuration: {}, secret: 'sk' });

  assert.equal(catalog.catalogResult?.status, 'absent');
  assert.deepEqual(catalog.catalogResult?.models, []);
});

// ---------------------------------------------------------------------------
// 2–3. The built-provider cache.
// ---------------------------------------------------------------------------

void test('two calls with the same target build the provider once', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.models({ target: target({ secret: 'sk-1' }) });
  await client.models({ target: target({ secret: 'sk-1' }) });

  assert.equal(recorded.builds.length, 1);
});

void test('a rotated secret builds again and the next call uses the new secret', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  const before = await client.models({ target: target({ secret: 'sk-old' }) });
  const after = await client.models({ target: target({ secret: 'sk-new' }) });

  assert.equal(before.models[0]?.name, 'token:sk-old');
  assert.equal(after.models[0]?.name, 'token:sk-new');
  assert.equal(recorded.builds.length, 2);
});

void test('a changed value builds again', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.models({ target: target({ values: { region: 'eu' } }) });
  await client.models({ target: target({ values: { region: 'us' } }) });

  assert.equal(recorded.builds.length, 2);
  assert.equal(recorded.builds[1]?.values.region, 'us');
});

void test('an absent secret and an empty stored secret are different targets, and the empty one still builds', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  const absent = await client.models({ target: target() });
  const empty = await client.models({ target: target({ secret: '' }) });

  assert.equal(recorded.builds.length, 2);
  assert.equal(absent.models[0]?.name, 'token:<none>');
  assert.equal(empty.models[0]?.name, 'token:');
});

void test('the secret reaches the build under the kind’s secret field, as a source', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.models({ target: target({ secret: 'sk-field' }) });

  const values = recorded.builds[0]?.values ?? {};

  assert.equal(values.region, 'eu');
  assert.equal(typeof values.token, 'function');
  assert.equal(await secretOf(values.token), 'sk-field');
});

void test('two providerIds with equal values build two providers', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.models({ target: target({ providerId: 'a', secret: 'sk' }) });
  await client.models({ target: target({ providerId: 'b', secret: 'sk' }) });

  assert.deepEqual(
    recorded.builds.map((build) => build.providerId),
    ['a', 'b'],
  );
});

void test('a build that throws fails the call with invalid_input and its message, and the next call builds again', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);
  const missing = target({ values: {} });

  const error = await rejectsWithCode(
    client.models({ target: missing }),
    'invalid_input',
  );

  assert.equal(error.message, 'Provider kind fake requires a region value.');

  await rejectsWithCode(client.models({ target: missing }), 'invalid_input');

  assert.equal(recorded.builds.length, 2);
});

// ---------------------------------------------------------------------------
// 4. Complete.
// ---------------------------------------------------------------------------

const answerSchema = JSON.stringify({
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
});

void test('Complete passes the header and the messages in order as one request and answers the provider’s result', async (t) => {
  const { source, recorded } = fakeSource({
    complete: () =>
      Promise.resolve({
        text: 'Done',
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [
          { id: 'c2', name: 'lookup', arguments: '{"q":"y"}', index: 1 },
        ],
        replay: [{ type: 'reasoning', id: 'r2' }],
        structured: { answer: 'yes' },
      }),
  });
  const { client } = await serve(t, source);

  const response = await client.complete(
    itemsOf<RequestItem>(
      header({
        target: target({ secret: 'sk' }),
        options: {
          model: 'fake-model',
          tools: [
            {
              name: 'lookup',
              description: 'Looks a word up.',
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' } },
              },
            },
            {
              name: 'define',
              description: 'Defines a word.',
              inputSchema: { type: 'object' },
              outputSchema: {
                type: 'object',
                properties: { meaning: { type: 'string' } },
              },
            },
          ],
          toolChoice: { choice: { case: 'name', value: 'lookup' } },
          parallelToolCalls: false,
          schema: answerSchema,
          effort: 'low',
          temperature: 0.5,
          maxOutputTokens: 256,
          flags: {
            reasoning: {
              case: 'reasoningRequest',
              value: { effort: 'high', summary: 'concise' },
            },
            includeUsage: true,
          },
        },
      }),
      message({
        role: 'user',
        content: {
          case: 'parts',
          value: {
            parts: [{ type: { case: 'text', value: { text: 'Look up x.' } } }],
          },
        },
      }),
      message({
        role: 'assistant',
        content: { case: 'text', value: 'Calling lookup.' },
        toolCalls: [
          { id: 'c1', name: 'lookup', arguments: '{"q":"x"}', index: 0 },
        ],
        replay: [{ type: 'reasoning', id: 'r1' }],
      }),
      message({
        role: 'tool',
        name: 'lookup',
        content: { case: 'text', value: 'x means y.' },
        toolCallId: 'c1',
        toolResultStatus: 'completed',
      }),
    ),
  );

  assert.equal(recorded.requests.length, 1);

  const request = recorded.requests[0];

  assert.ok(request !== undefined);
  assert.equal(request.model, 'fake-model');
  assert.deepEqual(plain(request.messages), [
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
  ]);
  assert.deepEqual(plain(request.tools), [
    {
      name: 'lookup',
      description: 'Looks a word up.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      outputSchema: {},
    },
    {
      name: 'define',
      description: 'Defines a word.',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { meaning: { type: 'string' } },
      },
    },
  ]);
  assert.deepEqual(request.toolChoice, { name: 'lookup' });
  assert.equal(request.parallelToolCalls, false);
  assert.equal(request.effort, 'low');
  assert.equal(request.temperature, 0.5);
  assert.equal(request.maxOutputTokens, 256);
  assert.deepEqual(plain(request.flags), {
    reasoning: { effort: 'high', summary: 'concise' },
    includeUsage: true,
  });
  assert.ok(request.signal instanceof AbortSignal);

  assert.deepEqual(toJson(CompleteResponseSchema, response), {
    providerFinished: {
      text: 'Done',
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCalls: [
        { id: 'c2', name: 'lookup', arguments: '{"q":"y"}', index: 1 },
      ],
      replay: [{ type: 'reasoning', id: 'r2' }],
      structured: { answer: 'yes' },
    },
  });
});

void test('a tool choice by mode and reasoning as a switch reach the provider as llms values', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.complete(
    itemsOf<RequestItem>(
      header({
        target: target(),
        options: {
          model: 'fake-model',
          toolChoice: { choice: { case: 'mode', value: 'required' } },
          flags: { reasoning: { case: 'reasoningEnabled', value: false } },
        },
      }),
      userText('hi'),
    ),
  );

  assert.equal(recorded.requests[0]?.toolChoice, 'required');
  assert.equal(recorded.requests[0]?.flags?.reasoning, false);
});

void test('Complete that starts with a message, or carries a second header, is invalid_input and calls no provider', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await rejectsWithCode(
    client.complete(itemsOf<RequestItem>(userText('one'), simpleHeader())),
    'invalid_input',
  );
  await rejectsWithCode(
    client.complete(
      itemsOf<RequestItem>(simpleHeader(), userText('one'), simpleHeader()),
    ),
    'invalid_input',
  );
  await rejectsWithCode(
    drain(
      client.stream(
        itemsOf<RequestItem>(simpleHeader(), userText('one'), simpleHeader()),
      ),
    ),
    'invalid_input',
  );

  assert.equal(recorded.requests.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Stream.
// ---------------------------------------------------------------------------

void test('Stream answers each llms event as one item, in order, an error event included', async (t) => {
  const events: readonly ProviderStreamEvent[] = [
    {
      type: 'response.started',
      provider: 'fake',
      model: 'fake-model',
      contextWindow: 200_000,
    },
    { type: 'text.delta', delta: 'Hel' },
    { type: 'reasoning.delta', delta: 'thinking' },
    { type: 'refusal.delta', delta: 'no' },
    {
      type: 'tool_call.delta',
      index: 1,
      id: 'c1',
      name: 'lookup',
      argumentsDelta: '{"q"',
    },
    {
      type: 'tool_call.done',
      call: { id: 'c1', name: 'lookup', arguments: '{"q":"x"}', index: 1 },
    },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    {
      type: 'error',
      error: {
        provider: 'fake',
        code: 'provider_error',
        message: 'Overloaded.',
        retryable: true,
      },
    },
    {
      type: 'response.finished',
      finish: { text: 'Hello', finishReason: 'stop', toolCalls: [] },
    },
  ];
  const { source } = fakeSource({ stream: () => itemsOf(...events) });
  const { client } = await serve(t, source);

  const items = await drain(
    client.stream(itemsOf<RequestItem>(simpleHeader(), userText('hi'))),
  );

  assert.deepEqual(
    items.map((item) => toJson(StreamResponseSchema, item)),
    [
      {
        providerStreamEvent: {
          responseStarted: {
            provider: 'fake',
            model: 'fake-model',
            contextWindow: 200_000,
          },
        },
      },
      { providerStreamEvent: { textDelta: { delta: 'Hel' } } },
      { providerStreamEvent: { reasoningDelta: { delta: 'thinking' } } },
      { providerStreamEvent: { refusalDelta: { delta: 'no' } } },
      {
        providerStreamEvent: {
          toolCallDelta: {
            index: 1,
            id: 'c1',
            name: 'lookup',
            argumentsDelta: '{"q"',
          },
        },
      },
      {
        providerStreamEvent: {
          toolCallDone: {
            call: {
              id: 'c1',
              name: 'lookup',
              arguments: '{"q":"x"}',
              index: 1,
            },
          },
        },
      },
      {
        providerStreamEvent: {
          usage: { usage: { inputTokens: 3, outputTokens: 2 } },
        },
      },
      {
        providerStreamEvent: {
          error: {
            error: {
              provider: 'fake',
              code: 'provider_error',
              message: 'Overloaded.',
              retryable: true,
            },
          },
        },
      },
      {
        providerStreamEvent: {
          responseFinished: { finish: { text: 'Hello', finishReason: 'stop' } },
        },
      },
    ],
  );
});

void test('cancelling a Stream aborts the signal the provider received', async (t) => {
  let received: AbortSignal | undefined;
  const { source } = fakeSource({
    async *stream(request) {
      received = request.signal;

      yield { type: 'text.delta', delta: 'first' };

      if (request.signal !== undefined) {
        await abortedWithin(request.signal, 5_000);
      }
    },
  });
  const { client } = await serve(t, source);
  const controller = new AbortController();

  const stream = client.stream(
    itemsOf<RequestItem>(simpleHeader(), userText('hi')),
    { signal: controller.signal },
  );

  await assert.rejects(async () => {
    for await (const _item of stream) {
      controller.abort();
    }
  });

  assert.ok(received !== undefined, 'the provider received no signal');
  await abortedWithin(received, 2_000);
});

// ---------------------------------------------------------------------------
// 6. Structured output.
// ---------------------------------------------------------------------------

void test('a schema reaches the provider as a schema that accepts and rejects as the JSON Schema does', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await client.complete(
    itemsOf<RequestItem>(
      header({
        target: target(),
        options: { model: 'fake-model', schema: answerSchema },
      }),
      userText('hi'),
    ),
  );

  const schema = recorded.requests[0]?.schema;

  assert.ok(schema !== undefined, 'the provider received no schema');
  assert.equal(schema.safeParse({ answer: 'yes' }).success, true);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ answer: 1 }).success, false);
});

void test('a schema that is not JSON fails with invalid_input and calls no provider', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source);

  await rejectsWithCode(
    client.complete(
      itemsOf<RequestItem>(
        header({
          target: target(),
          options: { model: 'fake-model', schema: '{ not json' },
        }),
        userText('hi'),
      ),
    ),
    'invalid_input',
  );

  assert.equal(recorded.requests.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Errors.
// ---------------------------------------------------------------------------

void test('a thrown llms provider error crosses as provider_error with the whole error in details', async (t) => {
  const data: ProviderError = {
    provider: 'fake',
    code: 'network_error',
    message: 'socket hang up',
    status: 503,
    retryable: true,
    diagnostic: 'ECONNRESET',
    retryAfterMs: 1500,
    requestId: 'req-1',
  };
  const { source } = fakeSource({
    complete: () => Promise.reject(new ProviderErrorObject(data)),
    stream: () => {
      throw new ProviderErrorObject(data);
    },
  });
  const { client } = await serve(t, source);

  for (const call of [
    () => client.complete(itemsOf<RequestItem>(simpleHeader(), userText('hi'))),
    () =>
      drain(
        client.stream(itemsOf<RequestItem>(simpleHeader(), userText('hi'))),
      ),
  ]) {
    const error = await rejectsWithCode(call(), 'provider_error');

    assert.equal(error.message, 'socket hang up');
    assert.deepEqual(error.details, { providerError: data });
  }
});

void test('a plain Error from the provider fails the call with internal', async (t) => {
  const { source } = fakeSource({
    complete: () => Promise.reject(new Error('boom')),
  });
  const { client } = await serve(t, source);

  await rejectsWithCode(
    client.complete(itemsOf<RequestItem>(simpleHeader(), userText('hi'))),
    'internal',
  );
});

// ---------------------------------------------------------------------------
// 8. Embedding, Rerank, Models and ValidateModel.
// ---------------------------------------------------------------------------

void test('Embedding passes its request and signal through and answers the provider’s result', async (t) => {
  const { source, recorded } = fakeSource({
    embedding: () =>
      Promise.resolve({ embedding: [0.25, 0.5], usage: { inputTokens: 4 } }),
  });
  const { client } = await serve(t, source);

  const response = await client.embedding({
    target: target(),
    request: { model: 'embed', input: 'hello', dimensions: 2 },
  });

  const request = recorded.embeddings[0];

  assert.ok(request !== undefined);
  assert.deepEqual(
    {
      model: request.model,
      input: request.input,
      dimensions: request.dimensions,
    },
    { model: 'embed', input: 'hello', dimensions: 2 },
  );
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(toJson(EmbeddingResponseSchema, response), {
    providerEmbeddingFinished: {
      embedding: [0.25, 0.5],
      usage: { inputTokens: 4 },
    },
  });
});

void test('Rerank passes its request and signal through and answers the provider’s result', async (t) => {
  const { source, recorded } = fakeSource({
    rerank: () =>
      Promise.resolve({ results: [{ index: 1, relevanceScore: 0.9 }] }),
  });
  const { client } = await serve(t, source);

  const response = await client.rerank({
    target: target(),
    request: { model: 'rr', query: 'q', documents: ['a', 'b'], topN: 1 },
  });

  const request = recorded.reranks[0];

  assert.ok(request !== undefined);
  assert.deepEqual(
    {
      model: request.model,
      query: request.query,
      documents: request.documents,
      topN: request.topN,
    },
    { model: 'rr', query: 'q', documents: ['a', 'b'], topN: 1 },
  );
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(toJson(RerankResponseSchema, response), {
    providerRerankFinished: { results: [{ index: 1, relevanceScore: 0.9 }] },
  });
});

void test('Models answers the provider’s models, raw included, and passes the signal', async (t) => {
  const { source, recorded } = fakeSource({
    models: () =>
      Promise.resolve([
        {
          id: 'fake-model',
          name: 'Fake',
          contextWindow: 128_000,
          inputModalities: ['text', 'image'],
          provider: 'fake',
          raw: { family: 'f', tags: ['a'] },
        },
      ]),
  });
  const { client } = await serve(t, source);

  const response = await client.models({ target: target() });

  assert.ok(recorded.signals[0] instanceof AbortSignal);
  assert.deepEqual(toJson(ModelsResponseSchema, response), {
    models: [
      {
        id: 'fake-model',
        name: 'Fake',
        contextWindow: 128_000,
        inputModalities: ['text', 'image'],
        provider: 'fake',
        raw: { family: 'f', tags: ['a'] },
      },
    ],
  });
});

void test('ValidateModel answers the provider’s model, and an unknown model fails as the provider does', async (t) => {
  const unknown: ProviderError = {
    provider: 'fake',
    code: 'missing_model',
    message: 'Unknown model nope.',
  };
  const { source, recorded } = fakeSource({
    validateModel: (model) =>
      model === 'fake-model'
        ? Promise.resolve({ id: 'fake-model', name: 'Fake' })
        : Promise.reject(new ProviderErrorObject(unknown)),
  });
  const { client } = await serve(t, source);

  const response = await client.validateModel({
    target: target(),
    model: 'fake-model',
  });

  assert.deepEqual(recorded.validated, ['fake-model']);
  assert.ok(recorded.signals[0] instanceof AbortSignal);
  assert.deepEqual(toJson(ValidateModelResponseSchema, response), {
    model: { id: 'fake-model', name: 'Fake' },
  });

  const error = await rejectsWithCode(
    client.validateModel({ target: target(), model: 'nope' }),
    'provider_error',
  );

  assert.deepEqual(error.details, { providerError: unknown });
});

// ---------------------------------------------------------------------------
// 9–10. Images by reference (T3.7 unit level, AC3.9 unit half).
// ---------------------------------------------------------------------------

void test('a 5 MiB image by reference reaches the provider as a data URL read in chunks of at most 1 MiB', async (t) => {
  const bytes = new Uint8Array(5 * MiB);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }

  const attachments = fakeAttachments(
    new Map([
      [attachmentId, { mediaType: 'image/png', name: 'diagram.png', bytes }],
    ]),
  );
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source, {
    fakes: [attachments.entry],
    scope: { threadId: 'thread-1' },
  });
  const items: RequestItem[] = [
    simpleHeader(),
    imageMessage({
      case: 'attachment',
      value: { id: attachmentId, mediaType: 'image/png' },
    }),
  ];

  await drain(client.stream(itemsOf(...items)));

  const content = recorded.requests[0]?.messages[0]?.content;

  assert.ok(Array.isArray(content), 'the provider received no parts');
  assert.deepEqual(content[0], { type: 'text', text: 'What is this?' });

  const image = content[1];
  const expected = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

  assert.equal(image?.type, 'image');
  assert.ok(
    image?.type === 'image' && image.imageUrl === expected,
    'the image is not the 5 MiB as a data:image/png URL',
  );

  assert.deepEqual(attachments.seen.reads, [
    { id: attachmentId, scope: { threadId: 'thread-1' } },
  ]);

  for (const item of items) {
    const size = toBinary(
      StreamRequestSchema,
      create(StreamRequestSchema, item),
    ).length;

    assert.ok(size <= 64 * KiB, `a request item is ${size} bytes`);
  }

  assert.equal(attachments.seen.answeredSizes.length, 6);

  for (const size of attachments.seen.answeredSizes) {
    assert.ok(size <= MiB + 16, `an answered item is ${size} bytes`);
  }
});

void test('a Read head without an attachment fails with not_found and calls no provider', async (t) => {
  const attachments = fakeAttachments(new Map());
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source, { fakes: [attachments.entry] });

  const error = await rejectsWithCode(
    drain(
      client.stream(
        itemsOf<RequestItem>(
          simpleHeader(),
          imageMessage({
            case: 'attachment',
            value: { id: attachmentId, mediaType: 'image/png' },
          }),
        ),
      ),
    ),
    'not_found',
  );

  assert.equal(error.message, `Attachment ${attachmentId} is not available.`);
  assert.equal(recorded.requests.length, 0);
});

void test('with no provider of runtime.attachments/v1, an image by reference fails with unavailable and calls no provider', async (t) => {
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source, {
    requires: [AttachmentsService.typeName],
  });

  await rejectsWithCode(
    client.complete(
      itemsOf<RequestItem>(
        simpleHeader(),
        imageMessage({
          case: 'attachment',
          value: { id: attachmentId, mediaType: 'image/png' },
        }),
      ),
    ),
    'unavailable',
  );

  assert.equal(recorded.requests.length, 0);
});

void test('with runtime.attachments/v1 undeclared, an image by reference fails with unavailable and calls no provider', async (t) => {
  const attachments = fakeAttachments(new Map());
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source, {
    fakes: [attachments.entry],
    requires: [],
  });

  await rejectsWithCode(
    client.complete(
      itemsOf<RequestItem>(
        simpleHeader(),
        imageMessage({
          case: 'attachment',
          value: { id: attachmentId, mediaType: 'image/png' },
        }),
      ),
    ),
    'unavailable',
  );

  assert.equal(recorded.requests.length, 0);
});

void test('an image by https URL reaches the provider unchanged, with no Read', async (t) => {
  const attachments = fakeAttachments(new Map());
  const { source, recorded } = fakeSource();
  const { client } = await serve(t, source, { fakes: [attachments.entry] });

  await client.complete(
    itemsOf<RequestItem>(
      simpleHeader(),
      imageMessage({ case: 'url', value: 'https://img.test/a.png' }),
    ),
  );

  assert.deepEqual(plain(recorded.requests[0]?.messages[0]?.content), [
    { type: 'text', text: 'What is this?' },
    { type: 'image', imageUrl: 'https://img.test/a.png' },
  ]);
  assert.equal(attachments.seen.reads.length, 0);
});

// ---------------------------------------------------------------------------
// 11. Secrets.
// ---------------------------------------------------------------------------

void test('no secret appears in a log or an error of a failing call', async (t) => {
  const secret = 'sk-live-0123456789abcdef';
  const { source } = fakeSource({
    complete: () =>
      Promise.reject(
        new ProviderErrorObject({
          provider: 'fake',
          code: 'auth_failed',
          message: 'The token was refused.',
          status: 401,
        }),
      ),
  });
  const { client, router } = await serve(t, source);

  const buildError = await rejectsWithCode(
    client.models({ target: target({ values: {}, secret }) }),
    'invalid_input',
  );
  const providerError = await rejectsWithCode(
    client.complete(itemsOf<RequestItem>(simpleHeader(secret), userText('hi'))),
    'provider_error',
  );

  for (const error of [buildError, providerError]) {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(
      JSON.stringify(error.details ?? null),
      new RegExp(secret),
    );
  }

  assert.doesNotMatch(JSON.stringify(router.logs), new RegExp(secret));
});
