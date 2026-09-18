import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import {
  createLexicalIndex,
  type SearchIndex,
  type SearchResult,
} from '../src/index.js';

const logger = pino({ enabled: false });

type Document = {
  readonly id: string;
  readonly text: string;
};

const text = (document: Document): string => document.text;

test('ranks shorter matching documents ahead of longer ones', async () => {
  const index: SearchIndex<Document> = createLexicalIndex({ logger });

  const focused = {
    id: 'focused',
    text: 'slack channel publish finalized message',
  };

  await index.add(
    {
      id: 'verbose',
      text: 'slack channel publish finalized message with unrelated database migration deployment monitoring and reporting details',
    },
    text,
  );

  await index.add(focused, text);

  await index.add({ id: 'unrelated', text: 'database migration' }, text);

  const results: ReadonlyArray<SearchResult<Document>> = await index.search(
    'slack channel publish',
    3,
  );

  assert.deepEqual(
    results.map(({ data }) => data),
    [
      focused,
      {
        id: 'verbose',
        text: 'slack channel publish finalized message with unrelated database migration deployment monitoring and reporting details',
      },
    ],
  );

  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
});

test('normalizes Unicode case and retains insertion order for equal scores', async () => {
  const index = createLexicalIndex<Document>({ logger });
  const first = { id: 'first', text: 'Publicação Slack' };
  const second = { id: 'second', text: 'PUBLICAÇÃO SLACK' };

  await index.add(first, text);

  await index.add(second, text);

  const results = await index.search('publicação slack', 2);

  assert.deepEqual(
    results.map(({ data }) => data),
    [first, second],
  );

  assert.ok((results[0]?.score ?? 0) > 0);

  assert.equal(results[0]?.score, results[1]?.score);
});

test('returns no results for empty indexes, unmatched queries, or a zero limit', async () => {
  const index = createLexicalIndex<Document>({ logger });

  assert.deepEqual(await index.search('searchable', 5), []);

  await index.add({ id: 'stored', text: 'searchable' }, text);

  assert.deepEqual(await index.search('---', 5), []);
  assert.deepEqual(await index.search('unmatched', 5), []);
  assert.deepEqual(await index.search('searchable', 0), []);
});

test('rewards repeated document terms without counting repeated query terms', async () => {
  const index = createLexicalIndex<Document>({ logger });

  await index.add({ id: 'once', text: 'search other other' }, text);
  await index.add({ id: 'repeated', text: 'search search other' }, text);

  const results = await index.search('search', 2);

  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['repeated', 'once'],
  );
  assert.ok(results[0]!.score > results[1]!.score);
  assert.deepEqual(await index.search('search search', 2), results);
  assert.deepEqual(await index.search('search', 1), results.slice(0, 1));
});

test('updates BM25 weights after inserting documents with existing terms', async () => {
  const index = createLexicalIndex<Document>({ logger });
  await index.add({ id: 'alpha-first', text: 'alpha' }, text);
  await index.add({ id: 'beta', text: 'beta' }, text);

  const before = await index.search('alpha beta', 3);
  assert.deepEqual(
    before.map(({ data }) => data.id),
    ['alpha-first', 'beta'],
  );
  assert.ok(Math.abs(before[0].score - Math.LN2) < 1e-12);

  await index.add({ id: 'alpha-later', text: 'alpha' }, text);
  const after = await index.search('alpha beta', 3);

  assert.deepEqual(
    after.map(({ data }) => data.id),
    ['beta', 'alpha-first', 'alpha-later'],
  );
  assert.ok(Math.abs(after[0].score - 0.9808292530117263) < 1e-12);
  assert.ok(Math.abs(after[1].score - 0.47000362924573563) < 1e-12);
  assert.equal(after[1].score, after[2].score);
});

test('preserves insertion ties across different query terms and top-K boundaries', async () => {
  const index = createLexicalIndex<Document>({ logger });
  const ids = Array.from(
    { length: 16 },
    (_, position) => `document-${position}`,
  );

  for (let position = 0; position < ids.length; position += 1) {
    await index.add(
      {
        id: ids[position],
        text: position % 2 === 0 ? 'alpha' : 'beta',
      },
      text,
    );
  }

  for (const query of ['beta alpha', 'alpha beta', 'missing beta alpha beta']) {
    for (const limit of [1, 2, 3, 5, 7, 16, 20]) {
      const results = await index.search(query, limit);
      assert.deepEqual(
        results.map(({ data }) => data.id),
        ids.slice(0, limit),
      );
    }
  }
});

test('leaves results and corpus statistics unchanged after rejected additions', async () => {
  const index = createLexicalIndex<Document>({ logger });
  await index.add({ id: 'stored', text: 'alpha beta beta' }, text);
  const before = await index.search('alpha beta', 10);
  const rejected = { id: 'rejected', text: 'alpha' };
  const failure = new Error('transform failed');

  await assert.rejects(
    index.add(rejected, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    index.add(rejected, () => '---'),
    TypeError,
  );
  await assert.rejects(
    index.add(rejected, (() => 42) as unknown as typeof text),
    TypeError,
  );
  assert.deepEqual(await index.search('alpha beta', 10), before);
});

test('matches compatibility and decomposed Unicode forms', async () => {
  const index = createLexicalIndex<Document>({ logger });
  await index.add({ id: 'stored', text: 'Ｃａｆé' }, text);

  const results = await index.search('CAFE\u0301', 1);
  assert.deepEqual(
    results.map(({ data }) => data.id),
    ['stored'],
  );
});

for (const topK of [-1, 0.5, NaN, Infinity]) {
  test(`rejects an invalid result limit of ${topK}`, async () => {
    const index = createLexicalIndex<Document>({ logger });

    await assert.rejects(index.search('query', topK), TypeError);
  });
}
