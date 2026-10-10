import type { EmbeddedBundle } from 'bundle';
import {
  type HostContext,
  ModelsV1,
  SecretsV1,
  ToolsV1,
} from 'bundle/contracts';
import type { Express } from 'express';
import type { Logger } from 'pino';
import {
  ConfigurationV1,
  RuntimeLeaseV1,
  RuntimeTerminalsV1,
  RuntimeThreadsV1,
  RuntimeV1,
  SandboxV1,
} from 'runtime/contracts';
import type { Server as SocketServer } from 'socket.io';

import { registerHttpRoutes } from './host/app.js';
import { type HostResources, readHostResources } from './host/resources.js';
import type { TransportServices } from './host/services.js';
import { registerStatusSocket } from './host/sockets/status.js';
import { createWorkspaceSocket } from './host/sockets/workspace.js';

export type { HostResources } from './host/resources.js';
export { cpuPercentBetween, readHostResources } from './host/resources.js';
export type { LeaseScope, TransportServices } from './host/services.js';

export interface TransportOptions {
  /** Created by the kernel: `express()`. */
  readonly app: Express;
  /** Created by the kernel: `new SocketServer(server)`, default options. */
  readonly io: SocketServer;
  /** The kernel logger; the routes never log secrets. */
  readonly logger: Logger;
  /** The host machine reading `GET /resources` answers; the default reads `node:os`. */
  readonly readHostResources?: () => HostResources;
}

const id = 'transport';
const version = '0.0.0';

/** The contracts the routes and sockets call, every one resolved at call time. */
export const transportRequires = [
  'runtime/v1@^1.0.0',
  'runtime.threads/v1@^1.0.0',
  'runtime.lease/v1@^1.0.0',
  'runtime.terminals/v1@^1.0.0',
  'sandbox/v1@^1.0.0',
  'tools/v1@^1.0.0',
  'models/v1@^1.0.0',
  'secrets/v1@^1.0.0',
  'host-config/v1@^1.0.0',
] as const;

/**
 * The REST and Socket.IO surface as a kernel-embedded bundle (design 57 §8).
 * It provides no contract. Activation registers the routes and namespaces
 * over lazy stubs and subscribes the workspace socket to each `runtime/v1`
 * provider as it becomes available, so nothing here calls the generation
 * while it is not running yet.
 */
export const createTransport = (options: TransportOptions): EmbeddedBundle => ({
  manifest: {
    manifestVersion: 1,
    id,
    version,
    engines: { doric: '^1.0.0' },
    description: 'The host REST routes and Socket.IO namespaces.',
    provides: [],
    requires: [...transportRequires],
  },
  descriptor: {
    descriptorVersion: 1,
    bundle: { id, version },
    contracts: [],
  },
  host: {
    activate: ({ services }: HostContext) => {
      const transport: TransportServices = {
        runtime: services.use(RuntimeV1),
        threads: services.use(RuntimeThreadsV1),
        terminals: services.use(RuntimeTerminalsV1),
        // A lease read binds the request's Project or Thread as call scope.
        lease: (scope) => services.use(RuntimeLeaseV1, scope),
        sandbox: services.use(SandboxV1),
        tools: services.use(ToolsV1),
        models: services.use(ModelsV1),
        secrets: services.use(SecretsV1),
        configuration: services.use(ConfigurationV1),
      };

      registerStatusSocket(options.io);
      const listener = createWorkspaceSocket(options.io, {
        thread: (threadId) => transport.threads.storedThread(threadId),
        eventsAfter: (threadId, afterSequence) =>
          transport.threads.storedEventsAfter({ id: threadId, afterSequence }),
        project: (projectId) => transport.runtime.project(projectId),
        projectThreads: (projectId) =>
          transport.threads.projectThreads(projectId),
        terminals: (projectId) => transport.terminals.list(projectId),
      });
      // The subscription returned is tracked by the callback's scope, so it
      // ends when that provider leaves.
      const watching = services.whenAvailable(RuntimeV1, (runtime) => {
        runtime.watch(listener);
      });

      registerHttpRoutes(
        options.app,
        transport,
        options.readHostResources ?? readHostResources,
      );

      return () => {
        watching.dispose();
      };
    },
  },
});
