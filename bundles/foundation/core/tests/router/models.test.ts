// `models/v1` served by `core` over the router (S41b): `core` relays to the
// provider bundle that reports the configured provider's kind through
// `models.provider/v1` (`use(ProviderService, { provider: bundleId })`),
// with a target of the provider id, its configuration without the secret
// fields, and the secret read per request through `secrets/v1`.
//
// The provider bundles are the boundary: `serveCore({ modelProviders })`
// answers each with a fake and records the calls core made
// (`providerCalls`). Coordinator decisions (S41 contracts, gaps 4 and 5):
// `Prepare` builds nothing, and each call uses the configuration active at
// call time.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  type DescMessage,
  type JsonObject,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import { ContractError, fromConnectError } from 'bundle/contracts';
import {
  ModelIconChoiceSchema,
  type ModelKindDescriptor,
  ModelKindDescriptorSchema,
  ProviderService,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { ajvValidators } from 'bundle/host';
import { createTestRouter } from 'bundle/testing';
import { modelIconSvg } from 'llms';

import { createCoreServices } from '../../src/host/services.js';
import {
  type ModelProviderFake,
  type RoutedCore,
  serveCore,
  testMessages,
} from '../support/router.js';

type Models = Client<typeof ModelsService>;
type ModelKindInit = Parameters<
  typeof create<typeof ModelKindDescriptorSchema>
>[1];

// --- Fixture ----------------------------------------------------------------

const ENDPOINT = 'https://api.openai.example.test/v1';
const SECRET = 'sk-1';

/** Advertised, with a secret field and catalog capacity. */
const OPENAI: ModelKindInit = {
  id: 'openai',
  label: 'OpenAI',
  description: 'OpenAI models.',
  fields: [
    { key: 'apiKey', label: 'API key', kind: 'secret', required: true },
    { key: 'baseUrl', label: 'Base URL', kind: 'url', required: false },
  ],
  lists: ['models'],
};

/** Not advertised, no fields, no capacity. */
const CODEX: ModelKindInit = {
  id: 'codex',
  label: 'Codex',
  description: 'Codex models.',
  fields: [],
  lists: ['models'],
};

const kindOf = (id: string): ModelKindInit => ({
  id,
  label: id,
  description: `The ${id} kind.`,
  fields: [],
  lists: ['models'],
});

/** A provider bundle reporting `descriptor`; `more` adds or replaces methods. */
const providerFake = (
  descriptor: ModelKindInit,
  flags: { readonly advertised?: boolean; readonly capacity?: boolean } = {},
  more: ModelProviderFake = {},
): ModelProviderFake => ({
  kind: () => ({ modelKindDescriptor: descriptor }),
  advertised: () => ({ advertised: flags.advertised ?? true }),
  catalogCapacity: () => ({ catalogCapacity: flags.capacity ?? false }),
  ...more,
});

const openaiFake = (more: ModelProviderFake = {}) =>
  providerFake(OPENAI, { advertised: true, capacity: true }, more);

const codexFake = (more: ModelProviderFake = {}) =>
  providerFake(CODEX, { advertised: false, capacity: false }, more);

/** The configured provider `main` of kind `openai`. */
const mainProvider = (credentialId: string, id = 'main'): JsonObject => ({
  id,
  kind: 'openai',
  configuration: { apiKey: credentialId, baseUrl: ENDPOINT },
  models: [{ name: 'gpt-5' }],
});

/** The configured provider `cx` of kind `codex`. */
const codexProvider: JsonObject = {
  id: 'cx',
  kind: 'codex',
  configuration: {},
  models: [{ name: 'codex-1' }],
};

/** `main`'s target: the configuration without `apiKey`, and the secret. */
const mainTarget = (secret = SECRET) => ({
  providerId: 'main',
  values: { baseUrl: ENDPOINT },
  secret,
});

interface World {
  readonly core: RoutedCore;
  /** `models/v1` as the bundle `agent` (generation 1). */
  readonly models: Models;
  /** `secrets/v1` as the platform. */
  readonly secrets: Client<typeof SecretsService>;
  /** The stored credential whose secret is {@link SECRET}. */
  readonly credentialId: string;
}

/**
 * `core` served with `fakes` as the provider bundles (by default
 * `openai-models` then `codex-models`) and one stored `API_TOKEN`
 * credential holding {@link SECRET}.
 */
const withModels = async (
  run: (world: World) => Promise<void>,
  fakes: Record<string, ModelProviderFake> = {
    'openai-models': openaiFake(),
    'codex-models': codexFake(),
  },
) => {
  const core = await serveCore({
    bundles: { agent: [] },
    modelProviders: fakes,
  });

  try {
    const secrets = core.client(SecretsService, 'doric');
    const created = (
      await secrets.create({
        kind: 'API_TOKEN',
        name: 'openai',
        secret: SECRET,
      })
    ).credentialDescription;

    assert.ok(created !== undefined);
    await run({
      core,
      models: core.client(ModelsService, 'agent'),
      secrets,
      credentialId: created.id,
    });
  } finally {
    await core.close();
  }
};

/** `Prepare` of a stored configuration snapshot (it becomes the active set). */
const prepare = (
  models: Models,
  revision: number,
  providers: readonly JsonObject[],
) =>
  models.prepare({
    configuration: { revision, configuration: { providers: [...providers] } },
  });

// --- Observation helpers ----------------------------------------------------

const json = <D extends DescMessage>(schema: D, message: unknown) =>
  toJson(schema, message as MessageShape<D>);

/** The requests of every `method` call core made, as proto JSON, in order. */
const callsOf = (
  core: RoutedCore,
  method: keyof typeof ProviderService.method,
  provider?: string,
) => {
  const { input } = ProviderService.method[method];

  return core.providerCalls
    .filter(
      (call) =>
        call.method === method &&
        (provider === undefined || call.provider === provider),
    )
    .map(({ request }) =>
      Array.isArray(request)
        ? request.map((item) => json(input, item))
        : json(input, request),
    );
};

const RELAYED = [
  'complete',
  'stream',
  'embedding',
  'rerank',
  'models',
  'validateModel',
] as const;

/** How many relayed `models.provider/v1` calls core made. */
const relayedCalls = (core: RoutedCore) =>
  core.providerCalls.filter(({ method }) =>
    (RELAYED as readonly string[]).includes(method),
  ).length;

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  message?: string,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);

    if (message !== undefined) {
      assert.equal(contract.message, message);
    }

    return true;
  });
};

const UNAVAILABLE = 'Configured provider is unavailable.';

/** Every item of a server stream. */
const drain = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
};

/** `promise`, or a rejection naming `what` after `ms`. */
const within = async <T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Expected ${what} within ${ms} ms.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const header = (providerId: string) => ({
  item: {
    case: 'header' as const,
    value: { providerId, options: { model: 'gpt-5' } },
  },
});

const message = (text: string) => ({
  item: {
    case: 'message' as const,
    value: { role: 'user', content: { case: 'text' as const, value: text } },
  },
});

/** A `Complete` or `Stream` request item. */
type Item = ReturnType<typeof header> | ReturnType<typeof message>;

async function* itemsOf(...items: Item[]) {
  for (const item of items) {
    yield item;
  }
}

const descriptorJson = (init: ModelKindInit) =>
  json(ModelKindDescriptorSchema, create(ModelKindDescriptorSchema, init));

const kindJson = (descriptor: ModelKindDescriptor | undefined) =>
  descriptor === undefined
    ? undefined
    : json(ModelKindDescriptorSchema, descriptor);

// --- Kinds --------------------------------------------------------------------

void test('Kinds answers the advertised kinds in provider order as their bundles declare them, and Kind answers any reported kind', async () => {
  await withModels(
    async ({ models }) => {
      const { kinds } = await models.kinds({});

      assert.deepEqual(kinds.map(kindJson), [
        descriptorJson(kindOf('zeta')),
        descriptorJson(OPENAI),
      ]);
      assert.deepEqual(
        kindJson((await models.kind({ id: 'codex' })).modelKindDescriptor),
        descriptorJson(CODEX),
      );
      assert.equal(
        (await models.kind({ id: 'nope' })).modelKindDescriptor,
        undefined,
      );
    },
    {
      'zeta-models': providerFake(kindOf('zeta')),
      'openai-models': openaiFake(),
      'codex-models': codexFake(),
    },
  );
});

void test('a bundle whose Kind fails is left out and read again by the next Kinds; one whose CatalogCapacity fails keeps its kind without capacity', async () => {
  let kindReads = 0;

  await withModels(
    async ({ core, models, credentialId }) => {
      const ids = async () =>
        (await models.kinds({})).kinds.map(({ id }) => id);

      assert.deepEqual(await ids(), ['openai']);
      assert.deepEqual(await ids(), ['openai', 'flaky']);

      // `openai` has no capacity: its provider is no context-window
      // candidate, so its catalog is not read.
      await prepare(models, 1, [mainProvider(credentialId)]);
      assert.equal(
        (await models.contextWindow({ model: 'gpt-5' })).contextWindow,
        undefined,
      );
      assert.deepEqual(callsOf(core, 'models'), []);
    },
    {
      'openai-models': openaiFake({
        catalogCapacity: () => {
          throw new ContractError('unavailable', 'Capacity is unknown.');
        },
        models: () => ({ models: [{ id: 'gpt-5', contextWindow: 128_000 }] }),
      }),
      'flaky-models': providerFake(
        kindOf('flaky'),
        {},
        {
          kind: () => {
            kindReads += 1;

            if (kindReads === 1) {
              throw new ContractError('unavailable', 'Not ready yet.');
            }

            return { modelKindDescriptor: kindOf('flaky') };
          },
        },
      ),
    },
  );
});

// --- Catalog --------------------------------------------------------------------

void test('Catalog passes the bundle the configuration unchanged and the stored secret its secret field names, or no secret', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      const read = await models.catalog({
        kind: 'openai',
        configuration: { apiKey: credentialId, baseUrl: ENDPOINT },
      });

      assert.deepEqual(json(ModelsService.method.catalog.output, read), {
        catalogResult: { status: 'read', models: [{ id: 'gpt-5' }] },
      });

      await models.catalog({
        kind: 'openai',
        configuration: { baseUrl: ENDPOINT },
      });
      await models.catalog({
        kind: 'openai',
        configuration: { apiKey: 'not-stored', baseUrl: ENDPOINT },
      });

      assert.deepEqual(callsOf(core, 'catalog', 'openai-models'), [
        {
          configuration: { apiKey: credentialId, baseUrl: ENDPOINT },
          secret: SECRET,
        },
        { configuration: { baseUrl: ENDPOINT } },
        { configuration: { apiKey: 'not-stored', baseUrl: ENDPOINT } },
      ]);
    },
    {
      'openai-models': openaiFake({
        catalog: () => ({
          catalogResult: { status: 'read', models: [{ id: 'gpt-5' }] },
        }),
      }),
    },
  );
});

void test('Catalog of an unreported kind is absent, and a failing bundle gives failed with one warn log that holds neither the secret nor the endpoint', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      assert.equal(
        (await models.catalog({ kind: 'mystery', configuration: {} }))
          .catalogResult?.status,
        'absent',
      );

      const failed = await models.catalog({
        kind: 'openai',
        configuration: { apiKey: credentialId, baseUrl: ENDPOINT },
      });

      assert.equal(failed.catalogResult?.status, 'failed');
      assert.deepEqual(failed.catalogResult?.models, []);

      const warnings = core.platformLogs.filter(
        ({ level }) => level === 'warn',
      );

      assert.equal(warnings.length, 1);

      const [warning] = warnings;

      assert.equal(warning?.message, 'Model catalog could not be read');
      assert.deepEqual(warning?.fields, { kind: 'openai' });

      const written = JSON.stringify(warning);

      assert.equal(written.includes(SECRET), false);
      assert.equal(written.includes(ENDPOINT), false);
    },
    {
      'openai-models': openaiFake({
        catalog: () => {
          throw new ContractError(
            'unavailable',
            `GET ${ENDPOINT}/models with ${SECRET} failed.`,
          );
        },
      }),
    },
  );
});

// --- Resolve and Prepare -------------------------------------------------------

void test('Resolve answers only providerId, model and effort for a provider of the active configuration, and unavailable otherwise', async () => {
  await withModels(async ({ models, credentialId }) => {
    await rejectsWith(
      models.resolve({ providerId: 'main', model: 'gpt-5' }),
      'unavailable',
      UNAVAILABLE,
    );

    await prepare(models, 1, [mainProvider(credentialId), codexProvider]);

    const resolved = await models.resolve({
      providerId: 'main',
      model: 'gpt-5',
      effort: 'high',
    });

    assert.deepEqual(json(ModelsService.method.resolve.output, resolved), {
      providerId: 'main',
      model: 'gpt-5',
      effort: 'high',
    });
    await rejectsWith(
      models.resolve({ providerId: 'nope', model: 'gpt-5' }),
      'unavailable',
      UNAVAILABLE,
    );
  });
});

void test('Prepare of an unknown kind fails unavailable and keeps the active set, and a configuration without providers is invalid_input', async () => {
  await withModels(async ({ models, credentialId }) => {
    await prepare(models, 1, [mainProvider(credentialId)]);

    await rejectsWith(
      prepare(models, 2, [{ id: 'other', kind: 'mystery', configuration: {} }]),
      'unavailable',
      'Unknown provider kind: mystery',
    );
    assert.equal(
      (await models.resolve({ providerId: 'main', model: 'gpt-5' })).providerId,
      'main',
    );
    await rejectsWith(
      models.resolve({ providerId: 'other', model: 'x' }),
      'unavailable',
      UNAVAILABLE,
    );

    await rejectsWith(
      models.prepare({ configuration: { revision: 3, configuration: {} } }),
      'invalid_input',
    );
  });
});

// --- Relayed operations -------------------------------------------------------

void test('Embedding reaches the bundle of the provider kind with the target and answers its result, which holds no secret', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId), codexProvider]);

      const answer = await models.embedding({
        providerId: 'main',
        request: { model: 'text-embed', input: 'hello' },
      });

      assert.deepEqual(json(ModelsService.method.embedding.output, answer), {
        providerEmbeddingFinished: { embedding: [0.25, 0.5] },
      });
      assert.deepEqual(callsOf(core, 'embedding'), [
        {
          target: mainTarget(),
          request: { model: 'text-embed', input: 'hello' },
        },
      ]);
      assert.equal(
        core.providerCalls.some(
          ({ provider, method }) =>
            provider === 'codex-models' && method === 'embedding',
        ),
        false,
      );
      assert.equal(JSON.stringify(answer).includes(SECRET), false);
    },
    {
      'openai-models': openaiFake({
        embedding: () => ({
          providerEmbeddingFinished: { embedding: [0.25, 0.5] },
        }),
      }),
      'codex-models': codexFake(),
    },
  );
});

void test('a credential rotation reaches the next request without a new Prepare, and a secret field naming no stored credential sends an empty secret', async () => {
  await withModels(
    async ({ core, models, secrets, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);
      await models.models({ providerId: 'main' });

      await secrets.update({
        ref: { id: credentialId },
        update: { secret: 'sk-2' },
      });
      await models.models({ providerId: 'main' });

      await prepare(models, 2, [mainProvider('not-stored')]);
      await models.models({ providerId: 'main' });

      assert.deepEqual(callsOf(core, 'models'), [
        { target: mainTarget('sk-1') },
        { target: mainTarget('sk-2') },
        { target: mainTarget('') },
      ]);
    },
    {
      'openai-models': openaiFake({
        models: () => ({ models: [{ id: 'gpt-5' }] }),
      }),
    },
  );
});

void test('Complete sends the bundle its header with the target and then each message in order, and answers the bundle result', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      const answer = await models.complete(
        itemsOf(
          header('main'),
          message('one'),
          message('two'),
          message('three'),
        ),
      );

      assert.deepEqual(json(ModelsService.method.complete.output, answer), {
        providerFinished: { text: 'done', finishReason: 'stop' },
      });
      assert.deepEqual(callsOf(core, 'complete'), [
        [
          { header: { target: mainTarget(), options: { model: 'gpt-5' } } },
          { message: { role: 'user', text: 'one' } },
          { message: { role: 'user', text: 'two' } },
          { message: { role: 'user', text: 'three' } },
        ],
      ]);
    },
    {
      'openai-models': openaiFake({
        complete: async (requests) => {
          for await (const _item of requests) {
            // Read every item, so the recorded call holds them all.
          }

          return { providerFinished: { text: 'done', finishReason: 'stop' } };
        },
      }),
    },
  );
});

void test('Complete that starts with a message or carries a second header is invalid_input', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      await rejectsWith(
        models.complete(itemsOf(message('one'), header('main'))),
        'invalid_input',
      );
      assert.equal(relayedCalls(core), 0);

      await rejectsWith(
        models.complete(
          itemsOf(header('main'), message('one'), header('main')),
        ),
        'invalid_input',
      );
    },
    {
      'openai-models': openaiFake({
        complete: async (requests) => {
          for await (const _item of requests) {
            // Read every item.
          }

          return { providerFinished: { text: 'done', finishReason: 'stop' } };
        },
      }),
    },
  );
});

void test('Stream relays each provider event as it arrives, an in-band error event included', async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delta = (text: string) => ({
    providerStreamEvent: {
      type: { case: 'textDelta' as const, value: { delta: text } },
    },
  });

  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      try {
        const events = models
          .stream(itemsOf(header('main'), message('hi')))
          [Symbol.asyncIterator]();
        const first = await within(
          events.next(),
          2000,
          'event 1 before the provider sends event 2',
        );

        assert.equal(first.done, false);
        assert.deepEqual(
          json(ModelsService.method.stream.output, first.value),
          {
            providerStreamEvent: { textDelta: { delta: 'a' } },
          },
        );

        release();

        const rest: unknown[] = [];

        for (
          let next = await events.next();
          !next.done;
          next = await events.next()
        ) {
          rest.push(json(ModelsService.method.stream.output, next.value));
        }

        assert.deepEqual(rest, [
          { providerStreamEvent: { textDelta: { delta: 'b' } } },
          {
            providerStreamEvent: {
              error: {
                error: {
                  provider: 'openai',
                  code: 'rate_limited',
                  message: 'Slow down.',
                },
              },
            },
          },
        ]);
        assert.deepEqual(callsOf(core, 'stream'), [
          [
            { header: { target: mainTarget(), options: { model: 'gpt-5' } } },
            { message: { role: 'user', text: 'hi' } },
          ],
        ]);
      } finally {
        release();
      }
    },
    {
      'openai-models': openaiFake({
        async *stream(requests) {
          for await (const _item of requests) {
            // Read every item first.
          }

          yield delta('a');
          await released;
          yield delta('b');
          yield {
            providerStreamEvent: {
              type: {
                case: 'error',
                value: {
                  error: {
                    provider: 'openai',
                    code: 'rate_limited',
                    message: 'Slow down.',
                  },
                },
              },
            },
          };
        },
      }),
    },
  );
});

void test('Stream ends with the provider call error code, and cancelling the caller aborts the provider call', async () => {
  let refused = true;
  let aborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => {
    aborted = resolve;
  });

  await withModels(
    async ({ models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      await rejectsWith(
        drain(models.stream(itemsOf(header('main'), message('hi')))),
        'credential_invalid',
      );

      refused = false;

      const controller = new AbortController();
      const events = models
        .stream(itemsOf(header('main'), message('hi')), {
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();

      assert.equal((await events.next()).done, false);
      controller.abort();
      await within(abortSeen, 2000, 'the provider call to be aborted');
      await events.return?.();
    },
    {
      'openai-models': openaiFake({
        async *stream(requests, context) {
          for await (const _item of requests) {
            // Read every item first.
          }

          if (refused) {
            throw new ContractError(
              'credential_invalid',
              'The key was refused.',
            );
          }

          yield {
            providerStreamEvent: {
              type: { case: 'textDelta', value: { delta: 'a' } },
            },
          };
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              resolve();
            }

            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          aborted();
        },
      }),
    },
  );
});

void test('Rerank, Models and ValidateModel relay with the target, and a refused model ends with the bundle code', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      const reranked = await models.rerank({
        providerId: 'main',
        request: { model: 'rr', query: 'q', documents: ['a', 'b'] },
      });
      const listed = await models.models({ providerId: 'main' });
      const valid = await models.validateModel({
        providerId: 'main',
        model: 'gpt-5',
      });

      assert.deepEqual(json(ModelsService.method.rerank.output, reranked), {
        providerRerankFinished: {
          results: [{ index: 1, relevanceScore: 0.9 }],
        },
      });
      assert.deepEqual(json(ModelsService.method.models.output, listed), {
        models: [{ id: 'gpt-5', name: 'GPT-5' }],
      });
      assert.deepEqual(json(ModelsService.method.validateModel.output, valid), {
        model: { id: 'gpt-5', name: 'GPT-5' },
      });
      await rejectsWith(
        models.validateModel({ providerId: 'main', model: 'nope' }),
        'not_found',
        'Unknown model nope.',
      );

      assert.deepEqual(callsOf(core, 'rerank'), [
        {
          target: mainTarget(),
          request: { model: 'rr', query: 'q', documents: ['a', 'b'] },
        },
      ]);
      assert.deepEqual(callsOf(core, 'models'), [{ target: mainTarget() }]);
      assert.deepEqual(callsOf(core, 'validateModel'), [
        { target: mainTarget(), model: 'gpt-5' },
        { target: mainTarget(), model: 'nope' },
      ]);
    },
    {
      'openai-models': openaiFake({
        rerank: () => ({
          providerRerankFinished: {
            results: [{ index: 1, relevanceScore: 0.9 }],
          },
        }),
        models: () => ({ models: [{ id: 'gpt-5', name: 'GPT-5' }] }),
        validateModel: ({ model }) => {
          if (model !== 'gpt-5') {
            throw new ContractError('not_found', `Unknown model ${model}.`);
          }

          return { model: { id: 'gpt-5', name: 'GPT-5' } };
        },
      }),
    },
  );
});

void test('every relayed RPC on an unknown provider, or on one whose kind bundle left the catalog, fails unavailable and makes no provider call', async () => {
  const relays = (models: Models, providerId: string) => [
    () => models.complete(itemsOf(header(providerId), message('hi'))),
    () => drain(models.stream(itemsOf(header(providerId), message('hi')))),
    () =>
      models.embedding({
        providerId,
        request: { model: 'text-embed', input: 'hello' },
      }),
    () =>
      models.rerank({
        providerId,
        request: { model: 'rr', query: 'q', documents: ['a'] },
      }),
    () => models.models({ providerId }),
    () => models.validateModel({ providerId, model: 'gpt-5' }),
  ];
  const answering: ModelProviderFake = {
    complete: async () => ({
      providerFinished: { text: '', finishReason: 'stop' },
    }),
    async *stream() {},
    embedding: () => ({ providerEmbeddingFinished: {} }),
    rerank: () => ({ providerRerankFinished: {} }),
    models: () => ({ models: [] }),
    validateModel: () => ({ model: { id: 'gpt-5' } }),
  };

  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      for (const relay of relays(models, 'ghost')) {
        await rejectsWith(relay(), 'unavailable', UNAVAILABLE);
      }

      assert.equal(relayedCalls(core), 0);

      // `openai-models` leaves the catalog; a caller of generation 2 reads a
      // snapshot without it.
      core.modelProviders.delete('openai-models');

      const later = core.client(ModelsService, 'agent', { generation: 2 });

      for (const relay of relays(later, 'main')) {
        await rejectsWith(relay(), 'unavailable', UNAVAILABLE);
      }

      assert.equal(relayedCalls(core), 0);
    },
    { 'openai-models': openaiFake(answering) },
  );
});

// --- Capacity reads -------------------------------------------------------------

void test('ContextWindow reads the one capacity provider listing the model, and answers absent without failing otherwise', async () => {
  let mode: 'listed' | 'failing' | 'zero' | 'infinite' = 'listed';

  await withModels(
    async ({ core, models, credentialId }) => {
      const windowOf = async (model: string, providerId?: string) =>
        (
          await models.contextWindow({
            model,
            ...(providerId === undefined ? {} : { providerId }),
          })
        ).contextWindow;

      await prepare(models, 1, [mainProvider(credentialId), codexProvider]);
      assert.equal(await windowOf('gpt-5'), 128_000);
      assert.deepEqual(callsOf(core, 'models', 'openai-models'), [
        { target: mainTarget() },
      ]);
      assert.equal(await windowOf('codex-1'), undefined);

      // Two candidates list the model; naming one picks it.
      await prepare(models, 2, [
        mainProvider(credentialId),
        mainProvider(credentialId, 'second'),
      ]);
      assert.equal(await windowOf('gpt-5'), undefined);
      assert.equal(await windowOf('gpt-5', 'main'), 128_000);

      await prepare(models, 3, [mainProvider(credentialId)]);

      for (const failing of ['failing', 'zero', 'infinite'] as const) {
        mode = failing;
        assert.equal(await windowOf('gpt-5'), undefined, failing);
      }
    },
    {
      'openai-models': openaiFake({
        models: () => {
          if (mode === 'failing') {
            throw new ContractError('unavailable', 'The catalog is down.');
          }

          const contextWindow =
            mode === 'zero'
              ? 0
              : mode === 'infinite'
                ? Number.POSITIVE_INFINITY
                : 128_000;

          return {
            models: [
              {
                id: 'gpt-5',
                contextWindow,
                inputModalities: ['text', 'image'],
              },
            ],
          };
        },
      }),
      'codex-models': codexFake({
        models: () => ({ models: [{ id: 'codex-1', contextWindow: 64_000 }] }),
      }),
    },
  );
});

void test('InputModalities answers known modalities from the one candidate and unknown otherwise, never failing', async () => {
  let failing = false;

  await withModels(
    async ({ models, credentialId }) => {
      const modalitiesOf = async (model: string) => {
        const { known, inputModalities } = await models.inputModalities({
          model,
        });

        return { known, inputModalities };
      };

      await prepare(models, 1, [mainProvider(credentialId)]);

      assert.deepEqual(await modalitiesOf('gpt-5'), {
        known: true,
        inputModalities: ['text', 'image'],
      });
      assert.deepEqual(await modalitiesOf('nope'), {
        known: false,
        inputModalities: [],
      });

      failing = true;
      assert.deepEqual(await modalitiesOf('gpt-5'), {
        known: false,
        inputModalities: [],
      });
    },
    {
      'openai-models': openaiFake({
        models: () => {
          if (failing) {
            throw new ContractError('unavailable', 'The catalog is down.');
          }

          return {
            models: [{ id: 'gpt-5', inputModalities: ['text', 'image'] }],
          };
        },
      }),
    },
  );
});

// --- Icons ------------------------------------------------------------------------

void test('Icons asks the kind bundle with a draft configuration or a configured provider values, gives none for every failure, and falls back to the provider icon', async () => {
  await withModels(
    async ({ core, models, credentialId }) => {
      await prepare(models, 1, [mainProvider(credentialId)]);

      const draft = (kind: string, modelIds: readonly string[]) => ({
        kind,
        configuration: { baseUrl: 'https://draft.example.test' },
        models: [...modelIds],
      });
      const answer = await within(
        models.icons({
          requests: [
            draft('openai', ['m1', 'm2']),
            { providerId: 'main', models: ['gpt-5'] },
            { providerId: 'ghost', models: ['x'] },
            draft('mystery', ['x']),
            draft('rejects', ['x']),
            draft('slow', ['x']),
            draft('short', ['x', 'y']),
          ],
        }),
        5000,
        'Icons to answer despite a bundle that never answers',
      );

      assert.deepEqual(
        answer.answers.map((choice) => json(ModelIconChoiceSchema, choice)),
        [
          { provider: 'openai', models: ['claude', 'openai'] },
          { provider: 'openai', models: ['claude'] },
          { models: [''] },
          { models: [''] },
          { models: [''] },
          { models: [''] },
          { models: ['', ''] },
        ],
      );
      assert.deepEqual(Object.keys(answer.svgs).sort(), ['claude', 'openai']);
      assert.equal(answer.svgs.claude, modelIconSvg('claude'));
      assert.equal(answer.svgs.openai, modelIconSvg('openai'));

      const asked = callsOf(core, 'icons', 'openai-models').map((request) =>
        JSON.stringify(request),
      );

      assert.deepEqual(
        asked.sort(),
        [
          JSON.stringify({
            configuration: { baseUrl: 'https://draft.example.test' },
            models: ['m1', 'm2'],
          }),
          JSON.stringify({
            configuration: { baseUrl: ENDPOINT },
            models: ['gpt-5'],
          }),
        ].sort(),
      );
    },
    {
      'openai-models': openaiFake({
        // The first model has its own icon; the others fall back.
        icons: ({ models: modelIds }) => ({
          modelIconChoice: {
            provider: 'openai',
            models: modelIds.map((_, index) => (index === 0 ? 'claude' : '')),
          },
        }),
      }),
      'rejects-models': providerFake(
        kindOf('rejects'),
        {},
        {
          icons: () => {
            throw new ContractError('unavailable', 'No icons.');
          },
        },
      ),
      'slow-models': providerFake(
        kindOf('slow'),
        {},
        {
          icons: (_request, context) =>
            new Promise((_resolve, reject) => {
              context.signal.addEventListener(
                'abort',
                () => reject(new ContractError('cancelled', 'Too late.')),
                { once: true },
              );
            }),
        },
      ),
      'short-models': providerFake(
        kindOf('short'),
        {},
        {
          icons: ({ models: modelIds }) => ({
            modelIconChoice: { provider: 'openai', models: modelIds.slice(1) },
          }),
        },
      ),
    },
  );
});

// --- Activation -----------------------------------------------------------------

void test('every models/v1 RPC fails with unavailable until activate ran', async () => {
  const core = createCoreServices({
    types: testMessages(),
    validators: ajvValidators(),
  });
  const router = createTestRouter();

  // Served, but `core.activate` is never called.
  await router.activate({ services: core.services, activate: () => {} });

  try {
    const models = router.client(ModelsService, {
      caller: { bundleId: 'agent', version: '1.2.3', generation: 1 },
    });
    const calls: readonly (() => Promise<unknown>)[] = [
      () => models.resolve({ providerId: 'main', model: 'gpt-5' }),
      () => models.kinds({}),
      () => models.kind({ id: 'openai' }),
      () => models.catalog({ kind: 'openai', configuration: {} }),
      () => models.prepare({ configuration: { providers: [] } }),
      () => models.contextWindow({ model: 'gpt-5' }),
      () => models.inputModalities({ model: 'gpt-5' }),
      () => models.icons({ requests: [] }),
      () => models.complete(itemsOf(header('main'))),
      () => drain(models.stream(itemsOf(header('main')))),
      () =>
        models.embedding({
          providerId: 'main',
          request: { model: 'text-embed', input: 'hello' },
        }),
      () =>
        models.rerank({
          providerId: 'main',
          request: { model: 'rr', query: 'q', documents: [] },
        }),
      () => models.models({ providerId: 'main' }),
      () => models.validateModel({ providerId: 'main', model: 'gpt-5' }),
    ];

    for (const call of calls) {
      await rejectsWith(call(), 'unavailable');
    }
  } finally {
    await router.control.stop();
  }
});
