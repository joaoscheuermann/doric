import type {
  Embedding,
  SearchIndex,
  SearchResult,
  VectorIndexOptions,
} from './types/search.js';
import { selectTop } from './utils/top.js';
import { invalid, validateLogger, validateTopK } from './utils/validation.js';

type Entry<Data> = {
  readonly data: Data;
  readonly embedding: ReadonlyArray<number>;
};

type Magnitude = {
  readonly scale: number;
  readonly norm: number;
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

const normalize = (
  value: unknown,
  dimensions: number,
): ReadonlyArray<number> => {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw invalidVector(
      `embedding result: expected an array with ${dimensions} dimensions`,
    );
  }

  // Copy first so sparse arrays are validated as undefined entries.
  const vector = [...value];

  if (
    !vector.every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry),
    )
  ) {
    throw invalidVector('embedding result: expected only finite numbers');
  }

  const magnitude = magnitudeOf(vector);

  if (magnitude === undefined) {
    throw invalidVector('embedding result: expected a non-zero magnitude');
  }

  // Divide in stages: scale * norm can overflow for valid finite inputs.
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index] / magnitude.scale / magnitude.norm;
  }

  return vector;
};

const cosine = (
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number => {
  let score = 0;

  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }

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
  const embed = async (data: string): Promise<ReadonlyArray<number>> =>
    normalize(await embedding(data), dimensions);

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

        const embedding = await embed(text);

        entries.push({ data, embedding });

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

        const embedding = await embed(query);

        function* candidates() {
          for (let index = 0; index < entries.length; index += 1) {
            yield { index, score: cosine(entries[index].embedding, embedding) };
          }
        }

        const results = selectTop(
          candidates(),
          topK,
          (left, right) => right.score - left.score || left.index - right.index,
        ).map(({ index, score }) => ({ data: entries[index].data, score }));

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
