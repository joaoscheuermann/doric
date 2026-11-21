import assert from 'node:assert/strict';
import test from 'node:test';

import type { EmbeddedBundle } from 'bundle';
import {
  type CatalogResult,
  type ModelField,
  type ModelKindDescriptor,
  type Models,
  ModelsV1,
  SecretsV1,
} from 'bundle/contracts';
import { modelIconSvg } from 'llms';

import { readModelProperties } from '../src/contracts/index.js';
import { type Booted, boot, core } from './support/host.js';
import { fakeKind } from './support/providers.js';

// D-M: models/v1 over `models.provider/v1` records (design 57 §6, stage 10
// §3.1-3.3). The records are fakes (bundle isolation 6(b)): what a real kind
// answers is each provider bundle's own test.

interface World {
  readonly host: Booted;
  readonly models: Models;
  /** Stores an API token and returns its id. */
  token(name: string, secret: string): Promise<string>;
  rotate(id: string, secret: string): Promise<void>;
}

const withModels = async (
  bundles: readonly EmbeddedBundle[],
  run: (world: World) => Promise<void>,
) => {
  const host = await boot([await core(), ...bundles], {
    enabled: bundles.map(({ manifest }) => manifest.id),
  });
  const secrets = host.platform.services.use(SecretsV1);

  try {
    await run({
      host,
      models: host.platform.services.use(ModelsV1),
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

const token: ModelField = {
  key: 'token',
  label: 'Token',
  kind: 'secret',
  required: false,
};

const descriptor = (id: string): ModelKindDescriptor => ({
  id,
  label: id,
  description: `The ${id} kind.`,
  fields: [token],
  lists: ['models', 'reasonings'],
});

/** One model as a built provider's catalog lists it (llms `Model`). */
interface ListedModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly inputModalities?: readonly string[];
}

/** What a fake record builds: a model whose catalog lists `listed`. */
class FakeModel {
  constructor(private readonly listed: readonly ListedModel[] | 'fails') {}

  models(): Promise<readonly ListedModel[]> {
    return this.listed === 'fails'
      ? Promise.reject(new Error('Catalog unavailable.'))
      : Promise.resolve(this.listed);
  }
}

/** A record of the kind `id` that builds a `FakeModel`, keeping each one it built. */
const building = (
  id: string,
  options: {
    readonly catalogCapacity?: boolean;
    readonly listed?: readonly ListedModel[] | 'fails';
  } = {},
) => {
  const built: FakeModel[] = [];
  const fake = fakeKind(`${id}-bundle`, {
    kind: descriptor(id),
    catalogCapacity: options.catalogCapacity ?? false,
    create: () => {
      const model = new FakeModel(options.listed ?? []);

      built.push(model);

      return model;
    },
  });

  return { ...fake, built };
};

const snapshot = (
  revision: number,
  providers: readonly {
    readonly id: string;
    readonly [key: string]: unknown;
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

/** A provider of the kind `kind`, naming a credential when given one. */
const provider = (
  id: string,
  options: {
    readonly kind?: string;
    readonly credential?: string;
    readonly listed?: readonly string[];
  } = {},
) => ({
  id,
  kind: options.kind ?? 'direct',
  configuration: {
    endpoint: `https://${id}.example.test/v1`,
    ...(options.credential === undefined ? {} : { token: options.credential }),
  },
  ...(options.listed === undefined
    ? {}
    : { models: options.listed.map((name) => ({ name })) }),
});

const catalogRead: CatalogResult = {
  status: 'read',
  models: [
    {
      id: 'vendor/model-1',
      reasonings: ['low', 'high'],
      parameters: ['reasoning'],
      mandatory: false,
    },
  ],
};

void test('the advertised kinds are the records that advertise theirs, in activation order, each as its record declares it', async () => {
  const bKind = descriptor('b-kind');
  // The site is what models.provider/v1 1.3.0 adds to the descriptor.
  const aKind = {
    ...descriptor('a-kind'),
    site: { url: 'https://a-kind.example.test/console', label: 'Open A' },
  };
  const hidden = descriptor('hidden');

  await withModels(
    [
      fakeKind('provider-1', { kind: bKind }).bundle,
      fakeKind('provider-2', { kind: aKind }).bundle,
      fakeKind('provider-3', { kind: hidden, advertised: false }).bundle,
    ],
    async ({ models }) => {
      assert.deepEqual(await models.kinds(), [bKind, aKind]);
      assert.deepEqual(await models.kind('a-kind'), aKind);
      assert.deepEqual(await models.kind('hidden'), hidden);
      assert.equal(await models.kind('nope'), undefined);
    },
  );
});

void test('a catalog read passes the record the stored secret the draft names, and its configuration unchanged', async () => {
  const router = fakeKind('router-bundle', {
    kind: descriptor('router'),
    catalog: () => Promise.resolve(catalogRead),
  });

  await withModels([router.bundle], async ({ models, token }) => {
    const id = await token('router', 'sk-or');

    assert.deepEqual(
      await models.catalog({ kind: 'router', configuration: { token: id } }),
      catalogRead,
    );
    assert.deepEqual(router.calls.catalog.at(-1), {
      configuration: { token: id },
      secret: 'sk-or',
    });

    // A credential id that is not stored passes no secret.
    const missing = '00000000-0000-4000-8000-00000000dead';

    await models.catalog({ kind: 'router', configuration: { token: missing } });
    assert.deepEqual(router.calls.catalog.at(-1), {
      configuration: { token: missing },
    });
  });
});

void test('a kind without a catalog or without a record keeps none, and a failed read is logged without its details', async () => {
  const absent = fakeKind('absent-bundle', { kind: descriptor('absent') });
  const failing = fakeKind('failing-bundle', {
    kind: descriptor('failing'),
    catalog: () => Promise.resolve({ status: 'failed' }),
  });

  await withModels(
    [absent.bundle, failing.bundle],
    async ({ host, models, token }) => {
      assert.deepEqual(
        await models.catalog({ kind: 'absent', configuration: {} }),
        { status: 'absent' },
      );
      assert.deepEqual(
        await models.catalog({ kind: 'anthropic', configuration: {} }),
        { status: 'absent' },
      );
      assert.equal(failing.calls.catalog.length, 0);

      const id = await token('failing', 'sk-or-secret');

      assert.deepEqual(
        await models.catalog({
          kind: 'failing',
          configuration: { token: id },
        }),
        { status: 'failed' },
      );

      const warning = host.records.find(
        ({ message }) => message === 'Model catalog could not be read',
      );

      assert.equal(warning?.level, 'warn');
      assert.deepEqual(warning?.fields, { kind: 'failing' });
      assert.equal(JSON.stringify(warning).includes('sk-or-secret'), false);
    },
  );
});

void test('resolve answers the provider of the active configuration, and an unknown one is unavailable', async () => {
  const direct = building('direct');

  await withModels([direct.bundle], async ({ models, token }) => {
    await assert.rejects(models.resolve({ providerId: 'a', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });

    const id = await token('a', 'sk-a');

    await models.prepare(
      snapshot(1, [provider('a', { credential: id }), provider('b')]),
    );
    assert.deepEqual(
      direct.calls.create.map(({ providerId, values }) => ({
        providerId,
        values,
      })),
      [
        { providerId: 'a', values: { endpoint: 'https://a.example.test/v1' } },
        { providerId: 'b', values: { endpoint: 'https://b.example.test/v1' } },
      ],
    );

    const resolved = await models.resolve({
      providerId: 'a',
      model: 'gpt-5',
      effort: 'low',
    });

    assert.equal(resolved.providerId, 'a');
    assert.equal(resolved.model, 'gpt-5');
    assert.equal(resolved.effort, 'low');
    assert.equal(resolved.languageModel, direct.built[0]);
    assert.equal(await direct.calls.create[0]?.secret?.(), 'sk-a');
    // The provider that names no credential is given no secret.
    assert.equal(direct.calls.create[1]?.secret, undefined);

    await assert.rejects(models.resolve({ providerId: 'c', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });
  });
});

void test('a credential rotation reaches a provider already built', async () => {
  const direct = building('direct');

  await withModels([direct.bundle], async ({ models, token, rotate }) => {
    const id = await token('a', 'first');

    await models.prepare(snapshot(1, [provider('a', { credential: id })]));

    const secret = direct.calls.create[0]?.secret;

    assert.equal(await secret?.(), 'first');
    await rotate(id, 'rotated');
    assert.equal(await secret?.(), 'rotated');
  });
});

void test('each revision has its own providers, and a provider resolved before stays the one it was', async () => {
  const direct = building('direct');

  await withModels([direct.bundle], async ({ models }) => {
    await models.prepare(snapshot(1, [provider('a')]));

    const first = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;

    // The same stored snapshot again builds nothing.
    await models.prepare(snapshot(1, [provider('a')]));
    assert.equal(
      (await models.resolve({ providerId: 'a', model: 'm' })).languageModel,
      first,
    );
    assert.equal(direct.calls.create.length, 1);

    await models.prepare(snapshot(2, [provider('a')]));

    const second = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;

    assert.notEqual(second, first);
    assert.equal(direct.calls.create.length, 2);
    assert.equal(first, direct.built[0]);
  });
});

void test('a replacement activates the providers it built before storing, and a rejected one changes nothing', async () => {
  const direct = building('direct');
  const strict = fakeKind('strict-bundle', {
    kind: descriptor('strict'),
    create: () => {
      throw new Error('Provider kind strict requires a token value.');
    },
  });

  await withModels([direct.bundle, strict.bundle], async ({ models }) => {
    await models.prepare(snapshot(1, [provider('a')]));

    const before = (await models.resolve({ providerId: 'a', model: 'm' }))
      .languageModel;
    const next = snapshot(2, [provider('a'), provider('b')]);

    // Built before the store: the active set is unchanged until it is stored.
    await models.prepare(next.configuration);
    assert.equal(direct.calls.create.length, 3);
    assert.equal(
      (await models.resolve({ providerId: 'a', model: 'm' })).languageModel,
      before,
    );
    await assert.rejects(models.resolve({ providerId: 'b', model: 'm' }), {
      message: 'Configured provider is unavailable.',
    });

    // Stored: the providers built for it become active, none built again.
    await models.prepare(next);
    assert.equal(direct.calls.create.length, 3);
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
        providers: [{ id: 'r', kind: 'strict', configuration: {} }],
      }),
      { message: 'Provider kind strict requires a token value.' },
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

void test('a provider whose model list is its catalog takes every listed model, and keeps its list when the read fails', async () => {
  const catalogModels = [
    {
      id: 'claude-opus-5-5',
      reasonings: ['low', 'medium', 'high'],
      parameters: [],
      defaultEffort: 'medium',
      mandatory: false,
    },
    {
      id: 'claude-haiku-4-5',
      reasonings: [],
      parameters: [],
      mandatory: false,
    },
    // A repeated or blank id names no second model.
    { id: 'claude-opus-5-5', reasonings: [], parameters: [], mandatory: false },
    { id: ' ', reasonings: [], parameters: [], mandatory: false },
  ];
  const reads: string[] = [];
  const filled = await readModelProperties(
    {
      providers: [
        { id: 'claude', kind: 'claude', configuration: {}, models: [] },
        {
          id: 'offline',
          kind: 'claude',
          configuration: {},
          models: [{ name: 'claude-opus-5', reasonings: ['high'] }],
        },
        // Not catalog-listed, with no models: never read.
        { id: 'router', kind: 'openrouter', configuration: {}, models: [] },
      ],
      models: { execution: { providerId: 'claude', model: 'claude-opus-5-5' } },
      execution: { maxTurns: 10 },
    },
    (provider) => {
      reads.push(provider.id);
      return Promise.resolve(
        provider.id === 'offline'
          ? { status: 'failed' }
          : { status: 'read', models: catalogModels },
      );
    },
    (provider) => provider.kind === 'claude',
  );

  assert.deepEqual(reads, ['claude', 'offline']);
  assert.deepEqual(filled.providers, [
    {
      id: 'claude',
      kind: 'claude',
      configuration: {},
      models: [
        {
          name: 'claude-opus-5-5',
          reasonings: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        { name: 'claude-haiku-4-5', reasonings: [] },
      ],
    },
    {
      id: 'offline',
      kind: 'claude',
      configuration: {},
      models: [{ name: 'claude-opus-5', reasonings: ['high'] }],
    },
    { id: 'router', kind: 'openrouter', configuration: {}, models: [] },
  ]);
  // The execution profile resolves against the list the catalog wrote.
  assert.deepEqual(filled.models, {
    execution: {
      providerId: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
    },
  });
});

// R-6.3: models/v1.contextWindow and (1.2.0) models/v1.inputModalities read
// the live, cached provider of a kind that reports catalog capacity.

/**
 * A `router` kind that reports catalog capacity and a `direct` kind that does
 * not, whose built models both list `listed`.
 */
const capacityKinds = (listed: readonly ListedModel[] | 'fails') => {
  const router = building('router', { catalogCapacity: true, listed });
  const direct = building('direct', { listed });

  return { router, direct, bundles: [router.bundle, direct.bundle] };
};

const routed = (id: string, listed: readonly string[]) =>
  provider(id, { kind: 'router', listed });

void test('contextWindow reads the one capacity provider that lists the model, from the provider already built', async () => {
  const { router, direct, bundles } = capacityKinds([
    { id: 'measured', contextWindow: 200000 },
  ]);

  await withModels(bundles, async ({ models }) => {
    await models.prepare(
      snapshot(1, [
        provider('direct', { listed: ['measured'] }),
        routed('router', ['measured']),
      ]),
    );

    assert.equal(await models.contextWindow({ model: 'measured' }), 200000);
    assert.equal(
      await models.contextWindow({ providerId: 'router', model: 'measured' }),
      200000,
    );
    // The usage footer polls: a poll builds no provider.
    assert.equal(router.calls.create.length + direct.calls.create.length, 2);
    // A kind without catalog capacity is never a candidate.
    assert.equal(
      await models.contextWindow({ providerId: 'direct', model: 'measured' }),
      undefined,
    );
    // Unlisted model without a provider id: no candidate.
    assert.equal(await models.contextWindow({ model: 'other' }), undefined);
  });
});

void test('contextWindow is unknown when the candidates are ambiguous', async () => {
  const { bundles } = capacityKinds([
    { id: 'measured', contextWindow: 200000 },
  ]);

  await withModels(bundles, async ({ models }) => {
    await models.prepare(
      snapshot(1, [routed('one', ['measured']), routed('two', ['measured'])]),
    );

    assert.equal(await models.contextWindow({ model: 'measured' }), undefined);
    // Naming the provider resolves the ambiguity.
    assert.equal(
      await models.contextWindow({ providerId: 'two', model: 'measured' }),
      200000,
    );
  });
});

void test('contextWindow never throws: a failed catalog, a missing or invalid capacity, or no configuration leave it unknown', async () => {
  await withModels(capacityKinds([]).bundles, async ({ models }) => {
    assert.equal(await models.contextWindow({ model: 'measured' }), undefined);
  });
  for (const listed of [
    'fails' as const,
    [{ id: 'other', contextWindow: 200000 }],
    [{ id: 'm', contextWindow: 0 }],
    [{ id: 'm' }],
  ]) {
    await withModels(capacityKinds(listed).bundles, async ({ models }) => {
      await models.prepare(snapshot(1, [routed('router', ['m'])]));
      assert.equal(
        await models.contextWindow({ model: 'm' }),
        undefined,
        JSON.stringify(listed),
      );
    });
  }
});

void test('inputModalities answers what the one catalog provider lists the model as reading', async () => {
  const { bundles } = capacityKinds([
    { id: 'text-only', inputModalities: ['text'] },
    { id: 'vision', inputModalities: ['text', 'image'] },
  ]);

  await withModels(bundles, async ({ models }) => {
    await models.prepare(
      snapshot(1, [
        provider('direct', { listed: ['text-only'] }),
        routed('router', ['text-only', 'vision']),
      ]),
    );

    assert.deepEqual(
      await models.inputModalities({
        providerId: 'router',
        model: 'text-only',
      }),
      ['text'],
    );
    assert.deepEqual(await models.inputModalities({ model: 'vision' }), [
      'text',
      'image',
    ]);
    // A kind without a live catalog says nothing about its models.
    assert.equal(
      await models.inputModalities({
        providerId: 'direct',
        model: 'text-only',
      }),
      undefined,
    );
  });
});

void test('inputModalities never throws: a failed catalog or a model it does not describe leave it unknown', async () => {
  await withModels(capacityKinds([]).bundles, async ({ models }) => {
    assert.equal(await models.inputModalities({ model: 'm' }), undefined);
  });
  for (const listed of [
    'fails' as const,
    [{ id: 'other', inputModalities: ['text'] }],
    [{ id: 'm' }],
  ]) {
    await withModels(capacityKinds(listed).bundles, async ({ models }) => {
      await models.prepare(snapshot(1, [routed('router', ['m'])]));
      assert.equal(
        await models.inputModalities({ model: 'm' }),
        undefined,
        JSON.stringify(listed),
      );
    });
  }
});

// models/v1.icons (1.3.0): the names a record chooses, each answered as its SVG.

void test("icons answers a draft each model's own icon, else its provider's own, with each SVG once", async () => {
  const lab = fakeKind('lab-bundle', {
    kind: descriptor('lab'),
    icons: ({ models }) => ({
      provider: 'openrouter',
      models: models.map((model) =>
        model.startsWith('anthropic/') ? 'claude' : null,
      ),
    }),
  });

  await withModels([lab.bundle], async ({ models }) => {
    assert.deepEqual(
      await models.icons({
        requests: [
          {
            kind: 'lab',
            configuration: {},
            models: ['anthropic/claude-sonnet-4', 'acme/coder-7b'],
          },
          { kind: 'lab', configuration: {}, models: ['anthropic/claude-4'] },
        ],
      }),
      {
        svgs: {
          claude: modelIconSvg('claude'),
          openrouter: modelIconSvg('openrouter'),
        },
        answers: [
          { provider: 'openrouter', models: ['claude', 'openrouter'] },
          { provider: 'openrouter', models: ['claude'] },
        ],
      },
    );
  });
});

void test('icons answers a draft whose record chooses no icon none, for the provider and its model', async () => {
  const plain = fakeKind('plain-bundle', { kind: descriptor('plain') });

  await withModels([plain.bundle], async ({ models }) => {
    assert.deepEqual(
      await models.icons({
        requests: [{ kind: 'plain', configuration: {}, models: ['phi4'] }],
      }),
      { svgs: {}, answers: [{ models: [null] }] },
    );
  });
});

void test('icons resolves a configured provider by id with its values, and an unknown kind answers no icon', async () => {
  const direct = fakeKind('direct-bundle', {
    kind: descriptor('direct'),
    // Only the configured provider's values name this endpoint.
    icons: ({ configuration, models }) => ({
      models: models.map((model) =>
        configuration.endpoint === 'https://a.example.test/v1' &&
        model.startsWith('gpt-')
          ? 'openai'
          : null,
      ),
    }),
  });

  await withModels([direct.bundle], async ({ models }) => {
    await models.prepare(snapshot(1, [provider('a')]));

    assert.deepEqual(
      await models.icons({
        requests: [
          { providerId: 'a', models: ['gpt-5', 'phi4'] },
          { kind: 'nope', configuration: {}, models: ['gpt-5'] },
        ],
      }),
      {
        svgs: { openai: modelIconSvg('openai') },
        answers: [{ models: ['openai', null] }, { models: [null] }],
      },
    );
  });
});
