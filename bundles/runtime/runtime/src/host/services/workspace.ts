import { defineMethod, defineService } from 'bundle/contracts';

import {
  runtimeWorkspaceMethods as methods,
  RuntimeWorkspaceV1,
} from '../../contracts/workspace.js';
import type { Bindings } from '../domain/bindings.js';
import type { WorkspaceService } from '../domain/types.js';

/**
 * runtime.workspace/v1: the calling prompt's own working directory, from
 * 1.1.0 local tasks on a named live Thread and, from 1.2.0, its location.
 */
export const workspaceService = (
  bindings: Bindings,
  service: WorkspaceService,
) =>
  defineService(RuntimeWorkspaceV1, {
    cwd: defineMethod({
      ...methods.cwd,
      execute: async (_input, call) =>
        bindings.bound(call).host.workspace.cwd(),
    }),
    setCwd: defineMethod({
      ...methods.setCwd,
      execute: (path, call) => bindings.bound(call).host.workspace.setCwd(path),
    }),
    location: defineMethod({
      ...methods.location,
      execute: async (_input, call) =>
        bindings.bound(call).host.workspace.location(),
    }),
    withThread: defineMethod({
      ...methods.withThread,
      execute: ([threadId, options, task]) =>
        service.threads.withThread(threadId, options, task),
    }),
  });
