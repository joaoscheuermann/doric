import {
  defineMethod,
  defineService,
  type StreamListener,
  type StreamObserver,
  toStreamObserver,
} from 'bundle/contracts';

import {
  legacyRuntimeMethods,
  RuntimeV1,
  RuntimeV2,
  runtimeMethods,
} from '../../contracts/runtime.js';
import type {
  LegacyProjectWatchItem,
  ProjectWatchItem,
} from '../../contracts/watches.js';
import type { Notices } from '../domain/notices.js';
import type { WorkspaceService } from '../domain/types.js';
import type { RuntimeLifecycle } from '../lifecycle.js';
import type { Watches } from './watches.js';

/*
 * runtime/v2 and runtime/v1 (design 57 §2.2, §4.9): Projects, the boot
 * recovery, the host stop and the live notices, one method per
 * WorkspaceService operation. The two differ only in `watchProject`: the
 * runtime/v2 snapshot has no terminals, which runtime.terminals/v1 streams.
 */

interface RuntimeServiceDeps {
  readonly service: WorkspaceService;
  readonly notices: Notices;
  readonly watches: Watches;
  readonly lifecycle: RuntimeLifecycle;
}

/** The methods runtime/v1 and runtime/v2 share: all but `watchProject`. */
const commonMethods = ({
  service,
  notices,
  lifecycle,
}: RuntimeServiceDeps) => ({
  recover: defineMethod({
    ...runtimeMethods.recover,
    execute: () => lifecycle.recover(),
  }),
  recoverWith: defineMethod({
    ...runtimeMethods.recoverWith,
    execute: (handover) => lifecycle.recoverWith(handover),
  }),
  adopt: defineMethod({
    ...runtimeMethods.adopt,
    execute: (handover) => lifecycle.adopt(handover),
  }),
  drain: defineMethod({
    ...runtimeMethods.drain,
    execute: (released) => lifecycle.drain(released),
  }),
  dispose: defineMethod({
    ...runtimeMethods.dispose,
    execute: () => lifecycle.dispose(),
  }),
  createProject: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.createProject,
    execute: ({ name }) => service.projects.create(name),
  }),
  project: defineMethod({
    ...runtimeMethods.project,
    execute: (id) => service.projects.find(id),
  }),
  projects: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.projects,
    execute: ({ limit, cursor }) => service.projects.list(limit, cursor),
  }),
  projectActivity: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.projectActivity,
    execute: () => service.projects.activity(),
  }),
  renameProject: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.renameProject,
    execute: ({ id, name }) => service.projects.rename(id, name),
  }),
  setProjectColor: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.setProjectColor,
    execute: ({ id, color }) =>
      service.projects.setColor(id, color ?? undefined),
  }),
  terminateProject: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.terminateProject,
    execute: (id) => service.projects.terminate(id),
  }),
  deleteProject: defineMethod({
    expose: 'desktop',
    ...runtimeMethods.deleteProject,
    execute: (id) => service.projects.delete(id),
  }),
  vmSsh: defineMethod({
    ...runtimeMethods.vmSsh,
    execute: (vmId) => service.sshForVm(vmId),
  }),
  watch: defineMethod({
    ...runtimeMethods.watch,
    execute: (listener) => notices.watch(listener),
  }),
});

/**
 * A runtime/v1 project watch listener over a runtime/v2 one: each item and
 * the end pass through, the snapshot without its terminals. What the inner
 * listener returns is returned, so a remote rejection still reaches the
 * watch, which settles it.
 */
const withoutTerminals = (
  listener: StreamListener<ProjectWatchItem>,
): StreamObserver<LegacyProjectWatchItem> => {
  const observer = toStreamObserver(listener);

  return {
    next: (item) => {
      if (item.kind !== 'snapshot') return observer.next(item);
      const { terminals: _terminals, ...snapshot } = item;
      return observer.next(snapshot);
    },
    end: (error) => observer.end?.(error),
  };
};

/** runtime/v2: the Project watch streams no terminals. */
export const runtimeService = (deps: RuntimeServiceDeps) =>
  defineService(RuntimeV2, {
    ...commonMethods(deps),
    watchProject: defineMethod({
      expose: 'desktop',
      ...runtimeMethods.watchProject,
      execute: ([input, listener]) =>
        deps.watches.project(input, withoutTerminals(listener)),
    }),
  });

/** runtime/v1 1.3.0; leaves in step 7(c). */
export const legacyRuntimeService = (deps: RuntimeServiceDeps) =>
  defineService(RuntimeV1, {
    ...commonMethods(deps),
    watchProject: defineMethod({
      expose: 'desktop',
      ...legacyRuntimeMethods.watchProject,
      execute: ([input, listener]) => deps.watches.project(input, listener),
    }),
  });
