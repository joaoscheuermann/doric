import type { Cleanup, Services } from 'bundle/contracts';

import { createRuntimeCore } from '../../../src/host/core.js';
import type { ArchiveSchedule } from '../../../src/host/domain/archiver.js';
import {
  type Bindings,
  createBindings,
} from '../../../src/host/domain/bindings.js';
import type { Notices } from '../../../src/host/domain/notices.js';
import type { RuntimeLifecycle } from '../../../src/host/lifecycle.js';
import type { RuntimePorts } from '../../../src/host/ports.js';
import { attachmentsService } from '../../../src/host/services/attachments.js';
import { leaseService } from '../../../src/host/services/lease.js';
import { runtimeService } from '../../../src/host/services/runtime.js';
import { threadsService } from '../../../src/host/services/threads.js';
import { usageService } from '../../../src/host/services/usage.js';
import { workspaceService } from '../../../src/host/services/workspace.js';
import type { AttachmentStore } from '../../../src/host/store/attachments.js';
import type {
  ProjectStore,
  ThreadStore,
} from '../../../src/host/store/types.js';

/*
 * The envelope provision of the runtime's contracts over `RuntimeCore`, for
 * the domain harness (S68d, Q-F1). It moved here from `src/host/index.ts`
 * with the kernel entry, keeping its signature and behavior; it goes with the
 * envelope in phase 6.
 */

/** What `provideRuntime` made: its cleanup and the lifecycle the hooks drive. */
export interface RuntimeProvision {
  readonly cleanup: Cleanup;
  readonly lifecycle: RuntimeLifecycle;
}

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
