import { ipcMain } from 'electron';

import { workspaceApi, WorkspaceError } from './api';
import type { ThreadEventService } from './events';
import type { ProjectEventService } from './project-events';
import type { ThreadHistoryStore } from './thread-history';
import {
  configuration,
  credentialCreate,
  credentialUpdate,
  identifier,
  name,
  projectColor,
  prompt,
  providerValues,
  relativePath,
  senderIsAllowed,
  sequence,
  workingDirectory,
} from './validation';

type Result<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: string };

const safe = <Args extends readonly unknown[], Value>(
  allowedUrls: readonly string[],
  operation: (...args: Args) => Promise<Value>,
) => {
  return async (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    try {
      if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) {
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

/**
 * Registers the renderer's complete, intentionally narrow workspace boundary.
 * `allowedUrls` is the exact allow-list of window URLs that may call it.
 */
export const registerWorkspaceHandlers = (
  allowedUrls: readonly string[],
  events: ThreadEventService,
  projects: ProjectEventService,
  history: ThreadHistoryStore,
): void => {
  ipcMain.handle(
    'doric:config:get',
    safe(allowedUrls, workspaceApi.config.get),
  );
  ipcMain.handle(
    'doric:config:update',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.config.update(configuration(value)),
    ),
  );
  ipcMain.handle(
    'doric:tools:catalog',
    safe(allowedUrls, workspaceApi.tools.catalog),
  );
  ipcMain.handle(
    'doric:providers:kinds',
    safe(allowedUrls, workspaceApi.providers.kinds),
  );
  ipcMain.handle(
    'doric:providers:models',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.providers.models(providerValues(value)),
    ),
  );
  ipcMain.handle(
    'doric:credentials:list',
    safe(allowedUrls, workspaceApi.credentials.list),
  );
  ipcMain.handle(
    'doric:credentials:create',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.credentials.create(credentialCreate(value)),
    ),
  );
  ipcMain.handle(
    'doric:credentials:update',
    safe(allowedUrls, (value: unknown, patch: unknown) =>
      workspaceApi.credentials.update(
        identifier(value),
        credentialUpdate(patch),
      ),
    ),
  );
  ipcMain.handle(
    'doric:credentials:remove',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.credentials.remove(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:list',
    safe(allowedUrls, workspaceApi.projects.list),
  );
  ipcMain.handle(
    'doric:projects:files',
    safe(allowedUrls, (value: unknown, path: unknown) =>
      workspaceApi.projects.files(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:file',
    safe(allowedUrls, (value: unknown, path: unknown) =>
      workspaceApi.projects.file(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:tree',
    safe(allowedUrls, (value: unknown, path: unknown) =>
      workspaceApi.projects.tree(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:diff',
    safe(allowedUrls, (value: unknown, path: unknown) =>
      workspaceApi.projects.diff(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:changes',
    safe(allowedUrls, (value: unknown, path: unknown) =>
      workspaceApi.projects.changes(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:file-diff',
    safe(allowedUrls, (value: unknown, repository: unknown, path: unknown) =>
      workspaceApi.projects.fileDiff(
        identifier(value),
        relativePath(repository),
        relativePath(path),
      ),
    ),
  );
  ipcMain.handle(
    'doric:projects:create',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.projects.create(name(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:rename',
    safe(allowedUrls, (value: unknown, nextName: unknown) =>
      workspaceApi.projects.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:projects:set-color',
    safe(allowedUrls, (value: unknown, nextColor: unknown) =>
      workspaceApi.projects.setColor(
        identifier(value),
        projectColor(nextColor),
      ),
    ),
  );
  ipcMain.handle(
    'doric:projects:terminate',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.projects.terminate(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:delete',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.projects.delete(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:list',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.threads.list(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:get',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.threads.get(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:history',
    safe(allowedUrls, async (value: unknown) =>
      history.read(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:create',
    safe(
      allowedUrls,
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
    safe(allowedUrls, (value: unknown, nextName: unknown) =>
      workspaceApi.threads.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:threads:set-cwd',
    safe(allowedUrls, (value: unknown, cwd: unknown) =>
      workspaceApi.threads.setCwd(identifier(value), workingDirectory(cwd)),
    ),
  );
  ipcMain.handle(
    'doric:threads:git',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.threads.git(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:prompt',
    safe(allowedUrls, (value: unknown, nextPrompt: unknown) =>
      workspaceApi.threads.prompt(identifier(value), prompt(nextPrompt)),
    ),
  );
  ipcMain.handle(
    'doric:threads:resume',
    safe(allowedUrls, (threadId: unknown, promptId: unknown) =>
      workspaceApi.threads.resume(identifier(threadId), identifier(promptId)),
    ),
  );
  ipcMain.handle(
    'doric:threads:rewind',
    safe(
      allowedUrls,
      (value: unknown, promptId: unknown, nextPrompt: unknown) =>
        workspaceApi.threads.rewind(
          identifier(value),
          identifier(promptId),
          prompt(nextPrompt),
        ),
    ),
  );
  ipcMain.handle(
    'doric:threads:interrupt',
    safe(allowedUrls, (threadId: unknown, promptId: unknown) =>
      workspaceApi.threads.interrupt(
        identifier(threadId),
        identifier(promptId),
      ),
    ),
  );
  ipcMain.handle(
    'doric:threads:terminate',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.threads.terminate(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:delete',
    safe(allowedUrls, (value: unknown) =>
      workspaceApi.threads.delete(identifier(value)),
    ),
  );
  ipcMain.on('doric:threads:watch', (event, value, afterSequence) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) return;
    try {
      events.watch(event.sender, identifier(value), sequence(afterSequence));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:threads:unwatch', (event, value) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) return;
    try {
      events.stop(event.sender, identifier(value));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:projects:watch', (event, value) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) return;
    try {
      projects.watch(event.sender, identifier(value));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:projects:unwatch', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) return;
    projects.stop(event.sender);
  });
};
