// `git`'s host part as a process (phase 3, S55): the `git` tool and the `GIT`
// credential kind (S55b), and `git.commands/v1` (S55c) over the router.

import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError, callOf } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import {
  contractErrorOf,
  createToolHandlers,
  type HostContext,
  type HostServices,
  type ToolHandlers,
} from 'bundle/host';

import type { CommandsService } from '../contracts/gen/doric/git/commands/v1/commands_pb.js';
import {
  branchesResponseOf,
  changesResponseOf,
  diffResponseOf,
  discardInputOf,
  discardResponseOf,
  fileDiffResponseOf,
  statusResponseOf,
  switchBranchResponseOf,
} from './codec.js';
import { createGitCommands, type GitCommands } from './commands.js';
import { gitCredentialKind } from './credentials.js';
import { routedGitCommandPorts, routedGitToolPorts } from './routed.js';
import { createTool } from './tools/git.js';

export interface GitProcessHost {
  /**
   * `git.commands/v1` 1.2.0 over the router (S55c). Each method runs
   * `createGitCommands(routedGitCommandPorts(services, callOf(context)))`
   * and answers through `codec.ts`; `Discard` reads its input with
   * `discardInputOf`. Errors: `unavailable` "git is not activated." before
   * `activate` resolved, and after an `activate` refusal.
   */
  readonly commands: ServiceImpl<typeof CommandsService>;
  /** The tool table `main.ts` serves as `ToolHandlerService`. */
  readonly tools: ToolHandlers;
  /**
   * In this order:
   * 1. `context.registrations.track(SecretsService, …RegisterKind GIT…)`
   *    (D7), so the kind is replayed after a `core` restart;
   * 2. `tools.register(context, createTool().bind(routedGitToolPorts(
   *    context.services)), {alwaysAvailable: false, order: 900})`;
   * 3. binds the `git.commands/v1` services.
   * Resolves once both registrations resolved. Rejects with the first
   * refusal (`duplicate_credential_kind`, `duplicate_tool`,
   * `invalid_input`); after a kind refusal no tool is registered, and
   * `git.commands/v1` stays `unavailable` after any refusal.
   */
  activate(
    context: Pick<HostContext, 'services' | 'registrations'>,
  ): Promise<void>;
}

/** Builds the host part with no I/O; never throws. */
export const createGitProcessHost = (): GitProcessHost => {
  const tools = createToolHandlers();
  let services: HostServices | undefined;

  /** The operations under the handler's call; `unavailable` before `activate`. */
  const commandsOf = (context: HandlerContext): GitCommands => {
    if (services === undefined)
      throw new ContractError('unavailable', 'git is not activated.');
    return createGitCommands(routedGitCommandPorts(services, callOf(context)));
  };

  return {
    commands: {
      status: async (request, context) =>
        statusResponseOf(await commandsOf(context).status(request.threadId)),
      branches: async (request, context) =>
        branchesResponseOf(
          await commandsOf(context).branches(request.threadId),
        ),
      switchBranch: async (request, context) =>
        switchBranchResponseOf(
          await commandsOf(context).switchBranch({
            threadId: request.threadId,
            branch: request.branch,
            cwd: request.cwd,
          }),
        ),
      discard: async (request, context) =>
        discardResponseOf(
          await commandsOf(context).discard(discardInputOf(request)),
        ),
      changes: async (request, context) =>
        changesResponseOf(
          await commandsOf(context).changes(
            request.path === undefined ? {} : { path: request.path },
          ),
        ),
      diff: async (request, context) =>
        diffResponseOf(
          await commandsOf(context).diff(
            request.path === undefined ? {} : { path: request.path },
          ),
        ),
      fileDiff: async (request, context) =>
        fileDiffResponseOf(
          await commandsOf(context).fileDiff({
            repository: request.repository,
            path: request.path,
          }),
        ),
    },
    tools,
    activate: async (context) => {
      await context.registrations.track(SecretsService, async (client) => {
        try {
          return await client.registerKind({
            credentialKindDefinition: {
              id: gitCredentialKind.id,
              required: [...gitCredentialKind.required],
              optional: [...gitCredentialKind.optional],
              label: gitCredentialKind.label,
            },
          });
        } catch (error) {
          throw contractErrorOf(error);
        }
      });

      await tools.register(
        context,
        createTool().bind(routedGitToolPorts(context.services)),
        { alwaysAvailable: false, order: 900 },
      );
      services = context.services;
    },
  };
};
