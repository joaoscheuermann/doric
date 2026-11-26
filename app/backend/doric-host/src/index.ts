import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StartupSink } from 'bundle/platform';
import pino from 'pino';
import pretty from 'pino-pretty';

import {
  bundlePaths,
  hostComposition,
  hostReady,
  startHostPlatform,
} from './lib/bundles/boot.js';

const logger = pino(
  { level: 'debug' },
  pino.multistream([
    { level: 'info', stream: pretty() },
    {
      level: 'debug',
      stream: pino.destination(process.env.DORIC_LOG_FILE ?? 'doric.log'),
    },
  ]),
);
const startup = logger.child({ component: 'startup' });
let startupStage = 'bootstrap';

/**
 * The host's startup record for `doric.startup/v1`: a bundle names the stage a
 * failure is reported at, and logs its flat lines through this process's log.
 */
const startupRecord: StartupSink = {
  stage: (name) => {
    startupStage = name;
  },
  log: ({ level, fields, message }) => {
    startup[level](fields, message);
  },
};

/** Ends the host with `code` once the log is written. */
const exit = (code: number): never => {
  logger.flush();
  process.exit(code);
};

const fail = (): never => {
  logger.fatal({ stage: startupStage }, 'Doric failed to start');

  return exit(1);
};

/** `<host>:<port>`, the IPv6 host in brackets. */
const addressOf = (host: string, port: number): string =>
  `${host.includes(':') ? `[${host}]` : host}:${String(port)}`;

async function main() {
  const host = process.env.DORIC_HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.DORIC_PORT ?? '3000', 10);
  const paths = bundlePaths(
    process.env,
    dirname(fileURLToPath(import.meta.url)),
  );
  const { composition, alternatives, required } = await hostComposition(
    process.env,
    paths.compositionPath,
  );

  startup.info({ host, port, alternatives }, 'Doric starting');

  // Each host part runs in its own process; the platform boots them in
  // activation order, each at its own stage, reads the storage identity, runs
  // the start hooks and binds the public listener (`network_binding`).
  startupStage = 'bundle_load';
  startup.info('Loading bundles');
  const { platform } = await startHostPlatform({
    ...paths,
    composition,
    required,
    publicAddress: addressOf(host, port),
    startup: startupRecord,
    logger,
    exit,
  });

  // The bundles hear that the host is ready once it accepts requests.
  await hostReady(platform, startup);
  startup.info(
    { host, port: platform.publicPort, alternatives },
    'Doric listening',
  );
  startupStage = 'ready';

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    // Closes the public listener, runs the stop hooks and stops every bundle
    // process within the shutdown deadline.
    await platform.shutdown();
    exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch(fail);
