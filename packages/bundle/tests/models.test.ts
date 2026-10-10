import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  bindRegistrant,
  type CatalogResult,
  type ContractTool,
  isContractError,
  type LanguageModel,
  type ModelKindDescriptor,
  type ModelsProvider,
  ModelsProviderV1,
  ModelsV1,
  modelsMethods,
  modelsProviderMethods,
  type ResolvedModel,
  type Services,
  ToolsV1,
  toLanguageModel,
} from '../src/contracts/index.js';
import { createHopCall } from '../src/runtime/index.js';
import { basicProvider } from './support/basic.js';
import { processes } from './support/envelope.js';
import { createMinimalTools } from './support/minimal-core.js';

const codeOf = (expected: string) => (error: unknown) =>
  isContractError(error) && error.code === expected;

/** What the generation's provider builds: a model that reads its secret per request. */
interface FakeModel extends LanguageModel {
  request(text: string): Promise<string>;
}

const openAiKind: ModelKindDescriptor = {
  id: 'openai',
  label: 'OpenAI',
  description: 'Responses API.',
  fields: [{ key: 'token', label: 'Token', kind: 'secret', required: false }],
  lists: ['models', 'reasonings'],
};

const catalogRead: CatalogResult = {
  status: 'read',
  models: [
    {
      id: 'gpt-5',
      reasonings: ['low', 'high'],
      parameters: ['reasoning'],
      defaultEffort: 'low',
      mandatory: false,
    },
  ],
};

/**
 * Kernel: a models/v1 core that builds each provider once and resolves it.
 * Generation: the provider (models adapter) and the consumer (direct).
 */
const modelsWorld = () => {
  const world = processes();
  const secrets = { current: 'first' };
  const built: FakeModel[] = [];
  const seenSecrets: (string | undefined)[] = [];
  let provider: ModelsProvider | undefined;
  let cached: LanguageModel | undefined;

  world.generation.principal('models-adapter').services.provide(
    basicProvider(
      'models.provider/v1',
      modelsProviderMethods,
      {
        kind: () => openAiKind,
        advertised: () => true,
        catalog: (input: { secret?: string }) => {
          seenSecrets.push(input.secret);

          return catalogRead;
        },
        create: (input: { secret?: () => Promise<string> }) => {
          const model = toLanguageModel({
            request: async (text: string) =>
              `${text} with ${(await input.secret?.()) ?? 'no secret'}`,
          });

          built.push(model);

          return model;
        },
      },
      [],
      { cardinality: 'many' },
    ),
  );
  world.generation.expose('models.provider/v1');

  const core = world.kernel.principal('core').services;

  core.whenAvailable(ModelsProviderV1, (api) => {
    provider = api;
  });
  core.provide(
    basicProvider('models/v1', modelsMethods, {
      resolve: async (request: { providerId: string; model: string }) => {
        cached ??= await (provider as ModelsProvider).create({
          providerId: request.providerId,
          values: {},
          secret: async () => secrets.current,
        });

        return { ...request, languageModel: cached };
      },
      kinds: async () => [await (provider as ModelsProvider).kind()],
      catalog: (input: { configuration: Record<string, string> }) =>
        (provider as ModelsProvider).catalog({
          configuration: input.configuration,
          secret: 'stored-token',
        }),
    }),
  );
  world.kernel.expose('models/v1');

  const direct = world.generation.principal('direct').services.use(ModelsV1);

  return { world, secrets, built, seenSecrets, direct };
};

void test('a model built in the generation resolves through the kernel back to the same object', async () => {
  const { built, direct } = modelsWorld();

  const resolved = await direct.resolve({ providerId: 'p1', model: 'gpt-5' });

  assert.equal(resolved.providerId, 'p1');
  assert.equal(resolved.model, 'gpt-5');
  assert.equal(resolved.languageModel, built[0]);
  assert.equal(
    await (resolved.languageModel as FakeModel).request('hello'),
    'hello with first',
  );
});

void test('each request reads the secret current at request time, so a rotation reaches the next request', async () => {
  const { secrets, direct } = modelsWorld();
  const model = (await direct.resolve({ providerId: 'p1', model: 'gpt-5' }))
    .languageModel as FakeModel;

  assert.equal(await model.request('one'), 'one with first');
  secrets.current = 'rotated';
  assert.equal(await model.request('two'), 'two with rotated');
});

void test('the kernel holds the model only as a handle: any use there is local_only', async () => {
  const { world } = modelsWorld();
  const resolved: ResolvedModel = await world.kernel
    .principal('transport')
    .services.use(ModelsV1)
    .resolve({ providerId: 'p1', model: 'gpt-5' });

  assert.throws(
    () => (resolved.languageModel as FakeModel).request('x'),
    codeOf('local_only'),
  );
});

void test('kinds and catalog reads cross as data', async () => {
  const { direct, seenSecrets } = modelsWorld();

  assert.deepEqual(await direct.kinds(), [openAiKind]);
  assert.deepEqual(
    await direct.catalog({ kind: 'openai', configuration: { token: 'id-1' } }),
    catalogRead,
  );
  assert.deepEqual(seenSecrets, ['stored-token']);
});

void test('toLanguageModel keeps the provider behavior, getters included', () => {
  let reads = 0;
  const source = {
    get token() {
      reads += 1;

      return `token ${reads}`;
    },
    name: 'provider',
  };
  const model = toLanguageModel(source) as typeof source;

  assert.equal(model.name, 'provider');
  assert.equal(model.token, 'token 1');
  assert.equal(model.token, 'token 2');

  class Built {}
  const instance = new Built();

  assert.equal(toLanguageModel(instance), instance);
});

// tools/v1.list across the envelope ------------------------------------------

/** A registrable tool; `bound` is the tool its registrant's binding produced. */
const echoTool = (name: string) => {
  const definition = {
    name,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  };
  const state: { bound?: ContractTool } = {};
  const registrable = {
    name,
    definition,
    [bindRegistrant]: (_services: Services): ContractTool => {
      state.bound = {
        name,
        input: z.looseObject({}),
        output: z.unknown(),
        definition,
        settings: [],
        execute: async (payload) => ({ name, payload }),
      };

      return state.bound;
    },
  };

  return { registrable, state };
};

const promptCall = () =>
  createHopCall({
    caller: { bundleId: 'doric', version: '1.0.0', generation: 1 },
    useScope: { projectId: 'p1', threadId: 't1', promptId: 'r1' },
    generationSignal: new AbortController().signal,
    generation: 2,
  });

void test('tools listed from the generation are the registered tools at home and executable remote tools otherwise', async () => {
  const world = processes();

  world.kernel.principal('mincore').services.provide(createMinimalTools());
  world.kernel.expose('tools/v1');

  const files = echoTool('read');
  const kernelTool = echoTool('kernel-tool');

  world.kernel
    .principal('kernel-a')
    .services.use(ToolsV1)
    .register(kernelTool.registrable as never, { alwaysAvailable: false });
  world.generation
    .principal('files')
    .services.use(ToolsV1)
    .register(files.registrable as never, { alwaysAvailable: true });
  await world.generation.link.settle('files');

  const listed = await world.generation
    .principal('direct')
    .services.use(ToolsV1)
    .list();
  const byName = new Map(listed.map((entry) => [entry.tool.name, entry]));

  assert.deepEqual(
    listed.map(({ bundleId, alwaysAvailable, tool }) => ({
      bundleId,
      alwaysAvailable,
      name: tool.name,
    })),
    [
      { bundleId: 'kernel-a', alwaysAvailable: false, name: 'kernel-tool' },
      { bundleId: 'files', alwaysAvailable: true, name: 'read' },
    ],
  );
  assert.equal(byName.get('read')?.tool, files.state.bound);
  assert.notEqual(byName.get('kernel-tool')?.tool, kernelTool.state.bound);
  assert.deepEqual(
    await byName.get('kernel-tool')?.tool.execute({ path: 'a' }, promptCall()),
    { name: 'kernel-tool', payload: { path: 'a' } },
  );
});
