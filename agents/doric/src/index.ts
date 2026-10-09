import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SecretsV1, SettingsV1, StorageV1 } from 'bundle/contracts';
import { createDockerClient, discardWorkspace } from 'docker';
import express from 'express';
import { createFirecrackerClient } from 'firecracker';
import pino from 'pino';
import pretty from 'pino-pretty';
import { createSandbox } from 'sandbox';
import { createSandpool } from 'sandpool';
import { Server as SocketServer } from 'socket.io';

import { createDirectExecutor } from './lib/agents/direct/executor.js';
import { createHostAdapter } from './lib/bundles/adapter.js';
import { bundlePaths, startBundles } from './lib/bundles/boot.js';
import { createHostConfig } from './lib/bundles/configuration.js';
import { connectDatabase } from './lib/bundles/database.js';
import { createConfigService } from './lib/config/service.js';
import { createConfigStore } from './lib/config/store.js';
import { createCredentialService } from './lib/credentials/service.js';
import { createWorkspaceSocket } from './lib/events/socket.js';
import { registerStatusSocket } from './lib/events/status.js';
import { registerHttpRoutes } from './lib/http/app.js';
import { createVmRegistry } from './lib/vms.js';
import { checkStorageHealth } from './lib/workspace/disk.js';
import { createProjectStore } from './lib/workspace/projects.js';
import { readHostResources } from './lib/workspace/resources.js';
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
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);

  startupStage = 'sandbox_pool';
  startup.info({ sandboxProviderName }, 'Configuring sandbox pool');
  const dockerClient =
    sandboxProviderName === 'firecracker' ? undefined : createDockerClient();
  const sandboxProvider = dockerClient ?? createFirecrackerClient();

  const vms = createVmRegistry(sandboxProviderName, sandboxProvider);
  // The image is a deployment choice, so it comes from the environment and
  // defaults to the plain Node image an operator gets without building one. A
  // named local tag that was never built fails the provider's pull instead of
  // silently falling back to that default.
  const sandboxImage = process.env.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm';
  const sandboxResources = {
    cpuCount: 1,
    memoryMiB: sandboxProviderName === 'docker' ? 2048 : 512,
    diskMiB: 4096,
  } as const;
  const poolLimits = {
    // Every acquisition Doric makes names the Project it serves, and the pool
    // provisions a new session for an identified acquisition instead of leasing
    // a warmed one, so warming would only hold capacity Doric cannot use.
    minIdle: 0,
    maxSandboxes: 10,
    maxCreateAttempts: 3,
  } as const;

  const pool = createSandpool({
    ...poolLimits,
    logger,
    create: (identity) =>
      createSandbox({
        provider: vms.provider,
        image: sandboxImage,
        imagePullPolicy: 'if-not-present',
        resources: sandboxResources,
        // The Project id names the durable workspace the sandbox reattaches.
        workspace: identity,
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
  const adapter = createHostAdapter();
  const hostConfig = createHostConfig();
  const bundles = await startBundles({
    ...bundlePaths(process.env, dirname(fileURLToPath(import.meta.url))),
    adapter,
    embedded: [hostConfig.bundle],
    logger,
  });
  startup.info(
    {
      bundleCount: bundles.bundleCount,
      skillCount: bundles.catalog.skills.length,
      toolCount: bundles.catalog.tools.length,
    },
    'Bundles loaded',
  );
  // Bundle activation opens no database, so the client is connected here,
  // through the `postgres` bundle; only a missing URL fails at this stage.
  startupStage = 'database_client';
  startup.info('Initializing PostgreSQL client');
  const database = await connectDatabase(bundles.platform);
  startup.info('PostgreSQL client initialized');
  startupStage = 'credential_activation';
  startup.info('Activating stored credentials');
  const credentials = await createCredentialService({
    secrets: bundles.platform.services.use(SecretsV1),
  });
  // The storage identity is the first query of the storage backend, so it is
  // read in this stage, where the first database round trip always failed.
  await bundles.platform.storageIdentity();
  startupStage = 'configuration_activation';
  startup.info('Activating Doric configuration');
  const config = await createConfigService({
    store: createConfigStore({
      settings: bundles.platform.services.use(SettingsV1),
      definition: hostConfig.definition,
      track: hostConfig.track,
    }),
    credentials,
    catalog: bundles.catalog,
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
  const publisher = createWorkspaceSocket(io, projects, threads, (id) =>
    service.terminals.list(id),
  );
  const service = createWorkspaceService({
    projects,
    threads,
    config,
    credentials,
    pool,
    publisher,
    logger,
    execute: createDirectExecutor({
      call: (scope, signal) => bundles.platform.call({ scope, signal }),
      attach: adapter.attach,
    }),
    checkStorage: () =>
      checkStorageHealth(bundles.platform.services.use(StorageV1)),
    // A durable workspace is the Docker provider's own storage. The Firecracker
    // profile keeps its guest disks per run, so it has no workspace volume to
    // remove yet.
    discardWorkspace: async (identity) => {
      if (dockerClient !== undefined)
        await discardWorkspace(dockerClient, identity);
    },
  });

  // Work the reader asked for and a host interruption left unfinished is work
  // this boot owes them, so every such prompt is taken up before the host starts
  // serving new ones: it comes back on demand, with its own identity, and its
  // prompts queue in the order the log accepted them.
  const resumedPrompts = await service.resumeInterrupted();
  startup.info({ resumedPrompts }, 'Interrupted prompts resumed');
  await service.recoverProjects();
  startup.info('Project sandbox recovery scheduled');

  registerHttpRoutes(app, {
    config,
    credentials,
    logger,
    service,
    readHostResources,
    vms: {
      list: () => vms.list(),
      find: (id) => vms.find(id),
      ssh: (id) => service.sshForVm(id),
    },
  });
  startup.info(
    { socketNamespaces: ['/status', '/projects', '/threads'] },
    'Network interfaces configured',
  );

  // The bundles hear that the host is ready before it accepts any request.
  await bundles.platform.ready();

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
    await io.close();
    await closed;
    await service.dispose();
    // The `postgres` bundle disconnects the client when it deactivates.
    await bundles.platform.stop();
    await pool.dispose();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

main().catch(() => {
  logger.fatal({ stage: startupStage }, 'Doric failed to start');
  logger.flush();
  process.exit(1);
});
