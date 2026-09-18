import type {
  Embedding,
  SearchIndex,
  SearchResult,
  VectorIndexOptions,
} from './types/search.js';
import { invalid, validateLogger, validateTopK } from './utils/validation.js';

type Entry<Data> = {
  readonly data: Data;
  readonly vector: ReadonlyArray<number>;
  readonly magnitude: Magnitude;
};

type Magnitude = {
  readonly scale: number;
  readonly norm: number;
};

type ScoredEntry<Data> = SearchResult<Data> & {
  readonly index: number;
};

const invalidVector = (message: string): TypeError =>
  invalid('vector index', message);

const magnitudeOf = (vector: ReadonlyArray<number>): Magnitude | undefined => {
  let scale = 0;
  let sum = 0;

  for (const value of vector) {
    const absolute = Math.abs(value);

    if (absolute === 0) {
      continue;
    }

    if (scale < absolute) {
      sum = 1 + sum * (scale / absolute) ** 2;

      scale = absolute;

      continue;
    }

    sum += (absolute / scale) ** 2;
  }

  return scale === 0 ? undefined : { scale, norm: Math.sqrt(sum) };
};

const validateDimensions = (dimensions: number): void => {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw invalidVector('dimensions: expected a positive safe integer');
  }
};

function validateEmbedding(embedding: unknown): asserts embedding is Embedding {
  if (typeof embedding !== 'function') {
    throw invalidVector('embedding: expected a function');
  }
}

const validateVector = (
  value: unknown,
  dimensions: number,
): ReadonlyArray<number> => {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw invalidVector(
      `embedding result: expected an array with ${dimensions} dimensions`,
    );
  }

  if (
    !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  ) {
    throw invalidVector('embedding result: expected only finite numbers');
  }

  const vector = [...value];
  const magnitude = magnitudeOf(vector);

  if (magnitude === undefined) {
    throw invalidVector('embedding result: expected a non-zero magnitude');
  }

  return vector;
};

const cosine = (
  left: ReadonlyArray<number>,
  leftMagnitude: Magnitude,
  right: ReadonlyArray<number>,
  rightMagnitude: Magnitude,
): number => {
  const score = left.reduce(
    (sum, value, index) =>
      sum +
      (value / leftMagnitude.scale / leftMagnitude.norm) *
        (right[index] / rightMagnitude.scale / rightMagnitude.norm),
    0,
  );

  return Math.max(-1, Math.min(1, score));
};

/** Creates an in-memory vector index that embeds stored values and queries. */
export const createVectorIndex = <Data = unknown>(
  options: VectorIndexOptions,
): SearchIndex<Data> => {
  const dimensions = options?.dimensions;
  const embedding = options?.embedding;
  const parentLogger = options?.logger;

  validateDimensions(dimensions);

  validateEmbedding(embedding);

  validateLogger(parentLogger, 'vector index');

  const logger = parentLogger.child({ component: 'victor' });
  const entries: Entry<Data>[] = [];
  const embed = async (data: string): Promise<Entry<Data>['vector']> =>
    validateVector(await embedding(data), dimensions);

  logger.debug({ dimensions }, 'vector database created');

  return {
    async add(data: Data, transform: (data: Data) => string): Promise<void> {
      logger.debug(
        { dimensions, entryCount: entries.length },
        'vector database add started',
      );

      try {
        if (typeof transform !== 'function') {
          throw invalidVector('transform: expected a function');
        }

        const text = transform(data);

        if (typeof text !== 'string') {
          throw invalidVector('transform result: expected a string');
        }

        const vector = await embed(text);
        const magnitude = magnitudeOf(vector);

        if (magnitude === undefined) {
          throw invalidVector(
            'embedding result: expected a non-zero magnitude',
          );
        }

        entries.push({ data, vector, magnitude });

        logger.debug(
          { dimensions, entryCount: entries.length },
          'vector database add completed',
        );
      } catch (error) {
        logger.debug(
          { dimensions, entryCount: entries.length },
          'vector database add failed',
        );

        throw error;
      }
    },

    async search(query, topK): Promise<ReadonlyArray<SearchResult<Data>>> {
      const safeTopK = Number.isFinite(topK) ? topK : undefined;
      const fields = { dimensions, entryCount: entries.length, topK: safeTopK };

      logger.debug(fields, 'vector database search started');

      try {
        validateTopK(topK, 'vector index');

        if (topK === 0 || entries.length === 0) {
          logger.debug(
            { ...fields, resultCount: 0 },
            'vector database search completed',
          );

          return [];
        }

        const vector = await embed(query);
        const magnitude = magnitudeOf(vector);

        if (magnitude === undefined) {
          throw invalidVector(
            'embedding result: expected a non-zero magnitude',
          );
        }

        const results = entries
          .map(
            (entry, index): ScoredEntry<Data> => ({
              data: entry.data,
              score: cosine(entry.vector, entry.magnitude, vector, magnitude),
              index,
            }),
          )
          .sort(
            (left, right) =>
              right.score - left.score || left.index - right.index,
          )
          .slice(0, topK)
          .map(({ data, score }) => ({ data, score }));

        logger.debug(
          { ...fields, resultCount: results.length },
          'vector database search completed',
        );

        return results;
      } catch (error) {
        logger.debug(fields, 'vector database search failed');

        throw error;
      }
    },
  };
};
