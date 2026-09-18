import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import {
  createHybridSearch,
  createLexicalIndex,
  createVectorIndex,
  type Search,
  type SearchResult,
} from '../src/index.js';

const logger = pino({ enabled: false });

type Document = {
  readonly id: string;
};

const result = (id: string, score: number): SearchResult<Document> => ({
  data: { id },
  score,
});

test('combines the real lexical and vector indexes without losing shared candidates', async () => {
  const lexical = createLexicalIndex<Document>({ logger });
  const vectors: Record<string, number[]> = {
    lexical: [0, 1],
    shared: [1, 1],
    semantic: [1, 0],
    target: [1, 0],
  };
  const semantic = createVectorIndex<Document>({
    dimensions: 2,
    logger,
    embedding: async (text) => vectors[text],
  });

  for (const [id, text] of [
    ['lexical', 'target'],
    ['shared', 'target filler'],
    ['semantic', 'unrelated'],
  ]) {
    const document = { id };
    await lexical.add(document, () => text);
    await semantic.add(document, ({ id }) => id);
  }

  const hybrid = createHybridSearch({
    lexical,
    semantic,
    key: ({ id }) => id,
    logger,
  });
  const results = await hybrid.search('target', 2);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['shared', 'lexical'],
  );
  assert.equal(results[0].score, 2 / 62);
});

test('fuses lexical and semantic ranks with RRF and canonical-key deduplication', async () => {
  const lexical: Search<Document> = {
    search: async () => [result('alpha', 100), result('beta', 50)],
  };

  const semantic: Search<Document> = {
    search: async () => [result('gamma', 0.9), result('beta', 0.8)],
  };

  const hybrid = createHybridSearch({
    lexical,
    semantic,
    key: ({ id }) => id,
    logger,
  });
  const results = await hybrid.search('private query', 3);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['beta', 'alpha', 'gamma'],
  );

  assert.equal(results[0]?.score, 2 / 62);
  assert.equal(results[1]?.score, 1 / 61);
  assert.equal(results[2]?.score, 1 / 61);
});

test('uses the requested query and limit for both sources', async () => {
  const source = (id: string): Search<Document> => ({
    search: async (query, topK) =>
      query === 'requested query' && topK === 2 ? [result(id, 1)] : [],
  });
  const hybrid = createHybridSearch({
    lexical: source('lexical'),
    semantic: source('semantic'),
    key: ({ id }) => id,
    logger,
  });

  const results = await hybrid.search('requested query', 2);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['lexical', 'semantic'],
  );
});

test('counts a canonical key only once per source without compressing later ranks', async () => {
  const hybrid = createHybridSearch({
    lexical: {
      search: async () => [
        result('alpha', 100),
        result('alpha', 90),
        result('beta', 80),
      ],
    },
    semantic: { search: async () => [] },
    key: ({ id }) => id,
    logger,
  });

  const results = await hybrid.search('query', 3);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['alpha', 'beta'],
  );
  assert.equal(results[0]?.score, 1 / 61);
  assert.equal(results[1]?.score, 1 / 63);
});

test('limits source rankings before fusion and the final ranking after fusion', async () => {
  const hybrid = createHybridSearch({
    lexical: {
      search: async () => [
        result('zulu', 100),
        result('alpha', 90),
        result('outside', 80),
      ],
    },
    semantic: {
      search: async () => [result('beta', 0.9), result('outside', 0.8)],
    },
    key: ({ id }) => id,
    logger,
  });

  const results = await hybrid.search('query', 2);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['beta', 'zulu'],
  );
});

test('does not query either source when topK is zero', async () => {
  let calls = 0;

  const source: Search<Document> = {
    search: async () => {
      calls += 1;

      return [];
    },
  };

  const hybrid = createHybridSearch({
    lexical: source,
    semantic: source,
    key: ({ id }) => id,
    logger,
  });

  assert.deepEqual(await hybrid.search('query', 0), []);

  assert.equal(calls, 0);
});

test('propagates source failures without returning a partial ranking', async () => {
  const failure = new Error('private lexical failure');

  const hybrid = createHybridSearch<Document>({
    lexical: { search: async () => Promise.reject(failure) },
    semantic: { search: async () => [result('semantic', 1)] },
    key: ({ id }) => id,
    logger,
  });

  await assert.rejects(
    hybrid.search('private query', 1),
    (error) => error === failure,
  );
});
