import { ipcMain } from 'electron';

import { WorkspaceError } from './api';
import type { TerminalEventService } from './terminal-events';
import { terminalApi } from './terminals';
import { identifier, senderIsAllowed } from './validation';

/** Terminal input deliberately preserves control characters and whitespace. */
export const terminalInput = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 65_536)
    throw new WorkspaceError('Terminal input is invalid.');
  return value;
};

export const terminalDimension = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1000
  )
    throw new WorkspaceError('Terminal dimensions are invalid.');
  return value;
};

/** Registers only semantic terminal controls for trusted application windows. */
export const registerTerminalHandlers = (
  allowedUrls: readonly string[],
  events: TerminalEventService,
): void => {
  const writes = new Map<string, Promise<void>>();
  const handle = (
    channel: string,
    operation: (...args: unknown[]) => Promise<unknown>,
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!senderIsAllowed(event.senderFrame?.url, allowedUrls))
          throw new WorkspaceError('The request source is not allowed.');
        return { ok: true, value: await operation(...args) };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof WorkspaceError
              ? error.message
              : 'Doric could not complete the terminal request.',
        };
      }
    });
  };
  handle('doric:terminals:list', (id) => terminalApi.list(identifier(id)));
  handle('doric:terminals:create', (id) => terminalApi.create(identifier(id)));
  handle('doric:terminals:input', async (value, data) => {
    const id = identifier(value);
    const input = terminalInput(data);
    // HTTP requests must preserve the order of keyboard events from preload.
    const write = (writes.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => terminalApi.input(id, input));
    writes.set(id, write);
    try {
      await write;
    } finally {
      if (writes.get(id) === write) writes.delete(id);
    }
  });
  handle('doric:terminals:resize', (id, cols, rows) =>
    terminalApi.resize(
      identifier(id),
      terminalDimension(cols),
      terminalDimension(rows),
    ),
  );
  handle('doric:terminals:stop', (id) => terminalApi.stop(identifier(id)));
  const on = (
    channel: string,
    operation: (target: Electron.WebContents, id: string) => void,
  ) => {
    ipcMain.on(channel, (event, id: unknown) => {
      if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) return;
      try {
        operation(event.sender, identifier(id));
      } catch {
        /* Invalid sends never cross IPC. */
      }
    });
  };
  on('doric:terminals:watch-project', events.watchProject);
  on('doric:terminals:unwatch-project', events.stopProject);
  on('doric:terminals:watch', events.watch);
  on('doric:terminals:unwatch', events.stop);
};
