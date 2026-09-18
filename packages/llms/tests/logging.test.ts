import assert from 'node:assert/strict';
import test from 'node:test';

import pino, { type Logger } from 'pino';

import {
  createCodexProvider,
  createLmStudioOpenAiProvider,
  createLmStudioProvider,
  createOpenAiProvider,
  createOpenRouterProvider,
  type HttpTransport,
} from '../src/index.js';
import { collect, fakeTransport, response } from './fakes.js';

type LogRecord = Readonly<Record<string, unknown>> & {
  readonly level: number;
  readonly msg: string;
};

test('emits uniform debug events with safe metadata for all operations', async () => {
  const captured = captureLogger();

  const transport = fakeTransport({
    responses: [
      response({
        status: 'completed',
        output_text: 'PRIVATE_RESPONSE',
        output: [],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
      response({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      response({ results: [{ index: 0, relevance_score: 0.75 }] }),
      response({ data: [{ id: 'listed-model' }] }),
      response({ data: [{ id: 'validated-model' }] }),
    ],
    streams: [
      [
        sse({
          type: 'response.completed',
          response: {
            status: 'completed',
            output_text: 'PRIVATE_STREAM_RESPONSE',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      ],
    ],
  });

  const provider = createOpenAiProvider({
    transport,
    apiKey: 'PRIVATE_CREDENTIAL',
    logger: captured.logger,
  });

  await provider.complete({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }],
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, outputSchema: {} },
    ],
  });

  await collect(
    provider.stream({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'PRIVATE_STREAM_PROMPT' }],
    }),
  );

  await provider.embedding({ model: 'embed-test', input: 'PRIVATE_INPUT' });

  await provider.rerank({
    model: 'rerank-test',
    query: 'PRIVATE_QUERY',
    documents: ['PRIVATE_DOCUMENT'],
  });

  await provider.models();

  await provider.validateModel('validated-model');

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    [
      'llm provider initialized',
      'llm completion started',
      'llm completion completed',
      'llm stream started',
      'llm stream completed',
      'llm embedding started',
      'llm embedding completed',
      'llm rerank started',
      'llm rerank completed',
      'llm model listing started',
      'llm model listing completed',
      'llm model validation started',
      'llm model validation completed',
    ],
  );

  assert.ok(captured.records.every(({ level }) => level === 20));

  assert.ok(
    captured.records.every(
      ({ component, provider }) =>
        component === 'llms' && provider === 'openai',
    ),
  );

  assert.deepEqual(select(captured.records[1] ?? {}, requestKeys), {
    model: 'gpt-test',
    messageCount: 1,
    toolCount: 1,
    hasSchema: false,
  });

  assert.deepEqual(select(captured.records[2] ?? {}, finishKeys), {
    finishReason: 'stop',
    toolCount: 0,
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });

  assert.equal(captured.records[6]?.dimensions, 3);

  assert.equal(captured.records[7]?.documentCount, 1);

  assert.equal(captured.records[8]?.resultCount, 1);

  assert.equal(captured.records[10]?.modelCount, 1);

  const serialized = JSON.stringify(captured.records);

  for (const sentinel of [
    'PRIVATE_PROMPT',
    'PRIVATE_STREAM_PROMPT',
    'PRIVATE_RESPONSE',
    'PRIVATE_STREAM_RESPONSE',
    'PRIVATE_INPUT',
    'PRIVATE_QUERY',
    'PRIVATE_DOCUMENT',
    'PRIVATE_CREDENTIAL',
    '/responses',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel, 'u'));
  }
});

test('emits no call events when sensitive output is enabled', async () => {
  const captured = captureLogger();

  const provider = createOpenAiProvider({
    logger: captured.logger,
    transport: fakeTransport({
      responses: [
        response({ status: 'completed', output_text: 'ok', output: [] }),
        response({ data: [{ embedding: [0.1] }] }),
        response({ results: [{ index: 0, relevance_score: 1 }] }),
      ],
      streams: [
        [
          sse({
            type: 'response.completed',
            response: { status: 'completed', output_text: 'ok', output: [] },
          }),
        ],
      ],
    }),
  });
  const flags = { sensitiveOutput: true } as const;

  await provider.complete({
    model: 'private-model',
    messages: [{ role: 'user', content: 'private' }],
    flags,
  });

  await collect(
    provider.stream({
      model: 'private-model',
      messages: [{ role: 'user', content: 'private' }],
      flags,
    }),
  );

  await provider.embedding({ model: 'private-model', input: 'private', flags });

  await provider.rerank({
    model: 'private-model',
    query: 'private',
    documents: ['private'],
    flags,
  });

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    ['llm provider initialized'],
  );
});

test('logs failed unsupported operations without logging the error', async () => {
  const captured = captureLogger();

  const provider = createLmStudioProvider({
    transport: fakeTransport({}),
    logger: captured.logger,
  });

  await assert.rejects(
    provider.embedding({ model: 'local', input: 'PRIVATE_INPUT' }),
  );

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    [
      'llm provider initialized',
      'llm embedding started',
      'llm embedding failed',
    ],
  );

  assert.doesNotMatch(JSON.stringify(captured.records), /PRIVATE_INPUT/u);
});

test('logs a cancelled terminal when a stream consumer stops early', async () => {
  const captured = captureLogger();

  const provider = createOpenAiProvider({
    logger: captured.logger,
    transport: fakeTransport({ streams: [['data: {}\n\n']] }),
  });

  for await (const _event of provider.stream({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'private' }],
  })) {
    break;
  }

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    ['llm provider initialized', 'llm stream started', 'llm stream cancelled'],
  );
});

test('keeps later stream events after logging the first error terminal', async () => {
  const captured = captureLogger();

  const provider = createLmStudioProvider({
    logger: captured.logger,
    transport: fakeTransport({
      streams: [
        [
          namedSse('error', { error: { message: 'private cause' } }),
          namedSse('chat.end', {
            result: {
              output: [{ type: 'message', content: 'private result' }],
            },
          }),
        ],
      ],
    }),
  });

  const events = await collect(
    provider.stream({
      model: 'local-model',
      messages: [{ role: 'user', content: 'private prompt' }],
    }),
  );

  assert.equal(events.at(-1)?.type, 'response.finished');

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    ['llm provider initialized', 'llm stream started', 'llm stream failed'],
  );
});

test('Codex complete and model validation do not duplicate internal events', async () => {
  const captured = captureLogger();

  const provider = createCodexProvider({
    authorization: 'Bearer private',
    logger: captured.logger,
    transport: fakeTransport({
      responses: [response({ data: [{ id: 'gpt-codex' }] })],
      streams: [
        [
          sse({
            type: 'response.completed',
            response: { status: 'completed', output_text: 'ok', output: [] },
          }),
        ],
      ],
    }),
  });

  await provider.complete({
    model: 'gpt-codex',
    messages: [{ role: 'user', content: 'private' }],
  });

  await provider.validateModel('gpt-codex');

  assert.deepEqual(
    captured.records.map(({ msg }) => msg),
    [
      'llm provider initialized',
      'llm completion started',
      'llm completion completed',
      'llm model validation started',
      'llm model validation completed',
    ],
  );

  assert.ok(captured.records.every(({ provider }) => provider === 'codex'));
});

test('validates logger methods synchronously for every provider factory', () => {
  const transport = fakeTransport({});
  const invalid = null as never;

  const factories = [
    () => createOpenAiProvider({ transport, logger: invalid }),
    () =>
      createOpenRouterProvider({ transport, apiKey: 'key', logger: invalid }),
    () => createLmStudioProvider({ transport, logger: invalid }),
    () => createLmStudioOpenAiProvider({ transport, logger: invalid }),
    () =>
      createCodexProvider({
        transport,
        authorization: 'token',
        logger: invalid,
      }),
  ];

  for (const create of factories) {
    assert.throws(create, /Pino-compatible logger/u);
  }

  assert.throws(
    () =>
      createOpenAiProvider({
        transport,
        logger: {
          debug() {},
          child: () => null,
        } as never,
      }),
    /Pino-compatible logger/u,
  );
});

test('preserves thrown error identity while logging only a failed terminal', async () => {
  const captured = captureLogger();
  const failure = new Error('PRIVATE_CAUSE');

  const transport: HttpTransport = {
    async request() {
      throw failure;
    },
    async *stream() {
      return;
    },
  };
  const provider = createOpenAiProvider({ transport, logger: captured.logger });
  let caught: unknown;

  try {
    await provider.complete({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'private' }],
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, failure);

  assert.equal(captured.records.at(-1)?.msg, 'llm completion failed');

  assert.doesNotMatch(JSON.stringify(captured.records), /PRIVATE_CAUSE/u);
});

const captureLogger = (): {
  readonly logger: Logger;
  readonly records: LogRecord[];
} => {
  const records: LogRecord[] = [];

  const logger = pino(
    { level: 'debug' },
    {
      write(chunk: string) {
        for (const line of chunk.split('\n').filter(Boolean)) {
          records.push(JSON.parse(line) as LogRecord);
        }
      },
    },
  );

  return { logger, records };
};

const select = (
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    keys.flatMap((key) => (key in record ? [[key, record[key]]] : [])),
  );
const requestKeys = ['model', 'messageCount', 'toolCount', 'hasSchema'];

const finishKeys = [
  'finishReason',
  'toolCount',
  'inputTokens',
  'outputTokens',
  'totalTokens',
];
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

const namedSse = (event: string, value: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
