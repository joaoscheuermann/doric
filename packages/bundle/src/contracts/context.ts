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
