import { defineMethod, defineService } from 'bundle/contracts';
import type { TerminalService } from 'terminal/contracts';

import {
  runtimeTerminalsMethods as methods,
  RuntimeTerminalsV1,
} from '../../contracts/terminals.js';
import type { Watches } from './watches.js';

/**
 * runtime.terminals/v1: the terminal sessions (design 57 §2.6), kept for the
 * desktop windows that still read this contract. Since the stage-10 host
 * switch the sessions are the `terminal` bundle's, agent and manual alike, so
 * every method delegates to its `terminal/v1` (G-9) and these windows see the
 * same sessions as the routes. Without a `terminal/v1` provider the Project
 * has no sessions: none listed, none created, and a stream of an empty
 * snapshot.
 */
export const terminalSessionsService = (
  watches: Watches,
  terminal: () => TerminalService | undefined,
) =>
  defineService(RuntimeTerminalsV1, {
    list: defineMethod({
      expose: 'desktop',
      ...methods.list,
      execute: async (projectId) => (await terminal()?.list(projectId)) ?? [],
    }),
    create: defineMethod({
      expose: 'desktop',
      ...methods.create,
      execute: async ({ threadId, cols, rows }) =>
        terminal()?.create(threadId, {
          ...(cols === undefined ? {} : { cols }),
          ...(rows === undefined ? {} : { rows }),
        }),
    }),
    snapshot: defineMethod({
      expose: 'desktop',
      ...methods.snapshot,
      execute: async ({ id, after }) => terminal()?.snapshot(id, after ?? 0),
    }),
    input: defineMethod({
      expose: 'desktop',
      ...methods.input,
      execute: async ({ id, data }) =>
        (await terminal()?.input(id, data)) ?? false,
    }),
    resize: defineMethod({
      expose: 'desktop',
      ...methods.resize,
      execute: async ({ id, cols, rows }) =>
        (await terminal()?.resize(id, cols, rows)) ?? false,
    }),
    stop: defineMethod({
      expose: 'desktop',
      ...methods.stop,
      execute: async (id) => (await terminal()?.stop(id)) ?? false,
    }),
    watchProject: defineMethod({
      expose: 'desktop',
      ...methods.watchProject,
      execute: ([projectId, listener]) =>
        terminal()?.watchProject(projectId, listener) ??
        watches.terminals(projectId, listener),
    }),
  });
