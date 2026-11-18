// A stand-in for the `Services` a files element receives: every contract the
// story serves is available at once, keyed by its contract id, so the
// components read seeded fixtures instead of a live host. `use` answers the
// same API whatever the scope, or the API a scoped factory builds for it.

import type {
  AnyServiceRef,
  ApiOf,
  CallScope,
  Disposable,
  Services,
} from 'bundle/contracts';
import type { Project, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';

type Provided = unknown | ((scope: CallScope | undefined) => unknown);

const disposed: Disposable = { dispose: () => undefined };

const provider = { bundleId: 'stories', version: '0.0.0' };

/**
 * Services over fixed APIs. A value that is a function receives the call's
 * scope and returns the API for it (`services.use(FilesV1, { projectId })`);
 * pass such APIs under `scoped`.
 */
export const storyServices = ({
  apis = {},
  scoped = {},
}: {
  readonly apis?: Readonly<Record<string, unknown>>;
  readonly scoped?: Readonly<
    Record<string, (scope: CallScope | undefined) => unknown>
  >;
}): Services => {
  const resolve = (id: string, scope?: CallScope): Provided => {
    const factory = scoped[id];
    return factory === undefined ? apis[id] : factory(scope);
  };
  return {
    provide: () => disposed,
    use: <R extends AnyServiceRef>(contract: R, scope?: CallScope) => {
      const api = resolve(contract.id, scope);
      if (api === undefined) {
        throw new Error(`The story does not serve ${contract.id}.`);
      }
      return api as ApiOf<R>;
    },
    whenAvailable: (contract, callback) => {
      const api = resolve(contract.id);
      if (api === undefined) return disposed;
      const cleanup = callback(api as never, provider);
      return {
        dispose: () => {
          if (typeof cleanup === 'function') void cleanup();
        },
      };
    },
  };
};

/** A `subscribe(listener): Disposable` source whose snapshot never changes. */
export const still = { subscribe: () => disposed };

/**
 * `workspace.selection/v1` on `project` and `thread` (either may be absent)
 * and `runtime.records/v1` holding them, primed so it answers the Thread.
 */
export const selectionApis = (selection: {
  readonly project?: Project;
  readonly thread?: Thread;
}): Readonly<Record<string, unknown>> => {
  const { project, thread } = selection;
  const ids = {
    ...(project === undefined ? {} : { projectId: project.id }),
    ...(thread === undefined ? {} : { threadId: thread.id }),
  };
  const records = createRecordsApi({
    projects: project === undefined ? [] : [project],
    threads: thread === undefined ? [] : [thread],
  });
  // The records answer a Thread of a described Project only.
  if (thread !== undefined) records.threads(thread.projectId);
  return {
    'workspace.selection/v1': { ...still, current: () => ids },
    'runtime.records/v1': records,
  };
};
