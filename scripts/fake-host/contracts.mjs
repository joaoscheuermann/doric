// Dev-only: the app contracts the fake host answers, all from memory.
//
// Only the members the desktop actually calls for a workspace to come up are
// implemented (`runtime/v1`, `runtime.threads/v1`, the catalog and its
// diagnostics report). Everything else is refused with a clear `unavailable`
// error and logged, so a boot that asks for something new says so instead of
// hanging.
//
// A key is `<contract> <method>`, the pair every bridge message carries.

import { DevHostError } from './bundles.mjs';

/** The argument a wire message carries: a tuple's first item, or the value. */
export const first = (input) => (Array.isArray(input) ? input[0] : input);

/** The refusal of a contract the fake host does not answer. */
export const unavailable = (contract, method) =>
  new DevHostError(
    'unavailable',
    `${contract} ${method} is not served by the development fake host.`,
  );

/**
 * The handler table of the fake host: a call handler takes the wire input and
 * answers the output; a stream handler takes the wire input and a sink
 * (`push`/`end`).
 */
export const createContracts = ({ workspace, catalog, log }) => {
  const calls = new Map();
  const streams = new Map();

  calls.set('doric.diagnostics/v1 report', () => undefined);
  calls.set('doric.catalog/v1 distribution', () => catalog.current().catalog);
  calls.set('doric.catalog/v1 artifact', ({ sha256 }) =>
    catalog.current().artifact(sha256),
  );
  calls.set('doric.catalog/v1 disable', (input) => {
    log.note(
      `disable(${JSON.stringify(input)}) is a no-op on the fake host: boot a composition without the bundle instead.`,
    );
  });
  calls.set('doric.catalog/v1 resetComposition', () => undefined);

  // runtime/v1 -------------------------------------------------------------
  calls.set('runtime/v1 projects', (input) =>
    workspace.projectPage({ limit: 100, ...(first(input) ?? {}) }),
  );
  calls.set('runtime/v1 project', (input) =>
    workspace.projectById(first(input)),
  );
  calls.set('runtime/v1 projectActivity', () => workspace.projectActivity());
  calls.set('runtime/v1 createProject', (input) =>
    workspace.createProject(first(input)),
  );
  calls.set('runtime/v1 renameProject', (input) =>
    workspace.renameProject(first(input)),
  );
  calls.set('runtime/v1 setProjectColor', (input) =>
    workspace.setProjectColor(first(input)),
  );
  calls.set('runtime/v1 terminateProject', (input) =>
    workspace.terminateProject(first(input)),
  );
  calls.set('runtime/v1 deleteProject', (input) =>
    workspace.deleteProject(first(input)),
  );

  // runtime.threads/v1 -----------------------------------------------------
  calls.set('runtime.threads/v1 threads', (input) =>
    workspace.threadPage({ limit: 100, ...(first(input) ?? {}) }),
  );
  calls.set('runtime.threads/v1 thread', (input) =>
    workspace.threadById(first(input)),
  );
  calls.set('runtime.threads/v1 createThread', (input) =>
    workspace.createThread(first(input)),
  );
  calls.set('runtime.threads/v1 renameThread', (input) =>
    workspace.renameThread(first(input)),
  );
  calls.set('runtime.threads/v1 terminateThread', (input) =>
    workspace.terminateThread(first(input)),
  );
  calls.set('runtime.threads/v1 deleteThread', (input) =>
    workspace.deleteThread(first(input)),
  );

  // Streams ----------------------------------------------------------------
  streams.set('runtime/v1 watchProject', (input, sink) => {
    const { projectId } = first(input) ?? {};
    const found = workspace.projectById(projectId);

    sink.push({
      kind: 'snapshot',
      projectId,
      project: found ?? null,
      threads: workspace.threadsOf(projectId),
      terminals: [],
    });
  });
  streams.set('runtime.threads/v1 watchThread', (input, sink) => {
    const { threadId } = first(input) ?? {};
    const found = workspace.threadById(threadId);

    sink.push({
      kind: 'snapshot',
      threadId,
      projectId: found?.projectId ?? null,
      project:
        found === undefined
          ? null
          : (workspace.projectById(found.projectId) ?? null),
      thread: found ?? null,
      events: [],
    });
  });
  streams.set('doric.catalog/v1 watch', (_input, sink) => {
    catalog.watch(sink);
  });
  // The terminal panel subscribes as soon as a Thread is selected; an empty
  // snapshot is the honest answer here (the fake host runs no sandbox).
  streams.set('terminal/v1 watchProject', (input, sink) => {
    sink.push({
      kind: 'snapshot',
      projectId: first(input),
      terminals: [],
    });
  });

  return { calls, streams };
};
