// The harness of `git`'s host part through the router (phase 3, S55b): the
// `git` tool served from `ToolHandlerService` by `createTestRouter` as
// `src/host/main.ts` serves it (`createGitProcessHost()`, its
// `tools.implementation` and `activate`), with recording fakes of section
// D's services: `tools/v1` (`Register`), `secrets/v1` (`RegisterKind`, or a
// refusal), `runtime.workspace/v1` (`Cwd`, settable or failing) and
// `runtime.lease/v1` (`Describe` and `Exec` over a test sandbox, with a
// settable sandbox id that may switch after `Describe`). `core`'s calls to
// the handler service arrive through `router.client` with the caller `core`
// and the prompt scope. S55c adds `git.commands/v1` and `terminal/v1`.

import {
  type DescMessage,
  type DescService,
  fromJson,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  ContractError,
  callOf,
  fromConnectError,
} from 'bundle/contracts';
import {
  RegisterKindRequestSchema,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  RegisterRequestSchema,
  ToolHandlerService,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  DescribeRequestSchema,
  ExecRequestSchema,
  LeaseService,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  CwdRequestSchema,
  WorkspaceService,
} from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import type { Sandbox } from 'sandbox';
import { TerminalService } from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';
import type { Tool, ToolInput, ToolOutput } from 'tool';

import { createGitProcessHost } from '../../src/host/part.js';

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The scope of the `tools/v1.Execute` call `core` relays: one prompt. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/** The services `git`'s host part declares it calls (section D). */
export const REQUIRES = [
  ToolsService.typeName,
  WorkspaceService.typeName,
  LeaseService.typeName,
  SecretsService.typeName,
  TerminalService.typeName,
];

/** The sandbox the lease fake runs `Exec` on. */
export type ExecSandbox = Pick<Sandbox, 'id' | 'root' | 'exec'>;

/** One call a fake received. */
export interface FakeCall {
  /** `tools`, `secrets`, `workspace` or `lease`. */
  readonly service: string;
  /** The method, lowerCamel (`register`, `registerKind`, `cwd`, `exec`). */
  readonly method: string;
  /** The request as JSON (`register`, `registerKind`: implicit fields emitted). */
  readonly request: JsonValue;
  /** `callOf(context).scope` of the call. */
  readonly scope: CallScope | undefined;
}

/** What the fakes answer, settable while a test runs. */
export interface FakeState {
  /** The Thread's working directory `Cwd` answers. */
  cwd: string;
  /** When set, `Cwd` fails with it (e.g. `thread_control_inactive`). */
  cwdError?: ContractError;
  /** The described sandbox's id; a later `expectSandboxId` must match it. */
  sandboxId: string;
  /** When set, `Describe` answers and then the sandbox id becomes this. */
  switchAfterDescribe?: string;
}

export interface HarnessOptions {
  /** The sandbox behind `runtime.lease/v1`. */
  readonly sandbox: ExecSandbox;
  /** The Thread's working directory (`/workspace` by default). */
  readonly cwd?: string;
  /** When set, `secrets/v1.RegisterKind` fails with it. */
  readonly registerKindError?: ContractError;
}

export interface Harness {
  readonly router: TestRouter;
  /** `core`'s client of the bundle's `ToolHandlerService`, under {@link promptScope}. */
  readonly client: Client<typeof ToolHandlerService>;
  /** Every call the fakes received, in order. */
  readonly calls: FakeCall[];
  /** The fakes' state. */
  readonly state: FakeState;
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/**
 * `git`'s host part on a test router, not yet activated: `services` lists
 * `ToolHandlerService` (`host.tools.implementation`) and `activate` is
 * `host.activate`, as `main.ts` does.
 */
export const harness = (options: HarnessOptions): Harness => {
  const { sandbox } = options;
  const calls: FakeCall[] = [];
  const state: FakeState = {
    cwd: options.cwd ?? '/workspace',
    sandboxId: sandbox.id,
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

  /** Fails as runtime's lease does for another sandbox than `expectSandboxId`. */
  const check = (target: { expectSandboxId?: string } | undefined): void => {
    if (
      target?.expectSandboxId !== undefined &&
      target.expectSandboxId !== state.sandboxId
    ) {
      throw new ContractError('unavailable', 'The sandbox changed.', {
        leaseStatus: 'unavailable',
      });
    }
  };

  const router = createTestRouter({
    caller: core,
    scope: promptScope,
    requires: REQUIRES,
    instance: { bundleId: 'git' },
    fakes: [
      fakeOf(ToolsService, {
        register: (request, context) => {
          record(
            'tools',
            'register',
            RegisterRequestSchema,
            request,
            context,
            true,
          );

          return { registrationId: 'tool-1' };
        },
        unregister: () => ({}),
      }),
      fakeOf(SecretsService, {
        registerKind: (request, context) => {
          record(
            'secrets',
            'registerKind',
            RegisterKindRequestSchema,
            request,
            context,
            true,
          );
          if (options.registerKindError !== undefined) {
            throw options.registerKindError;
          }

          return { registrationId: 'kind-1' };
        },
        unregister: () => ({}),
      }),
      fakeOf(WorkspaceService, {
        cwd: (request, context) => {
          record('workspace', 'cwd', CwdRequestSchema, request, context);
          if (state.cwdError !== undefined) throw state.cwdError;

          return { cwd: state.cwd };
        },
      }),
      fakeOf(LeaseService, {
        describe: (request, context) => {
          record('lease', 'describe', DescribeRequestSchema, request, context);
          check(request.target);
          const answer = { id: state.sandboxId, root: sandbox.root };

          if (state.switchAfterDescribe !== undefined) {
            state.sandboxId = state.switchAfterDescribe;
          }

          return answer;
        },
        exec: async (request, context) => {
          record('lease', 'exec', ExecRequestSchema, request, context);
          check(request.target);
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
              ...(result.exitCode === null
                ? {}
                : { exitCode: result.exitCode }),
              stdout: result.stdout,
              stderr: result.stderr,
              stdoutBytes: result.stdoutBytes,
              stderrBytes: result.stderrBytes,
            },
          };
        },
      }),
    ],
  });

  return {
    router,
    client: router.client(ToolHandlerService),
    calls,
    state,
    activate: async () => {
      const host = createGitProcessHost();

      await router.activate({
        services: [[ToolHandlerService, host.tools.implementation]],
        activate: host.activate,
      });
    },
  };
};

/**
 * `definition`'s tool as `core` calls it (S68b: the suites of the kernel-bound
 * tool run here): each `execute` serves the part on a fresh test router over
 * `sandbox`, with `Cwd` answering `cwd()` at that moment, activates it, sends
 * `Execute{name: definition.name, payload}` under {@link promptScope} and
 * stops the router. The answer is the result as parsed JSON; a failure
 * rejects with its Doric error.
 */
export const routedTool = <I extends ToolInput, O extends ToolOutput>(
  definition: { readonly name: string; readonly input: I; readonly output: O },
  sandbox: ExecSandbox,
  cwd: () => string,
): Pick<Tool<I, O>, 'execute'> => ({
  execute: async (payload) => {
    const h = harness({ sandbox, cwd: cwd() });

    try {
      await h.activate();
      const { result } = await h.client
        .execute({
          name: definition.name,
          payload: fromJson(ValueSchema, payload as unknown as JsonValue),
        })
        .catch((error: unknown) => {
          throw error instanceof ConnectError ? fromConnectError(error) : error;
        });

      return (
        result === undefined ? undefined : toJson(ValueSchema, result)
      ) as Awaited<ReturnType<Tool<I, O>['execute']>>;
    } finally {
      await h.router.control.stop();
    }
  },
});
