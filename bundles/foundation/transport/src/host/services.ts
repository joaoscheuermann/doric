import type { Models, Secrets, Tools } from 'bundle/contracts';
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

/** The scope one lease read binds: a Project's lease, or a Thread's. */
export type LeaseScope =
  | { readonly projectId: string }
  | { readonly threadId: string };

/**
 * The scope a Project read of a feature bundle binds. A type alias, not an
 * interface: `CallScope` is `Readonly<Record<string, string>>`, which only an
 * object type (not an interface) is assignable to.
 */
export type ProjectScope = {
  readonly projectId: string;
};

/**
 * The contract stubs the routes and sockets call (design 57 §8.1). Each one
 * resolves its provider at call time, so a route reaches the generation that
 * is active when the request arrives. Since the stage-10 host switch the
 * Project file, Git, usage, resource and terminal routes call the feature
 * bundles' services (stage 10 §4).
 */
export interface TransportServices {
  readonly runtime: Runtime;
  readonly threads: RuntimeThreads;
  /** `runtime.lease/v1` bound to one request's Project or Thread (SSH). */
  lease(scope: LeaseScope): RuntimeLease;
  /** `files/v1` bound to one request's Project. */
  files(scope: ProjectScope): Files;
  /** `git.commands/v1`, bound to a Project for its Project reads. */
  git(scope?: ProjectScope): Git;
  readonly usage: Usage;
  /** `resources/v1`, bound to a Project for `project()`. */
  resources(scope?: ProjectScope): Resources;
  /** `terminal/v1` 1.1.0: the terminal sessions of every Project. */
  readonly terminal: TerminalService;
  readonly sandbox: SandboxProviderApi;
  readonly tools: Tools;
  readonly models: Models;
  readonly secrets: Secrets;
  readonly configuration: Configuration;
}
