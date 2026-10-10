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
import type { Bindings } from '../domain/bindings.js';
import type { WorkspaceService } from '../domain/types.js';
import type { ProjectResourcesReader } from '../peers.js';

/*
 * runtime.lease/v1 (design 57 §2.5): the stage-1 sandbox operations of the
 * calling prompt, as the stage-1 adapter forwarded them, plus the
 * lease-dependent reads of the current routes, which answer the lease state
 * without acquiring.
 */

const describe = ({ id, root }: Sandbox) => ({ id, root });

const scoped = (call: Call, key: 'projectId' | 'threadId'): string => {
  const id = call.scope?.[key];
  if (id === undefined)
    throw new ContractError('invalid_input', leaseScopeMessage);
  return id;
};

export const leaseService = ({
  service,
  bindings,
  resources = () => undefined,
}: {
  readonly service: WorkspaceService;
  readonly bindings: Bindings;
  /**
   * The `resources` bundle's `resources/v1` while one is active: it reads the
   * container since stage 10 (§3.12), so the deprecated `resources` read
   * delegates to it on the caller's scope.
   */
  readonly resources?: () => ProjectResourcesReader | undefined;
}) =>
  defineService(RuntimeLeaseV1, {
    describe: defineMethod({
      ...methods.describe,
      execute: async (_input, call) => describe(bindings.bound(call).sandbox),
    }),
    exec: defineMethod({
      ...methods.exec,
      execute: async (input, call) => {
        // No abort signal reaches the sandbox, as no tool ever passed one.
        const result = await bindings.bound(call).sandbox.exec(input);

        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    }),
    readFile: defineMethod({
      ...methods.readFile,
      execute: (path, call) => bindings.bound(call).sandbox.readFile(path),
    }),
    writeFile: defineMethod({
      ...methods.writeFile,
      execute: async ([path, content], call) => {
        await bindings.bound(call).sandbox.writeFile(path, content);
      },
    }),
    ssh: defineMethod({
      ...methods.ssh,
      execute: (_input, call) =>
        service.projects.ssh(scoped(call, 'projectId')),
    }),
    files: defineMethod({
      ...methods.files,
      execute: ({ path }, call) =>
        service.projects.files(scoped(call, 'projectId'), path),
    }),
    tree: defineMethod({
      ...methods.tree,
      execute: ({ path }, call) =>
        service.projects.tree(scoped(call, 'projectId'), path),
    }),
    file: defineMethod({
      ...methods.file,
      execute: ({ path }, call) =>
        service.projects.file(scoped(call, 'projectId'), path),
    }),
    diff: defineMethod({
      ...methods.diff,
      execute: ({ path }, call) =>
        service.projects.diff(scoped(call, 'projectId'), path),
    }),
    changes: defineMethod({
      ...methods.changes,
      execute: ({ path }, call) =>
        service.projects.changes(scoped(call, 'projectId'), path),
    }),
    fileDiff: defineMethod({
      ...methods.fileDiff,
      execute: ({ repository, path }, call) =>
        service.projects.fileDiff(scoped(call, 'projectId'), repository, path),
    }),
    resources: defineMethod({
      ...methods.resources,
      execute: async (_input, call) => {
        const projectId = scoped(call, 'projectId');
        const reader = resources();
        if (reader === undefined) return service.projects.resources(projectId);
        const outcome = await reader.project(call);
        return outcome.status === 'ready'
          ? { status: 'ready' as const, container: outcome.value }
          : { status: outcome.status };
      },
    }),
    git: defineMethod({
      ...methods.git,
      execute: (_input, call) => service.threads.git(scoped(call, 'threadId')),
    }),
    branches: defineMethod({
      ...methods.branches,
      execute: ({ branch, cwd }, call) =>
        service.threads.branches(scoped(call, 'threadId'), branch, cwd),
    }),
    withLease: defineMethod({
      ...methods.withLease,
      execute: async (task, call) =>
        service.projects.withLease(scoped(call, 'projectId'), task),
    }),
  });
