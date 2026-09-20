# Victor

Process-local, in-memory lexical, vector, and hybrid retrieval. The public
entrypoint exports `createLexicalIndex`, `createVectorIndex`, and
`createHybridSearch`. Embedding generation and the logger are injected by the
caller; Victor has no provider integration or persistence.

## Retrieval

- **Lexical:** Unicode NFKC normalization, lowercase letter/number tokenization,
  and BM25 (`k1 = 1.2`, `b = 0.75`). An inverted index stores document references
  and term frequencies. Queries visit only matching postings and compute each
  term's IDF once using the current corpus statistics.
- **Vector:** dense, finite, non-zero embeddings are copied and normalized once
  when added. A query is normalized once, then compared with stored vectors
  through dot products. Scaling before normalization avoids overflow and
  underflow for extreme finite magnitudes. Search remains exact, not approximate.
- **Selection:** lexical and vector searches retain their best `K` candidates
  with a bounded heap, then sort those results. Equal scores preserve insertion
  order, including when lexical postings visit documents in a different order.
- **Hybrid:** both sources are queried concurrently, bounded rankings are fused
  with equal-weight reciprocal rank fusion (`k = 60`), and canonical keys
  deduplicate results and break ties.

The vector scan costs `O(N × D)` for `N` stored vectors of dimension `D`.
Selection costs `O(N log K + K log K)` and retains at most `K` candidates.
Lexical scoring visits the queried posting lists, accumulates scores for their
matching documents, and applies the same bounded selection to those matches.
It still needs a per-query score accumulator proportional to the matching
documents; the heap does not make that accumulator constant-space.

## Validation

```sh
npx nx run-many -t build,typecheck,test -p victor
```

## Reproducible benchmark

```sh
npx nx benchmark victor
```

The benchmark uses seeded synthetic documents and vectors at 1,000 and 10,000
documents, 384 dimensions, and `topK = 10`. It measures index construction and
selective, common-term, missing-term, and vector queries after warmup. Output is
JSON Lines containing the environment, median and p95 latency, ranking checksums,
and an approximate combined retained-heap delta after explicit garbage
collection. Memory measurements are noisy and are not peak allocation counts.

Vectors are generated before timing. The injected embedding function only
returns those vectors, so these measurements deliberately exclude model,
network, and provider latency. Each workload has 20 warmup searches and 100
measured searches. There are no timing assertions in the test suite.

To compare against a previous implementation, save that version's compiled
`dist` directory before rebuilding, then run the same harness against each
entrypoint in separate processes:

```sh
node --expose-gc packages/victor/benchmarks/search.mjs /path/to/baseline/index.js
node --expose-gc packages/victor/benchmarks/search.mjs
```

Compare ranking checksums as well as latency. Repeat runs on the same idle
machine; synthetic results are not a production latency guarantee. Small
collections, broad lexical queries, and `K` near the corpus size may benefit
less than selective queries or small `K`.

### Measured lexical improvement

Local comparison on Node 24.16.0 / Apple M5 Pro, using the workload above and
the median of three independent process runs. The baseline is the compiled
pre-inverted-index implementation; **both sides already use the optimized
vector index**, so this comparison isolates the lexical changes.

| 10,000 documents, K = 10   | Before (median ms) | After (median ms) |
| -------------------------- | -----------------: | ----------------: |
| Selective lexical query    |           0.319500 |          0.009667 |
| Common-term lexical query  |           0.890708 |          0.473500 |
| Missing-term lexical query |           0.288375 |          0.000334 |

Selective and common-term queries improved approximately 33× and 1.9× in this
fixture. Missing-term timings are close to timer/dispatch overhead and should
not be interpreted as a precise speedup ratio. Lexical construction measured
11.552 ms before versus 11.404 ms after; combined retained heap measured
29.43 MiB versus 29.27 MiB. Those small differences are not evidence of a
meaningful indexing or memory improvement.

All benchmark ranking checksums matched. A separate seeded differential check
compared 640 lexical result sets over incremental corpus updates and multiple
query lengths and limits; IDs, order, and scores matched exactly. Neither
the synthetic workload nor these measurements establish a production SLA.
