import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failingTransport,
  providerWorld,
  recordingTransport,
} from './support/world.js';

void test('catalog reads the default models URL with the secret as a bearer token', async () => {
  const { requests, transport } = recordingTransport({
    data: [{ id: 'openai/gpt-5', context_length: 400000 }],
  });
  const { world, provider } = await providerWorld('openrouter', { transport });

  try {
    const read = await provider.catalog({
      configuration: {},
      secret: 'sk-or',
    });

    assert.equal(read.status, 'read');
    assert.deepEqual(
      read.status === 'read' ? read.models.map(({ id }) => id) : [],
      ['openai/gpt-5'],
    );
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: 'https://openrouter.ai/api/v1/models',
        headers: { accept: 'application/json', authorization: 'Bearer sk-or' },
      },
    ]);
  } finally {
    await world.dispose();
  }
});

void test('an empty or missing secret sends no authorization header', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('openrouter', { transport });

  try {
    await provider.catalog({ configuration: {}, secret: '' });
    await provider.catalog({ configuration: {} });
    assert.deepEqual(
      requests.map(({ headers }) => headers),
      [{ accept: 'application/json' }, { accept: 'application/json' }],
    );
  } finally {
    await world.dispose();
  }
});

void test('the catalog URL is the models URL, else the endpoint models path', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('openrouter', { transport });

  try {
    await provider.catalog({
      configuration: { endpoint: 'https://proxy.test/v1' },
    });
    await provider.catalog({
      configuration: {
        endpoint: 'https://proxy.test/v1',
        modelsUrl: 'https://catalog.test/list',
      },
    });
    assert.deepEqual(
      requests.map(({ url }) => url),
      ['https://proxy.test/v1/models', 'https://catalog.test/list'],
    );
  } finally {
    await world.dispose();
  }
});

void test('a catalog that cannot be read is failed and logs nothing naming the URL or secret', async () => {
  const { world, lines, provider } = await providerWorld('openrouter', {
    transport: failingTransport(new Error('connection refused')),
  });

  try {
    assert.deepEqual(
      await provider.catalog({
        configuration: { modelsUrl: 'https://catalog.test/list' },
        secret: 'sk-secret',
      }),
      { status: 'failed' },
    );

    const logged = JSON.stringify(lines);

    assert.equal(logged.includes('catalog.test'), false);
    assert.equal(logged.includes('sk-secret'), false);
  } finally {
    await world.dispose();
  }
});
