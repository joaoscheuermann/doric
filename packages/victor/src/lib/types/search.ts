import type { Logger } from 'pino';

/** Generates a vector for text. */
export type Embedding = (data: string) => Promise<readonly number[]>;

/** One relevance match returned by a search. */
export interface SearchResult<Data = unknown> {
  readonly data: Data;
  readonly score: number;
}

/** Read-only ranked search operations. */
export interface Search<Data = unknown> {
  search(query: string, topK: number): Promise<readonly SearchResult<Data>[]>;
}

/** Incremental in-memory indexing and ranked search operations. */
export type SearchIndex<Data = unknown> = Search<Data> & {
  add(data: Data, transform: (data: Data) => string): Promise<void>;
};

/** Configuration for an in-memory BM25 lexical index. */
export interface LexicalIndexOptions {
  readonly logger: Logger;
}

/** Configuration for an in-memory vector index. */
export interface VectorIndexOptions {
  readonly dimensions: number;
  readonly embedding: Embedding;
  readonly logger: Logger;
}

/** Configuration for rank fusion over lexical and semantic search sources. */
export interface HybridSearchOptions<Data> {
  readonly lexical: Search<Data>;
  readonly semantic: Search<Data>;
  readonly key: (data: Data) => string;
  readonly logger: Logger;
}
