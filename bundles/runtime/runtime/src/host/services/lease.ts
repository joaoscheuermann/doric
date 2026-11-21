import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

import {
  leaseScopeMessage,
  runtimeLeaseMethods as methods,
  RuntimeLeaseV1,
} from '../../contracts/lease.js';
import { readRuntimeScope } from '../../contracts/scope.js';
import type { Bindings } from '../domain/bindings.js';
import type { WorkspaceService } from '../domain/types.js';

/*
 * runtime.lease/v1 (design 57 §2.5): the stage-1 sandbox operations of the
 * calling prompt, as the stage-1 adapter forwarded them, plus `ssh` and
 * `withLease`, which answer the lease state without acquiring. The other
 * lease reads left with 1.3.0 (bundle isolation 7(c)) for the bundles that
 * own them.
 */

const describe = ({ id, root }: Sandbox) => ({ id, root });

const scoped = (call: Call, key: 'projectId' | 'threadId'): string => {
  const id = readRuntimeScope(call)[key];
  if (id === undefined)
    throw new ContractError('invalid_input', leaseScopeMessage);
  return id;
};

export const leaseService = ({
  service,
  bindings,
}: {
  readonly service: WorkspaceService;
  readonly bindings: Bindings;
}) => {
  const runWithSandbox = async <T>(
    call: Call,
    operation: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> => {
    const scope = readRuntimeScope(call);
    if (scope.promptId !== undefined) {
      return operation(bindings.bound(call).sandbox);
    }

    let projectId = scope.projectId;
    if (projectId === undefined && scope.threadId !== undefined) {
      const thread = await service.threads.find(scope.threadId);
      projectId = thread?.projectId;
    }
    if (projectId === undefined) {
      const active = await service.projects.activity();
      if (active.length > 0) {
        projectId = active[0]?.project.id;
      }
    }
    if (projectId !== undefined) {
      const outcome = await service.projects.withLease(projectId, operation);
      if (outcome.status === 'ready') {
        return outcome.value;
      }
      throw new ContractError(
        'unavailable',
        `Project lease is not ready (${outcome.status}).`,
      );
    }
    throw new ContractError('invalid_input', leaseScopeMessage);
  };

  return defineService(RuntimeLeaseV1, {
    describe: defineMethod({
      ...methods.describe,
      execute: async (_input, call) =>
        runWithSandbox(call, async (sandbox) => describe(sandbox)),
    }),
    exec: defineMethod({
      ...methods.exec,
      execute: async (input, call) =>
        runWithSandbox(call, async (sandbox) => {
          // No abort signal reaches the sandbox, as no tool ever passed one.
          const result = await sandbox.exec(input);

          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }),
    }),
    readFile: defineMethod({
      ...methods.readFile,
      execute: (path, call) =>
        runWithSandbox(call, (sandbox) => sandbox.readFile(path)),
    }),
    readFileBytes: defineMethod({
      ...methods.readFileBytes,
      execute: (path, call) =>
        runWithSandbox(call, async (sandbox) =>
          Buffer.from(await sandbox.getFile(path)).toString('base64'),
        ),
    }),
    writeFile: defineMethod({
      ...methods.writeFile,
      execute: async ([path, content], call) => {
        await runWithSandbox(call, async (sandbox) => {
          await sandbox.writeFile(path, content);
        });
      },
    }),
    ssh: defineMethod({
      ...methods.ssh,
      execute: (_input, call) =>
        service.projects.ssh(scoped(call, 'projectId')),
    }),
    withLease: defineMethod({
      ...methods.withLease,
      execute: async (task, call) =>
        service.projects.withLease(scoped(call, 'projectId'), task),
    }),
  });
};
