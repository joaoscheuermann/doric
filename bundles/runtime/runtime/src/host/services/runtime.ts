import { defineMethod, defineService } from 'bundle/contracts';

import { RuntimeV1, runtimeMethods } from '../../contracts/runtime.js';
import type { Notices } from '../domain/notices.js';
import type { WorkspaceService } from '../domain/types.js';
import type { RuntimeLifecycle } from '../lifecycle.js';
import type { Watches } from './watches.js';

/*
 * runtime/v1 (design 57 §2.2, §4.9): Projects, the boot recovery, the host
 * stop and the live notices, one method per WorkspaceService operation.
 */
export const runtimeService = ({
  service,
  notices,
  watches,
  lifecycle,
}: {
  readonly service: WorkspaceService;
  readonly notices: Notices;
  readonly watches: Watches;
  readonly lifecycle: RuntimeLifecycle;
}) =>
  defineService(RuntimeV1, {
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
    watchProject: defineMethod({
      expose: 'desktop',
      ...runtimeMethods.watchProject,
      execute: ([input, listener]) => watches.project(input, listener),
    }),
  });
