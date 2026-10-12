import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelsV1, SecretsV1, SkillsV1, ToolsV1 } from 'bundle/contracts';
import express from 'express';
import pino from 'pino';
import pretty from 'pino-pretty';
import { ConfigurationV1, RuntimeV1 } from 'runtime/contracts';
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
import { connectDatabase } from './lib/bundles/database.js';
import { installHandover } from './lib/bundles/handover.js';
import { createHostTransport } from './lib/bundles/transport.js';
import { createCredentialService } from './lib/credentials/service.js';

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
let startupStage = 'bootstrap';

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
  const startup = logger.child({ component: 'startup' });

  startup.info({ host, port, alternatives }, 'Doric starting');
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);

  // The pool itself is built by the enabled sandbox bundle in the generation
  // process, from its own environment; the kernel names only the chosen
  // alternatives. Its settings are logged by that bundle (BWP-6).
  startupStage = 'sandbox_pool';
  startup.info({ alternatives }, 'Configuring sandbox pool');
  startup.info({ alternatives }, 'Sandbox pool configured');

  startupStage = 'bundle_load';
  startup.info('Loading bundles');
  const hostConfig = createHostConfig();
  const transport = createHostTransport({ app, io, logger });
  const bundles = await startBundles({
    ...paths,
    composition,
    embedded: [hostConfig.bundle, transport.bundle],
    logger,
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
  // Bundle activation opens no database, so the client is connected here,
  // through the `postgres` bundle; a missing URL, or legacy rows the stage-7
  // migration has not moved, fail at this stage.
  startupStage = 'database_client';
  startup.info('Initializing PostgreSQL client');
  await connectDatabase(platform);
  startup.info('PostgreSQL client initialized');
  startupStage = 'credential_activation';
  startup.info('Activating stored credentials');
  await createCredentialService({ secrets: platform.services.use(SecretsV1) });
  // The storage identity is the first query of the storage backend, so it is
  // read in this stage, where the first database round trip always failed.
  await platform.storageIdentity();
  startupStage = 'configuration_activation';
  startup.info('Activating Doric configuration');
  const snapshot = await platform.services.use(ConfigurationV1).current();
  // The providers of the stored configuration are built before any prompt
  // can resolve one, as the host built its first generation here.
  await platform.services.use(ModelsV1).prepare({ ...snapshot });
  startup.info(
    {
      configRevision: snapshot.revision,
      providerCount: snapshot.configuration.providers.length,
      executionModel: snapshot.configuration.models.execution,
      maxTurns: snapshot.configuration.execution.maxTurns,
    },
    'Doric configuration activated',
  );
  // The runtime reconciles, resumes the prompts a host interruption left
  // unfinished and schedules the Project sandboxes, logging each step.
  startupStage = 'workspace_reconciliation';
  startup.info('Reconciling persisted projects and threads');
  const runtime = platform.services.use(RuntimeV1);
  const { interruptedThreads, interruptedProjects } = await runtime.recover();
  const interrupted = { interruptedThreads, interruptedProjects };

  // From here a switch or a respawn hands the Projects over between the
  // runtimes of two generation processes.
  const handover = installHandover({
    generations: platform.generations,
    view: (generation) => platform.view(generation),
    services: platform.services,
    log: startup,
  });
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
  startup.info(
    { socketNamespaces: ['/status', '/projects', '/threads'] },
    'Network interfaces configured',
  );

  // The bundles hear that the host is ready before it accepts any request.
  await platform.ready();

  startupStage = 'network_binding';
  startup.info({ host, port }, 'Binding HTTP listener');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  startup.info({ host, port, alternatives, interrupted }, 'Doric listening');
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
    // Running prompts are suspended while their tool bundles are active.
    await runtime.dispose();
    handover();
    // Reverse deactivation: the transport, the generation (the sandbox pool
    // after the runtime), the core, and `postgres` last, which disconnects
    // the database.
    await platform.stop();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch(fail);
