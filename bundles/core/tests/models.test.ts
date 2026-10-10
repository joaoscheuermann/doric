import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Descriptor, EmbeddedBundle, ManifestV1 } from 'bundle';
import { type Models, ModelsV1, SecretsV1 } from 'bundle/contracts';
import { createActivate as createCodex } from 'codex/host';
import {
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type LlmProvider,
  providerKind,
  providerKinds,
} from 'llms';
import { createActivate as createOpenAi } from 'openai/host';
import { createActivate as createOpenRouter } from 'openrouter/host';

import { readModelProperties } from '../src/contracts/index.js';
import { type Booted, boot, core } from './support/host.js';

// D-M: models/v1 over the provider bundles `openai`, `openrouter` and `codex`
// (design 57 §6, stage 10 §3.1-3.3), with the
// cases of the host's provider generation and model catalog tests.

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** Every request the providers sent, and the answer the test chose. */
const fakeTransport = (
  answer: (request: HttpRequest) => HttpResponse = () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ data: [] }),
  }),
) => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: (request) => {
      requests.push(request);

      return Promise.resolve(answer(request));
    },
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };

  return { requests, transport };
};

/** The three provider-kind bundles, over one transport. */
const providers = async (transport: HttpTransport): Promise<EmbeddedBundle[]> =>
  Promise.all(
    (
      [
        ['codex', createCodex],
        ['openai', createOpenAi],
        ['openrouter', createOpenRouter],
      ] as const
    ).map(async ([id, create]) => ({
      manifest: (await readJson(
        `bundles/${id}/dist/manifest.json`,
      )) as ManifestV1,
      descriptor: (await readJson(
        `bundles/${id}/dist/contracts.json`,
      )) as Descriptor,
      host: { activate: create({ transport: () => transport }) },
    })),
  );

interface World {
  readonly host: Booted;
  readonly models: Models;
  readonly requests: HttpRequest[];
  /** Stores an API token and returns its id. */
  token(name: string, secret: string): Promise<string>;
  rotate(id: string, secret: string): Promise<void>;
}

const withModels = async (
  run: (world: World) => Promise<void>,
  answer?: (request: HttpRequest) => HttpResponse,
) => {
  const { requests, transport } = fakeTransport(answer);
  const host = await boot([await core(), ...(await providers(transport))], {
    enabled: ['codex', 'openai', 'openrouter'],
  });
  const secrets = host.platform.services.use(SecretsV1);

  try {
    await run({
      host,
      models: host.platform.services.use(ModelsV1),
      requests,
      token: async (name, secret) =>
        (await secrets.create({ kind: 'API_TOKEN', name, secret })).id,
      rotate: async (id, secret) => {
        await secrets.update({ id }, { secret });
      },
    });
  } finally {
    await host.close();
  }
};

const snapshot = (
  revision: number,
  providers: readonly {
    id: string;
    kind: string;
    configuration: Record<string, string>;
  }[],
) => ({
  configuration: {
    providers,
    models: { execution: { providerId: providers[0]?.id ?? '', model: 'm' } },
    execution: { maxTurns: 10 },
  },
  revision,
  updatedAt: '2026-10-09T00:00:00.000Z',
});

const openai = (id: string, token?: string) => ({
  id,
  kind: 'openai',
  configuration: {
    endpoint: `https://${id}.example.test/v1`,
    ...(token === undefined ? {} : { token }),
  },
});

const initialized = (host: Booted) =>
  host.records.filter(({ message }) => message === 'llm provider initialized')
    .length;

const authorizationOf = (request: HttpRequest | undefined) =>
  request?.headers?.authorization;

void test('the advertised kinds are the llms provider kinds, in order, and codex is a kind but not advertised', async () => {
  await withModels(async ({ models }) => {
    assert.deepEqual(await models.kinds(), providerKinds);
    assert.deepEqual(
      (await models.kinds()).map(({ id }) => id),
      ['openai', 'openrouter'],
    );
    assert.deepEqual(await models.kind('codex'), providerKind('codex'));
    assert.deepEqual(await models.kind('openai'), providerKind('openai'));
    assert.equal(await models.kind('anthropic'), undefined);
  });
});

void test('a catalog read sends the stored credential the draft names as a bearer token', async () => {
  await withModels(
    async ({ models, requests, token }) => {
      const id = await token('openrouter', 'sk-or');
      const read = await models.catalog({
        kind: 'openrouter',
        configuration: { token: id },
      });

      assert.equal(read.status, 'read');
      assert.deepEqual(
        read.status === 'read' ? read.models.map(({ id }) => id) : [],
        ['openai/gpt-5'],
      );
      assert.deepEqual(requests.at(-1), {
        method: 'GET',
        url: 'https://openrouter.ai/api/v1/models',
        headers: { accept: 'application/json', authorization: 'Bearer sk-or' },
      });

      // A configured endpoint moves the catalog beside it; a configured URL wins.
      await models.catalog({
        kind: 'openrouter',
        configuration: { endpoint: 'https://proxy.test/api' },
      });
      assert.equal(requests.at(-1)?.url, 'https://proxy.test/api/models');
      assert.equal(authorizationOf(requests.at(-1)), undefined);
      await models.catalog({
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://proxy.test/api',
          modelsUrl: 'https://catalog.test/list',
        },
      });
      assert.equal(requests.at(-1)?.url, 'https://catalog.test/list');

      // A credential id that is not stored sends no authorization.
      await models.catalog({
        kind: 'openrouter',
        configuration: { token: '00000000-0000-4000-8000-00000000dead' },
      });
      assert.equal(authorizationOf(requests.at(-1)), undefined);
    },
    () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        data: [
          {
            id: 'openai/gpt-5',
            supported_parameters: ['reasoning'],
          },
        ],
      }),
    }),
  );
});

void test('a kind without a models URL keeps no catalog, and a failed read is logged without its details', async () => {
  await withModels(
    async ({ host, models, requests, token }) => {
      assert.deepEqual(
        await models.catalog({ kind: 'openai', configuration: {} }),
        { status: 'absent' },
      );
      assert.deepEqual(
        await models.catalog({ kind: 'anthropic', configuration: {} }),
        { status: 'absent' },
      );
      assert.equal(requests.length, 0);

      const id = await token('openrouter', 'sk-or-secret');

      assert.deepEqual(
        await models.catalog({
          kind: 'openrouter',
          configuration: { token: id },
        }),
        { status: 'failed' },
      );

      const warning = host.records.find(
        ({ message }) => message === 'Model catalog could not be read',
      );

      assert.equal(warning?.level, 'warn');
      assert.deepEqual(warning?.fields, { kind: 'openrouter' });
      assert.equal(JSON.stringify(warning).includes('sk-or-secret'), false);
    },
    () => ({ status: 503, headers: {}, body: 'unavailable' }),
  );
});

void test('resolve answers the provider of the active configuration, and an unknown one is unavailable', async () => {
  await withModels(async ({ host, models, requests, token }) => {
    await assert.rejects(models.resolve({ providerId: 'a', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });

    const id = await token('a', 'sk-a');

    await models.prepare(snapshot(1, [openai('a', id), openai('b')]));
    assert.equal(initialized(host), 2);

    const resolved = await models.resolve({
      providerId: 'a',
      model: 'gpt-5',
      effort: 'low',
    });

    assert.equal(resolved.providerId, 'a');
    assert.equal(resolved.model, 'gpt-5');
    assert.equal(resolved.effort, 'low');

    const provider = resolved.languageModel as unknown as LlmProvider;

    assert.deepEqual(provider.metadata, {
      id: 'a',
      name: 'a',
      baseUrl: 'https://a.example.test/v1',
    });
    await provider.models();
    assert.equal(authorizationOf(requests.at(-1)), 'Bearer sk-a');

    // The provider that names no credential sends no authorization.
    await (
      (await models.resolve({ providerId: 'b', model: 'm' }))
        .languageModel as unknown as LlmProvider
    ).models();
    assert.equal(authorizationOf(requests.at(-1)), undefined);

    await assert.rejects(models.resolve({ providerId: 'c', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });
  });
});

void test('a credential rotation reaches the next request of a provider already built', async () => {
  await withModels(async ({ models, requests, token, rotate }) => {
    const id = await token('a', 'first');

    await models.prepare(snapshot(1, [openai('a', id)]));

    const provider = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel as unknown as LlmProvider;

    await provider.models();
    assert.equal(authorizationOf(requests.at(-1)), 'Bearer first');
    await rotate(id, 'rotated');
    await provider.models();
    assert.equal(authorizationOf(requests.at(-1)), 'Bearer rotated');
  });
});

void test('each revision has its own providers, and a provider resolved before keeps working', async () => {
  await withModels(async ({ host, models, requests }) => {
    await models.prepare(snapshot(1, [openai('a')]));

    const first = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;

    // The same stored snapshot again builds nothing.
    await models.prepare(snapshot(1, [openai('a')]));
    assert.equal(
      (await models.resolve({ providerId: 'a', model: 'm' })).languageModel,
      first,
    );
    assert.equal(initialized(host), 1);

    await models.prepare(snapshot(2, [openai('a')]));

    const second = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;

    assert.notEqual(second, first);
    assert.equal(initialized(host), 2);
    await (first as unknown as LlmProvider).models();
    assert.equal(requests.at(-1)?.url, 'https://a.example.test/v1/models');
  });
});

void test('a replacement activates the providers it built before storing, and a rejected one changes nothing', async () => {
  await withModels(async ({ host, models }) => {
    await models.prepare(snapshot(1, [openai('a')]));

    const before = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;
    const next = snapshot(2, [openai('a'), openai('b')]);

    // Built before the store: the active set is unchanged until it is stored.
    await models.prepare(next.configuration);
    assert.equal(initialized(host), 3);
    assert.equal(
      (await models.resolve({ providerId: 'a', model: 'm' })).languageModel,
      before,
    );
    await assert.rejects(models.resolve({ providerId: 'b', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });

    // Stored: the providers built for it become active, none built again.
    await models.prepare(next);
    assert.equal(initialized(host), 3);
    assert.notEqual(
      (await models.resolve({ providerId: 'a', model: 'm' })).languageModel,
      before,
    );
    await models.resolve({ providerId: 'b', model: 'm' });

    // A configuration a provider cannot be built from is refused, and the
    // active set stays.
    await assert.rejects(
      models.prepare({
        ...next.configuration,
        providers: [{ id: 'r', kind: 'openrouter', configuration: {} }],
      }),
      { message: 'Provider kind openrouter requires a token value.' },
    );
    await assert.rejects(
      models.prepare(
        snapshot(3, [{ id: 'x', kind: 'anthropic', configuration: {} }]),
      ),
      { message: 'Unknown provider kind: anthropic' },
    );
    await models.resolve({ providerId: 'b', model: 'm' });
  });
});

void test('the catalog fill writes each listed model as the catalog describes it and resolves the execution effort', async () => {
  const reads: string[] = [];
  const filled = await readModelProperties(
    {
      providers: [
        {
          id: 'openrouter',
          kind: 'openrouter',
          configuration: {},
          models: [
            { name: ' openai/gpt-5 ' },
            { name: 'unknown/model', reasonings: ['high'] },
          ],
        },
        { id: 'empty', kind: 'openrouter', configuration: {}, models: [] },
        {
          id: 'down',
          kind: 'openrouter',
          configuration: {},
          models: [{ name: 'kept', reasonings: ['low'] }],
        },
      ],
      models: {
        execution: { providerId: 'openrouter', model: ' openai/gpt-5 ' },
      },
      execution: { maxTurns: 10 },
    },
    (provider) => {
      reads.push(provider.id);

      return Promise.resolve(
        provider.id === 'down'
          ? { status: 'failed' }
          : {
              status: 'read',
              models: [
                {
                  id: 'openai/gpt-5',
                  reasonings: ['none', 'low', 'high'],
                  parameters: ['reasoning'],
                  defaultEffort: 'high',
                  mandatory: true,
                },
              ],
            },
      );
    },
  );

  assert.deepEqual(reads, ['openrouter', 'down']);
  assert.deepEqual(filled, {
    providers: [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {},
        models: [
          {
            name: ' openai/gpt-5 ',
            reasonings: ['none', 'low', 'high'],
            defaultEffort: 'high',
            mandatory: true,
          },
          { name: 'unknown/model', reasonings: [] },
        ],
      },
      { id: 'empty', kind: 'openrouter', configuration: {}, models: [] },
      {
        id: 'down',
        kind: 'openrouter',
        configuration: {},
        models: [{ name: 'kept', reasonings: ['low'] }],
      },
    ],
    models: {
      execution: {
        providerId: 'openrouter',
        model: ' openai/gpt-5 ',
        effort: 'high',
      },
    },
    execution: { maxTurns: 10 },
  });
});

// R-6.3: models/v1.contextWindow, the context capacity fill moved from the
// runtime's usage-context.ts onto the live, cached providers.

const router = (id: string, token: string, listed: readonly string[]) => ({
  id,
  kind: 'openrouter',
  configuration: { endpoint: `https://${id}.example.test/api/v1`, token },
  models: listed.map((name) => ({ name })),
});

const listedSnapshot = (
  revision: number,
  providers: readonly Record<string, unknown>[],
) => ({
  configuration: {
    providers,
    models: { execution: { providerId: 'router', model: 'measured' } },
    execution: { maxTurns: 10 },
  },
  revision,
  updatedAt: '2026-10-09T00:00:00.000Z',
});

const catalogAnswer =
  (models: readonly Record<string, unknown>[], status = 200) =>
  (): HttpResponse => ({
    status,
    headers: {},
    body: JSON.stringify({ data: models }),
  });

void test('contextWindow reads the one capacity provider that lists the model, from its cached catalog', async () => {
  await withModels(
    async ({ models, token, requests }) => {
      const id = await token('openrouter', 'sk-or');

      await models.prepare(
        listedSnapshot(1, [
          { ...openai('direct', id), models: [{ name: 'measured' }] },
          router('router', id, ['measured']),
        ]),
      );

      assert.equal(await models.contextWindow({ model: 'measured' }), 200000);
      assert.equal(
        await models.contextWindow({ providerId: 'router', model: 'measured' }),
        200000,
      );
      // The usage footer polls: the live provider's catalog is read once.
      assert.equal(requests.length, 1);
      // A kind without catalog capacity is never a candidate.
      assert.equal(
        await models.contextWindow({ providerId: 'direct', model: 'measured' }),
        undefined,
      );
      // Unlisted model without a provider id: no candidate.
      assert.equal(await models.contextWindow({ model: 'other' }), undefined);
    },
    catalogAnswer([{ id: 'measured', context_length: 200000 }]),
  );
});

void test('contextWindow is unknown when the candidates are ambiguous', async () => {
  await withModels(
    async ({ models, token }) => {
      const id = await token('openrouter', 'sk-or');

      await models.prepare(
        listedSnapshot(1, [
          router('one', id, ['measured']),
          router('two', id, ['measured']),
        ]),
      );

      assert.equal(
        await models.contextWindow({ model: 'measured' }),
        undefined,
      );
      // Naming the provider resolves the ambiguity.
      assert.equal(
        await models.contextWindow({ providerId: 'two', model: 'measured' }),
        200000,
      );
    },
    catalogAnswer([{ id: 'measured', context_length: 200000 }]),
  );
});

void test('contextWindow never throws: a failed catalog, a missing or invalid capacity, or no configuration leave it unknown', async () => {
  await withModels(async ({ models }) => {
    assert.equal(await models.contextWindow({ model: 'measured' }), undefined);
  });
  await withModels(
    async ({ models, token }) => {
      const id = await token('openrouter', 'sk-or');

      await models.prepare(listedSnapshot(1, [router('router', id, ['m'])]));
      assert.equal(await models.contextWindow({ model: 'm' }), undefined);
    },
    catalogAnswer([], 500),
  );
  for (const answer of [
    [{ id: 'other', context_length: 200000 }],
    [{ id: 'm', context_length: 0 }],
    [{ id: 'm' }],
  ]) {
    await withModels(async ({ models, token }) => {
      const id = await token('openrouter', 'sk-or');

      await models.prepare(listedSnapshot(1, [router('router', id, ['m'])]));
      assert.equal(await models.contextWindow({ model: 'm' }), undefined);
    }, catalogAnswer(answer));
  }
});
