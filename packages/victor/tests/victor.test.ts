import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import pino, { type Logger } from 'pino';

import {
  createVectorIndex as createVectorDatabase,
  type SearchIndex as VectorDatabase,
  type SearchResult as VectorSearchResult,
} from '../src/index.js';

type LogRecord = {
  readonly component?: string;
  readonly dimensions?: number;
  readonly entryCount?: number;
  readonly level: number;
  readonly msg: string;
  readonly resultCount?: number;
  readonly topK?: number;
};

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
  const vectors: VectorDatabase<Skill> = createVectorDatabase<Skill>({
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

  const result = await vectors.search('query', 2);

  const acceptsSkillResults = (
    value: ReadonlyArray<VectorSearchResult<Skill>>,
  ): void => undefined;

  acceptsSkillResults(result);

  assert.equal(result.length, 2);

  assert.deepEqual(result[0], { data: east, score: 1 });

  assert.deepEqual(result[1]?.data, { direction: 'diagonal', id: 'diagonal' });

  assert.ok(Math.abs((result[1]?.score ?? 0) - Math.SQRT1_2) < 1e-12);

  assert.equal('metadata' in (result[0] ?? {}), false);
});

test('embeds only text returned by the transformer and runs it once per add', async () => {
  const texts: string[] = [];

  const vectors = createVectorDatabase<{
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

  const vectors = createVectorDatabase<TextData>({
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
  const vectors = createVectorDatabase<{
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
  const { logger, records } = captureLogger();

  const vectors = createVectorDatabase({
    dimensions: 2,
    logger,
    embedding: async () => {
      calls += 1;

      return [1, 0];
    },
  });

  assert.deepEqual(await vectors.search('zero', 0), []);

  assert.equal(calls, 0);

  assert.deepEqual(await vectors.search('empty', 1), []);

  assert.equal(calls, 0);

  assert.deepEqual(
    records.map(({ msg, entryCount, resultCount, topK }) => ({
      msg,
      entryCount,
      resultCount,
      topK,
    })),
    [
      {
        msg: 'vector database created',
        entryCount: undefined,
        resultCount: undefined,
        topK: undefined,
      },
      {
        msg: 'vector database search started',
        entryCount: 0,
        resultCount: undefined,
        topK: 0,
      },
      {
        msg: 'vector database search completed',
        entryCount: 0,
        resultCount: 0,
        topK: 0,
      },
      {
        msg: 'vector database search started',
        entryCount: 0,
        resultCount: undefined,
        topK: 1,
      },
      {
        msg: 'vector database search completed',
        entryCount: 0,
        resultCount: 0,
        topK: 1,
      },
    ],
  );
});

test('rejects invalid configuration, malformed embeddings, and invalid topK values', async () => {
  for (const dimensions of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      createVectorDatabase({
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
    const vectors = createVectorDatabase<TextData>({
      dimensions: 2,
      logger: silentLogger,
      embedding: async () => vector,
    });

    await assert.rejects(() =>
      vectors.add({ text: 'invalid' }, (data) => data.text),
    );
  }

  const vectors = createVectorDatabase({
    dimensions: 2,
    logger: silentLogger,
    embedding: async () => [1, 0],
  });

  for (const topK of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => vectors.search('query', topK));
  }
});

test('does not retain data when its transformer or embedding fails', async () => {
  const vectors = createVectorDatabase<{
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
      createVectorDatabase({
        dimensions: 2,
        embedding: async () => [1, 0],
        logger: { debug: () => undefined } as unknown as Logger,
      }),
    /logger: expected an object with debug and child functions/,
  );
});

test('emits structured debug logs for successful add and search operations', async () => {
  const { logger, records } = captureLogger();

  const vectors = createVectorDatabase({
    dimensions: 2,
    logger,
    embedding: async (text) => (text === 'query' ? [0, 1] : [1, 0]),
  });

  await vectors.add({ id: 'stored' }, () => 'stored');

  await vectors.search('query', 1);

  assert.deepEqual(
    records.map(
      ({
        component,
        dimensions,
        entryCount,
        level,
        msg,
        resultCount,
        topK,
      }) => ({
        component,
        dimensions,
        entryCount,
        level,
        msg,
        resultCount,
        topK,
      }),
    ),
    [
      {
        component: 'victor',
        dimensions: 2,
        entryCount: undefined,
        level: 20,
        msg: 'vector database created',
        resultCount: undefined,
        topK: undefined,
      },
      {
        component: 'victor',
        dimensions: 2,
        entryCount: 0,
        level: 20,
        msg: 'vector database add started',
        resultCount: undefined,
        topK: undefined,
      },
      {
        component: 'victor',
        dimensions: 2,
        entryCount: 1,
        level: 20,
        msg: 'vector database add completed',
        resultCount: undefined,
        topK: undefined,
      },
      {
        component: 'victor',
        dimensions: 2,
        entryCount: 1,
        level: 20,
        msg: 'vector database search started',
        resultCount: undefined,
        topK: 1,
      },
      {
        component: 'victor',
        dimensions: 2,
        entryCount: 1,
        level: 20,
        msg: 'vector database search completed',
        resultCount: 1,
        topK: 1,
      },
    ],
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

  const vectors = createVectorDatabase({
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

  assert.deepEqual(
    records.map(({ msg }) => msg),
    [
      'vector database created',
      'vector database add started',
      'vector database add failed',
      'vector database add started',
      'vector database add completed',
      'vector database search started',
      'vector database search failed',
    ],
  );

  assert.equal(
    records.every(
      ({ component, level }) => component === 'victor' && level === 20,
    ),
    true,
  );

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
