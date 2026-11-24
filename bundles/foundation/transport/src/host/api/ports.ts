import type {
  Models,
  Secrets,
  ToolCatalogEntry,
  Tools,
} from 'bundle/contracts';
import type { Files } from 'files/contracts';
import type { Git } from 'git/contracts';
import type { Resources } from 'resources/contracts';
import type {
  Configuration,
  Runtime,
  RuntimeLease,
  RuntimeThreads,
  SandboxProviderApi,
} from 'runtime/contracts';
import type { TerminalService } from 'terminal/contracts';
import type { Usage } from 'usage/contracts';

import type { LeaseScope, ProjectScope } from '../services.js';

/**
 * The calls the routes make, with today's domain shapes. Today's `TransportServices` is assignable to it (the kernel
 * passes it unchanged); `routedTransportPorts` implements it over the router. A method resolves as the kernel's does
 * (`undefined` for a missing record, outcome unions as data) and rejects with the callee's `ContractError`.
 */
export interface TransportPorts {
  readonly runtime: Pick<
    Runtime,
    | 'createProject'
    | 'projects'
    | 'renameProject'
    | 'setProjectColor'
    | 'project'
    | 'terminateProject'
    | 'deleteProject'
    | 'vmSsh'
  >;
  readonly threads: Pick<
    RuntimeThreads,
    | 'createThread'
    | 'threads'
    | 'thread'
    | 'renameThread'
    | 'setThreadCwd'
    | 'setThreadExecution'
    | 'prompt'
    | 'steer'
    | 'resume'
    | 'rewind'
    | 'compact'
    | 'threadEvents'
    | 'pause'
    | 'terminateThread'
    | 'deleteThread'
    | 'queue'
    | 'resumeQueue'
    | 'queuedPrompt'
    | 'editQueued'
    | 'removeQueued'
  >;
  /** `runtime.lease/v1` bound to `scope`; only `ssh` (the current lease state, never acquiring). */
  lease(scope: LeaseScope): Pick<RuntimeLease, 'ssh'>;
  files(scope: ProjectScope): Pick<Files, 'directory' | 'tree' | 'content'>;
  git(
    scope?: ProjectScope,
  ): Pick<
    Git,
    'status' | 'branches' | 'switchBranch' | 'diff' | 'changes' | 'fileDiff'
  >;
  readonly usage: Pick<Usage, 'thread'>;
  resources(scope?: ProjectScope): Pick<Resources, 'host' | 'project'>;
  readonly terminal: Pick<
    TerminalService,
    'list' | 'create' | 'snapshot' | 'input' | 'resize' | 'stop'
  >;
  readonly sandbox: Pick<SandboxProviderApi, 'machines' | 'machine'>;
  /**
   * `Tools.list` (the kernel answers it synchronously), or the catalog entries as `{tool}` (over the router, a
   * promise); the routes read only each tool's name, description and settings.
   */
  readonly tools: {
    list():
      | ReturnType<Tools['list']>
      | Promise<readonly { readonly tool: ToolCatalogEntry }[]>;
  };
  readonly models: Pick<Models, 'kinds' | 'kind' | 'catalog'>;
  readonly secrets: Pick<
    Secrets,
    'list' | 'kinds' | 'create' | 'update' | 'delete'
  >;
  readonly configuration: Pick<Configuration, 'current' | 'replace'>;
}
