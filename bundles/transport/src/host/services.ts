import type { Models, Secrets, Tools } from 'bundle/contracts';
import type {
  Configuration,
  Runtime,
  RuntimeLease,
  RuntimeTerminals,
  RuntimeThreads,
  SandboxProviderApi,
} from 'runtime/contracts';

/** The scope one lease read binds: a Project's lease, or a Thread's. */
export type LeaseScope =
  | { readonly projectId: string }
  | { readonly threadId: string };

/**
 * The contract stubs the routes and sockets call (design 57 §8.1). Each one
 * resolves its provider at call time, so a route reaches the generation that
 * is active when the request arrives.
 */
export interface TransportServices {
  readonly runtime: Runtime;
  readonly threads: RuntimeThreads;
  readonly terminals: RuntimeTerminals;
  /** `runtime.lease/v1` bound to one request's Project or Thread. */
  lease(scope: LeaseScope): RuntimeLease;
  readonly sandbox: SandboxProviderApi;
  readonly tools: Tools;
  readonly models: Models;
  readonly secrets: Secrets;
  readonly configuration: Configuration;
}
