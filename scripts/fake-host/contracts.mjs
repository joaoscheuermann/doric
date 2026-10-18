// Dev-only: the app contracts the fake host answers, all from memory.
//
// Only the members the desktop actually calls for a workspace to come up are
// implemented (`runtime/v1`, `runtime.threads/v1`, the catalog and its
// diagnostics report), plus the feature surfaces the dev host is here to show:
// `artifacts/v1`, `comments/v1`, `papercraft.previews/v1` and the durable
// event log `runtime.threads/v1.watchThread` streams. Everything else is
// refused with a clear `unavailable` error and logged, so a boot that asks for
// something new says so instead of hanging.
//
// A key is `<contract> <method>`, the pair every bridge message carries.

import { randomUUID } from 'node:crypto';

import { DevHostError } from './bundles.mjs';

/** The argument a wire message carries: a tuple's first item, or the value. */
export const first = (input) => (Array.isArray(input) ? input[0] : input);

/**
 * The scope of a Project-bound call, refused without a `projectId` exactly as
 * the real host's lease refuses it (`runtime.lease/v1`): a window that forgets
 * to scope its call fails here as it would against the real host, instead of
 * landing on the seeded Project by default.
 */
export const projectScopeOf = (call) => {
  const scope = call?.scope;

  if (typeof scope?.projectId !== 'string' || scope.projectId.length === 0) {
    throw new DevHostError(
      'invalid_input',
      'The call needs a projectId in its scope: the Project lease is scoped by it.',
    );
  }

  return {
    projectId: scope.projectId,
    ...(typeof scope.threadId === 'string' ? { threadId: scope.threadId } : {}),
    ...(typeof scope.promptId === 'string' ? { promptId: scope.promptId } : {}),
  };
};

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
 *
 * `threads`, `artifacts` and `comments` are the in-memory feature state the
 * fake host seeds at boot (see `thread-log.mjs`, `artifacts.mjs`, `seed.mjs`).
 */
export const createContracts = ({
  workspace,
  catalog,
  log,
  threads,
  artifacts,
  comments,
}) => {
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

  // The composer's send: accepted, then its own durable events, so the
  // conversation shows the reader's turn. The fake host runs no agent, so the
  // turn is opened and closed with no answer text — which is what happened.
  calls.set('runtime.threads/v1 prompt', (input) => {
    const { id, prompt } = first(input) ?? {};
    const found = workspace.threadById(id);

    if (found === undefined) return { status: 'missing' };

    const text = String(prompt ?? '').trim();

    if (text.length === 0) {
      throw new DevHostError(
        'invalid_input',
        'A non-empty prompt is required.',
      );
    }

    const promptId = randomUUID();
    const scope = { projectId: found.projectId, threadId: id, promptId };

    threads.appendMany({
      ...scope,
      values: [
        {
          type: 'prompt.accepted',
          event: {
            type: 'prompt.accepted',
            text,
            source: { kind: 'user' },
            queued: false,
          },
        },
        { type: 'prompt.started', event: { type: 'prompt.started' } },
        {
          type: 'prompt.finished',
          event: {
            type: 'prompt.finished',
            status: 'completed',
            text: '',
            source: { kind: 'user' },
          },
        },
      ],
    });

    log.note(
      `prompt accepted on Thread ${id} as ${promptId}: the fake host runs no agent, so its turn completes with no answer text`,
    );

    return { status: 'accepted', promptId };
  });

  // artifacts/v1 -------------------------------------------------------------
  // Every Project-bound surface takes the call's scope, and refuses a call
  // without a Project the way the real host's lease does.
  const scoped = (handler) => (input, call) =>
    handler(first(input) ?? {}, projectScopeOf(call));

  calls.set(
    'artifacts/v1 create',
    scoped((input, scope) => artifacts.create(input, scope)),
  );
  calls.set(
    'artifacts/v1 revise',
    scoped((input, scope) => artifacts.revise(input, scope)),
  );
  calls.set(
    'artifacts/v1 read',
    scoped((input) => artifacts.read(input)),
  );
  calls.set(
    'artifacts/v1 list',
    scoped((input, scope) => artifacts.list(input, scope)),
  );
  calls.set(
    'artifacts/v1 revisions',
    scoped((input) => artifacts.revisions(input)),
  );

  // artifact.kind/v1 ---------------------------------------------------------
  // The kinds the host registered, as the window's frame reads them to mount
  // a kind's body. The fake host runs no host parts, so it answers the one
  // kind it seeds: papercraft's `preview`, whose body is `<papercraft-preview>`
  // (`bundles/features/papercraft/src/host/kind.ts`).
  calls.set('artifact.kind/v1 list', () => [
    {
      id: 'preview',
      title: 'Preview',
      blockType: 'papercraft.preview/v1',
      bodyTag: 'papercraft-preview',
      header: 'body',
    },
  ]);
  calls.set(
    'artifacts/v1 approve',
    scoped((input, scope) => artifacts.approve(input, scope)),
  );
  calls.set(
    'artifacts/v1 apply',
    scoped((input, scope) => artifacts.apply(input, scope)),
  );
  calls.set(
    'artifacts/v1 policy',
    scoped(() => artifacts.policy()),
  );

  // comments/v1 --------------------------------------------------------------
  calls.set(
    'comments/v1 add',
    scoped((input, scope) => comments.add(input, scope)),
  );
  calls.set(
    'comments/v1 list',
    scoped((input) => comments.list(input)),
  );
  calls.set(
    'comments/v1 resolve',
    scoped((input, scope) => comments.resolve(input, scope)),
  );

  // papercraft.previews/v1 ---------------------------------------------------
  calls.set(
    'papercraft.previews/v1 build',
    scoped((input, scope) => artifacts.build(input, scope)),
  );
  calls.set(
    'papercraft.previews/v1 read',
    scoped((input) => artifacts.readPreview(input)),
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
    const { threadId, afterSequence } = first(input) ?? {};
    const found = workspace.threadById(threadId);
    const from = typeof afterSequence === 'number' ? afterSequence : 0;

    sink.push({
      kind: 'snapshot',
      threadId,
      projectId: found?.projectId ?? null,
      project:
        found === undefined
          ? null
          : (workspace.projectById(found.projectId) ?? null),
      thread: found ?? null,
      // A replay after this sequence, exactly as the real watch answers: 0
      // replays the whole log of the seeded conversation.
      events: threads
        .eventsOf(threadId)
        .filter((event) => event.sequence > from),
    });

    // Every event the feature appends while the app runs, as it happens.
    const release = threads.watch(threadId, {
      push: (event) => sink.push({ kind: 'event', event }),
    });
    const end = sink.end.bind(sink);

    sink.end = (error) => {
      release();
      end(error);
    };
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
