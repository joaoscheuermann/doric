// The SDK's side of the generation frames (spec
// `docs/designs/grpc-processes.md`, section 6, "Generation events and peer
// signals"): `context.generations`, and the delivery of `GenerationChanged`
// and `PeerSignal` to its handlers. Shared by `startBundle` and
// `bundle/testing`.

import { toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { Log } from '../../contracts/basic/log.js';
import type {
  GenerationChanged,
  Instance,
  PeerSignal,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import {
  type GenerationEvent,
  generationAckTimeoutMs,
} from '../../platform/router/control.js';
import type {
  BundleInstance,
  GenerationChangedEvent,
  HostGenerations,
  LiveGeneration,
  PeerSignalEvent,
} from './context.js';

export interface GenerationsOptions {
  /** This process's instance: the `self` of every event. */
  readonly instance: BundleInstance;
  /** Where a handler's failure is logged, at level `error`. */
  readonly log: Log;
  /**
   * How long `changed` waits for the handlers; `generationAckTimeoutMs`
   * (`control.ts`) when undefined. Tests pass shorter ones.
   */
  readonly ackTimeoutMs?: number;
}

/** `context.generations` and the frames it is fed with. */
export interface Generations {
  /** The object given to the bundle as `context.generations`. */
  readonly api: HostGenerations;
  /**
   * Delivers one `GenerationChanged` to the `onChanged` handlers, as
   * `HostGenerations.onChanged` says: the event is `frame.event`, its
   * `generation` and `incarnation` are `frame.subject`'s (this instance's
   * when the frame has no subject), `live` is `frame.live` with each
   * entry's instance and state (an entry whose state is neither `active`
   * nor `draining` is left out), and `self` is the instance. Resolves when
   * the caller should answer `GenerationAck { event: frame.event }`: once
   * every handler settled, or `ackTimeoutMs` after the call, or at once with
   * no handler; frames passed while one is delivered wait their turn, in
   * call order. Remembers `live` for the next peer signals. A frame whose
   * `event` is not a `GenerationEvent` (`control.ts`) runs no handler and
   * resolves at once. Never rejects.
   */
  changed(frame: GenerationChanged): Promise<void>;
  /**
   * Delivers one `PeerSignal` to the `onSignal` handlers, as
   * `HostGenerations.onSignal` says: `payload` is `frame.payload` as JSON
   * (`null` without one), `from` is `frame.from`, `live` the last `changed`
   * frame's (this instance alone as `active` before any). Returns once
   * every handler was called; never throws.
   */
  signal(frame: PeerSignal): void;
  /**
   * As {@link Generations.signal}, and resolves once every handler's
   * promise settled; never rejects. `bundle/testing`'s `peerSignal`.
   */
  signalled(frame: PeerSignal): Promise<void>;
}

const generationEvents: ReadonlySet<string> = new Set<GenerationEvent>([
  'draining',
  'activated',
  'lost',
  'stopped',
]);

const isGenerationEvent = (event: string): event is GenerationEvent =>
  generationEvents.has(event);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const bundleInstanceOf = (instance: Instance): BundleInstance => ({
  bundleId: instance.bundleId,
  generation: instance.generation,
  incarnation: instance.incarnation,
});

const liveOf = (frame: GenerationChanged): LiveGeneration[] =>
  frame.live.flatMap(({ instance, state }) =>
    instance !== undefined && (state === 'active' || state === 'draining')
      ? [
          {
            generation: instance.generation,
            incarnation: instance.incarnation,
            state,
          },
        ]
      : [],
  );

/**
 * Calls each handler with `value` at once, in order; resolves once every
 * one returned or settled. A failure is passed to `failed`.
 */
const callAll = <T>(
  handlers: Iterable<(value: T) => void | Promise<void>>,
  value: T,
  failed: (error: unknown) => void,
): Promise<void> => {
  const settled = [...handlers].map((handler) => {
    try {
      return Promise.resolve(handler(value)).catch(failed);
    } catch (error) {
      failed(error);

      return Promise.resolve();
    }
  });

  return Promise.all(settled).then(() => undefined);
};

/** Resolves with `promise`, or after `ms` when it has not settled by then. */
const withTimeout = (promise: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** New generation handlers, with none added. Never throws. */
export const createGenerations = (options: GenerationsOptions): Generations => {
  const { instance, log } = options;
  const ackTimeoutMs = options.ackTimeoutMs ?? generationAckTimeoutMs;
  const changedHandlers = new Set<
    (change: GenerationChangedEvent) => void | Promise<void>
  >();
  const signalHandlers = new Set<
    (signal: PeerSignalEvent) => void | Promise<void>
  >();
  let live: readonly LiveGeneration[] = [
    {
      generation: instance.generation,
      incarnation: instance.incarnation,
      state: 'active',
    },
  ];
  let delivered: Promise<void> = Promise.resolve();

  /** Adds `handler` under a fresh identity, so it can be added twice. */
  const add = <T>(
    handlers: Set<(value: T) => void | Promise<void>>,
    handler: (value: T) => void | Promise<void>,
  ): (() => void) => {
    const entry = (value: T): void | Promise<void> => handler(value);

    handlers.add(entry);

    return () => {
      handlers.delete(entry);
    };
  };

  const deliver = (frame: GenerationChanged): Promise<void> => {
    const { event } = frame;

    if (!isGenerationEvent(event)) {
      return Promise.resolve();
    }

    const subject = frame.subject ?? instance;

    live = liveOf(frame);

    if (changedHandlers.size === 0) {
      return Promise.resolve();
    }

    return withTimeout(
      callAll(
        changedHandlers,
        {
          event,
          generation: subject.generation,
          incarnation: subject.incarnation,
          self: instance,
          live,
        },
        (error) =>
          log.error('generation handler failed', {
            event,
            error: messageOf(error),
          }),
      ),
      ackTimeoutMs,
    );
  };

  const signalled = (frame: PeerSignal): Promise<void> =>
    callAll(
      signalHandlers,
      {
        topic: frame.topic,
        payload:
          frame.payload === undefined
            ? null
            : toJson(ValueSchema, frame.payload),
        from:
          frame.from === undefined
            ? { bundleId: instance.bundleId, generation: 0, incarnation: 0 }
            : bundleInstanceOf(frame.from),
        self: instance,
        live,
      },
      (error) =>
        log.error('peer signal handler failed', {
          topic: frame.topic,
          error: messageOf(error),
        }),
    );

  return {
    api: {
      onChanged: (handler) => add(changedHandlers, handler),
      onSignal: (handler) => add(signalHandlers, handler),
    },
    changed: (frame) => {
      delivered = delivered.then(() => deliver(frame));

      return delivered;
    },
    signal: (frame) => {
      void signalled(frame);
    },
    signalled,
  };
};
