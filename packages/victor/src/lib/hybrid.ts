import type {
  HybridSearchOptions,
  Search,
  SearchResult,
} from './types/search.js';
import { invalid, validateLogger, validateTopK } from './utils/validation.js';

type Fused<Data> = SearchResult<Data> & {
  readonly key: string;
};

type Fusion<Data> = {
  readonly lexical: readonly SearchResult<Data>[];
  readonly semantic: readonly SearchResult<Data>[];
  readonly key: (data: Data) => string;
  readonly topK: number;
};

const RRF_K = 60;

const validateSearch = (value: unknown, name: string): void => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { search?: unknown }).search !== 'function'
  ) {
    throw invalid('hybrid search', `${name}: expected a search source`);
  }
};

const addRanking = <Data>(
  fused: Map<string, Fused<Data>>,
  ranking: readonly SearchResult<Data>[],
  keyOf: (data: Data) => string,
): void => {
  const seen = new Set<string>();

  ranking.forEach(({ data }, index) => {
    const key = keyOf(data);

    if (typeof key !== 'string' || key.length === 0) {
      throw invalid('hybrid search', 'key result: expected a non-empty string');
    }

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const current = fused.get(key);
    const score = (current?.score ?? 0) + 1 / (RRF_K + index + 1);

    fused.set(key, { data: current?.data ?? data, key, score });
  });
};

const fuse = <Data>({
  lexical,
  semantic,
  key,
  topK,
}: Fusion<Data>): ReadonlyArray<SearchResult<Data>> => {
  const fused = new Map<string, Fused<Data>>();

  addRanking(fused, lexical.slice(0, topK), key);

  addRanking(fused, semantic.slice(0, topK), key);

  return [...fused.values()]
    .sort(
      (left, right) => right.score - left.score || compare(left.key, right.key),
    )
    .slice(0, topK)
    .map(({ data, score }) => ({ data, score }));
};

/** Creates a read-only hybrid search that fuses lexical and semantic ranks. */
export const createHybridSearch = <Data = unknown>(
  options: HybridSearchOptions<Data>,
): Search<Data> => {
  const lexical = options?.lexical;
  const semantic = options?.semantic;
  const key = options?.key;
  const parentLogger = options?.logger;

  validateSearch(lexical, 'lexical');

  validateSearch(semantic, 'semantic');

  if (typeof key !== 'function') {
    throw invalid('hybrid search', 'key: expected a function');
  }

  validateLogger(parentLogger, 'hybrid search');

  const logger = parentLogger.child({ component: 'victor' });

  logger.debug({}, 'hybrid search created');

  return {
    async search(query, topK): Promise<ReadonlyArray<SearchResult<Data>>> {
      const safeTopK = Number.isFinite(topK) ? topK : undefined;
      const fields = { topK: safeTopK };

      logger.debug(fields, 'hybrid search started');

      try {
        validateTopK(topK, 'hybrid search');

        if (topK === 0) {
          logger.debug(
            { ...fields, resultCount: 0 },
            'hybrid search completed',
          );

          return [];
        }

        const rankings = await Promise.all([
          lexical.search(query, topK),
          semantic.search(query, topK),
        ]);

        const results = fuse({
          lexical: rankings[0],
          semantic: rankings[1],
          key,
          topK,
        });

        logger.debug(
          { ...fields, resultCount: results.length },
          'hybrid search completed',
        );

        return results;
      } catch (error) {
        logger.debug(fields, 'hybrid search failed');

        throw error;
      }
    },
  };
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
