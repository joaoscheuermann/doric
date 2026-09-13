import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { createEmbeddingCache } from './embedding-cache.mjs';

const routes = new Set([
  'POST /api/v1/chat/completions',
  'POST /api/v1/embeddings',
  'POST /api/v1/rerank',
  'GET /api/v1/models',
  'POST /api/v1/events',
]);

const authenticated = (request, token) => {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const readInput = async (request) => {
  if (request.method === 'GET') {
    return {};
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 8 * 1024 * 1024) {
      return { error: 413 };
    }

    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  let input;

  try {
    input = JSON.parse(body);
  } catch {
    return { error: 400 };
  }

  return { body, input };
};

const validEvent = (event) =>
  ['runId', 'agent', 'stage', 'at'].every(
    (key) => typeof event?.[key] === 'string',
  ) &&
  Number.isSafeInteger(event.sequence) &&
  event.sequence > 0 &&
  Object.hasOwn(event, 'data');

const validProviderInput = (request, input, allowed) =>
  request.method === 'GET' || (allowed.has(input?.model) && !input.stream);

const reportedUsage = (bytes) => {
  try {
    return JSON.parse(Buffer.from(bytes).toString()).usage ?? null;
  } catch {
    return null;
  }
};

/** Serve one immutable archive and an authenticated multi-model OpenRouter gateway. */
export const startGateway = async ({
  archive,
  eventsPath,
  embeddingCacheDirectory,
  token,
  models,
  apiKey,
  fetcher = fetch,
  host = '0.0.0.0',
}) => {
  const allowed = new Set(models);
  const usage = [];
  const shutdown = new AbortController();

  const providerFetch = embeddingCacheDirectory
    ? createEmbeddingCache({ directory: embeddingCacheDirectory, fetcher })
    : fetcher;
  let writes = Promise.resolve();

  const ingest = async (request, response) => {
    const { input, error } = await readInput(request);

    if (error || !validEvent(input)) {
      response.writeHead(error ?? 400).end();

      return;
    }

    writes = writes.then(() =>
      appendFile(eventsPath, JSON.stringify(input) + '\n'),
    );

    await writes;

    response.writeHead(204).end();
  };

  const forward = async (request, response) => {
    const { input, body, error } = await readInput(request);

    if (error) {
      response.writeHead(error).end();

      return;
    }

    if (!validProviderInput(request, input, allowed)) {
      response.writeHead(400).end();

      return;
    }

    const entry = input
      ? {
          model: input.model,
          operation: request.url.split('/').at(-1),
          status: null,
          usage: null,
        }
      : undefined;

    if (entry) {
      usage.push(entry);
    }

    const disconnected = new AbortController();

    response.once('close', () => disconnected.abort());

    const upstream = await providerFetch(
      'https://openrouter.ai' + request.url,
      {
        method: request.method,
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.any([
          shutdown.signal,
          disconnected.signal,
          AbortSignal.timeout(15 * 60_000),
        ]),
      },
    );
    const bytes = await upstream.arrayBuffer();

    if (entry) {
      Object.assign(entry, {
        status: upstream.status,
        usage: reportedUsage(bytes),
        ...cacheUsage(request.url, upstream),
      });
    }

    response.writeHead(upstream.status, {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
    });

    response.end(Buffer.from(bytes));
  };

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/agent.tar.gz') {
      response.writeHead(200, { 'content-type': 'application/gzip' });

      createReadStream(archive)
        .on('error', () => response.destroy())
        .pipe(response);

      return;
    }

    if (!authenticated(request, token)) {
      response.writeHead(401).end();

      return;
    }

    if (!routes.has(request.method + ' ' + request.url)) {
      response.writeHead(404).end();

      return;
    }

    const handle = request.url === '/api/v1/events' ? ingest : forward;

    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502);
      }

      response.end('Gateway request failed.');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(0, host, resolve);
  });

  return {
    port: server.address().port,
    usage,
    close: async () => {
      shutdown.abort();

      server.closeAllConnections();

      await new Promise((resolve) => server.close(resolve));

      await writes.catch(() => {});
    },
  };
};

const cacheUsage = (url, response) =>
  url === '/api/v1/embeddings'
    ? { cache: response.headers.get('x-doric-embedding-cache') ?? 'miss' }
    : {};
