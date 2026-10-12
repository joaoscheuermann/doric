import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillsV1, ToolsV1 } from 'bundle/contracts';
import express from 'express';
import pino from 'pino';
import pretty from 'pino-pretty';
import { Server as SocketServer } from 'socket.io';

import { installBridge } from './lib/bridge/socket.js';
import {
  assertStructural,
  bundlePaths,
  hostComposition,
  startBundles,
  watchStructural,
} from './lib/bundles/boot.js';
import { createHostConfig } from './lib/bundles/configuration.js';
import { createHostTransport } from './lib/bundles/transport.js';

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
const startupRecord = {
  stage: (name: string) => {
    startupStage = name;
  },
  log: ({
    level,
    fields,
    message,
  }: {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly fields: Readonly<Record<string, unknown>>;
    readonly message: string;
  }) => {
    startup[level](fields, message);
  },
};

const fail = (): never => {
  logger.fatal({ stage: startupStage }, 'Doric failed to start');
  logger.flush();
  process.exit(1);
};

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
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);

  // The enabled bundles build their own pools in the generation process, from
  // their own environment, and log them at their start steps.
  startupStage = 'bundle_load';
  startup.info('Loading bundles');
  const hostConfig = createHostConfig();
  const transport = createHostTransport({ app, io, logger });
  const bundles = await startBundles({
    ...paths,
    composition,
    embedded: [hostConfig.bundle, transport.bundle],
    logger,
    startup: startupRecord,
  });
  const { platform } = bundles;
  transport.bind(platform);

  await assertStructural(platform, startup, required);
  const skills = await platform.services.use(SkillsV1).list();
  startup.info(
    {
      bundleCount: bundles.bundleCount,
      skillCount: skills.length,
      toolCount: platform.services.use(ToolsV1).list().length,
    },
    'Bundles loaded',
  );
  // The bundles' start steps run in activation order, each at its own stage;
  // the storage identity is read after them.
  await platform.start();

  // From here a switch or a respawn is handed over between generation
  // processes by the bundles' own generation hooks.
  const structural = watchStructural(
    platform,
    startup,
    () => {
      logger.flush();
      process.exit(1);
    },
    required,
  );
  // The desktop's bridge to the kernel (HR-1): distribution, artifacts and
  // generation changes of `doric.catalog/v1`, and desktop diagnostics.
  installBridge({
    io,
    platform,
    log: logger.child({ component: 'bridge' }),
  });

  // The bundles hear that the host is ready before it accepts any request.
  await platform.ready();

  startupStage = 'network_binding';
  startup.info({ host, port }, 'Binding HTTP listener');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  startup.info({ host, port, alternatives }, 'Doric listening');
  startupStage = 'ready';

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    structural();
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    await io.close();
    await closed;
    // The stop steps run in reverse activation order, while the other bundles
    // are still active.
    await platform.shutdown();
    // Reverse deactivation: the transport, the generations, the core, and the
    // storage last.
    await platform.stop();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch(fail);
