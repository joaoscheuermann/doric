import { ipcMain } from 'electron';

import { WorkspaceError, workspaceApi } from './api';
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

/**
 * Whether the legacy channels may reach the host. Recovery on the last core
 * that worked answers every one with the REST client's unavailable message,
 * so a diagnosis never works on data.
 */
let hostAvailable: () => boolean = () => true;

const safe = <Args extends readonly unknown[], Value>(
  operation: (...args: Args) => Promise<Value>,
) => {
  return async (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    try {
      if (!senderIsAllowed(event.senderFrame?.url)) {
        throw new WorkspaceError('The request source is not allowed.');
      }
      if (!hostAvailable()) {
        throw new WorkspaceError('Doric backend is unavailable.');
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
 * Only the shell pages of `doric://app` may call it.
 */
export const registerWorkspaceHandlers = (
  events: ThreadEventService,
  projects: ProjectEventService,
  history: ThreadHistoryStore,
  available: () => boolean = () => true,
): void => {
  hostAvailable = available;
  ipcMain.handle('doric:config:get', safe(workspaceApi.config.get));
  ipcMain.handle(
    'doric:config:update',
    safe((value: unknown) => workspaceApi.config.update(configuration(value))),
  );
  ipcMain.handle('doric:tools:catalog', safe(workspaceApi.tools.catalog));
  ipcMain.handle('doric:resources:host', safe(workspaceApi.resources.host));
  ipcMain.handle(
    'doric:resources:project',
    safe((value: unknown) => workspaceApi.resources.project(identifier(value))),
  );
  ipcMain.handle('doric:providers:kinds', safe(workspaceApi.providers.kinds));
  ipcMain.handle(
    'doric:providers:models',
    safe((value: unknown) =>
      workspaceApi.providers.models(providerValues(value)),
    ),
  );
  ipcMain.handle('doric:credentials:list', safe(workspaceApi.credentials.list));
  ipcMain.handle(
    'doric:credentials:create',
    safe((value: unknown) =>
      workspaceApi.credentials.create(credentialCreate(value)),
    ),
  );
  ipcMain.handle(
    'doric:credentials:update',
    safe((value: unknown, patch: unknown) =>
      workspaceApi.credentials.update(
        identifier(value),
        credentialUpdate(patch),
      ),
    ),
  );
  ipcMain.handle(
    'doric:credentials:remove',
    safe((value: unknown) =>
      workspaceApi.credentials.remove(identifier(value)),
    ),
  );
  ipcMain.handle('doric:projects:list', safe(workspaceApi.projects.list));
  ipcMain.handle(
    'doric:projects:files',
    safe((value: unknown, path: unknown) =>
      workspaceApi.projects.files(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:file',
    safe((value: unknown, path: unknown) =>
      workspaceApi.projects.file(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:tree',
    safe((value: unknown, path: unknown) =>
      workspaceApi.projects.tree(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:diff',
    safe((value: unknown, path: unknown) =>
      workspaceApi.projects.diff(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:changes',
    safe((value: unknown, path: unknown) =>
      workspaceApi.projects.changes(identifier(value), relativePath(path)),
    ),
  );
  ipcMain.handle(
    'doric:projects:file-diff',
    safe((value: unknown, repository: unknown, path: unknown) =>
      workspaceApi.projects.fileDiff(
        identifier(value),
        relativePath(repository),
        relativePath(path),
      ),
    ),
  );
  ipcMain.handle(
    'doric:projects:create',
    safe((value: unknown) => workspaceApi.projects.create(name(value))),
  );
  ipcMain.handle(
    'doric:projects:rename',
    safe((value: unknown, nextName: unknown) =>
      workspaceApi.projects.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:projects:set-color',
    safe((value: unknown, nextColor: unknown) =>
      workspaceApi.projects.setColor(
        identifier(value),
        projectColor(nextColor),
      ),
    ),
  );
  ipcMain.handle(
    'doric:projects:terminate',
    safe((value: unknown) =>
      workspaceApi.projects.terminate(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:projects:delete',
    safe((value: unknown) => workspaceApi.projects.delete(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:list',
    safe((value: unknown) => workspaceApi.threads.list(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:get',
    safe((value: unknown) => workspaceApi.threads.get(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:history',
    safe(async (value: unknown) => history.read(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:create',
    safe((projectId: unknown, nextName: unknown, parentId: unknown) =>
      workspaceApi.threads.create(
        identifier(projectId),
        name(nextName),
        parentId === undefined ? undefined : identifier(parentId),
      ),
    ),
  );
  ipcMain.handle(
    'doric:threads:rename',
    safe((value: unknown, nextName: unknown) =>
      workspaceApi.threads.rename(identifier(value), name(nextName)),
    ),
  );
  ipcMain.handle(
    'doric:threads:set-cwd',
    safe((value: unknown, cwd: unknown) =>
      workspaceApi.threads.setCwd(identifier(value), workingDirectory(cwd)),
    ),
  );
  ipcMain.handle(
    'doric:threads:git',
    safe((value: unknown) => workspaceApi.threads.git(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:branches',
    safe((value: unknown) => workspaceApi.threads.branches(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:usage',
    safe((value: unknown) => workspaceApi.threads.usage(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:queue',
    safe((value: unknown) => workspaceApi.threads.queue(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:queue-resume',
    safe((value: unknown) =>
      workspaceApi.threads.resumeQueue(identifier(value)),
    ),
  );
  ipcMain.handle(
    'doric:threads:queue-remove',
    safe((value: unknown, prompt: unknown) =>
      workspaceApi.threads.removeQueued(identifier(value), identifier(prompt)),
    ),
  );
  ipcMain.handle(
    'doric:threads:queue-prompt',
    safe((value: unknown, target: unknown) =>
      workspaceApi.threads.queuedPrompt(identifier(value), identifier(target)),
    ),
  );
  ipcMain.handle(
    'doric:threads:queue-edit',
    safe(
      (value: unknown, target: unknown, text: unknown, revision: unknown) => {
        if (
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        )
          throw new WorkspaceError('Invalid prompt revision.');
        return workspaceApi.threads.editQueued(
          identifier(value),
          identifier(target),
          prompt(text),
          revision,
        );
      },
    ),
  );
  ipcMain.handle(
    'doric:threads:switch-branch',
    safe((value: unknown, branch: unknown, cwd: unknown) => {
      if (
        typeof branch !== 'string' ||
        !branch ||
        branch.length > 1024 ||
        branch.includes('\0') ||
        branch.startsWith('-')
      )
        throw new WorkspaceError('Invalid branch name.');
      return workspaceApi.threads.switchBranch(
        identifier(value),
        branch,
        workingDirectory(cwd),
      );
    }),
  );
  ipcMain.handle(
    'doric:threads:prompt',
    safe((value: unknown, nextPrompt: unknown) =>
      workspaceApi.threads.prompt(identifier(value), prompt(nextPrompt)),
    ),
  );
  ipcMain.handle(
    'doric:threads:resume',
    safe((threadId: unknown, promptId: unknown) =>
      workspaceApi.threads.resume(identifier(threadId), identifier(promptId)),
    ),
  );
  ipcMain.handle(
    'doric:threads:rewind',
    safe((value: unknown, promptId: unknown, nextPrompt: unknown) =>
      workspaceApi.threads.rewind(
        identifier(value),
        identifier(promptId),
        prompt(nextPrompt),
      ),
    ),
  );
  ipcMain.handle(
    'doric:threads:interrupt',
    safe((threadId: unknown, promptId: unknown) =>
      workspaceApi.threads.interrupt(
        identifier(threadId),
        identifier(promptId),
      ),
    ),
  );
  ipcMain.handle(
    'doric:threads:terminate',
    safe((value: unknown) => workspaceApi.threads.terminate(identifier(value))),
  );
  ipcMain.handle(
    'doric:threads:delete',
    safe((value: unknown) => workspaceApi.threads.delete(identifier(value))),
  );
  ipcMain.on('doric:threads:watch', (event, value, afterSequence) => {
    if (!senderIsAllowed(event.senderFrame?.url)) return;
    try {
      events.watch(event.sender, identifier(value), sequence(afterSequence));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:threads:unwatch', (event, value) => {
    if (!senderIsAllowed(event.senderFrame?.url)) return;
    try {
      events.stop(event.sender, identifier(value));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:projects:watch', (event, value) => {
    if (!senderIsAllowed(event.senderFrame?.url)) return;
    try {
      projects.watch(event.sender, identifier(value));
    } catch {
      // Invalid send payloads never cross the main-process boundary.
    }
  });
  ipcMain.on('doric:projects:unwatch', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url)) return;
    projects.stop(event.sender);
  });
};
