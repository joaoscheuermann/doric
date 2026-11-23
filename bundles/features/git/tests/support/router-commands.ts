// The harness of `git.commands/v1` served by `git`'s host part through the
// router (phase 3, S55c): `createGitProcessHost()` activated as
// `src/host/main.ts` does (`commands` as `CommandsService`, the tool table as
// `ToolHandlerService`, `activate`), over recording fakes of section D:
// - `runtime.workspace/v1`: `OpenThread` answers a settable Thread state;
//   `ready` opens a session that lives until the caller cancels the stream
//   (or the test ends it), `ThreadState` answers settable `busyCwds`;
// - `runtime.lease/v1`: `Describe`, `Exec`, `Diff` over a real-git sandbox,
//   for a session target (`unknown_session` once it ended) or the Project
//   lease (a settable state; `expectSandboxId` checked; a sandbox switch
//   after `Describe`), with an optional step failure;
// - `terminal/v1`: `List` over a settable list or a failure, or no fake at
//   all (no provider);
// - `secrets/v1`, `tools/v1`: the registrations `activate` makes.

import {
  type DescMessage,
  type DescService,
  fromJson,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { type CallScope, ContractError, callOf } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  DescribeRequestSchema,
  DiffRequestSchema,
  ExecRequestSchema,
  LeaseService,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  OpenThreadRequestSchema,
  OpenThreadResponseSchema,
  ThreadStateRequestSchema,
  WorkspaceService,
} from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import type { Sandbox } from 'sandbox';
import type { TerminalSession } from 'terminal/contracts';
import {
  ListRequestSchema,
  TerminalService,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import { CommandsService } from '../../src/contracts/gen/doric/git/commands/v1/commands_pb.js';
import { createGitProcessHost } from '../../src/host/part.js';
import { REQUIRES } from './router.js';

/** A desktop call's scope: the Project, the Thread and a prompt. */
export const desktopScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/** The sandbox id a Thread session runs on. */
export const SESSION_SANDBOX = 'sandbox-session';

export type ThreadStatus = 'ready' | 'missing' | 'inactive' | 'pending';
export type LeaseStatus =
  | 'ready'
  | 'pending'
  | 'unavailable'
  | 'expired'
  | 'missing';

/** One call a fake received. */
export interface FakeCall {
  /** `workspace`, `lease`, `terminal`, `secrets` or `tools`. */
  readonly service: string;
  /** The method, lowerCamel (`openThread`, `describe`, `exec`, `diff`, …). */
  readonly method: string;
  /** The request as JSON (implicit fields emitted for `openThread`). */
  readonly request: JsonValue;
  /** `callOf(context).scope` of the call. */
  readonly scope: CallScope | undefined;
}

/** One session `OpenThread` opened. */
export interface FakeSession {
  readonly threadSessionId: string;
  /** The stream was cancelled (the caller ended the session). */
  cancelled: boolean;
  /** Later session calls fail `unknown_session`. */
  ended: boolean;
}

/** What the fakes answer, settable while a test runs. */
export interface CommandsState {
  /** `OpenThread`'s answer. */
  thread: ThreadStatus;
  /** The Thread's working directory in `ready`. */
  cwd: string;
  /** `ThreadState.busyCwds`. */
  busyCwds: string[];
  /** `terminal/v1.List`'s sessions. */
  terminals: TerminalSession[];
  /** When set, `terminal/v1.List` fails with it. */
  terminalError?: ContractError;
  /** The Project lease's state; not `ready` fails Project calls with it. */
  lease: LeaseStatus;
  /** The Project's sandbox id; `expectSandboxId` must match it. */
  sandboxId: string;
  /** When set, a Project `Describe` answers and then the id becomes this. */
  switchAfterDescribe?: string;
  /** A session's `Describe` answers and then ends the session. */
  endSessionAfterDescribe: boolean;
  /** When set, every `Exec` and `Diff` fails with it. */
  stepError?: ContractError;
}

export interface CommandsHarnessOptions {
  /** The workspace behind both the sessions and the Project lease. */
  readonly sandbox: Pick<Sandbox, 'root' | 'exec' | 'diff'>;
  /** Whether a `terminal/v1` fake exists (default true). */
  readonly terminal?: boolean;
  /** Overrides of the initial state. */
  readonly state?: Partial<CommandsState>;
}

export interface CommandsHarness {
  readonly router: TestRouter;
  /** A client of the bundle's `CommandsService` under `scope` (default {@link desktopScope}). */
  client(scope?: CallScope): Client<typeof CommandsService>;
  readonly calls: FakeCall[];
  readonly sessions: FakeSession[];
  readonly state: CommandsState;
  /** The calls of one fake service (and method). */
  callsOf(service: string, method?: string): FakeCall[];
  /** Activates the part as `main.ts` does. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveUnactivated(): Promise<void>;
}

const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** `git.commands/v1` of a fresh host part on a test router; not yet activated. */
export const commandsHarness = (
  options: CommandsHarnessOptions,
): CommandsHarness => {
  const { sandbox } = options;
  const calls: FakeCall[] = [];
  const sessions: FakeSession[] = [];
  const state: CommandsState = {
    thread: 'ready',
    cwd: sandbox.root,
    busyCwds: [],
    terminals: [],
    lease: 'ready',
    sandboxId: 'sandbox-1',
    endSessionAfterDescribe: false,
    ...options.state,
  };

  const record = <Desc extends DescMessage>(
    service: string,
    method: string,
    schema: Desc,
    request: MessageShape<Desc>,
    context: HandlerContext,
    alwaysEmitImplicit = false,
  ): void => {
    calls.push({
      service,
      method,
      request: toJson(schema, request, { alwaysEmitImplicit }),
      scope: callOf(context).scope,
    });
  };

  const liveSession = (id: string): FakeSession => {
    const session = sessions.find((item) => item.threadSessionId === id);
    if (session === undefined || session.ended)
      throw new ContractError('unknown_session', `No Thread session ${id}.`);
    return session;
  };

  const leaseFailure = (status: LeaseStatus): ContractError =>
    new ContractError('unavailable', `The lease is ${status}.`, {
      leaseStatus: status,
    });

  /** Checks a target as runtime's lease does; answers the session, if any. */
  const checked = (
    target: { threadSessionId?: string; expectSandboxId?: string } | undefined,
  ): FakeSession | undefined => {
    if (target?.threadSessionId !== undefined)
      return liveSession(target.threadSessionId);
    if (state.lease !== 'ready') throw leaseFailure(state.lease);
    if (
      target?.expectSandboxId !== undefined &&
      target.expectSandboxId !== state.sandboxId
    )
      throw leaseFailure('unavailable');
    return undefined;
  };

  const workspace = fakeOf(WorkspaceService, {
    openThread: async function* (request, context) {
      record(
        'workspace',
        'openThread',
        OpenThreadRequestSchema,
        request,
        context,
        true,
      );
      if (state.thread !== 'ready') {
        yield fromJson(OpenThreadResponseSchema, { [state.thread]: {} });
        return;
      }
      const session: FakeSession = {
        threadSessionId: `session-${sessions.length + 1}`,
        cancelled: false,
        ended: false,
      };
      sessions.push(session);
      try {
        yield {
          status: {
            case: 'ready',
            value: {
              threadSessionId: session.threadSessionId,
              projectId: 'project-1',
              threadId: request.threadId,
              cwd: state.cwd,
              sandboxId: SESSION_SANDBOX,
            },
          },
        };
        await aborted(context.signal);
      } finally {
        session.cancelled = true;
        session.ended = true;
      }
    },
    threadState: (request, context) => {
      record(
        'workspace',
        'threadState',
        ThreadStateRequestSchema,
        request,
        context,
      );
      liveSession(request.threadSessionId);
      return { closing: false, busyCwds: [...state.busyCwds] };
    },
  });

  const lease = fakeOf(LeaseService, {
    describe: (request, context) => {
      record('lease', 'describe', DescribeRequestSchema, request, context);
      const session = checked(request.target);
      if (session !== undefined) {
        if (state.endSessionAfterDescribe) session.ended = true;
        return { id: SESSION_SANDBOX, root: sandbox.root };
      }
      const answer = { id: state.sandboxId, root: sandbox.root };
      if (state.switchAfterDescribe !== undefined)
        state.sandboxId = state.switchAfterDescribe;
      return answer;
    },
    exec: async (request, context) => {
      record('lease', 'exec', ExecRequestSchema, request, context);
      checked(request.target);
      if (state.stepError !== undefined) throw state.stepError;
      const input = request.request;
      const result = await sandbox.exec({
        cmd: [...(input?.cmd ?? [])],
        ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input?.env.length ? { env: [...input.env] } : {}),
        ...(input?.timeoutMs === undefined
          ? {}
          : { timeoutMs: input.timeoutMs }),
      });
      return {
        response: {
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        },
      };
    },
    diff: async (request, context) => {
      record('lease', 'diff', DiffRequestSchema, request, context);
      checked(request.target);
      if (state.stepError !== undefined) throw state.stepError;
      const input = request.request;
      const diff = await sandbox.diff({
        ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input?.paths.length ? { paths: [...input.paths] } : {}),
      });
      return { response: { diff } };
    },
  });

  const terminal = fakeOf(TerminalService, {
    list: (request, context) => {
      record('terminal', 'list', ListRequestSchema, request, context);
      if (state.terminalError !== undefined) throw state.terminalError;
      return {
        terminals: state.terminals.map(({ timeoutMs, ...item }) => ({
          ...item,
          ...(timeoutMs === null ? {} : { timeoutMs }),
        })),
      };
    },
  });

  const router = createTestRouter({
    scope: desktopScope,
    requires: REQUIRES,
    instance: { bundleId: 'git' },
    fakes: [
      fakeOf(ToolsService, {
        register: () => ({ registrationId: 'tool-1' }),
        unregister: () => ({}),
      }),
      fakeOf(SecretsService, {
        registerKind: () => ({ registrationId: 'kind-1' }),
        unregister: () => ({}),
      }),
      workspace,
      lease,
      ...(options.terminal === false ? [] : [terminal]),
    ],
  });

  const serve = async (run: boolean): Promise<void> => {
    const host = createGitProcessHost();
    await router.activate({
      services: [
        [CommandsService, host.commands],
        [ToolHandlerService, host.tools.implementation],
      ],
      activate: run ? host.activate : async () => undefined,
    });
  };

  return {
    router,
    client: (scope = desktopScope) => router.client(CommandsService, { scope }),
    calls,
    sessions,
    state,
    callsOf: (service, method) =>
      calls.filter(
        (call) =>
          call.service === service &&
          (method === undefined || call.method === method),
      ),
    activate: () => serve(true),
    serveUnactivated: () => serve(false),
  };
};
