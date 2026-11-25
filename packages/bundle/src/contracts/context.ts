import type { DescService } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';

import type { CallScope } from './call.js';
import type { AnyServiceDefinition } from './define.js';
import type { AnyServiceRef, ApiOf } from './types.js';

/** A registration that can be released early; `dispose` is idempotent. */
export interface Disposable {
  dispose(): void;
}

/** What `activate` and `whenAvailable` callbacks may return. */
export type Cleanup = () => void | Promise<void>;

/** The provider a `whenAvailable` callback is bound to. */
export interface ProviderInfo {
  readonly bundleId: string;
  readonly version: string;
}

/** The only thing a bundle part receives: access to versioned contracts. */
export interface Services {
  /** Provides a service declared in `provides`; each execute gets (input, call, services). */
  provide<D extends AnyServiceDefinition>(definition: D): Disposable;
  /** A typed stub of a contract in `requires` (or `doric.*`), optionally bound to a scope. */
  use<R extends AnyServiceRef>(contract: R, scope?: CallScope): ApiOf<R>;
  /** Runs the callback for each compatible provider, now and when one activates later. */
  whenAvailable<R extends AnyServiceRef>(
    contract: R,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ): Disposable;
}

/**
 * The contracts a client part calls: host contracts over Connect, the rest on
 * the envelope (phases 3–5).
 */
export interface ClientServices extends Services {
  /**
   * A Connect client of a `HOST` contract's generated descriptor over the
   * part's window transport (`bundle/client`'s `ClientPart.use`, resumable
   * streams included), each call with `doric-client-part: <this bundle>`
   * and `scope` as `doric-scope-bin`; or, for a `ref<T>()`, the envelope
   * stub as before. Creating the client makes no call; an out-of-bounds
   * `scope` throws `invalid_scope`, and a runtime without a window transport
   * (`ServiceRuntime.hostClients`) throws `unavailable`. A call of a
   * contract the part did not declare fails with `undeclared_requirement`
   * from the router; a host that is not reached, `unavailable`.
   */
  use<S extends DescService>(ref: S, scope?: CallScope): Client<S>;
  use<R extends AnyServiceRef>(contract: R, scope?: CallScope): ApiOf<R>;
  /**
   * For a generated descriptor: calls `callback` once, after the current
   * task, with the client and the provider when the window's pinned
   * generation lists a provider of its contract in the host catalog; never
   * otherwise (a window's host catalog does not change). Disposing before
   * the callback runs cancels it; disposing after runs its cleanup. For a
   * `ref<T>()`: as before.
   */
  whenAvailable<S extends DescService>(
    ref: S,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
    callback: (client: Client<S>, provider: ProviderInfo) => void | Cleanup,
  ): Disposable;
  whenAvailable<R extends AnyServiceRef>(
    contract: R,
    // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
    callback: (api: ApiOf<R>, provider: ProviderInfo) => void | Cleanup,
  ): Disposable;
}

export interface HostContext {
  readonly services: Services;
}

export interface DesktopContext {
  readonly services: Services;
}

export interface ClientContext {
  readonly services: Services;
}

export type Activate<
  Ctx extends HostContext | DesktopContext | ClientContext = HostContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks may return nothing or a cleanup; `void` keeps callbacks that end on a void call assignable, which `undefined` would reject
> = (ctx: Ctx) => void | Cleanup | Promise<void | Cleanup>;
