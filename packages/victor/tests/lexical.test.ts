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

test('ranks documents with BM25 term frequency and document-length normalization', async () => {
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

  const results = await index.search('slack channel publish', 2);
  const acceptsResults = (value: ReadonlyArray<SearchResult<Document>>): void =>
    undefined;

  acceptsResults(results);

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

test('returns no results without transforming or searching unusable input', async () => {
  let transformations = 0;
  const index = createLexicalIndex<Document>({ logger });

  assert.deepEqual(await index.search('---', 5), []);

  assert.deepEqual(await index.search('query', 0), []);

  assert.equal(transformations, 0);

  await index.add({ id: 'stored', text: 'searchable' }, (document) => {
    transformations += 1;

    return document.text;
  });

  assert.equal(transformations, 1);

  await assert.rejects(() => index.search('query', -1));
});
