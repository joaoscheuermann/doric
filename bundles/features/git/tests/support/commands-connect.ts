// `git.commands/v1` as the window reaches it from slice S65c: the
// generated `CommandsService` over Connect, served by a fake `HostClients`
// (`./connect.ts`). Behind it, each RPC calls today's `Git` of the call's
// scope (`doric-scope-bin`) with the domain input the host part reads from
// the request, and writes its answer with the host's codec
// (`src/host/codec.ts`), as `createGitProcessHost` does; a refusal is sent
// as the host sends it (`toConnectError`).

import type { ServiceImpl } from '@connectrpc/connect';
import type { CallScope, ClientServices } from 'bundle/contracts';

import { CommandsService } from '../../src/contracts/gen/doric/git/commands/v1/commands_pb.js';
import type { Git } from '../../src/contracts/index.js';
import {
  branchesResponseOf,
  changesResponseOf,
  diffResponseOf,
  discardInputOf,
  discardResponseOf,
  fileDiffResponseOf,
  statusResponseOf,
  switchBranchResponseOf,
} from '../../src/host/codec.js';
import {
  connectFailure,
  fakeClientServices,
  fakeHostClients,
  type HostCall,
  scopeOf,
} from './connect.js';

/** Runs `answer`; a failure fails the call as the host sends it. */
const answered = async <T>(answer: () => Promise<T>): Promise<T> => {
  try {
    return await answer();
  } catch (error) {
    throw connectFailure(error);
  }
};

/** `CommandsService` over today's `git` of each call's scope. */
export const commandsOver = (
  git: (scope: CallScope) => Git,
): ServiceImpl<typeof CommandsService> => {
  const of = (context: { readonly requestHeader: Headers }): Git =>
    git(scopeOf(context) ?? {});

  return {
    status: (request, context) =>
      answered(async () =>
        statusResponseOf(await of(context).status(request.threadId)),
      ),
    branches: (request, context) =>
      answered(async () =>
        branchesResponseOf(await of(context).branches(request.threadId)),
      ),
    switchBranch: (request, context) =>
      answered(async () =>
        switchBranchResponseOf(
          await of(context).switchBranch({
            threadId: request.threadId,
            branch: request.branch,
            cwd: request.cwd,
          }),
        ),
      ),
    discard: (request, context) =>
      answered(async () =>
        discardResponseOf(await of(context).discard(discardInputOf(request))),
      ),
    changes: (request, context) =>
      answered(async () =>
        changesResponseOf(
          await of(context).changes(
            request.path === undefined ? {} : { path: request.path },
          ),
        ),
      ),
    diff: (request, context) =>
      answered(async () =>
        diffResponseOf(
          await of(context).diff(
            request.path === undefined ? {} : { path: request.path },
          ),
        ),
      ),
    fileDiff: (request, context) =>
      answered(async () =>
        fileDiffResponseOf(
          await of(context).fileDiff({
            repository: request.repository,
            path: request.path,
          }),
        ),
      ),
  };
};

/**
 * The git client part's window services: `services.use(CommandsService,
 * scope)` reaches `implementation` over Connect as the part `git`; `calls`
 * are the window's host calls, in order.
 */
export const gitWindow = (
  implementation: Partial<ServiceImpl<typeof CommandsService>>,
): { readonly services: ClientServices; readonly calls: HostCall[] } => {
  const { hostClients, calls } = fakeHostClients((router) => {
    router.service(CommandsService, implementation);
  });

  return {
    services: fakeClientServices({ bundleId: 'git', hostClients }).services,
    calls,
  };
};
