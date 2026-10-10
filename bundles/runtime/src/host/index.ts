import {
  type Cleanup,
  EventsV1,
  type HostContext,
  type Services,
  type Storage,
  StorageV1,
} from 'bundle/contracts';

import { promptFinishedEvent } from '../contracts/events.js';
import { type Bindings, createBindings } from './domain/bindings.js';
import { createNotices } from './domain/notices.js';
import { createRedactor } from './domain/redactor.js';
import { createWorkspaceService } from './domain/service.js';
import { createPorts, type RuntimePorts } from './ports.js';
import { leaseService } from './services/lease.js';
import { runtimeService } from './services/runtime.js';
import { terminalService } from './services/terminal.js';
import { terminalsService } from './services/terminals.js';
import { threadsService } from './services/threads.js';
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
  }: {
    readonly projects: ProjectStore;
    readonly threads: ThreadStore;
    readonly ports: RuntimePorts;
    /** The prompt bindings; a test passes its own to observe them. */
    readonly bindings?: Bindings;
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
  });

  services.provide(
    runtimeService({ service, notices, projects, threads, log: ports.log }),
  );
  services.provide(threadsService({ service, threads, bindings }));
  services.provide(workspaceService(bindings));
  services.provide(leaseService({ service, bindings }));
  services.provide(terminalsService(service));
  services.provide(terminalService(bindings));

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

  return provideRuntime(services, {
    ...runtimeStores(storage, ports),
    ports,
  });
};
