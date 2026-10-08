import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  createProviderForKind,
  ProviderErrorObject,
  type ProviderField,
  type ProviderKind,
  type ProviderKindId,
  type ProviderValues,
  providerKind,
  providerKinds,
} from '../src/index.js';
import {
  type FakeTransport,
  fakeTransport,
  response,
  silentLogger,
} from './fakes.js';

/** Every field carrying a sample value, so a whole kind surface is exercised. */
const endpointValue = 'http://127.0.0.1:4321/proxy';
const tokenValue = 'sk-catalog-value';

/**
 * The identity the compatible factory reports. A provider is its own id now, so
 * the test supplies one and the compatible case reads it back.
 */
const identity = { id: 'compatible-identity', name: 'Compatible Identity' };

const sample = (field: ProviderField): string => {
  switch (field.kind) {
    case 'url':
      return endpointValue;
    case 'number':
      return '2';
    case 'enum':
      return field.options?.[0] ?? '';
    case 'secret':
      return tokenValue;
    case 'text':
      return `${field.key}-value`;
  }
};

const valuesFor = (
  kind: ProviderKind,
  overrides: ProviderValues = {},
): ProviderValues => ({
  ...Object.fromEntries(
    kind.fields.map((field) => [field.key, sample(field)] as const),
  ),
  ...overrides,
});

const requiredValuesFor = (kind: ProviderKind): ProviderValues =>
  Object.fromEntries(
    kind.fields
      .filter((field) => field.required)
      .map((field) => [field.key, sample(field)] as const),
  );

const sse = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

/** The one answer each kind's own request shape needs to finish. */
const responsesAnswer = () => response({ output_text: 'ok', output: [] });
const chatAnswer = () =>
  response({
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
  });
const modelsAnswer = () => response({ data: [] });
/**
 * One kind with the request it must send. The URLs are stated here rather than
 * read from the catalog, so a catalog that stops matching its factory fails.
 */
interface Case {
  readonly kind: ProviderKindId;
  readonly defaultBaseUrl: string;
  readonly path: string;
  readonly transport: () => FakeTransport;
  readonly metadata: { readonly id: string; readonly name: string };
  /** The header a completion carries when only required values are set. */
  readonly requiredAuth?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const cases: readonly Case[] = [
  {
    kind: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    path: '/responses',
    transport: () => fakeTransport({ responses: [responsesAnswer()] }),
    metadata: identity,
  },
  {
    kind: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    path: '/chat/completions',
    transport: () => fakeTransport({ responses: [chatAnswer()] }),
    metadata: { id: 'openrouter', name: 'OpenRouter' },
    requiredAuth: `Bearer ${tokenValue}`,
  },
  {
    kind: 'codex',
    defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
    path: '/responses',
    transport: () =>
      fakeTransport({
        streams: [
          [
            sse({
              type: 'response.completed',
              response: { output_text: 'ok', output: [] },
            }),
            'data: [DONE]\n\n',
          ],
        ],
      }),
    metadata: { id: 'codex', name: 'Codex' },
    // Codex takes the raw authorization value, not a bearer key.
    requiredAuth: tokenValue,
    extraHeaders: {
      'ChatGPT-Account-ID': 'chatGptAccountId-value',
      'X-OpenAI-Fedramp': 'true',
    },
  },
];

const kindOf = (id: ProviderKindId): ProviderKind => {
  const kind = providerKind(id);
  assert.ok(kind !== undefined, `Missing catalog entry: ${id}`);
  return kind;
};

/** The completion request among a kind's requests, which discovery may precede. */
const completionRequest = (transport: FakeTransport, entry: Case) => {
  const completion = transport.requests.find(({ url }) =>
    url.endsWith(entry.path),
  );

  assert.ok(completion !== undefined, `${entry.kind} sent no completion`);
  return completion;
};

/** The one value a completion carries when only the required fields are set. */
const completionAuth = (entry: Case): string | undefined =>
  entry.kind === 'codex' ? tokenValue : `Bearer ${tokenValue}`;

const complete = async (
  kind: ProviderKind,
  values: ProviderValues,
  transport: FakeTransport,
) => {
  const provider = createProviderForKind(kind.id, values, {
    transport,
    logger: silentLogger,
    identity,
  });

  await provider.complete({
    model: 'catalog-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });

  return provider;
};

void test('advertises only OpenAI and OpenRouter while keeping Codex internal', () => {
  assert.deepEqual(
    providerKinds.map(({ id }) => id),
    ['openai', 'openrouter'],
  );
  assert.ok(providerKind('codex'));
  for (const removed of [
    'unified',
    'openai-compatible',
    'lmstudio',
    'lmstudio-openai',
  ]) {
    assert.equal(providerKind(removed), undefined);
  }

  for (const kind of providerKinds) {
    assert.equal(providerKind(kind.id), kind);
    assert.equal(providerKind(`${kind.id}!`), undefined);
    assert.ok(kind.label.length > 0 && kind.description.length > 0);
    assert.equal(
      new Set(kind.fields.map(({ key }) => key)).size,
      kind.fields.length,
      `${kind.id} declares a repeated field key`,
    );
    assert.equal(
      new Set(kind.lists).size,
      kind.lists.length,
      `${kind.id} declares a repeated list`,
    );

    for (const field of kind.fields) {
      // The renderer chooses a control from the field kind, so the two agree.
      assert.equal(
        field.kind === 'enum',
        field.options !== undefined,
        `${kind.id}.${field.key} carries options exactly when it is an enum`,
      );
      assert.equal(
        field.placeholder !== undefined && field.required,
        false,
        `${kind.id}.${field.key} shows a default only when it is optional`,
      );
    }
  }
});

void test('uses the configured OpenRouter catalog for execution and model listing', async () => {
  const catalog = 'https://catalog.example.test/models';
  const transport = fakeTransport({
    responses: [
      response({
        data: [
          {
            id: 'custom/model',
            supported_parameters: ['tools'],
            context_length: 12345,
          },
        ],
      }),
      chatAnswer(),
    ],
  });
  const provider = createProviderForKind(
    'openrouter',
    {
      token: tokenValue,
      endpoint: endpointValue,
      modelsUrl: catalog,
    },
    { transport, logger: silentLogger, identity },
  );

  await provider.complete({
    model: 'custom/model',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [
      {
        name: 'lookup',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'string' },
      },
    ],
  });
  assert.equal(transport.requests[0]?.url, catalog);
  assert.equal(transport.requests[1]?.url, `${endpointValue}/chat/completions`);
  assert.equal(
    (await provider.validateModel('custom/model')).contextWindow,
    12345,
  );
});

void test('builds each kind from its required values alone, leaving optional dependencies to the factory', async () => {
  for (const entry of cases) {
    const kind = kindOf(entry.kind);
    const transport = entry.transport();

    const provider = await complete(kind, requiredValuesFor(kind), transport);
    const urls = transport.requests.map(({ url }) => url);

    assert.deepEqual(provider.metadata.id, entry.metadata.id);
    assert.deepEqual(provider.metadata.name, entry.metadata.name);
    assert.ok(
      urls.includes(`${entry.defaultBaseUrl}${entry.path}`),
      `${entry.kind} did not reach ${entry.defaultBaseUrl}${entry.path}`,
    );
    // An unset endpoint keeps the factory's own base URL, which the optional
    // field shows as its placeholder.
    const endpoint = kind.fields.find(({ key }) => key === 'endpoint');
    assert.equal(endpoint?.placeholder, entry.defaultBaseUrl);

    assert.equal(
      completionRequest(transport, entry).headers?.authorization,
      entry.requiredAuth,
    );
  }
});

void test('sends every value a kind declares, including its endpoint and its own identity', async () => {
  for (const entry of cases) {
    const kind = kindOf(entry.kind);
    const transport = entry.transport();

    const provider = await complete(kind, valuesFor(kind), transport);
    const urls = transport.requests.map(({ url }) => url);
    const completion = completionRequest(transport, entry);

    assert.equal(provider.metadata.id, entry.metadata.id);
    assert.equal(provider.metadata.name, entry.metadata.name);
    assert.ok(
      urls.includes(`${endpointValue}${entry.path}`),
      `${entry.kind} did not reach ${endpointValue}${entry.path}`,
    );
    assert.equal(completion.headers?.authorization, completionAuth(entry));

    for (const [key, value] of Object.entries(entry.extraHeaders ?? {}))
      assert.equal(completion.headers?.[key], value);
  }
});

void test('answers the kind and the fields a provider was built from', async () => {
  for (const entry of cases) {
    const kind = kindOf(entry.kind);
    const transport = entry.transport();

    const provider = await complete(kind, requiredValuesFor(kind), transport);

    assert.equal(provider.kind, kind.id);
    assert.deepEqual(provider.configuration, kind.fields);
  }
});

void test('refuses a kind whose required value is absent or blank', () => {
  const deps = {
    transport: fakeTransport({}),
    logger: silentLogger,
    identity,
  };

  for (const kind of providerKinds) {
    const required = kind.fields.filter((field) => field.required);
    const complete_ = requiredValuesFor(kind);

    for (const field of required) {
      const absent = { ...complete_ };
      delete absent[field.key];

      assert.throws(
        () => createProviderForKind(kind.id, absent, deps),
        new RegExp(`requires a ${field.key}`, 'u'),
      );
      assert.throws(() =>
        createProviderForKind(
          kind.id,
          { ...complete_, [field.key]: '  ' },
          deps,
        ),
      );
    }

    if (required.length === 0)
      assert.doesNotThrow(() => createProviderForKind(kind.id, {}, deps));
  }
});

void test('refuses a value its factory cannot use', () => {
  const deps = {
    transport: fakeTransport({}),
    logger: silentLogger,
    identity,
  };
  const router = kindOf('openrouter');
  const codex = kindOf('codex');

  assert.throws(
    () =>
      createProviderForKind(
        'openrouter',
        valuesFor(router, { maxStructuredOutputRepairs: 'many' }),
        deps,
      ),
    /maxStructuredOutputRepairs/u,
  );
  assert.throws(
    () =>
      createProviderForKind(
        'codex',
        valuesFor(codex, { fedramp: 'yes' }),
        deps,
      ),
    /fedramp/u,
  );
  assert.throws(
    () => createProviderForKind('nope' as ProviderKindId, {}, deps),
    /Unknown provider kind: nope/u,
  );
});

void test('passes a number field through to its factory', async () => {
  const kind = kindOf('openrouter');
  const structured = {
    model: 'catalog-model',
    messages: [{ role: 'user' as const, content: 'Answer as JSON.' }],
    schema: z.object({ answer: z.string() }),
  };
  const invalid = () =>
    response({
      choices: [
        { finish_reason: 'stop', message: { content: '{"answer":123}' } },
      ],
    });
  const completionRequests = (transport: FakeTransport) =>
    transport.requests.filter(({ url }) => url.endsWith('/chat/completions'))
      .length;

  for (const [repairs, expected] of [
    [undefined, 3],
    ['0', 1],
  ] as const) {
    const transport = fakeTransport({
      responses: [modelsAnswer(), invalid(), invalid(), invalid()],
    });
    const values: Record<string, ProviderValues[string]> = {
      ...valuesFor(kind),
    };
    if (repairs === undefined) delete values.maxStructuredOutputRepairs;
    else values.maxStructuredOutputRepairs = repairs;
    const provider = createProviderForKind('openrouter', values, {
      transport,
      logger: silentLogger,
      identity,
    });

    await assert.rejects(
      provider.complete(structured),
      (error) => error instanceof ProviderErrorObject,
    );
    assert.equal(completionRequests(transport), expected);
  }
});
