// files.refresh/v1 (stage 10, §3.6): the Project refresh coordinator, moved
// from the layout's `useProjectRefresh` and `projectActivity`. Each
// registrant owns its reads and rereads them with `refreshProject` (250 ms
// coalescing, one trailing read); the coordinator decides when.
//
// Triggers, each followed by a request for the selected Project:
// - chat's `onSandboxActivityHook` (wired in the activation, any Project);
// - a change of the selected Project's id or state, the selected Thread's id
//   or cwd, the Project's Thread activity (id, state, cwd), whether something
//   of the Project is shown, and the connection turning on — while connected;
// - `window` focus and `visibilitychange` while the document is visible,
//   something is shown and the connection is on;
// - every 15 s while visible, shown and connected, as a periodic request.
// Terminal list activity arrives as `request` from the terminal bundle.

import { type Disposable, defineMethod, defineService } from 'bundle/contracts';

import {
  FilesRefreshV1,
  filesRefreshMethods,
  type ProjectReads,
} from '../../contracts/index.js';

/** The workspace fields the coordinator reads (`layout.workspace/v1`). */
export interface RefreshWorkspace {
  selection(): {
    readonly project?: { readonly id: string; readonly state: string };
    readonly thread?: { readonly id: string; readonly cwd?: string };
  };
  threads(projectId: string): readonly {
    readonly id: string;
    readonly state: string;
    readonly cwd?: string;
  }[];
  connected(): boolean;
  subscribe(listener: () => void): Disposable;
}

/** The window the coordinator listens to; a fake in tests. */
export interface RefreshEnvironment {
  /** Whether the document is visible now. */
  visible(): boolean;
  /** Calls `listener` on window focus and on visibility changes; returns its stop. */
  onFocus(listener: () => void): () => void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The fallback poll: no filesystem watcher exists. */
export const PERIODIC_REFRESH_MS = 15_000;

export interface RefreshCoordinator {
  register(reads: ProjectReads): Disposable;
  request(projectId: string, options?: { readonly periodic?: boolean }): void;
  /** Binds the workspace the triggers read; `undefined` unbinds it. */
  setWorkspace(workspace: RefreshWorkspace | undefined): void;
  dispose(): void;
}

export const createRefreshCoordinator = (
  environment: RefreshEnvironment,
): RefreshCoordinator => {
  const registrants = new Set<ProjectReads>();
  let workspace: RefreshWorkspace | undefined;
  let watch: Disposable | undefined;
  let signature: string | undefined;
  let stopFocus: (() => void) | undefined;
  let interval: unknown;
  let disposed = false;

  const request = (
    projectId: string,
    options?: { readonly periodic?: boolean },
  ): void => {
    if (disposed) return;
    const periodic = options?.periodic === true;
    for (const reads of [...registrants]) {
      if (reads.projectId !== projectId) continue;
      void reads.refresh({ periodic }).catch(() => undefined);
    }
  };

  const shown = (projectId: string): boolean =>
    [...registrants].some(
      (reads) => reads.projectId === projectId && reads.active(),
    );

  /** The selected Project whose reads are shown, while connected. */
  const watched = (): string | undefined => {
    if (workspace === undefined || !workspace.connected()) return undefined;
    const projectId = workspace.selection().project?.id;
    return projectId !== undefined && shown(projectId) ? projectId : undefined;
  };

  const stopWindow = () => {
    stopFocus?.();
    stopFocus = undefined;
    if (interval !== undefined) environment.clearInterval(interval);
    interval = undefined;
  };

  const startWindow = () => {
    stopWindow();
    stopFocus = environment.onFocus(() => {
      const projectId = watched();
      if (projectId !== undefined && environment.visible()) request(projectId);
    });
    interval = environment.setInterval(() => {
      const projectId = watched();
      if (projectId !== undefined && environment.visible())
        request(projectId, { periodic: true });
    }, PERIODIC_REFRESH_MS);
  };

  /** Re-evaluates the triggers after any change they read. */
  const evaluate = () => {
    if (disposed || workspace === undefined) {
      signature = undefined;
      stopWindow();
      return;
    }
    const connected = workspace.connected();
    const { project, thread } = workspace.selection();
    const projectId = project?.id;
    const activity =
      projectId === undefined
        ? []
        : workspace
            .threads(projectId)
            .map(({ id, state, cwd }) => [id, state, cwd]);
    const visible = projectId !== undefined && shown(projectId);
    const next = JSON.stringify([
      projectId,
      project?.state,
      thread?.id,
      thread?.cwd,
      visible,
      connected,
      activity,
    ]);
    const changed = next !== signature;
    signature = next;
    if (changed && projectId !== undefined && connected) request(projectId);
    // The window listeners and the poll exist only while something is shown.
    if (projectId !== undefined && visible && connected) {
      if (stopFocus === undefined) startWindow();
    } else {
      stopWindow();
    }
  };

  return {
    register: (reads) => {
      registrants.add(reads);
      evaluate();
      let active = true;
      return {
        dispose: () => {
          if (!active) return;
          active = false;
          registrants.delete(reads);
          evaluate();
        },
      };
    },
    request,
    setWorkspace: (next) => {
      watch?.dispose();
      watch = undefined;
      workspace = next;
      signature = undefined;
      if (next !== undefined) watch = next.subscribe(evaluate);
      evaluate();
    },
    dispose: () => {
      disposed = true;
      watch?.dispose();
      watch = undefined;
      workspace = undefined;
      stopWindow();
      registrants.clear();
    },
  };
};

/** `files.refresh/v1` over a coordinator. */
export const createFilesRefresh = (coordinator: RefreshCoordinator) =>
  defineService(FilesRefreshV1, {
    register: defineMethod({
      ...filesRefreshMethods.register,
      execute: (reads: ProjectReads) => coordinator.register(reads),
    }),
    request: defineMethod({
      ...filesRefreshMethods.request,
      execute: ([projectId, options]: [
        string,
        { readonly periodic?: boolean }?,
      ]) => coordinator.request(projectId, options),
    }),
  });
