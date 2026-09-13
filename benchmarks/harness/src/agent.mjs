import { readFile } from 'node:fs/promises';

import pino from 'pino';

import { createFetchTransport, createUnifiedProvider } from 'llms';

import { serveAcp } from './acp.mjs';
import { createEventPublisher } from './events.mjs';
import { currentRunner } from './runner.mjs';

const mode = process.argv[2];

if (!['direct', 'mosaic'].includes(mode)) {
  throw new Error('Choose direct or mosaic.');
}

const connection = JSON.parse(
  await readFile('/opt/doric/endpoint.json', 'utf8'),
);
const apiKey = process.env.BENCHFLOW_PROVIDER_API_KEY;

if (!apiKey) {
  throw new Error('BenchFlow proxy credential is required.');
}

for (const name of Object.keys(process.env)) {
  if (
    /key|token|secret|password|credential|authorization|cookie/iu.test(name)
  ) {
    delete process.env[name];
  }
}

const provider = createUnifiedProvider({
  apiKey: () => apiKey,
  baseUrl: connection.baseUrl,
  transport: createFetchTransport(),
  logger: pino({ enabled: false }),
});

await serveAcp({
  mode,
  createRunner: () =>
    currentRunner(mode, {
      profile: { provider },
      publish: createEventPublisher({ baseUrl: connection.baseUrl, apiKey }),
    }),
});
