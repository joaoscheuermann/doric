import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import {
  createHybridSearch,
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

test('fuses lexical and semantic ranks with RRF and canonical-key deduplication', async () => {
  const calls: Array<{ readonly source: string; readonly topK: number }> = [];

  const lexical: Search<Document> = {
    search: async (_query, topK) => {
      calls.push({ source: 'lexical', topK });

      return [result('alpha', 100), result('beta', 50)];
    },
  };

  const semantic: Search<Document> = {
    search: async (_query, topK) => {
      calls.push({ source: 'semantic', topK });

      return [result('gamma', 0.9), result('beta', 0.8)];
    },
  };

  const hybrid = createHybridSearch({
    lexical,
    semantic,
    key: ({ id }) => id,
    logger,
  });
  const results = await hybrid.search('private query', 3);

  assert.deepEqual(calls, [
    { source: 'lexical', topK: 3 },
    { source: 'semantic', topK: 3 },
  ]);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['beta', 'alpha', 'gamma'],
  );

  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));

  assert.equal(results[1]?.score, results[2]?.score);
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
