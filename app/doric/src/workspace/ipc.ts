import { ipcMain } from 'electron';

import { workspaceApi, WorkspaceError } from './api';
import type { ThreadEventService } from './events';
import type { ProjectEventService } from './project-events';
import {
  identifier,
  name,
  projectColor,
  prompt,
  senderIsAllowed,
  sequence,
} from './validation';

type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: string };

const safe = <Args extends readonly unknown[], Value>(
  rendererUrl: string,
  operation: (...args: Args) => Promise<Value>,
) => {
  return async (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    try {
      if (!senderIsAllowed(event.senderFrame?.url, rendererUrl)) {
        throw new WorkspaceError('The request source is not allowed.');
      }
      return {
        ok: true,
        value: await operation(...args),
      } satisfies Result<Value>;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof WorkspaceError
            ? error.message
            : 'Doric could not complete the request.',
      } satisfies Result<Value>;
    }
  };
};

/** Registers the renderer's complete, intentionally narrow workspace boundary. */
export const registerWorkspaceHandlers = (
  rendererUrl: string,
  events: ThreadEventService,
  projects: ProjectEventService,
): void => {
  ipcMain.handle(
    'doric:projects:list',
    safe(rendererUrl, workspaceApi.projects.list),
  );
  ipcMain.handle(
    'doric:projects:create',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.projects.create(name(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:rename',
    safe(rendererUrl, (value: unknown, nextName: unknown) =>
      workspaceApi.projects.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:projects:set-color',
    safe(rendererUrl, (value: unknown, nextColor: unknown) =>
      workspaceApi.projects.setColor(
        identifier(value),
        projectColor(nextColor),
      ),
    ),
  );
  ipcMain.handle(
    'doric:projects:terminate',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.projects.terminate(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:delete',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.projects.delete(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:list',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.threads.list(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:get',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.threads.get(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:create',
    safe(
      rendererUrl,
      (projectId: unknown, nextName: unknown, parentId: unknown) =>
        workspaceApi.threads.create(
          identifier(projectId),
          name(nextName),
          parentId === undefined ? undefined : identifier(parentId),
        ),
    ),
  );
  ipcMain.handle(
    'doric:threads:rename',
    safe(rendererUrl, (value: unknown, nextName: unknown) =>
      workspaceApi.threads.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:threads:prompt',
    safe(rendererUrl, (value: unknown, nextPrompt: unknown) =>
      workspaceApi.threads.prompt(identifier(value), prompt(nextPrompt)),
    ),
  );
  ipcMain.handle(
    'doric:threads:rewind',
    safe(
      rendererUrl,
      (value: unknown, promptId: unknown, nextPrompt: unknown) =>
        workspaceApi.threads.rewind(
          identifier(value),
          identifier(promptId),
          prompt(nextPrompt),
        ),
    ),
  );
  ipcMain.handle(
    'doric:threads:terminate',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.threads.terminate(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:delete',
    safe(rendererUrl, (value: unknown) =>
      workspaceApi.threads.delete(identifier(value)),
    ),
  );
  ipcMain.on('doric:threads:watch', (event, value, afterSequence) => {
    if (!senderIsAllowed(event.senderFrame?.url, rendererUrl)) return;
    try {
      events.watch(event.sender, identifier(value), sequence(afterSequence));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:threads:unwatch', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url, rendererUrl)) return;
    events.stop(event.sender);
  });
  ipcMain.on('doric:projects:watch', (event, value) => {
    if (!senderIsAllowed(event.senderFrame?.url, rendererUrl)) return;
    try {
      projects.watch(event.sender, identifier(value));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:projects:unwatch', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url, rendererUrl)) return;
    projects.stop(event.sender);
  });
};
