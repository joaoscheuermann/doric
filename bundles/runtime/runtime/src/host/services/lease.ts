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
import type { ProjectResourcesReader } from '../peers.js';

/*
 * runtime.lease/v1 (design 57 §2.5): the stage-1 sandbox operations of the
 * calling prompt, as the stage-1 adapter forwarded them, plus the
 * lease-dependent reads of the current routes, which answer the lease state
 * without acquiring.
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
    files: defineMethod({
      expose: 'desktop',
      ...methods.files,
      execute: ({ path }, call) =>
        service.projects.files(scoped(call, 'projectId'), path),
    }),
    tree: defineMethod({
      expose: 'desktop',
      ...methods.tree,
      execute: ({ path }, call) =>
        service.projects.tree(scoped(call, 'projectId'), path),
    }),
    file: defineMethod({
      expose: 'desktop',
      ...methods.file,
      execute: ({ path }, call) =>
        service.projects.file(scoped(call, 'projectId'), path),
    }),
    diff: defineMethod({
      expose: 'desktop',
      ...methods.diff,
      execute: ({ path }, call) =>
        service.projects.diff(scoped(call, 'projectId'), path),
    }),
    changes: defineMethod({
      expose: 'desktop',
      ...methods.changes,
      execute: ({ path }, call) =>
        service.projects.changes(scoped(call, 'projectId'), path),
    }),
    fileDiff: defineMethod({
      expose: 'desktop',
      ...methods.fileDiff,
      execute: ({ repository, path }, call) =>
        service.projects.fileDiff(scoped(call, 'projectId'), repository, path),
    }),
    resources: defineMethod({
      expose: 'desktop',
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
      expose: 'desktop',
      ...methods.git,
      execute: (_input, call) => service.threads.git(scoped(call, 'threadId')),
    }),
    branches: defineMethod({
      expose: 'desktop',
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
};
