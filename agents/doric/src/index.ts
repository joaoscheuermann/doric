import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import pino from 'pino';
import pretty from 'pino-pretty';
import { Server as SocketServer } from 'socket.io';

import { loadBundles } from 'bundle';
import { createDockerClient } from 'docker';
import { createFirecrackerClient } from 'firecracker';
import { createSandbox } from 'sandbox';
import { createSandpool } from 'sandpool';

import { createConfigService } from './lib/config-service.js';
import { createConfigStore } from './lib/config-store.js';
import { createDatabase } from './lib/database.js';
import { handleHttpError } from './lib/http.js';
import { createSessionService } from './lib/session-service.js';
import { createSessionStore } from './lib/sessions.js';
import { createSessionsSocket } from './lib/socket.js';
import { createVmRegistry } from './lib/vms.js';
import { createConfigRouter } from './routes/config.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createVmsRouter } from './routes/vms.js';

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

async function main() {
  const host = process.env.DORIC_HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.DORIC_PORT ?? '3000', 10);

  const sandboxProviderName =
    process.env.DORIC_SANDBOX_PROVIDER === 'firecracker'
      ? 'firecracker'
      : 'docker';
  const sandboxSshEnabled = process.env.DORIC_SANDBOX_SSH === 'true';
  const startup = logger.child({ component: 'startup' });

  startup.info(
    {
      host,
      port,
      sandboxProviderName,
      sshEnabled: sandboxSshEnabled,
    },
    'Doric starting',
  );

  startupStage = 'database_client';

  startup.info('Initializing PostgreSQL client');

  const database = createDatabase(process.env.DORIC_DATABASE_URL ?? '');

  await database.$connect();

  startup.info('PostgreSQL client initialized');

  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);

  startupStage = 'sandbox_pool';

  startup.info({ sandboxProviderName }, 'Configuring sandbox pool');

  const sandboxProvider =
    sandboxProviderName === 'firecracker'
      ? createFirecrackerClient()
      : createDockerClient();
  const vms = createVmRegistry(sandboxProviderName, sandboxProvider);
  const sandboxImage = 'node:22-bookworm';

  const sandboxResources = {
    cpuCount: 1,
    memoryMiB: 512,
    diskMiB: 4096,
  } as const;

  const poolLimits = {
    minIdle: 1,
    maxSandboxes: 10,
    maxCreateAttempts: 3,
  } as const;

  const pool = createSandpool({
    ...poolLimits,
    logger,
    create: () =>
      createSandbox({
        provider: vms.provider,
        image: sandboxImage,
        imagePullPolicy: 'if-not-present',
        resources: sandboxResources,
        network: {
          mode: 'egress',
          ssh: sandboxSshEnabled,
          dnsServers: ['1.1.1.1'],
        },
      }),
  });

  startup.info(
    {
      sandboxProviderName,
      sandboxImage,
      sandboxResources,
      ...poolLimits,
      networkMode: 'egress',
      sshEnabled: sandboxSshEnabled,
    },
    'Sandbox pool configured',
  );

  startupStage = 'bundle_load';

  startup.info('Loading bundles');

  const bundles = await loadBundles(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'bundles'),
  );

  startup.info(
    {
      bundleCount: bundles.length,
      skillCount: bundles.reduce(
        (count, bundle) => count + bundle.skills.length,
        0,
      ),
      toolCount: bundles.reduce(
        (count, bundle) => count + bundle.tools.length,
        0,
      ),
    },
    'Bundles loaded',
  );

  startupStage = 'configuration_activation';

  startup.info('Activating Doric configuration');

  const config = await createConfigService({
    store: createConfigStore(database),
    bundles,
    logger,
  });
  const snapshot = config.current().snapshot;

  startup.info(
    {
      configRevision: snapshot.revision,
      providerCount: snapshot.configuration.providers.length,
      executionModel: snapshot.configuration.models.execution,
      maxTurns: snapshot.configuration.execution.maxTurns,
    },
    'Doric configuration activated',
  );

  startupStage = 'session_reconciliation';

  startup.info('Reconciling persisted sessions');

  const sessions = createSessionStore(database);
  const interrupted = await sessions.reconcile();

  if (interrupted === 0) {
    startup.info({ interruptedSessionCount: interrupted }, 'Sessions ready');
  } else {
    startup.warn(
      { interruptedSessionCount: interrupted },
      'Interrupted sessions marked as failed',
    );
  }

  const publisher = createSessionsSocket(io, sessions);

  const service = createSessionService({
    store: sessions,
    config,
    pool,
    publisher,
    logger,
  });

  app.use(express.json());

  app.use(
    '/vms',
    createVmsRouter({
      list: vms.list,
      find: vms.find,
      ssh: service.sshForVm,
    }),
  );

  app.use('/config', createConfigRouter(config));

  app.use('/sessions', createSessionsRouter(service));

  app.use(handleHttpError);

  startup.info(
    { restEndpointCount: 11, socketNamespace: '/sessions' },
    'Network interfaces configured',
  );

  startupStage = 'network_binding';

  startup.info({ host, port }, 'Binding HTTP listener');

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, host, resolve);
  });

  startup.info(
    { host, port, sandboxProvider: sandboxProviderName, interrupted },
    'Doric listening',
  );

  startupStage = 'ready';

  let closing = false;

  const close = async () => {
    if (closing) {
      return;
    }

    closing = true;

    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );

    io.close();

    await closed;

    await service.dispose();

    await pool.dispose();

    await database.$disconnect();
  };

  process.once('SIGINT', () => void close());

  process.once('SIGTERM', () => void close());
}

main().catch(() => {
  logger.fatal({ stage: startupStage }, 'Doric failed to start');

  logger.flush();

  process.exit(1);
});
