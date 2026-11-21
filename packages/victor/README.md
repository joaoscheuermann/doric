# Victor

Victor is a library of ranked, in-memory search for a JavaScript process. It holds two incremental indexes, a lexical one ranked with BM25 and a vector one ranked by cosine similarity, and a read-only hybrid search that fuses the rankings of two sources with reciprocal rank fusion. The caller supplies the embedding function and the logger; Victor supplies exact, deterministic ranking. It has no search server, no vector database, no embedding provider and no persistence: an index lives as long as the object that holds it.

It is meant for packages, bundles, agent tools and tests that need ranked results over a corpus they hold in memory. No bundle, application or other package of the repository imports it; it is available to them as the workspace package `victor`.

Part of [Doric](../../README.md).

## Entry points

[`package.json`](package.json) declares an ES module package (`"type": "module"`) with two exports:

| Export           | Resolves to                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`              | [`src/index.ts`](src/index.ts) under the `@org/source` condition (the workspace's source condition); `dist/index.js` and `dist/index.d.ts` otherwise |
| `./package.json` | The package manifest                                                                                                                                 |

Everything public is exported from [`src/index.ts`](src/index.ts): three factory functions and seven types. The runtime code imports no other package: its modules import only each other, `pino` supplies only the `Logger` type, and `tslib` is declared for TypeScript's `importHelpers` ([`tsconfig.base.json`](../../tsconfig.base.json)) but is not imported by the ES2022 output.

```ts
import {
  createHybridSearch,
  createLexicalIndex,
  createVectorIndex,
  type Embedding,
  type HybridSearchOptions,
  type LexicalIndexOptions,
  type Search,
  type SearchIndex,
  type SearchResult,
  type VectorIndexOptions,
} from 'victor';
```

## Types

All types are declared in [`src/lib/types/search.ts`](src/lib/types/search.ts). `Logger` is pino's `Logger` type.

```ts
type Embedding = (data: string) => Promise<readonly number[]>;

interface SearchResult<Data = unknown> {
  readonly data: Data;
  readonly score: number;
}

interface Search<Data = unknown> {
  search(query: string, topK: number): Promise<readonly SearchResult<Data>[]>;
}

type SearchIndex<Data = unknown> = Search<Data> & {
  add(data: Data, transform: (data: Data) => string): Promise<void>;
};

interface LexicalIndexOptions {
  readonly logger: Logger;
}

interface VectorIndexOptions {
  readonly dimensions: number;
  readonly embedding: Embedding;
  readonly logger: Logger;
}

interface HybridSearchOptions<Data> {
  readonly lexical: Search<Data>;
  readonly semantic: Search<Data>;
  readonly key: (data: Data) => string;
  readonly logger: Logger;
}
```

- `Search` is a read-only ranked search: `search(query, topK)` resolves at most `topK` results, best first.
- `SearchIndex` adds `add(data, transform)`, which indexes the caller's value `data` under the text `transform(data)` returns. `data` is stored by reference and returned as is in results; the index never inspects it.
- `Embedding` turns text into a vector. Its result must be an array of exactly `dimensions` finite numbers with a non-zero magnitude. The result is awaited, so a function that returns an array synchronously is accepted the same way, and a synchronous throw becomes a rejection of the `add` or `search` that called it ([`src/lib/vector.ts`](src/lib/vector.ts)).
- Every option is required; none has a default.

## Usage

```ts
import pino from 'pino';
import {
  createHybridSearch,
  createLexicalIndex,
  createVectorIndex,
} from 'victor';

interface Doc {
  readonly id: string;
  readonly text: string;
}

const logger = pino();
const lexical = createLexicalIndex<Doc>({ logger });
const semantic = createVectorIndex<Doc>({
  dimensions: 384,
  embedding: (text) => embed(text), // the caller's model; resolves 384 numbers
  logger,
});

for (const doc of docs) {
  await lexical.add(doc, (d) => d.text);
  await semantic.add(doc, (d) => d.text);
}

const search = createHybridSearch<Doc>({
  lexical,
  semantic,
  key: (d) => d.id,
  logger,
});

for (const { data, score } of await search.search('session persistence', 10)) {
  console.log(data.id, score);
}
```

## Rules common to the three searches

- **`topK`.** `search` accepts a non-negative safe integer (`Number.isSafeInteger(topK) && topK >= 0`); any other value rejects the returned promise with a `TypeError` ([`src/lib/utils/validation.ts`](src/lib/utils/validation.ts)). `topK = 0` resolves `[]` without further work: no embedding is computed and no source is queried.
- **Exact top-K.** The lexical and vector indexes score every candidate and keep only the best `topK` in a bounded binary heap whose root is the worst retained candidate; the retained candidates are then sorted best first ([`src/lib/utils/top.ts`](src/lib/utils/top.ts)). The result is exact, not approximate.
- **Ties.** In both indexes, equal scores are ordered by insertion order, earliest first, whatever order the candidates are visited in ([`src/lib/lexical.ts`](src/lib/lexical.ts), [`src/lib/vector.ts`](src/lib/vector.ts)). The hybrid search orders equal fused scores by key ([`src/lib/hybrid.ts`](src/lib/hybrid.ts)).
- **Growth only.** An index has no removal, update or clear operation. Each `add` appends one entry, and an entry stays until the index object is released ([`src/lib/lexical.ts`](src/lib/lexical.ts), [`src/lib/vector.ts`](src/lib/vector.ts)).
- **Concurrency.** Calls are not serialized. A lexical `add` completes its work before it yields, so lexical insertion order is call order. A vector `add` appends its entry after its embedding resolves, so vector insertion order is the order in which the embeddings of concurrent `add` calls resolve ([`src/lib/vector.ts`](src/lib/vector.ts)).

## `createLexicalIndex(options)`

```ts
createLexicalIndex<Data = unknown>(options: LexicalIndexOptions): SearchIndex<Data>
```

An in-memory inverted index ranked with BM25 ([`src/lib/lexical.ts`](src/lib/lexical.ts)).

**Construction.** It throws a `TypeError` synchronously when `options.logger` is not an object with `debug` and `child` functions. A `null` or `undefined` `options` fails that same check.

**Tokenization.** A text is normalized to Unicode NFKC, lowercased with `toLowerCase`, and split into the maximal runs of letters and numbers (`/[\p{L}\p{N}]+/gu`); every other character separates tokens. Compatibility forms (`ﬁ`, full-width letters) and decomposed accents therefore match their composed forms.

**`add(data, transform)`.** It calls `transform(data)` once and tokenizes the result. It rejects with a `TypeError` when `transform` is not a function, when its result is not a string, or when the result has no token. On rejection nothing is stored and the corpus statistics do not change; an exception thrown by `transform` propagates unchanged. On success it stores the entry with its length (its number of tokens, repetitions included), adds one posting `{ entry, count }` per distinct term to that term's posting list, and adds the length to the corpus total.

**`search(query, topK)`.** After the `topK` check it resolves `[]` when `topK` is 0, when the index is empty, or when the query has no token. Otherwise it takes the set of distinct query terms (a term repeated in the query counts once) and, for each term that has a posting list, computes its weight once from the current corpus:

- `idf = ln(1 + (N − n + 0.5) / (n + 0.5))`, where `N` is the number of entries and `n` the number of entries that hold the term;
- for each posting, `idf × count × (k1 + 1) / (count + k1 × (1 − b + b × length / averageLength))`, with `k1 = 1.2`, `b = 0.75` and `averageLength` the corpus total divided by `N`.

An entry's score is the sum of its terms' contributions. Only entries that hold at least one query term are candidates, so a search may return fewer than `topK` results. Each `add` changes `N`, `n` and `averageLength`, so the scores of a query change as the corpus grows.

The query is not validated: when it is not a string and the search gets past the `topK`, `topK = 0` and empty-index checks, the search rejects with the `TypeError` the engine raises on `query.normalize`, not with an `Invalid …` error, and logs `lexical index search failed`.

## `createVectorIndex(options)`

```ts
createVectorIndex<Data = unknown>(options: VectorIndexOptions): SearchIndex<Data>
```

An in-memory index of normalized embeddings, searched exactly by cosine similarity ([`src/lib/vector.ts`](src/lib/vector.ts)).

**Construction.** It throws a `TypeError` synchronously when `dimensions` is not a positive safe integer, when `embedding` is not a function, or when `logger` is not an object with `debug` and `child` functions, checked in that order. A `null` or `undefined` `options` fails the first check, on `dimensions`.

**Embedding check.** Every embedding the index receives, on `add` and on `search`, is checked and normalized the same way. The result must be an array (`Array.isArray`) of exactly `dimensions` entries; it is copied first, so a hole of a sparse array reads as `undefined`; every entry must be a finite number; and the magnitude must not be zero. A result that fails rejects the call with a `TypeError`. The copy is then divided by its Euclidean norm, computed with a running scale (the largest absolute value) so that it neither overflows nor underflows for extreme finite magnitudes, and divided in two stages, by the scale and then by the scaled norm. The index keeps only its own normalized copy, so a later change to the array the embedding function returned does not affect it.

**`add(data, transform)`.** It rejects with a `TypeError` when `transform` is not a function or its result is not a string; it then awaits `embedding(text)` and checks the result. On any rejection, including one from `transform` or `embedding`, which propagates unchanged, nothing is stored. An empty string is a valid text: it is passed to the embedding function.

**`search(query, topK)`.** After the `topK` check it resolves `[]` when `topK` is 0 or the index is empty, without calling the embedding function. Otherwise it embeds the query, checks the result, and scores every stored entry with the dot product of the two unit vectors, clamped to `[−1, 1]`. Every entry is a candidate, so the search returns `min(topK, entries)` results, negative scores included. The entries scored are those stored when the query's embedding resolves. A scan costs `O(N × D)` for `N` entries of dimension `D`, and selection `O(N log K + K log K)` with at most `K` candidates retained.

## `createHybridSearch(options)`

```ts
createHybridSearch<Data = unknown>(options: HybridSearchOptions<Data>): Search<Data>
```

A read-only search that fuses the rankings of a lexical and a semantic source ([`src/lib/hybrid.ts`](src/lib/hybrid.ts)). The two sources are any `Search`, usually a lexical and a vector index over the same values; the hybrid search does not index anything itself.

**Construction.** It throws a `TypeError` synchronously when `lexical` or `semantic` is not an object with a `search` function, when `key` is not a function, or when `logger` is not an object with `debug` and `child` functions, checked in that order. A `null` or `undefined` `options` fails the first check, on `lexical`.

**`search(query, topK)`.** After the `topK` check (0 resolves `[]` and queries neither source) it calls `lexical.search(query, topK)` and then `semantic.search(query, topK)` without awaiting between them, and awaits both with `Promise.all`. When either rejects, the search rejects with that error and returns no partial ranking; when both reject, the first rejection to settle wins. When `lexical.search` throws synchronously, `semantic.search` is not called and the search rejects with that error. When `semantic.search` throws synchronously, the search rejects with that error and the promise `lexical.search` returned is not awaited, so a later rejection of it is unhandled. It then fuses the two rankings:

1. Each ranking is cut to its first `topK` results, in case a source returns more. A source must resolve an array of results; any other value rejects the search with the `TypeError` the engine raises on `ranking.slice`.
2. For each result it calls `key(data)`; a result that is not a non-empty string rejects the search with a `TypeError`.
3. Within one ranking, a key counts once, at its first position; a later duplicate is skipped and does not move the results after it up.
4. A key at 1-based rank `r` gains `1 / (60 + r)`. The two sources weigh the same, and their own scores are ignored. A key's fused score is the sum over both rankings.
5. The `data` kept for a key is the one from the first ranking that held it, the lexical one first; when that `data` is `null` or `undefined`, the `data` of the next ranking that holds the key replaces it.
6. The fused results are sorted by score, highest first, then by key in ascending code-unit order, cut to `topK`, and returned as `{ data, score }` with the fused score.

## Logging

Each factory calls `logger.child({ component: 'victor' })` once and writes only `debug` records to that child ([`src/lib/lexical.ts`](src/lib/lexical.ts), [`src/lib/vector.ts`](src/lib/vector.ts), [`src/lib/hybrid.ts`](src/lib/hybrid.ts)). The records carry counts only, never `data`, texts, queries or embeddings: `entryCount` (entries stored), `topK` (`undefined` when it is not a finite number), `dimensions` (vector index) and `resultCount`. A failure is logged and the original error is rethrown unchanged. The runtime checks only that the logger has `debug` and `child` functions; the type asks for a pino `Logger`.

Each record is written as `debug(fields, message)`:

- `created` carries `{}` (lexical index, hybrid search) or `{ dimensions }` (vector index).
- `add started`, `add completed` and `add failed` carry `entryCount`, read when the record is written, and `dimensions` for the vector index.
- `search started` and `search failed` carry `entryCount` (indexes only, read when the search starts), `topK`, and `dimensions` (vector index). `search completed` carries the same fields plus `resultCount`.
- Hybrid search records carry only `topK`, plus `resultCount` on `hybrid search completed`.

| Factory              | Messages                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createLexicalIndex` | `lexical index created`; `lexical index add started`, `… completed`, `… failed`; `lexical index search started`, `… completed`, `… failed`       |
| `createVectorIndex`  | `vector database created`; `vector database add started`, `… completed`, `… failed`; `vector database search started`, `… completed`, `… failed` |
| `createHybridSearch` | `hybrid search created`; `hybrid search started`, `hybrid search completed`, `hybrid search failed`                                              |

## Errors

Every error Victor raises itself is a `TypeError` with the message `Invalid <subject> <detail>.`, where the subject is `lexical index`, `vector index` or `hybrid search` ([`src/lib/utils/validation.ts`](src/lib/utils/validation.ts) builds the message; [`src/lib/lexical.ts`](src/lib/lexical.ts), [`src/lib/vector.ts`](src/lib/vector.ts) and [`src/lib/hybrid.ts`](src/lib/hybrid.ts) raise the subject-specific ones). Option errors are thrown synchronously by the factory; every other error rejects the promise of `add` or `search`. Errors from `transform`, `embedding`, `key` (when it throws) and the hybrid sources propagate unchanged.

| Subject         | Detail                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any             | `logger: expected an object with debug and child functions`; `topK: expected a nonnegative safe integer`                                                                                                                                                                                                                           |
| `lexical index` | `transform: expected a function`; `transform result: expected a string`; `transform result: expected searchable text`                                                                                                                                                                                                              |
| `vector index`  | `dimensions: expected a positive safe integer`; `embedding: expected a function`; `transform: expected a function`; `transform result: expected a string`; `embedding result: expected an array with <dimensions> dimensions`; `embedding result: expected only finite numbers`; `embedding result: expected a non-zero magnitude` |
| `hybrid search` | `lexical: expected a search source`; `semantic: expected a search source`; `key: expected a function`; `key result: expected a non-empty string`                                                                                                                                                                                   |

## Limits

- Everything is held in memory: the caller's values, one posting per distinct term of each lexical entry, and `D` numbers per vector entry. Nothing is written to disk and nothing is sent over the network; the only external calls are the injected embedding function and the logger ([`src/lib/lexical.ts`](src/lib/lexical.ts), [`src/lib/vector.ts`](src/lib/vector.ts)).
- Lexical search keeps a score accumulator proportional to the entries that match the query terms; the bounded heap limits the retained results, not that accumulator ([`src/lib/lexical.ts`](src/lib/lexical.ts)).
- Vector search is a linear scan of every entry on each query ([`src/lib/vector.ts`](src/lib/vector.ts)).

## Build and test

| Target      | Command                   | What it does                                                                                                                                                                                |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | `npx nx build victor`     | Compiles `src/` with [`tsconfig.lib.json`](tsconfig.lib.json) into `dist/`; inferred by the `@nx/js/typescript` plugin of [`nx.json`](../../nx.json)                                        |
| `typecheck` | `npx nx typecheck victor` | Type-checks the project; inferred by the same plugin                                                                                                                                        |
| `test`      | `npx nx test victor`      | Compiles `src/` and `tests/` with [`tsconfig.spec.json`](tsconfig.spec.json) into `dist-tests/`, then runs `node --test` on the compiled `tests/*.test.js` ([`project.json`](project.json)) |
| `benchmark` | `npx nx benchmark victor` | Builds, then runs [`benchmarks/search.mjs`](benchmarks/search.mjs) with `node --expose-gc`; not cached                                                                                      |

The tests in [`tests/`](tests) cover the lexical index, the vector index and the hybrid search, and use Node's test runner; they make no timing assertions.

### Benchmark

[`benchmarks/search.mjs`](benchmarks/search.mjs) measures the lexical and vector indexes on seeded synthetic data (a linear congruential generator, seed 42) at 1,000 and 10,000 documents, with 384 dimensions and `topK = 10`. Vectors are generated before timing and the embedding function only looks them up, so the figures leave out model, network and provider latency. For each size it times the construction of each index and four workloads: selective, common-term and missing-term lexical queries, and vector queries. Each workload runs 20 warm-up searches, then 100 measured ones (20 queries, 5 rounds).

The output is JSON Lines: a first line with the environment (Node version, CPU model, parameters, whether explicit garbage collection is available), then one line per size with the construction times, the retained heap of both indexes measured around explicit garbage collection, and, per workload, the median and p95 latency in milliseconds and a SHA-256 checksum of the ranked document ids. The heap figure is approximate and is not a peak allocation count.

The script takes an optional path to another compiled `index.js` and runs the same workload against it, so two builds can be compared in separate processes on the same idle machine; equal ranking checksums show that both rank alike. Run `npx nx build victor` first: without a path, the script imports `../dist/index.js`, relative to itself.

```sh
node --expose-gc packages/victor/benchmarks/search.mjs /path/to/other/dist/index.js
node --expose-gc packages/victor/benchmarks/search.mjs
```

The figures depend on the machine and the synthetic workload; they are no production latency guarantee.
