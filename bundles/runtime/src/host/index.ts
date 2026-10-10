import {
  type Cleanup,
  EventsV1,
  type HostContext,
  type Services,
  type Storage,
  StorageV1,
} from 'bundle/contracts';
import { type TerminalService, TerminalServiceV1 } from 'terminal/contracts';

import { promptFinishedEvent } from '../contracts/events.js';
import { type Bindings, createBindings } from './domain/bindings.js';
import { createNotices } from './domain/notices.js';
import { createRedactor } from './domain/redactor.js';
import { createWorkspaceService } from './domain/service.js';
import { type ProjectResourcesReader, ResourcesV1 } from './peers.js';
import { createPorts, type RuntimePorts } from './ports.js';
import { leaseService } from './services/lease.js';
import { runtimeService } from './services/runtime.js';
import { terminalSessionsService } from './services/terminal-sessions.js';
import { threadsService } from './services/threads.js';
import { usageService } from './services/usage.js';
import { createWatches } from './services/watches.js';
import { workspaceService } from './services/workspace.js';
import {
  createRuntimeStores,
  type ProjectStore,
  type RuntimeStores,
  runtimeStorageTypes,
  type ThreadStore,
} from './store/index.js';

/*
 * The `runtime` bundle's host part (design 57 §4.2): wiring only. Activation
 * does no data work; reconcile and resume run in `runtime/v1.recover()`, which
 * the kernel calls once every bundle is active.
 */

/** The runtime's providers over its stores and ports. */
export const provideRuntime = (
  services: Pick<Services, 'provide'>,
  {
    projects,
    threads,
    ports,
    bindings = createBindings(),
    terminal = () => undefined,
    resources = () => undefined,
  }: {
    readonly projects: ProjectStore;
    readonly threads: ThreadStore;
    readonly ports: RuntimePorts;
    /** The prompt bindings; a test passes its own to observe them. */
    readonly bindings?: Bindings;
    /**
     * The `terminal` bundle's `terminal/v1` while one is active: it owns the
     * terminal sessions since the stage-10 host switch, so the runtime's
     * terminal reads delegate to it; without one, a Project has none.
     */
    readonly terminal?: () => TerminalService | undefined;
    /**
     * The `resources` bundle's `resources/v1` while one is active: the
     * deprecated `runtime.lease/v1.resources` read delegates to it.
     */
    readonly resources?: () => ProjectResourcesReader | undefined;
  },
): Cleanup => {
  const notices = createNotices(ports.log);
  const redactor = createRedactor(ports.storedRedactions);
  const service = createWorkspaceService({
    projects,
    threads,
    ports,
    publisher: notices.publisher,
    redactor,
    bindings,
    terminals: async (projectId) => (await terminal()?.list(projectId)) ?? [],
  });

  // The remote watches read what the transport socket reads (R-STREAM).
  const watches = createWatches({
    notices,
    reads: {
      thread: (threadId) => threads.record(threadId),
      eventsAfter: (threadId, afterSequence) =>
        threads.eventsAfter(threadId, afterSequence),
      project: (projectId) => service.projects.find(projectId),
      projectThreads: (projectId) => threads.listByProject(projectId),
      terminals: async (projectId) => (await terminal()?.list(projectId)) ?? [],
    },
  });

  services.provide(
    runtimeService({
      service,
      notices,
      projects,
      threads,
      log: ports.log,
      watches,
    }),
  );
  services.provide(threadsService({ service, threads, bindings, watches }));
  services.provide(workspaceService(bindings, service));
  services.provide(usageService(service));
  services.provide(leaseService({ service, bindings, resources }));
  services.provide(terminalSessionsService(watches, terminal));

  // Idempotent: the kernel already called runtime/v1.dispose on a normal stop.
  return () => service.dispose();
};

/** The runtime's stores over storage/v1, rewinding through executor/v1. */
export const runtimeStores = (
  storage: Storage,
  ports: Pick<RuntimePorts, 'executor'>,
): RuntimeStores =>
  createRuntimeStores(storage, {
    // The executor's rewind participation, scoped to the rewound prompt.
    executor: {
      rewind: ({ projectId, threadId, ...input }) =>
        ports
          .executor({ projectId, threadId, promptId: input.promptId })
          .rewind(input),
    },
  });

export const activate = ({ services }: HostContext): Cleanup => {
  const storage = services.use(StorageV1);
  for (const type of runtimeStorageTypes) storage.defineType(type);
  services.use(EventsV1).register(promptFinishedEvent);

  const ports = createPorts(services);
  // terminal/v1 is the `terminal` bundle's (stage 10 host switch); it
  // activates after the runtime, whose contracts it requires.
  let terminal: TerminalService | undefined;
  services.whenAvailable(TerminalServiceV1, (api) => {
    terminal = api;
    return () => {
      if (terminal === api) terminal = undefined;
    };
  });

  // resources/v1 is the `resources` bundle's (stage 10 §3.12), which also
  // activates after the runtime.
  let resources: ProjectResourcesReader | undefined;
  services.whenAvailable(ResourcesV1, (api) => {
    resources = api;
    return () => {
      if (resources === api) resources = undefined;
    };
  });

  return provideRuntime(services, {
    ...runtimeStores(storage, ports),
    ports,
    terminal: () => terminal,
    resources: () => resources,
  });
};
