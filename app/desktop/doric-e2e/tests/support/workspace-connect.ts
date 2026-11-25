// The window's Connect calls of the workspace (S65a; spec
// `docs/designs/grpc-processes.md`, section 13, "The window from phase 3 to
// phase 5"): `runtime/v2` and `runtime.threads/v1` as the generated
// `RuntimeService` and `ThreadsService`, answered from `workspace-host`'s
// Projects, Threads and logs, behind a `HostForward` main's `doric:connect`
// relay forwards to (`bootPlatform({ hostForward })`). The other contracts
// stay on the Socket.IO fake until their slices (S65b–S65d) and S66.

import type { MessageInitShape, MessageShape } from '@bufbuild/protobuf';
import { type ConnectRouter, createConnectRouter } from '@connectrpc/connect';
import { createUniversalHandlerClient } from '@connectrpc/connect/protocol';
import { encode, runtimeOneofs } from 'runtime/contracts';
import {
  QueueResponseSchema,
  ThreadResponseSchema,
  ThreadsResponseSchema,
  ThreadsService,
  type ViewThreadRequest,
  type ViewThreadResponseSchema,
  type WatchThreadRequest,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  ProjectActivityResponseSchema,
  ProjectResponseSchema,
  ProjectsResponseSchema,
  RuntimeService,
  WatchProjectResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import type {
  ForwardRequest,
  ForwardResponse,
  HostForward,
} from '../../../doric/src/platform/bridge/connect-relay';
import {
  logOf,
  PLAN,
  PROJECTS,
  THREADS,
  type WorkspaceThread,
} from './workspace-host';

/**
 * Today's JSON as the proto message `schema` (the host's own codec). The
 * answer is untyped: this CommonJS project sees `@bufbuild/protobuf`'s CJS
 * types, `runtime/contracts` its ESM ones.
 */
const proto = (schema: object, value: unknown): never =>
  encode(
    schema as unknown as Parameters<typeof encode>[0],
    value,
    runtimeOneofs,
  ) as never;

type ViewItem = MessageInitShape<typeof ViewThreadResponseSchema>;

/** One opening of a server stream the fake serves. */
export interface Opening<Request, Item> {
  readonly request: Request;
  push(item: Item): void;
  /** Ends the stream: without error, or with `error` (a `ConnectError`). */
  end(error?: unknown): void;
  readonly closed: boolean;
}

/**
 * The openings of one server-streaming method: `serve` is its handler; each
 * call adds an opening that `open` fills with its first items and a test
 * then drives; the caller's cancelling closes it.
 */
const streamOf = <Request, Item>(
  open: (opening: Opening<Request, Item>) => void,
) => {
  const openings: Opening<Request, Item>[] = [];

  async function* serve(
    request: Request,
    context: { readonly signal: AbortSignal },
  ): AsyncGenerator<Item> {
    const queue: { item?: Item; end?: true; error?: unknown }[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const opening: Opening<Request, Item> = {
      request,
      push: (item) => {
        queue.push({ item });
        notify();
      },
      end: (error) => {
        queue.push(error === undefined ? { end: true } : { end: true, error });
        notify();
      },
      get closed() {
        return closed;
      },
    };
    const cancel = () => {
      closed = true;
      notify();
    };

    context.signal.addEventListener('abort', cancel, { once: true });
    openings.push(opening);
    open(opening);
    try {
      while (!closed) {
        const next = queue.shift();

        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (next.end === true) {
          closed = true;
          if (next.error !== undefined) throw next.error;
          return;
        }
        yield next.item as Item;
      }
    } finally {
      closed = true;
      context.signal.removeEventListener('abort', cancel);
    }
  }

  return { serve, openings };
};

/** `router`'s handlers as main's forward to the host. */
const forwardTo = (router: ConnectRouter): HostForward => {
  const client = createUniversalHandlerClient(router.handlers);

  return {
    request: async (
      input: ForwardRequest,
      signal: AbortSignal,
    ): Promise<ForwardResponse> => {
      const response = await client({
        url: `http://host.invalid${input.path}`,
        method: 'POST',
        header: new Headers(input.headers as [string, string][]),
        body: (async function* () {
          yield input.body;
        })(),
        signal,
      });

      return {
        status: response.status,
        headers: [...response.header],
        body: response.body,
      };
    },
  };
};

export interface WorkspaceConnect {
  readonly forward: HostForward;
  /** Every `ThreadsService.WatchThread` opening, in order. */
  readonly watches: readonly Opening<WatchThreadRequest, WatchThreadResponse>[];
  /** Every `ThreadsService.ViewThread` opening, in order. */
  readonly views: readonly Opening<ViewThreadRequest, ViewItem>[];
  /**
   * The snapshot a new `WatchThread` opening of `threadId` sends first:
   * `events` replaces the Thread's log for every later opening.
   */
  replaceLog(threadId: string, events: readonly unknown[]): void;
  /** Every method called, `<Service>/<Method>`, in call order. */
  readonly calls: readonly string[];
}

export interface WorkspaceConnectOptions {
  /**
   * Threads `Thread` and `WatchThread` also answer, beside the workspace's
   * (`serveTranscript`'s measured Thread); `Threads` lists only the
   * workspace's.
   */
  readonly threads?: readonly WorkspaceThread[];
  /** The logs `WatchThread` replays for these Threads, before `logOf`'s. */
  readonly logs?: ReadonlyMap<string, readonly unknown[]>;
  /** Registers more Connect services on the same router (`settings-host`). */
  readonly routes?: (router: ConnectRouter) => void;
}

/** The workspace's `RuntimeService` and `ThreadsService` over Connect. */
export const serveWorkspaceConnect = (
  options: WorkspaceConnectOptions = {},
): WorkspaceConnect => {
  const calls: string[] = [];
  const logs = new Map<string, readonly unknown[]>(options.logs ?? []);
  const known = [...THREADS, ...(options.threads ?? [])];
  const threadsOf = (projectId: string) =>
    THREADS.filter((item) => item.projectId === projectId);
  const logFor = (threadId: string) => logs.get(threadId) ?? logOf(threadId);
  const record = (method: string) => calls.push(method);

  const watches = streamOf<WatchThreadRequest, WatchThreadResponse>(
    (opening) => {
      const { threadId, afterSequence } = opening.request;
      const found = known.find((item) => item.id === threadId);

      opening.push(
        proto(WatchThreadResponseSchema, {
          kind: 'snapshot',
          threadId,
          projectId: found?.projectId ?? null,
          project:
            PROJECTS.find((item) => item.id === found?.projectId) ?? null,
          thread: found ?? null,
          events: logFor(threadId).filter(
            (row) => (row as { sequence: number }).sequence > afterSequence,
          ),
        }),
      );
    },
  );
  // The view is held: its one item, then nothing until the caller cancels.
  const views = streamOf<ViewThreadRequest, ViewItem>((opening) => {
    opening.push({ kind: 'viewing', threadId: opening.request.threadId });
  });
  const watchProjects = streamOf<
    { readonly projectId: string },
    MessageShape<typeof WatchProjectResponseSchema>
  >((opening) => {
    const { projectId } = opening.request;

    opening.push(
      proto(WatchProjectResponseSchema, {
        kind: 'snapshot',
        projectId,
        project: PROJECTS.find((item) => item.id === projectId) ?? null,
        threads: threadsOf(projectId),
      }),
    );
  });

  const router = createConnectRouter();

  router.service(RuntimeService, {
    projects: () => {
      record('RuntimeService/Projects');
      return proto(ProjectsResponseSchema, { items: [...PROJECTS] });
    },
    project: ({ id }) => {
      record('RuntimeService/Project');
      return proto(ProjectResponseSchema, {
        project: PROJECTS.find((item) => item.id === id) ?? null,
      });
    },
    projectActivity: () => {
      record('RuntimeService/ProjectActivity');
      return proto(ProjectActivityResponseSchema, {
        projectActivity: [...PROJECTS]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((item) => ({
            project: item,
            activityAt: item.updatedAt,
            ...(threadsOf(item.id).length > 0
              ? { latestActiveThreadId: PLAN.id }
              : {}),
          })),
      });
    },
    watchProject: (request, context) => {
      record('RuntimeService/WatchProject');
      return watchProjects.serve(request, context);
    },
  });
  router.service(ThreadsService, {
    threads: ({ projectId }) => {
      record('ThreadsService/Threads');
      return proto(ThreadsResponseSchema, {
        threadPage: { items: threadsOf(projectId) },
      });
    },
    thread: ({ id }) => {
      record('ThreadsService/Thread');
      return proto(ThreadResponseSchema, {
        thread: known.find((item) => item.id === id) ?? null,
      });
    },
    // Nothing queued behind any Thread's prompt.
    queue: ({ id }) => {
      record('ThreadsService/Queue');
      return proto(QueueResponseSchema, {
        threadQueue: THREADS.some((item) => item.id === id)
          ? { revision: 0, paused: false, stopping: false, items: [] }
          : null,
      });
    },
    watchThread: (request, context) => {
      record('ThreadsService/WatchThread');
      return watches.serve(request, context);
    },
    viewThread: (request, context) => {
      record('ThreadsService/ViewThread');
      return views.serve(request, context);
    },
  });

  options.routes?.(router);

  return {
    forward: forwardTo(router),
    watches: watches.openings,
    views: views.openings,
    replaceLog: (threadId, events) => {
      logs.set(threadId, events);
    },
    calls,
  };
};
