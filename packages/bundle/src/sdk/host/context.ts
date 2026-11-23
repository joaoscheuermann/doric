// What a host part's `activate` and `deactivate` receive (spec
// `docs/designs/grpc-processes.md`, section 10, "The TypeScript SDK").

import type { DescService, JsonValue } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';

import type { Log } from '../../contracts/basic/log.js';
import type { GenerationEvent } from '../../platform/router/control.js';
import type { ResumeRequests } from '../../runtime/resumable.js';

/**
 * The instance a bundle process is, read from `DORIC_BUNDLE_ID`,
 * `DORIC_GENERATION` and `DORIC_INCARNATION` (section 7, "Spawn"): the
 * `instance` of its Hello. Fixed for the life of the process.
 */
export interface BundleInstance {
  readonly bundleId: string;
  readonly generation: number;
  readonly incarnation: number;
}

/**
 * How {@link HostServices.use} chooses the instance it calls and reopens
 * the resumable streams of `S`. With the default `S` it carries no
 * `resume` request, as before `resume` existed.
 */
export interface UseOptions<S extends DescService = DescService> {
  /**
   * The bundle id of the provider to call, for a contract with more than one
   * provider; absent, the router's choice for the contract.
   */
  readonly provider?: string;
  /**
   * The instance to call, `<bundleId>/<generation>/<incarnation>`, for a
   * handler service of a contract the bundle provides; sent as
   * `doric-target`.
   */
  readonly target?: string;
  /**
   * The requests that reopen resumable streams of `S` after an item was
   * received; a method without one reopens with its original request.
   */
  readonly resume?: ResumeRequests<S>;
}

/** The contracts a host part calls, over the router listener. */
export interface HostServices {
  /**
   * A Connect client of `ref` over the router transport
   * (`createRouterTransport` with the instance's URL and token, no `parent`,
   * and `options`' `provider` and `target`): each call carries the
   * instance's token, and a call made inside a handler inherits that call's
   * deadline, scope, trace and signal (`currentCall()`). Creating the client
   * makes no call and never throws; a call fails as the router or the
   * provider ends it (`UNIMPLEMENTED`, `PERMISSION_DENIED`, …), with a
   * `ConnectError` whose Doric code `fromConnectError` reads. Usable from
   * `activate` until the process exits, `deactivate` included.
   *
   * While the SDK replays the registrations of `ref`'s contract to a new
   * provider instance (`ProviderChanged`, {@link HostRegistrations}), a new
   * call through the client waits and starts after the last replay settled,
   * in the order the calls were made.
   *
   * A server-streaming method whose descriptor has
   * `(doric.platform.v1.method).resumable = true` returns a stream that
   * `reopenResumable` (`runtime/resumable.ts`) iterates (section 4,
   * "Resumable streams"): when an opening ends with `generation_lost`, the
   * client opens it again after the delays of `resumableDelays`, with
   * `options.resume`'s request for the method built from the last item
   * received, or the original request when there is none or no item
   * arrived; the caller's next item is the new opening's first, its
   * snapshot. Each opening is a new call through the client, with the call
   * options of the call, and waits for a replay as any new call does. Their
   * `signal` aborting ends the iteration and cancels a pending reopening.
   * Any other error ends the iteration with that error. Other methods are
   * not reopened. The same holds for `bundle/testing`'s
   * `context.services.use`.
   */
  use<S extends DescService>(ref: S, options?: UseOptions<S>): Client<S>;
}

/** How {@link HostRegistrations.track} calls and replays a registration. */
export interface TrackOptions<R> extends UseOptions {
  /**
   * Called with the answer of each successful replay, after it replaced
   * {@link TrackedRegistration.current}; so the bundle learns the
   * `registrationId` the new provider instance answered. A throw is logged
   * at level `error` and changes nothing else.
   */
  readonly onReplayed?: (result: R) => void;
}

/** A live registration the SDK replays to each new provider instance. */
export interface TrackedRegistration<R> {
  /** The answer of the last successful call: the first, or a replay's. */
  readonly current: R;
  /**
   * Stops replaying the registration; the provider is not called (the
   * bundle calls the contract's removal method itself). Idempotent.
   */
  untrack(): void;
}

/**
 * The registrations a host part made with the contracts it calls, which
 * the SDK replays when a provider gets a new instance (section 4, "When a
 * provider changes").
 *
 * On `ProviderChanged { contractId, instance }` the SDK queues the bundle's
 * new calls to the contract (see {@link HostServices.use}), calls again the
 * `register` of each live registration of that contract, one after the
 * other in the order they were tracked, then sends `ReplayDone
 * { contractId, instance }` and releases the queue. A registration tracked
 * with `provider` is replayed only when `instance.bundleId` is that
 * provider. With no live registration of the contract, `ReplayDone` follows
 * at once. A replay that rejects is logged at level `error` with the
 * contract and the error; the registration stays tracked, keeps its
 * `current`, and the next replays and `ReplayDone` still follow.
 */
export interface HostRegistrations {
  /**
   * Calls `register` with a client of `ref` (`services.use(ref, options)`)
   * and, when it resolves, tracks it for replay and resolves with the
   * tracked registration, whose `current` is the answer. When `register`
   * rejects, rejects with its error and tracks nothing. `register` must make
   * the registration call again each time it is called, with the same
   * request; its own failures are the provider's errors as `use` answers
   * them. Usable from `activate` until the instance stops.
   */
  track<S extends DescService, R>(
    ref: S,
    register: (client: Client<S>) => Promise<R>,
    options?: TrackOptions<R>,
  ): Promise<TrackedRegistration<R>>;
}

/**
 * The instances that end, for a host part that provides a registration
 * contract (section 4, "When an instance ends").
 */
export interface HostInstances {
  /**
   * Calls `handler` with the instance of each `InstanceGone` the router
   * sends, in the order they arrive, so the provider drops the gone
   * instance's registrations, holds and leases
   * (`RegistrationTable.dropInstance`). Answers the function that removes
   * the handler. A handler that throws is logged at level `error`; the
   * other handlers still run.
   */
  onGone(handler: (instance: BundleInstance) => void): () => void;
}

/** A live instance of the bundle, as a generation event lists it. */
export interface LiveGeneration {
  readonly generation: number;
  readonly incarnation: number;
  readonly state: 'active' | 'draining';
}

/**
 * A `GenerationChanged` frame (section 6), with today's fields of
 * `onGenerationChangedHook` (`contracts/platform.ts`) less `holds`.
 */
export interface GenerationChangedEvent {
  readonly event: GenerationEvent;
  /** The subject's generation: the instance the event is about. */
  readonly generation: number;
  /** The subject's incarnation. */
  readonly incarnation: number;
  /** This process's instance. */
  readonly self: BundleInstance;
  /** The bundle's `active` and `draining` instances after the change. */
  readonly live: readonly LiveGeneration[];
}

/**
 * A `PeerSignal` frame (section 6): what another instance of the bundle
 * sent with `doric.generation/v1.Signal`, with today's fields of
 * `onPeerSignalHook`.
 */
export interface PeerSignalEvent {
  readonly topic: string;
  /** The signal's `payload`, as JSON; `null` when it had none. */
  readonly payload: JsonValue;
  /** The instance that sent it, of this bundle. */
  readonly from: BundleInstance;
  /** This process's instance. */
  readonly self: BundleInstance;
  /**
   * The `live` of the last {@link GenerationChangedEvent} this process
   * received; before any, this instance alone as `active`.
   */
  readonly live: readonly LiveGeneration[];
}

/**
 * The generation events and peer signals of the bundle's instances
 * (section 6, "Generation events and peer signals", D5): the frames that
 * replace `onGenerationChangedHook` and `onPeerSignalHook`.
 */
export interface HostGenerations {
  /**
   * Calls `handler` with each `GenerationChanged` the router sends this
   * instance, until the function it answers is called. The handlers of one
   * frame run at once, in the order they were added, and the SDK answers
   * `GenerationAck { event }` when every one of them has returned or
   * settled, or `generationAckTimeoutMs` (10 s, `control.ts`) after the
   * frame arrived, whichever comes first; with no handler, at once. So a
   * `doric.generation/v1.Hold` a `draining` handler takes before it returns
   * keeps the instance alive. Frames are delivered in arrival order: a
   * frame's handlers start once the previous frame was acknowledged. A
   * handler that throws or rejects is logged at level `error` with the
   * event; the others still run and the ack is still sent. Usable from
   * `activate` until the process exits; a frame that arrives before any
   * handler is added is acknowledged and not replayed.
   */
  onChanged(
    handler: (change: GenerationChangedEvent) => void | Promise<void>,
  ): () => void;
  /**
   * Calls `handler` with each `PeerSignal` the router delivers to this
   * instance, in arrival order, until the function it answers is called.
   * Nothing is answered to the router; a handler's promise is not awaited
   * before the next signal. A handler that throws or rejects is logged at
   * level `error` with the topic; the others still run. A signal that
   * arrives before any handler is added is dropped.
   */
  onSignal(
    handler: (signal: PeerSignalEvent) => void | Promise<void>,
  ): () => void;
}

/**
 * The context of a host part, one per process, given to `activate` and to
 * `deactivate` (the same object both times).
 *
 * `context.assets` lands with section 14.
 */
export interface HostContext {
  /** The instance this process is. */
  readonly instance: BundleInstance;
  readonly services: HostServices;
  /** The registrations the SDK replays to new provider instances. */
  readonly registrations: HostRegistrations;
  /** The instances that end, as `InstanceGone` names them. */
  readonly instances: HostInstances;
  /** The bundle's generation events and peer signals. */
  readonly generations: HostGenerations;
  /**
   * The log facade: synchronous, never throws, never awaited. The record
   * carries the instance.
   */
  readonly log: Log;
  /**
   * Aborted when the instance stops: on `Stop`, before `deactivate` runs, and
   * when the host is gone. Never aborted before `Activate`.
   */
  readonly signal: AbortSignal;
}
