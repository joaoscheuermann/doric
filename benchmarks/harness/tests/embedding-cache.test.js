import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startGateway } from '../src/gateway.mjs';

const setup = async (t, directory, fetcher) => {
  const gateway = await startGateway({
    token: 'temporary',
    apiKey: 'unused',
    models: ['model-a', 'model-b'],
    host: '127.0.0.1',
    embeddingCacheDirectory: directory,
    fetcher,
  });

  t.after(() => gateway.close());

  return {
    gateway,
    post: (input, route = 'embeddings') =>
      fetch('http://127.0.0.1:' + gateway.port + '/api/v1/' + route, {
        method: 'POST',
        headers: { authorization: 'Bearer temporary' },
        body: JSON.stringify(input),
      }),
  };
};

test('corrupted cached vectors are replaced by fresh embeddings', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'benchmark-embedding-corrupt-'),
  );

  t.after(() => rm(directory, { recursive: true, force: true }));

  let calls = 0;

  const { post } = await setup(t, directory, async () => {
    calls += 1;

    return Response.json({ data: [{ index: 0, embedding: [calls, 0] }] });
  });
  const input = { model: 'model-a', dimensions: 2, input: 'skill' };

  await (await post(input)).arrayBuffer();

  const [file] = await readdir(directory);

  await writeFile(join(directory, file), '[null, 0]');

  assert.deepEqual(
    (await (await post(input)).json()).data[0].embedding,
    [2, 0],
  );

  await (await post(input)).arrayBuffer();

  assert.equal(calls, 2);
});

test('completion requests always reach the provider', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'benchmark-no-completion-cache-'),
  );

  t.after(() => rm(directory, { recursive: true, force: true }));

  let calls = 0;

  const { post } = await setup(t, directory, async () => {
    calls += 1;

    return Response.json({ choices: [] });
  });

  for (const route of [
    'chat/completions',
    'chat/completions',
    'rerank',
    'rerank',
  ]) {
    await (
      await post({ model: 'model-a', input: 'same' }, route)
    ).arrayBuffer();
  }

  assert.equal(calls, 4);
});

test('embeddings survive gateway restarts without new provider calls or repeated cost', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-embeddings-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const request = {
    model: 'model-a',
    input: 'Exact skill body',
    dimensions: 2,
  };

  const first = await setup(t, directory, async () =>
    Response.json({
      data: [{ index: 0, embedding: [0.25, 0.75] }],
      usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.001 },
    }),
  );

  assert.equal((await (await first.post(request)).json()).usage.cost, 0.001);

  await first.gateway.close();

  const second = await setup(t, directory, async () => {
    throw new Error('Cache hit must not call the provider');
  });

  const response = await second.post({
    dimensions: 2,
    input: request.input,
    model: request.model,
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.deepEqual(body.data[0].embedding, [0.25, 0.75]);

  assert.equal(body.usage.total_tokens, 0);

  assert.equal(body.usage.cost, 0);

  assert.equal(second.gateway.usage[0].cache, 'hit');
});

test('changed model, dimensions or text misses the embedding cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-embedding-keys-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  let calls = 0;

  const { post } = await setup(t, directory, async (_url, options) => {
    calls += 1;

    const input = JSON.parse(options.body);

    return Response.json({
      data: [{ index: 0, embedding: Array(input.dimensions).fill(calls) }],
    });
  });

  for (const input of [
    { model: 'model-a', dimensions: 2, input: 'skill' },
    { model: 'model-b', dimensions: 2, input: 'skill' },
    { model: 'model-a', dimensions: 3, input: 'skill' },
    { model: 'model-a', dimensions: 2, input: 'skill ' },
  ]) {
    await (await post(input)).arrayBuffer();
  }

  assert.equal(calls, 4);
});

test('failed embedding responses are retried upstream rather than cached', async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), 'benchmark-embedding-errors-'),
  );

  t.after(() => rm(directory, { recursive: true, force: true }));

  let calls = 0;

  const { post } = await setup(t, directory, async () => {
    calls += 1;

    if (calls === 1) {
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    }

    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  const input = { model: 'model-a', dimensions: 2, input: 'skill' };

  assert.equal((await post(input)).status, 503);

  assert.equal((await post(input)).status, 200);

  await (await post(input)).arrayBuffer();

  assert.equal(calls, 2);
});
