import { defineMethod, defineService } from 'bundle/contracts';

import {
  runtimeTerminalsMethods as methods,
  RuntimeTerminalsV1,
} from '../../contracts/terminals.js';
import type { WorkspaceService } from '../domain/types.js';
import type { Watches } from './watches.js';

/** runtime.terminals/v1: the manual terminal sessions (design 57 §2.6). */
export const terminalsService = (service: WorkspaceService, watches: Watches) =>
  defineService(RuntimeTerminalsV1, {
    list: defineMethod({
      ...methods.list,
      execute: async (projectId) => service.terminals.list(projectId),
    }),
    create: defineMethod({
      ...methods.create,
      execute: ({ threadId, cols, rows }) =>
        service.terminals.create(threadId, cols, rows),
    }),
    snapshot: defineMethod({
      ...methods.snapshot,
      execute: async ({ id, after }) => service.terminals.snapshot(id, after),
    }),
    input: defineMethod({
      ...methods.input,
      execute: ({ id, data }) => service.terminals.input(id, data),
    }),
    resize: defineMethod({
      ...methods.resize,
      execute: ({ id, cols, rows }) => service.terminals.resize(id, cols, rows),
    }),
    stop: defineMethod({
      ...methods.stop,
      execute: (id) => service.terminals.stop(id),
    }),
    watchProject: defineMethod({
      ...methods.watchProject,
      execute: ([projectId, listener]) =>
        watches.terminals(projectId, listener),
    }),
  });
