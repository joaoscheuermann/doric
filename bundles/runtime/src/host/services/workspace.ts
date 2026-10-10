import { defineMethod, defineService } from 'bundle/contracts';

import {
  runtimeWorkspaceMethods as methods,
  RuntimeWorkspaceV1,
} from '../../contracts/workspace.js';
import type { Bindings } from '../domain/bindings.js';

/** runtime.workspace/v1: the calling prompt's own working directory. */
export const workspaceService = (bindings: Bindings) =>
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
  });
