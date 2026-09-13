import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const canonical = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }

  return value;
};

const validVector = (value, dimensions) =>
  Array.isArray(value) &&
  value.length > 0 &&
  (dimensions === undefined || value.length === dimensions) &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item));

const readVector = async (path, dimensions) => {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));

    return validVector(value, dimensions) ? value : undefined;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return;
    }

    throw error;
  }
};

const storeVector = async (path, vector) => {
  const temporary = path + '.' + randomUUID() + '.tmp';

  try {
    await writeFile(temporary, JSON.stringify(vector), {
      flag: 'wx',
      mode: 0o600,
    });

    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Persist successful single-text embeddings; never cache other provider operations. */
export const createEmbeddingCache =
  ({ directory, fetcher }) =>
  async (url, options) => {
    if (!url.endsWith('/embeddings')) {
      return fetcher(url, options);
    }

    const input = JSON.parse(options.body);

    if (
      typeof input.input !== 'string' ||
      ![undefined, 'float'].includes(input.encoding_format)
    ) {
      return fetcher(url, options);
    }

    const key = createHash('sha256')
      .update(JSON.stringify(['embedding-v1', url, canonical(input)]))
      .digest('hex');
    const path = join(directory, key + '.json');
    const cached = await readVector(path, input.dimensions);

    if (cached) {
      return Response.json(
        {
          object: 'list',
          model: input.model,
          data: [{ object: 'embedding', index: 0, embedding: cached }],
          usage: { prompt_tokens: 0, total_tokens: 0, cost: 0 },
        },
        { headers: { 'x-doric-embedding-cache': 'hit' } },
      );
    }

    const response = await fetcher(url, options);
    const vector = await extractVector(response, input.dimensions);

    if (vector) {
      await mkdir(directory, { recursive: true });

      await storeVector(path, vector);
    }

    return response;
  };

const extractVector = async (response, dimensions) => {
  if (response.status !== 200) {
    return;
  }

  try {
    const { data } = await response.clone().json();

    if (!Array.isArray(data) || data.length !== 1) {
      return;
    }

    const vector = data[0]?.embedding;

    return validVector(vector, dimensions) ? vector : undefined;
  } catch {
    return;
  }
};
