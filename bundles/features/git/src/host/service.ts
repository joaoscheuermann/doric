// git.commands/v1 (stage 10, §3.8): the Git reads and the branch switch the
// workspace window makes, moved from the runtime's `service.ts` (`git`,
// `branches`, `diff`, `changes`, `fileDiff`). The method bodies are
// `createGitCommands` (`commands.ts`) over the kernel ports: Thread reads run
// on the live Thread through `runtime.workspace/v1.withThread`, Project reads
// on the Project's current lease through `runtime.lease/v1.withLease`; neither
// ever acquires a lease, and every lease or Thread state is an answer, not a
// failure.

import {
  type Call,
  defineMethod,
  defineService,
  type Services,
} from 'bundle/contracts';
import type { TerminalService } from 'terminal/contracts';

import {
  type BranchSwitch,
  type Discard,
  GitCommandsV1,
  gitMethods,
} from '../contracts/index.js';
import { createGitCommands } from './commands.js';
import { kernelGitCommandPorts } from './ports.js';

export { busyMessage, staleCwdMessage } from './commands.js';

/** The Project's tracked terminals, while some provider lists them. */
export type TerminalList = () => Pick<TerminalService, 'list'> | undefined;

/** `git.commands/v1`; `terminals` serves the busy check while it is available. */
export const createGitService = (terminals: TerminalList) => {
  const commands = (services: Services, call: Call) =>
    createGitCommands(kernelGitCommandPorts(services, call, terminals));

  return defineService(GitCommandsV1, {
    status: defineMethod({
      expose: 'desktop',
      ...gitMethods.status,
      execute: (threadId: string, call: Call, services) =>
        commands(services, call).status(threadId),
    }),
    branches: defineMethod({
      expose: 'desktop',
      ...gitMethods.branches,
      execute: (threadId: string, call: Call, services) =>
        commands(services, call).branches(threadId),
    }),
    switchBranch: defineMethod({
      expose: 'desktop',
      ...gitMethods.switchBranch,
      execute: (
        input: {
          readonly threadId: string;
          readonly branch: string;
          readonly cwd: string;
        },
        call: Call,
        services,
      ): Promise<BranchSwitch> => commands(services, call).switchBranch(input),
    }),
    discard: defineMethod({
      expose: 'desktop',
      ...gitMethods.discard,
      execute: (
        input: {
          readonly threadId: string;
          readonly cwd: string;
          readonly repository: string;
          readonly paths?: readonly string[];
        },
        call: Call,
        services,
      ): Promise<Discard> => commands(services, call).discard(input),
    }),
    changes: defineMethod({
      expose: 'desktop',
      ...gitMethods.changes,
      execute: (input: { readonly path?: string }, call: Call, services) =>
        commands(services, call).changes(input),
    }),
    diff: defineMethod({
      expose: 'desktop',
      ...gitMethods.diff,
      execute: (input: { readonly path?: string }, call: Call, services) =>
        commands(services, call).diff(input),
    }),
    fileDiff: defineMethod({
      expose: 'desktop',
      ...gitMethods.fileDiff,
      execute: (
        input: { readonly repository: string; readonly path: string },
        call: Call,
        services,
      ) => commands(services, call).fileDiff(input),
    }),
  });
};
