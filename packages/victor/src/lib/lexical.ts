import type {
  LexicalIndexOptions,
  SearchIndex,
  SearchResult,
} from './types/search.js';
import { selectTop } from './utils/top.js';
import { invalid, validateLogger, validateTopK } from './utils/validation.js';

type Entry<Data> = {
  readonly data: Data;
  readonly length: number;
};

type Posting = {
  readonly index: number;
  readonly count: number;
};

const K1 = 1.2;
const B = 0.75;

const tokens = (value: string): string[] =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

const frequencies = (terms: readonly string[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();

  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  return counts;
};

const idf = (documents: number, frequency: number): number =>
  Math.log(1 + (documents - frequency + 0.5) / (frequency + 0.5));

const termScore = (
  count: number,
  documentLength: number,
  averageLength: number,
): number =>
  (count * (K1 + 1)) /
  (count + K1 * (1 - B + B * (documentLength / averageLength)));

/** Creates an in-memory lexical index ranked with BM25. */
export const createLexicalIndex = <Data = unknown>(
  options: LexicalIndexOptions,
): SearchIndex<Data> => {
  const parentLogger = options?.logger;

  validateLogger(parentLogger, 'lexical index');

  const logger = parentLogger.child({ component: 'victor' });
  const entries: Entry<Data>[] = [];
  const postings = new Map<string, Posting[]>();
  let totalLength = 0;

  logger.debug({}, 'lexical index created');

  return {
    async add(data, transform): Promise<void> {
      logger.debug({ entryCount: entries.length }, 'lexical index add started');

      try {
        if (typeof transform !== 'function') {
          throw invalid('lexical index', 'transform: expected a function');
        }

        const text = transform(data);

        if (typeof text !== 'string') {
          throw invalid('lexical index', 'transform result: expected a string');
        }

        const terms = tokens(text);

        if (terms.length === 0) {
          throw invalid(
            'lexical index',
            'transform result: expected searchable text',
          );
        }

        const counts = frequencies(terms);
        const index = entries.length;

        for (const [term, count] of counts) {
          const list = postings.get(term);

          if (list === undefined) {
            postings.set(term, [{ index, count }]);
          } else {
            list.push({ index, count });
          }
        }

        entries.push({
          data,
          length: terms.length,
        });

        totalLength += terms.length;

        logger.debug(
          { entryCount: entries.length },
          'lexical index add completed',
        );
      } catch (error) {
        logger.debug(
          { entryCount: entries.length },
          'lexical index add failed',
        );

        throw error;
      }
    },

    async search(query, topK): Promise<ReadonlyArray<SearchResult<Data>>> {
      const safeTopK = Number.isFinite(topK) ? topK : undefined;
      const fields = { entryCount: entries.length, topK: safeTopK };

      logger.debug(fields, 'lexical index search started');

      try {
        validateTopK(topK, 'lexical index');

        if (topK === 0 || entries.length === 0) {
          logger.debug(
            { ...fields, resultCount: 0 },
            'lexical index search completed',
          );

          return [];
        }

        const queryTerms = new Set(tokens(query));

        if (queryTerms.size === 0) {
          logger.debug(
            { ...fields, resultCount: 0 },
            'lexical index search completed',
          );

          return [];
        }

        const averageLength = totalLength / entries.length;
        const scores = new Map<number, number>();

        for (const term of queryTerms) {
          const list = postings.get(term);

          if (list === undefined) {
            continue;
          }

          const weight = idf(entries.length, list.length);

          for (const { index, count } of list) {
            const contribution =
              weight * termScore(count, entries[index].length, averageLength);
            scores.set(index, (scores.get(index) ?? 0) + contribution);
          }
        }

        // Posting traversal order differs from insertion order across terms.
        const results = selectTop(
          scores,
          topK,
          ([leftIndex, leftScore], [rightIndex, rightScore]) =>
            rightScore - leftScore || leftIndex - rightIndex,
        ).map(([index, score]) => ({ data: entries[index].data, score }));

        logger.debug(
          { ...fields, resultCount: results.length },
          'lexical index search completed',
        );

        return results;
      } catch (error) {
        logger.debug(fields, 'lexical index search failed');

        throw error;
      }
    },
  };
};
