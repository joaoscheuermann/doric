import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import pino, { type Logger } from 'pino';

import { createVectorIndex, type SearchResult } from '../src/index.js';

type LogRecord = Record<string, unknown>;

const silentLogger = pino({ enabled: false });

const captureLogger = (): {
  readonly logger: Logger;
  readonly records: LogRecord[];
} => {
  const records: LogRecord[] = [];

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(chunk.toString('utf8')) as LogRecord);

      callback();
    },
  });

  return {
    logger: pino({ base: null, level: 'debug', timestamp: false }, destination),
    records,
  };
};

type Skill = {
  readonly direction: string;
  readonly id: string;
  readonly tags?: ReadonlyArray<string>;
};

type TextData = {
  readonly text: string;
};

test('returns the closest stored structured data and cosine scores', async () => {
  const vectors = createVectorIndex<Skill>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) =>
      (
        ({
          north: [0, 1],
          diagonal: [1, 1],
          east: [1, 0],
          query: [1, 0],
        }) as Record<string, number[]>
      )[text] ?? [],
  });
  const transform = (data: Skill): string => data.direction;
  const east: Skill = { direction: 'east', id: 'east', tags: ['closest'] };

  await vectors.add({ direction: 'north', id: 'north' }, transform);

  await vectors.add({ direction: 'diagonal', id: 'diagonal' }, transform);

  await vectors.add(east, transform);

  const result: ReadonlyArray<SearchResult<Skill>> = await vectors.search(
    'query',
    2,
  );

  assert.equal(result.length, 2);

  assert.deepEqual(result[0], { data: east, score: 1 });

  assert.deepEqual(result[1]?.data, { direction: 'diagonal', id: 'diagonal' });

  assert.ok(Math.abs((result[1]?.score ?? 0) - Math.SQRT1_2) < 1e-12);
});

test('embeds only text returned by the transformer and runs it once per add', async () => {
  const texts: string[] = [];

  const vectors = createVectorIndex<{
    readonly title: string;
    readonly body: string;
  }>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) => {
      texts.push(text);

      return [1, 0];
    },
  });
  const data = { title: 'Original title', body: 'Indexed body' };
  let transformations = 0;

  await vectors.add(data, (value) => {
    transformations += 1;

    assert.equal(value, data);

    return value.body;
  });

  assert.equal(transformations, 1);

  assert.deepEqual(texts, ['Indexed body']);
});

test('rejects invalid transformers before embedding or retaining data', async () => {
  let embeddings = 0;

  const vectors = createVectorIndex<TextData>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async () => {
      embeddings += 1;

      return [1, 0];
    },
  });

  const invalidFunction = undefined as unknown as (data: {
    text: string;
  }) => string;

  const invalidResult = (() => 123) as unknown as (data: {
    text: string;
  }) => string;

  await assert.rejects(() =>
    vectors.add({ text: 'not a function' }, invalidFunction),
  );

  await assert.rejects(() => vectors.add({ text: 'not text' }, invalidResult));

  assert.equal(embeddings, 0);

  assert.deepEqual(await vectors.search('query', 1), []);

  assert.equal(embeddings, 0);
});

test('limits results to topK and retains insertion order for equal scores', async () => {
  const vectors = createVectorIndex<{
    readonly text: string;
    readonly order: number;
  }>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) =>
      (
        ({
          first: [1, 0],
          second: [2, 0],
          later: [0, 1],
          query: [1, 0],
        }) as Record<string, number[]>
      )[text] ?? [],
  });
  const transform = ({ text }: { readonly text: string }): string => text;

  await vectors.add({ text: 'first', order: 1 }, transform);

  await vectors.add({ text: 'second', order: 2 }, transform);

  await vectors.add({ text: 'later', order: 3 }, transform);

  assert.deepEqual(await vectors.search('query', 2), [
    { data: { text: 'first', order: 1 }, score: 1 },
    { data: { text: 'second', order: 2 }, score: 1 },
  ]);
});

test('returns no results without embedding zero-topK or empty-database queries', async () => {
  let calls = 0;

  const vectors = createVectorIndex({
    dimensions: 2,
    logger: silentLogger,
    embedding: async () => {
      calls += 1;

      return [1, 0];
    },
  });

  assert.deepEqual(await vectors.search('zero', 0), []);

  assert.equal(calls, 0);

  assert.deepEqual(await vectors.search('empty', 1), []);

  assert.equal(calls, 0);
});

test('rejects invalid configuration, malformed embeddings, and invalid topK values', async () => {
  for (const dimensions of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      createVectorIndex({
        dimensions,
        embedding: async () => [1],
        logger: silentLogger,
      }),
    );
  }

  for (const vector of [
    [1],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [0, 0],
  ]) {
    const vectors = createVectorIndex<TextData>({
      dimensions: 2,
      logger: silentLogger,
      embedding: async () => vector,
    });

    await assert.rejects(() =>
      vectors.add({ text: 'invalid' }, (data) => data.text),
    );
  }

  const vectors = createVectorIndex({
    dimensions: 2,
    logger: silentLogger,
    embedding: async () => [1, 0],
  });

  for (const topK of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => vectors.search('query', topK));
  }
});

test('rejects sparse embeddings without retaining data or returning invalid scores', async () => {
  const sparse = new Array<number>(2);
  sparse[0] = 1;
  const vectors = createVectorIndex<string>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) => (text === 'sparse' ? sparse : [1, 0]),
  });

  await assert.rejects(
    vectors.add('sparse', (text) => text),
    TypeError,
  );
  assert.deepEqual(await vectors.search('valid', 2), []);
  await vectors.add('valid', (text) => text);
  await assert.rejects(vectors.search('sparse', 2), TypeError);
  assert.deepEqual(await vectors.search('valid', 2), [
    { data: 'valid', score: 1 },
  ]);
});

test('keeps cosine scores finite for extreme finite embedding magnitudes', async () => {
  for (const scale of [Number.MAX_VALUE, Number.MIN_VALUE]) {
    const vectors = createVectorIndex<string>({
      dimensions: 2,
      logger: silentLogger,
      embedding: async (text) =>
        text === 'opposite' ? [-scale, -scale] : [scale, scale],
    });
    await vectors.add('same', (text) => text);
    await vectors.add('opposite', (text) => text);

    const results = await vectors.search('query', 2);

    assert.deepEqual(
      results.map(({ data }) => data),
      ['same', 'opposite'],
    );
    assert.ok(Math.abs(results[0].score - 1) < 1e-12);
    assert.ok(Math.abs(results[1].score + 1) < 1e-12);
  }
});

test('keeps stored embeddings independent of later provider mutations', async () => {
  const stored = [1, 0];
  const vectors = createVectorIndex<string>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) => (text === 'stored' ? stored : [1, 0]),
  });
  await vectors.add('stored', (text) => text);
  stored[0] = 0;
  stored[1] = 1;

  assert.deepEqual(await vectors.search('query', 1), [
    { data: 'stored', score: 1 },
  ]);
});

test('selects exact top-K with stable ties across mixed positive and negative scores', async () => {
  const directions = [0, -3, 2, 1, -1, 4, 2, -2, 3, 1, -4, 4, 0, 5, -5, 3];
  const vectors = createVectorIndex<number>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) =>
      text === 'query' ? [1, 0] : [directions[Number(text)], 1],
  });

  for (let index = 0; index < directions.length; index += 1) {
    await vectors.add(index, String);
  }

  // For vectors [x, 1] against [1, 0], cosine increases with x.
  const expected = directions
    .map((direction, index) => ({ direction, index }))
    .sort(
      (left, right) =>
        right.direction - left.direction || left.index - right.index,
    )
    .map(({ index }) => index);

  for (const limit of [1, 2, 3, 5, 8, 16, 20]) {
    const results = await vectors.search('query', limit);

    assert.deepEqual(
      results.map(({ data }) => data),
      expected.slice(0, limit),
    );
    assert.ok(
      results.every(
        ({ score }) => Number.isFinite(score) && Math.abs(score) <= 1,
      ),
    );
  }
});

test('does not retain data when its transformer or embedding fails', async () => {
  const vectors = createVectorIndex<{
    readonly text: string;
    readonly retained?: boolean;
  }>({
    dimensions: 2,
    logger: silentLogger,
    embedding: async (text) =>
      (
        ({ valid: [1, 0], invalid: [0, 0], query: [1, 0] }) as Record<
          string,
          number[]
        >
      )[text] ?? [],
  });

  await assert.rejects(() =>
    vectors.add({ text: 'transform-failure' }, () => {
      throw new Error('transform failed');
    }),
  );

  await assert.rejects(() =>
    vectors.add({ text: 'invalid' }, (data) => data.text),
  );

  await vectors.add({ text: 'valid', retained: true }, (data) => data.text);

  assert.deepEqual(await vectors.search('query', 10), [
    { data: { text: 'valid', retained: true }, score: 1 },
  ]);
});

test('requires a logger with debug and child functions synchronously', () => {
  assert.throws(
    () =>
      createVectorIndex({
        dimensions: 2,
        embedding: async () => [1, 0],
        logger: { debug: () => undefined } as unknown as Logger,
      }),
    TypeError,
  );
});

test('logs failures without exposing private data or changing error identity', async () => {
  const privateData = 'PRIVATE_STORED_DATA';
  const privateText = 'PRIVATE_TRANSFORMED_TEXT';
  const privateQuery = 'PRIVATE_QUERY';
  const privateAddFailure = 'PRIVATE_ADD_FAILURE';
  const privateSearchFailure = 'PRIVATE_SEARCH_FAILURE';
  const privateVector = [314159, 271828];
  const addFailure = new Error(privateAddFailure);
  const searchFailure = new Error(privateSearchFailure);
  const { logger, records } = captureLogger();

  const vectors = createVectorIndex({
    dimensions: 2,
    logger,
    embedding: async (text) => {
      if (text === privateQuery) {
        throw searchFailure;
      }

      return privateVector;
    },
  });

  await assert.rejects(
    vectors.add(privateData, () => {
      throw addFailure;
    }),
    (error) => error === addFailure,
  );

  await vectors.add(privateData, () => privateText);

  await assert.rejects(
    vectors.search(privateQuery, 1),
    (error) => error === searchFailure,
  );

  assert.ok(records.length > 0);

  const rendered = JSON.stringify(records);

  for (const value of [
    privateData,
    privateText,
    privateQuery,
    privateAddFailure,
    privateSearchFailure,
    ...privateVector.map(String),
  ]) {
    assert.equal(rendered.includes(value), false);
  }
});
