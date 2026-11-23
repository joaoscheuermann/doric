import {
  type Cleanup,
  EventsV1,
  HooksV1,
  type HostContext,
  type Services,
  type Storage,
  StorageV1,
} from 'bundle/contracts';

import { promptFinishedEvent, threadEventSink } from '../contracts/events.js';
import type { ThreadEvent } from '../contracts/model.js';
import { onEventAppended } from './appends.js';
import type { ArchiveSchedule } from './domain/archiver.js';
import { type Bindings, createBindings } from './domain/bindings.js';
import { createNotices, type Notices } from './domain/notices.js';
import { createRedactor } from './domain/redactor.js';
import { createWorkspaceService } from './domain/service.js';
import type { WorkspaceService } from './domain/types.js';
import { installHandover } from './handover.js';
import {
  createLifecycle,
  installStartStop,
  type RuntimeLifecycle,
} from './lifecycle.js';
import { CoreEventHooksV1 } from './peers.js';
import { createPorts, type RuntimePorts } from './ports.js';
import { attachmentsService } from './services/attachments.js';
import { leaseService } from './services/lease.js';
import { runtimeService } from './services/runtime.js';
import { threadsService } from './services/threads.js';
import { usageService } from './services/usage.js';
import { createWatches, type Watches } from './services/watches.js';
import { workspaceService } from './services/workspace.js';
import type { AttachmentStore } from './store/attachments.js';
import {
  createRuntimeStores,
  type ProjectStore,
  type RuntimeStores,
  runtimeStorageTypes,
  type ThreadStore,
} from './store/index.js';

/*
 * The `runtime` bundle's host part (design 57 §4.2): wiring only. Activation
 * does no data work; the reconcile and resume run in the start step
 * (lifecycle.ts), once every bundle is active.
 */

/** What `provideRuntime` made: its cleanup and the lifecycle the hooks drive. */
export interface RuntimeProvision {
  readonly cleanup: Cleanup;
  readonly lifecycle: RuntimeLifecycle;
}

/** What `provideRuntime` builds before it provides anything; the routed services share it. */
export interface RuntimeCore {
  readonly service: WorkspaceService;
  readonly notices: Notices;
  readonly watches: Watches;
  readonly lifecycle: RuntimeLifecycle;
  readonly bindings: Bindings;
  readonly threads: ThreadStore;
  readonly attachments?: AttachmentStore;
}

/**
 * The workspace service, watches and lifecycle over `stores` and `ports`,
 * built as `provideRuntime` builds them today. No I/O; never throws.
 * `provideRuntime` now calls it and keeps its signature and behavior.
 */
export const createRuntimeCore = ({
  projects,
  threads,
  ports,
  bindings = createBindings(),
  notices: injectedNotices,
  attachments,
  archiveSchedule,
}: {
  readonly projects: ProjectStore;
  readonly threads: ThreadStore;
  readonly attachments?: AttachmentStore;
  readonly ports: RuntimePorts;
  readonly notices?: Notices;
  readonly bindings?: Bindings;
  readonly archiveSchedule?: ArchiveSchedule;
}): RuntimeCore => {
  const notices = injectedNotices ?? createNotices(ports.log);
  const redactor = createRedactor(ports.storedRedactions);
  const service = createWorkspaceService({
    projects,
    threads,
    ports,
    publisher: notices.publisher,
    redactor,
    bindings,
    ...(attachments === undefined ? {} : { attachments }),
    ...(archiveSchedule === undefined ? {} : { archiveSchedule }),
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
    },
  });

  const lifecycle = createLifecycle({
    service,
    threads,
    projects,
    log: ports.log,
  });

  return {
    service,
    notices,
    watches,
    lifecycle,
    bindings,
    threads,
    ...(attachments === undefined ? {} : { attachments }),
  };
};

/** The runtime's providers over its stores and ports. */
export const provideRuntime = (
  services: Pick<Services, 'provide'>,
  {
    projects,
    threads,
    ports,
    bindings = createBindings(),
    notices: injectedNotices,
    attachments,
    archiveSchedule,
  }: {
    readonly projects: ProjectStore;
    readonly threads: ThreadStore;
    /** The images the Threads attached; a test may leave them out. */
    readonly attachments?: AttachmentStore;
    readonly ports: RuntimePorts;
    readonly notices?: Notices;
    /** The prompt bindings; a test passes its own to observe them. */
    readonly bindings?: Bindings;
    /**
     * Arms each archive sweep; the host's unref'd timer without it. A test
     * passes one that never fires and sweeps through the service itself.
     */
    readonly archiveSchedule?: ArchiveSchedule;
  },
): RuntimeProvision => {
  const { service, notices, watches, lifecycle } = createRuntimeCore({
    projects,
    threads,
    ports,
    bindings,
    ...(injectedNotices === undefined ? {} : { notices: injectedNotices }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(archiveSchedule === undefined ? {} : { archiveSchedule }),
  });

  services.provide(runtimeService({ service, notices, watches, lifecycle }));
  services.provide(threadsService({ service, threads, bindings, watches }));
  services.provide(workspaceService(bindings, service));
  services.provide(usageService(service));
  services.provide(leaseService({ service, bindings }));
  if (attachments !== undefined)
    services.provide(attachmentsService({ attachments, threads }));

  // Idempotent: the stop step already disposed it on a normal stop.
  return {
    cleanup: () => service.dispose(),
    lifecycle,
  };
};

/** The runtime's stores over storage/v1, rewinding through executor/v1. */
export const runtimeStores = (
  storage: Storage,
  ports: Pick<RuntimePorts, 'executor'>,
  publish?: (event: ThreadEvent) => void,
): RuntimeStores =>
  createRuntimeStores(storage, {
    // The executor's rewind participation, scoped to the rewound prompt.
    executor: {
      rewind: ({ projectId, threadId, ...input }) =>
        ports
          .executor({ projectId, threadId, promptId: input.promptId })
          .rewind(input),
    },
    ...(publish !== undefined ? { publish } : {}),
  });

export const activate = ({ services }: HostContext): Cleanup => {
  const storage = services.use(StorageV1);
  for (const type of runtimeStorageTypes) storage.defineType(type);
  const events = services.use(EventsV1);
  events.register(promptFinishedEvent);
  // The runtime's events land in the Thread logs it owns (see threadEventSink).
  const sink = events.sink(threadEventSink);

  const ports = createPorts(services);
  const notices = createNotices(ports.log);
  const stores = runtimeStores(storage, ports, notices.publisher.event);
  const { cleanup, lifecycle } = provideRuntime(services, {
    ...stores,
    notices,
    ports,
  });
  // What other bundles append to a Thread's log through `events/v1` is
  // folded into the Thread and published the moment it is committed, not at
  // the runtime's next write on that Thread.
  const appended = services
    .use(HooksV1)
    .whenAvailable(CoreEventHooksV1, (hooks) => {
      const registration = hooks.onEventAppendedHook(
        onEventAppended(stores.threads),
      );
      return () => registration.dispose();
    });
  // The start and stop steps, and the handover between generation processes.
  const steps = installStartStop({ services, lifecycle });
  const handover = installHandover({ services, lifecycle, log: ports.log });

  return () => {
    handover.dispose();
    steps.dispose();
    appended.dispose();
    sink.dispose();
    return cleanup();
  };
};
