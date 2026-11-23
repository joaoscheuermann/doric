// The harness of `terminal`'s host part through the router (phase 3, S54b):
// `terminal/v1`, the `terminal` tool and the `onThreadsClosingHook` handler
// served by `createTestRouter` as `src/host/main.ts` serves them
// (`createTerminalProcessHost`, its `activate`), with recording fakes of
// section D's services plus `runtime.lease/v1` (§9 G1): `tools/v1` and
// `hooks/v1` (`Register`), `secrets/v1` (`Redactions`, `WatchRedactions` on
// demand), `runtime.workspace/v1` (`Cwd`, `OpenThread` held open until
// cancelled, `ThreadState`), `runtime.threads/v1` (the background results)
// and `runtime.lease/v1` (`Start`: `started`, then output and exit on
// demand, recording `write` and `resize`). Each fake records its request,
// `callOf(context).scope`, `deadlineOf` and whether its signal aborted.

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import type { Client, HandlerContext } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  callOf,
  deadlineOf,
} from 'bundle/contracts';
import {
  HookHandlerService,
  RegisterRequestSchema as HookRegisterRequestSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { LogService } from 'bundle/contracts/gen/doric/log/v1/log_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  ToolHandlerService,
  RegisterRequestSchema as ToolRegisterRequestSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  EnqueueTerminalResultRequestSchema,
  FailTerminalResultRequestSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  OpenThreadRequestSchema,
  OpenThreadResponseSchema,
  WorkspaceService,
} from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import { TerminalService } from '../../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import {
  createTerminalProcessHost,
  type TerminalProcessHost,
} from '../../src/host/service.js';
import {
  aborted,
  channel,
  type FakeProcess,
  fakeOf,
  leaseFake,
} from './router-fakes.js';

export type { FakeProcess } from './router-fakes.js';

/** `core`, as the router stamps it on its calls to the handler services. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The scope of a prompt of `thread-1`, as `core` relays it. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/** The services `terminal`'s host part calls (section D plus `runtime.lease/v1`). */
export const REQUIRES: readonly string[] = [
  ToolsService.typeName,
  SecretsService.typeName,
  HooksService.typeName,
  LogService.typeName,
  WorkspaceService.typeName,
  ThreadsService.typeName,
  LeaseService.typeName,
];

/** One Thread as the fake `OpenThread` answers it. */
export interface FakeThread {
  readonly projectId: string;
  readonly cwd: string;
  /** `ready` (default) opens a session; any other status refuses. */
  readonly status?: 'ready' | 'missing' | 'inactive' | 'pending';
  /** What `ThreadState` answers for its sessions. */
  readonly closing?: boolean;
}

/** One call a fake received. */
export interface FakeCall {
  /** `<service>.<method>`, e.g. `workspace.cwd`, `threads.enqueueTerminalResult`. */
  readonly method: string;
  /** The request as JSON (fields at their default left out). */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
}

/** One `OpenThread` stream. */
export interface FakeSession {
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** The `ready` session id, absent for a refusal. */
  readonly threadSessionId?: string;
  /** Set once the stream was cancelled (or ended after a refusal). */
  cancelled: boolean;
}

/** One open `WatchRedactions` stream. */
export interface FakeWatch {
  readonly signal: AbortSignal;
  push(list: readonly string[]): void;
}

export interface HarnessOptions {
  /** The Threads `OpenThread` knows; default `thread-1` in `project-1`. */
  readonly threads?: Readonly<Record<string, FakeThread>>;
  /** What the part declares it calls; default {@link REQUIRES}. */
  readonly requires?: readonly string[];
  /** `Start` fails with this error before `started`. */
  readonly startError?: ContractError;
  /** `EnqueueTerminalResult` fails with this error. */
  readonly enqueueError?: ContractError;
  /** `FailTerminalResult` fails with this error. */
  readonly failError?: ContractError;
}

export interface Harness {
  readonly router: TestRouter;
  readonly host: TerminalProcessHost;
  /** Every fake call, in order. */
  readonly calls: FakeCall[];
  /** Coarse events in order: `workspace.openThread`, `workspace.threadState`, `secrets.redactions`, `lease.start`, `lease.started`, `workspace.session.cancelled`, `lease.cancelled`, … */
  readonly timeline: string[];
  readonly toolRegisters: JsonValue[];
  readonly hookRegisters: JsonValue[];
  readonly sessions: FakeSession[];
  readonly processes: FakeProcess[];
  readonly watches: FakeWatch[];
  /** Sets what `Redactions` answers from now on. */
  setRedactions(list: readonly string[]): void;
  terminal(scope?: CallScope): Client<typeof TerminalService>;
  tools(scope?: CallScope): Client<typeof ToolHandlerService>;
  hooks(): Client<typeof HookHandlerService>;
  /** Activates the part as `main.ts` does. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
}

const defaultThreads: Readonly<Record<string, FakeThread>> = {
  'thread-1': { projectId: 'project-1', cwd: '/workspace/app' },
};

/** `terminal`'s host part on a test router, not yet activated. */
export const harness = (options: HarnessOptions = {}): Harness => {
  const host = createTerminalProcessHost();
  const threads = options.threads ?? defaultThreads;
  const calls: FakeCall[] = [];
  const timeline: string[] = [];
  const toolRegisters: JsonValue[] = [];
  const hookRegisters: JsonValue[] = [];
  const sessions: FakeSession[] = [];
  const processes: FakeProcess[] = [];
  const watches: FakeWatch[] = [];
  const sessionThreads = new Map<string, string>();
  let redactions: readonly string[] = [];
  let ids = 0;

  const record = (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ) => {
    const call = callOf(context);

    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
    });
    timeline.push(method);

    return call;
  };

  const workspace = fakeOf(WorkspaceService, {
    cwd: (_request, context) => {
      const call = record('workspace.cwd', {}, context);

      return { cwd: threads[call.scope?.threadId ?? '']?.cwd ?? '/workspace' };
    },
    openThread: async function* (request, context) {
      const json = toJson(OpenThreadRequestSchema, request, {
        alwaysEmitImplicit: true,
      });
      const call = record('workspace.openThread', json, context);
      const thread = threads[request.threadId];
      const status =
        thread === undefined ? 'missing' : (thread.status ?? 'ready');

      if (thread === undefined || status !== 'ready') {
        sessions.push({ request: json, scope: call.scope, cancelled: true });
        yield fromJson(OpenThreadResponseSchema, { [status]: {} });

        return;
      }

      ids += 1;
      const threadSessionId = `session-${ids}`;
      const session: FakeSession = {
        request: json,
        scope: call.scope,
        threadSessionId,
        cancelled: false,
      };

      sessions.push(session);
      sessionThreads.set(threadSessionId, request.threadId);

      try {
        yield {
          status: {
            case: 'ready',
            value: {
              threadSessionId,
              projectId: thread.projectId,
              threadId: request.threadId,
              cwd: thread.cwd,
              sandboxId: 'sandbox-1',
            },
          },
        };
        await aborted(context.signal);
      } finally {
        session.cancelled = true;
        timeline.push('workspace.session.cancelled');
      }
    },
    threadState: (request, context) => {
      record(
        'workspace.threadState',
        { threadSessionId: request.threadSessionId },
        context,
      );
      const threadId = sessionThreads.get(request.threadSessionId) ?? '';

      return { closing: threads[threadId]?.closing ?? false, busyCwds: [] };
    },
  });

  const lease = leaseFake({
    ...(options.startError === undefined
      ? {}
      : { startError: options.startError }),
    record,
    processes,
    timeline,
  });

  const secrets = fakeOf(SecretsService, {
    redactions: (_request, context) => {
      record('secrets.redactions', {}, context);

      return { redactions: [...redactions] };
    },
    watchRedactions: async function* (_request, context) {
      record('secrets.watchRedactions', {}, context);
      const lists = channel<readonly string[]>();

      watches.push({ signal: context.signal, push: lists.push });
      context.signal.addEventListener('abort', () => lists.close(), {
        once: true,
      });

      for await (const list of lists.drain()) {
        yield { redactions: [...list] };
      }
    },
  });

  const runtimeThreads = fakeOf(ThreadsService, {
    enqueueTerminalResult: (request, context) => {
      record(
        'threads.enqueueTerminalResult',
        toJson(EnqueueTerminalResultRequestSchema, request),
        context,
      );

      if (options.enqueueError !== undefined) throw options.enqueueError;

      return {};
    },
    failTerminalResult: (request, context) => {
      record(
        'threads.failTerminalResult',
        toJson(FailTerminalResultRequestSchema, request),
        context,
      );

      if (options.failError !== undefined) throw options.failError;

      return {};
    },
  });

  const router = createTestRouter({
    requires: options.requires ?? REQUIRES,
    instance: { bundleId: 'terminal' },
    fakes: [
      fakeOf(ToolsService, {
        register: (request) => {
          toolRegisters.push(toJson(ToolRegisterRequestSchema, request));

          return { registrationId: `tool-${toolRegisters.length}` };
        },
        unregister: () => ({}),
      }),
      fakeOf(HooksService, {
        register: (request) => {
          hookRegisters.push(toJson(HookRegisterRequestSchema, request));

          return { registrationId: `hook-${hookRegisters.length}` };
        },
        unregister: () => ({}),
      }),
      secrets,
      workspace,
      runtimeThreads,
      lease,
    ],
  });

  const services = () =>
    [
      [TerminalService, host.terminal],
      [ToolHandlerService, host.tools.implementation],
      [HookHandlerService, host.hooks.implementation],
    ] as const;

  return {
    router,
    host,
    calls,
    timeline,
    toolRegisters,
    hookRegisters,
    sessions,
    processes,
    watches,
    setRedactions: (list) => {
      redactions = list;
    },
    terminal: (scope) =>
      router.client(TerminalService, scope === undefined ? {} : { scope }),
    tools: (scope = promptScope) =>
      router.client(ToolHandlerService, { caller: core, scope }),
    hooks: () => router.client(HookHandlerService, { caller: core }),
    activate: async () => {
      await router.activate({
        services: services(),
        activate: (context) => host.activate(context),
        deactivate: () => host.deactivate(),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        activate: () => undefined,
      });
    },
  };
};
