import type {
  LexicalIndexOptions,
  SearchIndex,
  SearchResult,
} from './types/search.js';
import { invalid, validateLogger, validateTopK } from './utils/validation.js';

type Entry<Data> = {
  readonly data: Data;
  readonly frequencies: ReadonlyMap<string, number>;
  readonly length: number;
  readonly index: number;
};

type ScoreContext = {
  readonly query: ReadonlySet<string>;
  readonly documentFrequencies: ReadonlyMap<string, number>;
  readonly documents: number;
  readonly averageLength: number;
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

const score = <Data>(entry: Entry<Data>, context: ScoreContext): number => {
  let total = 0;

  for (const term of context.query) {
    const count = entry.frequencies.get(term);
    const documentFrequency = context.documentFrequencies.get(term);

    if (count === undefined || documentFrequency === undefined) {
      continue;
    }

    total +=
      idf(context.documents, documentFrequency) *
      termScore(count, entry.length, context.averageLength);
  }

  return total;
};

/** Creates an in-memory lexical index ranked with BM25. */
export const createLexicalIndex = <Data = unknown>(
  options: LexicalIndexOptions,
): SearchIndex<Data> => {
  const parentLogger = options?.logger;

  validateLogger(parentLogger, 'lexical index');

  const logger = parentLogger.child({ component: 'victor' });
  const entries: Entry<Data>[] = [];
  const documentFrequencies = new Map<string, number>();
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

        for (const term of counts.keys()) {
          documentFrequencies.set(
            term,
            (documentFrequencies.get(term) ?? 0) + 1,
          );
        }

        entries.push({
          data,
          frequencies: counts,
          length: terms.length,
          index: entries.length,
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

        const context = {
          query: queryTerms,
          documentFrequencies,
          documents: entries.length,
          averageLength,
        };

        const results = entries
          .map((entry) => ({
            data: entry.data,
            index: entry.index,
            score: score(entry, context),
          }))
          .filter((entry) => entry.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.index - right.index,
          )
          .slice(0, topK)
          .map(({ data, score: relevance }) => ({ data, score: relevance }));

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
