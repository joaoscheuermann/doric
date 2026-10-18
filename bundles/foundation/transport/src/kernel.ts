import type { EmbeddedBundle } from 'bundle';
import {
  AppHooksV1,
  DoricStartupV1,
  HooksV1,
  type HostContext,
  ModelsV1,
  SecretsV1,
  type Services,
  ToolsV1,
} from 'bundle/contracts';
import type { Express } from 'express';
import { FilesV1 } from 'files/contracts';
import { GitCommandsV1 } from 'git/contracts';
import { ConfigurationV1 } from 'host-config/contracts';
import type { Logger } from 'pino';
import { ResourcesV1 } from 'resources/contracts';
import {
  RuntimeLeaseV1,
  RuntimeThreadsV1,
  RuntimeV1,
  SandboxV1,
} from 'runtime/contracts';
import type { Server as SocketServer } from 'socket.io';
import { TerminalServiceV1 } from 'terminal/contracts';
import { UsageV1 } from 'usage/contracts';

import { registerHttpRoutes } from './host/app.js';
import type { TransportServices } from './host/services.js';
import { registerStatusSocket } from './host/sockets/status.js';
import { createTerminalFeed } from './host/sockets/terminal-feed.js';
import { createWorkspaceSocket } from './host/sockets/workspace.js';

export type {
  LeaseScope,
  ProjectScope,
  TransportServices,
} from './host/services.js';

export interface TransportOptions {
  /** Created by the kernel: `express()`. */
  readonly app: Express;
  /** Created by the kernel: `new SocketServer(server)`, default options. */
  readonly io: SocketServer;
  /** The kernel logger; the routes never log secrets. */
  readonly logger?: Logger;
  /**
   * The services the feature routes call (`files/v1`, `git.commands/v1`,
   * `usage/v1`, `resources/v1`, `terminal/v1`): the platform's, as the
   * desktop bridge calls them, so that those bundles stay optional and a
   * disabled or quarantined one never takes the transport with it. Without
   * it, the transport's own services (whose `requires` do not list them).
   */
  readonly features?: () => Pick<Services, 'use'>;
}

/** A stub whose services object is only read at the first call. */
const lazy = <Api extends object>(resolve: () => Api): Api =>
  new Proxy({} as Api, {
    get: (_target, key) => {
      const api = resolve() as Record<PropertyKey, unknown>;
      const member = api[key];
      return typeof member === 'function' ? member.bind(api) : member;
    },
  });

const id = 'transport';
const version = '0.0.0';

/**
 * The contracts the routes and sockets call, every one resolved at call time.
 * The feature contracts the stage-10 routes call are optional and stay out
 * (see `features`): the transport is structural, and a feature bundle must
 * be able to leave the composition without it.
 */
export const transportRequires = [
  'hooks/v1@^1.0.0',
  'runtime/v1@^1.0.0',
  'runtime.threads/v1@^1.0.0',
  'runtime.lease/v1@^1.0.0',
  'sandbox/v1@^1.0.0',
  'tools/v1@^1.0.0',
  'models/v1@^1.0.0',
  'secrets/v1@^1.0.0',
  'host-config/v1@^1.0.0',
] as const;

/**
 * The REST and Socket.IO surface as a kernel-embedded bundle (design 57 §8).
 * It provides no contract: `resources/v1`, which it served in stage 9, is the
 * `resources` bundle's since stage 10. Activation registers the routes and
 * namespaces over lazy stubs and subscribes the workspace socket to each
 * `runtime/v1` and `terminal/v1` provider as it becomes available, so nothing
 * here calls the generation while it is not running yet.
 */
export const createTransport = (options: TransportOptions) =>
  ({
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
        const features = () => options.features?.() ?? services;
        const transport: TransportServices = {
          runtime: services.use(RuntimeV1),
          threads: services.use(RuntimeThreadsV1),
          // A lease read binds the request's Project or Thread as call scope.
          lease: (scope) => services.use(RuntimeLeaseV1, scope),
          // The feature bundles, resolved per request (stage 10 §4).
          files: (scope) => features().use(FilesV1, scope),
          git: (scope) => features().use(GitCommandsV1, scope),
          usage: lazy(() => features().use(UsageV1)),
          resources: (scope) => features().use(ResourcesV1, scope),
          terminal: lazy(() => features().use(TerminalServiceV1)),
          sandbox: services.use(SandboxV1),
          tools: services.use(ToolsV1),
          models: services.use(ModelsV1),
          secrets: services.use(SecretsV1),
          configuration: services.use(ConfigurationV1),
        };

        registerStatusSocket(options.io);
        const terminals = createTerminalFeed();
        const listener = createWorkspaceSocket(
          options.io,
          {
            thread: (threadId) => transport.threads.storedThread(threadId),
            eventsAfter: (threadId, afterSequence) =>
              transport.threads.storedEventsAfter({
                id: threadId,
                afterSequence,
              }),
            project: (projectId) => transport.runtime.project(projectId),
            projectThreads: (projectId) =>
              transport.threads.projectThreads(projectId),
            terminals: (projectId) => transport.terminal.list(projectId),
          },
          terminals,
        );
        // The subscriptions returned are tracked by the callback's scope, so
        // they end when that provider leaves.
        const watching = services.whenAvailable(RuntimeV1, (runtime) => {
          runtime.watch(listener);
        });
        const following = services.whenAvailable(
          TerminalServiceV1,
          (terminal) => terminals.attach(terminal),
        );

        registerHttpRoutes(options.app, transport);

        // The namespaces the host listens on, logged before it binds.
        const network = services
          .use(HooksV1)
          .use(AppHooksV1)
          .onHostStartHook(async (_input, call) => {
            await services.use(DoricStartupV1).log(
              {
                level: 'info',
                fields: {
                  socketNamespaces: ['/status', '/projects', '/threads'],
                },
                message: 'Network interfaces configured',
              },
              call,
            );
          });

        return () => {
          network.dispose();
          following.dispose();
          watching.dispose();
        };
      },
    },
  }) satisfies EmbeddedBundle;
