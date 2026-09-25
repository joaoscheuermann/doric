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

import { createConfigService } from './lib/config/service.js';
import { createConfigStore } from './lib/config/store.js';
import { createDatabase } from './lib/database.js';
import { createWorkspaceSocket } from './lib/events/socket.js';
import { registerStatusSocket } from './lib/events/status.js';
import { registerHttpRoutes } from './lib/http/app.js';
import { createVmRegistry } from './lib/vms.js';
import { createProjectStore } from './lib/workspace/projects.js';
import { createWorkspaceService } from './lib/workspace/service.js';
import { createThreadStore } from './lib/workspace/threads.js';

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
  // The image is a deployment choice, so it comes from the environment and
  // defaults to the plain Node image an operator gets without building one. A
  // named local tag that was never built fails the provider's pull instead of
  // silently falling back to that default.
  const sandboxImage = process.env.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm';
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
  startupStage = 'workspace_reconciliation';
  startup.info('Reconciling persisted projects and threads');
  const projects = createProjectStore(database);
  const threads = createThreadStore(database);
  const interruptedThreads = await threads.reconcile();
  const interruptedProjects = await projects.reconcile();
  const interrupted = { interruptedThreads, interruptedProjects };
  startup.info(interrupted, 'Project and thread reconciliation complete');
  registerStatusSocket(io);
  const publisher = createWorkspaceSocket(io, projects, threads);
  const service = createWorkspaceService({
    projects,
    threads,
    config,
    pool,
    publisher,
    logger,
  });

  registerHttpRoutes(app, {
    config,
    service,
    vms: {
      list: vms.list,
      find: vms.find,
      ssh: service.sshForVm,
    },
  });
  startup.info(
    { socketNamespaces: ['/status', '/projects', '/threads'] },
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
    if (closing) return;
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
