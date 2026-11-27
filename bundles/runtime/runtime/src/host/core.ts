import type { Storage } from 'bundle/contracts';

import type { ThreadEvent } from '../contracts/model.js';
import type { ArchiveSchedule } from './domain/archiver.js';
import { type Bindings, createBindings } from './domain/bindings.js';
import { createNotices, type Notices } from './domain/notices.js';
import { createRedactor } from './domain/redactor.js';
import { createWorkspaceService } from './domain/service.js';
import type { WorkspaceService } from './domain/types.js';
import { createLifecycle, type RuntimeLifecycle } from './lifecycle.js';
import type { RuntimePorts } from './ports.js';
import { createWatches, type Watches } from './services/watches.js';
import type { AttachmentStore } from './store/attachments.js';
import {
  createRuntimeStores,
  type ProjectStore,
  type RuntimeStores,
  type ThreadStore,
} from './store/index.js';

/*
 * The `runtime` bundle's core (design 57 §4.2): the workspace service, its
 * watches and lifecycle, and the stores they run over. The routed services
 * (service.ts, rpc/) share it; it does no data work and provides nothing.
 */

/** What `createRuntimeCore` builds; the routed services share it. */
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
 * The workspace service, watches and lifecycle over `stores` and `ports`.
 * No I/O; never throws.
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
