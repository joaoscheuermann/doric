// `GitToolPorts` (phase 3, S55b) and `GitCommandPorts` (S55c) over the router:
// `runtime.workspace/v1`'s `WorkspaceService`, `runtime.lease/v1`'s
// `LeaseService` and the optional `terminal/v1`'s `TerminalService`.

import type { Client } from '@connectrpc/connect';
import { type Call, ContractError, isContractError } from 'bundle/contracts';
import { contractErrorOf, type HostServices } from 'bundle/host';
import {
  execRequestOf,
  execResultOf,
  leaseScopeMessage,
  runOnProjectLease,
  withThreadSession,
} from 'runtime/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';
import type { SandboxDiffInput } from 'sandbox';
import {
  TerminalService,
  type TerminalSession as TerminalSessionMessage,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import type {
  GitCommandPorts,
  GitToolPorts,
  TerminalListing,
} from './ports.js';
import type { LeaseSandbox } from './sandbox.js';

/** Runs `request`, rejecting with `contractErrorOf` of its failure. */
const routed = async <T>(request: () => Promise<T>): Promise<T> => {
  try {
    return await request();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** The `request` of `runtime.lease/v1.Diff` for `input`: `cwd` when present, `paths`. */
const diffRequestOf = (input: SandboxDiffInput = {}) => ({
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  paths: [...(input.paths ?? [])],
});

/**
 * A listed terminal as the busy check reads it. `origin` and `state` are
 * protovalidated to the domain's values (`in` rules), so each maps onto its
 * own value.
 */
const listingOf = (session: TerminalSessionMessage): TerminalListing => ({
  state:
    session.state === 'starting' || session.state === 'running'
      ? session.state
      : 'exited',
  origin: session.origin === 'agent' ? 'agent' : 'user',
  command: session.command,
  cwd: session.cwd,
});

/** The part of the prompt's sandbox the `git` tool reaches. */
type RoutedSandbox = Pick<LeaseSandbox, 'id' | 'root' | 'exec'>;

/**
 * The prompt's sandbox over `lease`: `Describe{target: {}}` once, then each
 * `exec` is a step of the same run, bound to the described sandbox with
 * `expectSandboxId`. A `Describe` failure rejects as `contractErrorOf` reads
 * it, including one carrying a `leaseStatus`.
 */
const routedLeaseSandbox = async (
  lease: Client<typeof LeaseService>,
): Promise<RoutedSandbox> => {
  // `runOnProjectLease` answers a `Describe` lease failure as a status; the
  // tool rejects with the provider's error instead, so it is kept here.
  let describeFailure: unknown;
  const outcome = await runOnProjectLease(
    {
      describe: (request) =>
        lease.describe(request).catch((error: unknown) => {
          describeFailure = contractErrorOf(error);
          throw error;
        }),
    },
    async ({ id, root, target, step }): Promise<RoutedSandbox> => ({
      id,
      root,
      // `execRequestOf` never sends the input's `signal`.
      exec: (input) =>
        routed(async () =>
          execResultOf(
            await step(() =>
              lease.exec({ target, request: execRequestOf(input) }),
            ),
          ),
        ),
    }),
  );

  if (outcome.status === 'ready') return outcome.value;

  throw describeFailure;
};

/** The router's workspace and lease clients, each made on first use. */
const routedClients = (services: Pick<HostServices, 'use'>) => {
  let workspaceClient: Client<typeof WorkspaceService> | undefined;
  let leaseClient: Client<typeof LeaseService> | undefined;
  return {
    workspace: () => (workspaceClient ??= services.use(WorkspaceService)),
    lease: () => (leaseClient ??= services.use(LeaseService)),
  };
};

/**
 * `GitToolPorts` over the router. Calls are made inside the
 * `ToolHandlerService.Execute` handler, so they carry its scope (the
 * prompt), deadline and signal:
 * - `cwd` → `runtime.workspace/v1.Cwd{}` → `cwd`;
 * - `sandbox` → `runtime.lease/v1.Describe{target: {}}` once; each `exec`
 *   is `Exec{target: {expectSandboxId: id}, request: execRequestOf(input)}`
 *   answered as `execResultOf`.
 * Failures reject as `contractErrorOf` reads them. Makes no call until a
 * method is called.
 */
export const routedGitToolPorts = (
  services: Pick<HostServices, 'use'>,
): GitToolPorts => {
  const { workspace, lease } = routedClients(services);

  return {
    cwd: () => routed(async () => (await workspace().cwd({})).cwd),
    sandbox: () => routedLeaseSandbox(lease()),
  };
};

/**
 * `GitCommandPorts` over the router for the handler call `call` (S55c):
 * - `withThread`: `''` → `{status: 'missing'}` with no call (D8); else
 *   `withThreadSession(WorkspaceService client, {threadId, exclusive,
 *   refreshHint?}, task')`. On `ready`, `Describe{target: {threadSessionId}}`
 *   gives `root`; the task's sandbox has `id` = `sandboxId`, `exec` =
 *   `Exec{target: {threadSessionId}, request}`, `diff(input)` =
 *   `Diff{target: {threadSessionId}, request: {cwd?, paths}}` → `diff`; its
 *   `busyCwds()` = `ThreadState{threadSessionId}.busyCwds`. The session ends
 *   when the task settles (D2).
 * - `withProjectLease`: `runOnProjectLease(services.use(LeaseService,
 *   {scope: {projectId}}), …)` with `projectId` = `call.scope.projectId`
 *   (D3); `exec` and `diff` as above with `steps.target`, each through
 *   `steps.step`. No `projectId` → throws `ContractError('invalid_input',
 *   leaseScopeMessage)` with no call.
 * - `terminals(projectId)`: `TerminalService.List{projectId}` →
 *   `terminals[].{state, origin, command, cwd}`; any `unavailable` → `[]`
 *   (D6).
 * Every other failure rejects as `contractErrorOf` reads it. Makes no call
 * until a method is called.
 */
export const routedGitCommandPorts = (
  services: Pick<HostServices, 'use'>,
  call: Call,
): GitCommandPorts => {
  const { workspace, lease } = routedClients(services);

  return {
    withThread: async (threadId, options, task) => {
      // `OpenThread` refuses an empty id; the kernel found no Thread (D8).
      if (threadId === '') return { status: 'missing' };

      return await routed(() =>
        withThreadSession(
          workspace(),
          {
            threadId,
            exclusive: options.exclusive,
            ...(options.refreshHint === undefined
              ? {}
              : { refreshHint: options.refreshHint }),
          },
          async (session) => {
            const target = { threadSessionId: session.threadSessionId };
            const { root } = await lease().describe({ target });

            return await task({
              projectId: session.projectId,
              threadId: session.threadId,
              cwd: session.cwd,
              sandbox: {
                id: session.sandboxId,
                root,
                exec: (input) =>
                  routed(async () =>
                    execResultOf(
                      await lease().exec({
                        target,
                        request: execRequestOf(input),
                      }),
                    ),
                  ),
                diff: (input) =>
                  routed(
                    async () =>
                      (
                        await lease().diff({
                          target,
                          request: diffRequestOf(input),
                        })
                      ).response?.diff ?? '',
                  ),
              },
              busyCwds: () =>
                routed(
                  async () =>
                    (
                      await workspace().threadState({
                        threadSessionId: session.threadSessionId,
                      })
                    ).busyCwds,
                ),
            });
          },
        ),
      );
    },
    withProjectLease: async (task) => {
      // The Project's lease, never the prompt's (D3).
      const projectId = call.scope?.projectId;
      if (projectId === undefined)
        throw new ContractError('invalid_input', leaseScopeMessage);
      const project = services.use(LeaseService, { scope: { projectId } });

      return await runOnProjectLease(project, ({ id, root, target, step }) =>
        task({
          id,
          root,
          exec: async (input) =>
            execResultOf(
              await step(() =>
                project.exec({ target, request: execRequestOf(input) }),
              ),
            ),
          diff: async (input) =>
            (
              await step(() =>
                project.diff({ target, request: diffRequestOf(input) }),
              )
            ).response?.diff ?? '',
        }),
      );
    },
    terminals: async (projectId) => {
      try {
        const { terminals } = await services
          .use(TerminalService)
          .list({ projectId });
        return terminals.map(listingOf);
      } catch (error) {
        const failure = contractErrorOf(error);
        // No provider, or none active: no terminals, as the kernel's gap (D6).
        if (isContractError(failure) && failure.code === 'unavailable')
          return [];
        throw failure;
      }
    },
  };
};
