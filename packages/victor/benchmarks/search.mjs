import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import pino from 'pino';

// An optional compiled entrypoint lets the same workload measure a baseline.
const entrypoint = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../dist/index.js', import.meta.url);
const { createLexicalIndex, createVectorIndex } = await import(entrypoint.href);
const logger = pino({ enabled: false });
const dimensions = 384;
const topK = 10;
const queryCount = 20;
const rounds = 5;

let seed = 42;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const vector = () => Array.from({ length: dimensions }, () => random() * 2 - 1);

const measure = async (name, index, queries) => {
  for (const query of queries) {
    await index.search(query, topK);
  }

  const durations = [];
  const hash = createHash('sha256');

  for (let round = 0; round < rounds; round += 1) {
    for (const query of queries) {
      const start = performance.now();
      const results = await index.search(query, topK);
      durations.push(performance.now() - start);
      // Ranking checksum is outside timing; compare it between implementations.
      hash.update(JSON.stringify(results.map(({ data }) => data.id)));
    }
  }

  durations.sort((left, right) => left - right);
  return {
    name,
    medianMs: durations[Math.floor(durations.length * 0.5)],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    ranking: hash.digest('hex'),
  };
};

console.log(
  JSON.stringify({
    node: process.version,
    cpu: cpus()[0]?.model,
    dimensions,
    topK,
    queryCount,
    rounds,
    seed,
    explicitGc: typeof globalThis.gc === 'function',
  }),
);

for (const size of [1_000, 10_000]) {
  // Fixtures and embedding generation are deliberately outside timed regions.
  const documents = Array.from({ length: size }, (_, id) => ({
    id,
    text: `common topic${id % 200} ${'detail '.repeat(1 + (id % 8))} item${id}`,
  }));
  const embeddings = documents.map(vector);
  const queries = Array.from({ length: queryCount }, (_, id) => `query${id}`);
  const queryVectors = new Map(queries.map((query) => [query, vector()]));
  const lexical = createLexicalIndex({ logger });
  const semantic = createVectorIndex({
    dimensions,
    logger,
    embedding: async (text) =>
      queryVectors.get(text) ?? embeddings[Number(text)],
  });

  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  let start = performance.now();
  for (const document of documents) {
    await lexical.add(document, ({ text }) => text);
  }
  const lexicalBuildMs = performance.now() - start;

  start = performance.now();
  for (const document of documents) {
    await semantic.add(document, ({ id }) => String(id));
  }
  const vectorBuildMs = performance.now() - start;
  globalThis.gc?.();
  const retainedHeapBytes = process.memoryUsage().heapUsed - before;

  const searches = [
    await measure(
      'lexical-selective',
      lexical,
      queries.map((_, id) => `topic${id}`),
    ),
    await measure(
      'lexical-common',
      lexical,
      queries.map(() => 'common'),
    ),
    await measure(
      'lexical-missing',
      lexical,
      queries.map(() => 'absent'),
    ),
    await measure('vector', semantic, queries),
  ];

  console.log(
    JSON.stringify({
      size,
      lexicalBuildMs,
      vectorBuildMs,
      retainedHeapBytes,
      searches,
    }),
  );
}
