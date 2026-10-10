import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineMethod,
  defineService,
  type LogFields,
  LogV1,
  logMethods,
  type ModelsProvider,
  ModelsProviderV1,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type HttpRequest,
  type HttpTransport,
  type LlmProvider,
  providerKind,
} from 'llms';

import { activate, createActivate } from '../src/host/index.js';

interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

/** A log/v1 that keeps every line, and the adapter's records in order. */
const adapterWorld = (options: { transport?: HttpTransport } = {}) => {
  const lines: Line[] = [];
  const level = (name: string) =>
    defineMethod({
      ...logMethods.debug,
      execute: ([message, fields]: [string, LogFields?]) => {
        lines.push({
          level: name,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    });
  const world = createTestServices({
    bundle: { id: 'models-adapter' },
    provide: [
      defineService(LogV1, {
        debug: level('debug'),
        info: level('info'),
        warn: level('warn'),
        error: level('error'),
      }),
    ],
  });

  (options.transport === undefined
    ? activate
    : createActivate({ transport: () => options.transport as HttpTransport }))({
    services: world.services,
  });

  const records: ModelsProvider[] = [];

  world.services.whenAvailable(ModelsProviderV1, (api) => {
    records.push(api);
  });

  return { world, lines, records };
};

const recordingTransport = () => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: (request) => {
      requests.push(request);

      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ data: [{ id: 'gpt-5' }] }),
      });
    },
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };

  return { requests, transport };
};

void test('the adapter provides one record per llms kind, in the llms order, and advertises all but codex', async () => {
  const { world, records } = adapterWorld();

  try {
    assert.deepEqual(
      await Promise.all(records.map((record) => record.kind())),
      [
        providerKind('openai'),
        providerKind('openrouter'),
        providerKind('codex'),
      ],
    );
    assert.deepEqual(
      await Promise.all(records.map((record) => record.advertised())),
      [true, true, false],
    );
  } finally {
    await world.dispose();
  }
});

void test('create builds the kind with the provider id as its identity and logs through log/v1', async () => {
  const { requests, transport } = recordingTransport();
  const { world, lines, records } = adapterWorld({ transport });

  try {
    const [openai] = records;
    const provider = (await openai?.create({
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
    })) as unknown as LlmProvider;

    assert.deepEqual(provider.metadata, {
      id: 'work',
      name: 'work',
      baseUrl: 'https://work.test/v1',
    });
    assert.deepEqual(lines[0], {
      level: 'debug',
      message: 'llm provider initialized',
      fields: { component: 'llms', provider: 'work' },
    });

    await provider.models();
    assert.equal(requests.at(-1)?.url, 'https://work.test/v1/models');
    assert.equal(requests.at(-1)?.headers?.authorization, undefined);
  } finally {
    await world.dispose();
  }
});

void test('the secret source is read before every request, so a rotation reaches the next one', async () => {
  const { requests, transport } = recordingTransport();
  const { world, records } = adapterWorld({ transport });
  let secret = 'first';
  let reads = 0;

  try {
    const provider = (await records[0]?.create({
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
      secret: () => {
        reads += 1;

        return Promise.resolve(secret);
      },
    })) as unknown as LlmProvider;

    assert.equal(reads, 0);
    await provider.models();
    assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer first');
    secret = 'rotated';
    await provider.models();
    assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer rotated');
    assert.equal(reads, 2);
  } finally {
    await world.dispose();
  }
});

void test('a kind whose required token is missing cannot be built, and a non-number value is refused', async () => {
  const { world, records } = adapterWorld();

  try {
    await assert.rejects(
      async () => await records[1]?.create({ providerId: 'or', values: {} }),
      { message: 'Provider kind openrouter requires a token value.' },
    );
    await assert.rejects(
      async () =>
        await records[1]?.create({
          providerId: 'or',
          values: { maxStructuredOutputRepairs: 'many' },
          secret: () => Promise.resolve('sk'),
        }),
      {
        message:
          'Provider value maxStructuredOutputRepairs is not a number: many',
      },
    );
  } finally {
    await world.dispose();
  }
});

void test('catalog reads only kinds with a models URL, with the secret as a bearer token', async () => {
  const { requests, transport } = recordingTransport();
  const { world, records } = adapterWorld({ transport });

  try {
    const [openai, openrouter, codex] = records;

    assert.deepEqual(await openai?.catalog({ configuration: {} }), {
      status: 'absent',
    });
    assert.deepEqual(await codex?.catalog({ configuration: {} }), {
      status: 'absent',
    });
    assert.equal(requests.length, 0);

    const read = await openrouter?.catalog({
      configuration: {},
      secret: 'sk-or',
    });

    assert.equal(read?.status, 'read');
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: 'https://openrouter.ai/api/v1/models',
        headers: { accept: 'application/json', authorization: 'Bearer sk-or' },
      },
    ]);

    await openrouter?.catalog({ configuration: {}, secret: '' });
    assert.equal(requests.at(-1)?.headers?.authorization, undefined);
  } finally {
    await world.dispose();
  }
});

void test('a catalog that cannot be read is failed', async () => {
  const transport: HttpTransport = {
    request: () => Promise.reject(new Error('connection refused')),
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };
  const { world, records } = adapterWorld({ transport });

  try {
    assert.deepEqual(await records[1]?.catalog({ configuration: {} }), {
      status: 'failed',
    });
  } finally {
    await world.dispose();
  }
});
