import { defineMethod, defineService } from 'bundle/contracts';
import type { TerminalService } from 'terminal/contracts';

import {
  runtimeTerminalsMethods as methods,
  RuntimeTerminalsV1,
} from '../../contracts/terminals.js';
import type { WorkspaceService } from '../domain/types.js';
import type { Watches } from './watches.js';

/**
 * runtime.terminals/v1: the manual terminal sessions (design 57 §2.6). Since
 * the stage-10 host switch the sessions are the `terminal` bundle's, so every
 * method delegates to its `terminal/v1` while one is active (G-9), and the
 * desktop windows that still read this contract see the same sessions as the
 * routes. Without a `terminal/v1` provider (a runtime alone, as in its own
 * tests) the runtime's provisional registry answers, as before.
 */
export const terminalsService = (
  service: WorkspaceService,
  watches: Watches,
  terminal: () => TerminalService | undefined = () => undefined,
) =>
  defineService(RuntimeTerminalsV1, {
    list: defineMethod({
      ...methods.list,
      execute: async (projectId) =>
        (await terminal()?.list(projectId)) ??
        service.terminals.list(projectId),
    }),
    create: defineMethod({
      ...methods.create,
      execute: ({ threadId, cols, rows }) => {
        const delegate = terminal();
        return delegate === undefined
          ? service.terminals.create(threadId, cols, rows)
          : delegate.create(threadId, {
              ...(cols === undefined ? {} : { cols }),
              ...(rows === undefined ? {} : { rows }),
            });
      },
    }),
    snapshot: defineMethod({
      ...methods.snapshot,
      execute: ({ id, after }) => {
        const delegate = terminal();
        return delegate === undefined
          ? Promise.resolve(service.terminals.snapshot(id, after))
          : delegate.snapshot(id, after ?? 0);
      },
    }),
    input: defineMethod({
      ...methods.input,
      execute: ({ id, data }) =>
        terminal()?.input(id, data) ?? service.terminals.input(id, data),
    }),
    resize: defineMethod({
      ...methods.resize,
      execute: ({ id, cols, rows }) =>
        terminal()?.resize(id, cols, rows) ??
        service.terminals.resize(id, cols, rows),
    }),
    stop: defineMethod({
      ...methods.stop,
      execute: (id) => terminal()?.stop(id) ?? service.terminals.stop(id),
    }),
    watchProject: defineMethod({
      ...methods.watchProject,
      execute: ([projectId, listener]) =>
        terminal()?.watchProject(projectId, listener) ??
        watches.terminals(projectId, listener),
    }),
  });
