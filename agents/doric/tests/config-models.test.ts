import assert from 'node:assert/strict';
import test from 'node:test';

import type { HttpRequest, HttpTransport } from 'llms';

import { readModelProperties } from '../src/lib/config/models.js';
import {
  type ConfigInput,
  ConfigInputSchema,
} from '../src/lib/config/schema.js';
import type { Credential } from '../src/lib/credentials/kind.js';
import { credentialResolver } from './helpers/workspace.js';

/** The credential the provider authenticates its catalog read with. */
const providerCredential: Credential = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'OPENROUTER_API_KEY',
  secret: 'sk_stored_key',
};

const catalog = 'https://catalog.example.com/models';

/** One OpenRouter provider whose model list the catalog describes. */
const configuration = (
  models: readonly {
    readonly name: string;
    readonly reasonings?: readonly string[];
  }[],
  effort?: string,
): ConfigInput =>
  ConfigInputSchema.parse({
    providers: [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://catalog.example.com/v1',
          token: providerCredential.id,
          modelsUrl: catalog,
        },
        models: models.map((model) => ({
          name: model.name,
          // A kind that keeps reasonings carries the key on every model, so the
          // fixture states it even when the catalog has not filled it yet.
          reasonings: [...(model.reasonings ?? [])],
        })),
      },
    ],
    models: {
      execution: {
        providerId: 'openrouter',
        model: 'openai/gpt-5',
        ...(effort === undefined ? {} : { effort }),
      },
    },
    execution: { maxTurns: 8 },
  });

/**
 * The endpoint, answered without one. The reader only asks for a request, so the
 * double answers exactly that and never opens a stream.
 */
const transport = (
  answer: (request: HttpRequest) => Record<string, unknown>,
): HttpTransport & { readonly requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];

  return {
    requests,
    request: (request: HttpRequest) => {
      requests.push(request);

      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(answer(request)),
      });
    },
  } as unknown as HttpTransport & { readonly requests: HttpRequest[] };
};

/** An endpoint that cannot be reached at all. */
const unreachable = { request: () => Promise.reject(new Error('unreachable')) };

const entries = (
  ...models: readonly {
    readonly id: string;
    readonly supported_efforts?: readonly string[];
  }[]
) => ({
  data: models.map((model) => ({
    id: model.id,
    name: model.id,
    ...(model.supported_efforts === undefined
      ? {}
      : { reasoning: { supported_efforts: model.supported_efforts } }),
  })),
});

const read = (
  config: ConfigInput,
  http: HttpTransport,
  warnings: unknown[][] = [],
) =>
  readModelProperties(config, {
    credentials: credentialResolver(() => [providerCredential]),
    logger: { warn: (...args: unknown[]) => void warnings.push(args) } as never,
    transport: http,
  });

test('writes the efforts each model its catalog describes accepts', async () => {
  const http = transport(() =>
    entries(
      { id: 'openai/gpt-5', supported_efforts: ['low', 'medium', 'high'] },
      // The block says the model reasons without naming an effort it accepts.
      { id: 'anthropic/claude-sonnet-4', supported_efforts: [] },
      // An effort this library cannot send is not one a model accepts here.
      { id: 'x-ai/grok-4', supported_efforts: ['medium', 'ultra'] },
    ),
  );
  const filled = await read(
    configuration([
      { name: 'openai/gpt-5' },
      { name: 'anthropic/claude-sonnet-4' },
      { name: 'x-ai/grok-4' },
      { name: 'retired/model' },
    ]),
    http,
  );

  assert.equal(http.requests[0]?.url, catalog);
  assert.equal(
    http.requests[0]?.headers?.authorization,
    `Bearer ${providerCredential.secret}`,
  );
  assert.deepEqual(filled.providers[0]?.models, [
    { name: 'openai/gpt-5', reasonings: ['low', 'medium', 'high'] },
    { name: 'anthropic/claude-sonnet-4', reasonings: [] },
    { name: 'x-ai/grok-4', reasonings: ['medium'] },
    { name: 'retired/model', reasonings: [] },
  ]);
});

test('leaves a provider as it was when its catalog cannot be read', async () => {
  const warnings: unknown[][] = [];
  const http = unreachable as unknown as HttpTransport;
  const stored = configuration([{ name: 'openai/gpt-5', reasonings: ['low'] }]);
  const filled = await read(stored, http, warnings);

  assert.deepEqual(filled, stored);
  assert.deepEqual(warnings, [
    [{ providerId: 'openrouter' }, 'Model catalog could not be read'],
  ]);
  // The warning names the provider alone: never the endpoint, the credential, or
  // anything the response carried.
  assert.equal(JSON.stringify(warnings).includes(catalog), false);
  assert.equal(
    JSON.stringify(warnings).includes(String(providerCredential.secret)),
    false,
  );
});

test('resolves the execution effort away when its model lists none', async () => {
  const http = transport(() => entries({ id: 'openai/gpt-5' }));
  const filled = await read(
    configuration([{ name: 'openai/gpt-5' }], 'medium'),
    http,
  );

  assert.equal('effort' in filled.models.execution, false);
  assert.equal(filled.models.execution.model, 'openai/gpt-5');
});

test('keeps the execution effort when its model lists efforts', async () => {
  const http = transport(() =>
    entries({ id: 'openai/gpt-5', supported_efforts: ['medium'] }),
  );
  const filled = await read(
    configuration([{ name: 'openai/gpt-5' }], 'medium'),
    http,
  );

  assert.equal(filled.models.execution.effort, 'medium');
});

test('reads no catalog for a kind that declares no models URL', async () => {
  const http = transport(() => entries({ id: 'local/one' }));
  const stored = ConfigInputSchema.parse({
    providers: [
      {
        id: 'local',
        kind: 'lmstudio',
        configuration: {},
        models: [{ name: 'local/one' }],
      },
    ],
    models: { execution: { providerId: 'local', model: 'local/one' } },
    execution: { maxTurns: 8 },
  });
  const filled = await read(stored, http);

  assert.equal(http.requests.length, 0);
  assert.deepEqual(filled, stored);
});
