// The calls in flight of one relay (spec `docs/designs/grpc-processes.md`,
// section 6, "Drain"): what `inFlight` counts, the calls pinned to each
// instance's control stream, and how a drain, a stream's end or the close
// ends them.

import { create } from '@bufbuild/protobuf';

import { ContractError } from '../../contracts/error.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import { toStatus } from '../../contracts/status.js';
import type { CallRelay, ControlChannel } from './calls.js';
import {
  type InstanceKey,
  type InstanceRecord,
  instanceKey,
} from './instances.js';
import { PinnedCall, type Pins } from './pinned.js';
import { gatewayCaller } from './route.js';

/** A call in flight, as `CallRelay.inFlight` counts it. */
export interface Flight {
  /** The instance that made it. */
  readonly from: InstanceKey;
  /** Whether its method is `resumable`. */
  readonly resumable: boolean;
  /** The instance and call it is pinned to, once pinned. */
  pinned?: { readonly key: InstanceKey; readonly call: PinnedCall };
  /** Aborted when the drain deadline ends it before it was pinned. */
  readonly cut: AbortController;
  /** A connection the gateway proxied (`trackConnection`), and its cancel. */
  readonly connection?: {
    readonly key: InstanceKey;
    readonly cancel: () => void;
  };
}

/** Resolves when the drain deadline cuts `flight`. */
export const cutOff = (flight: Flight): Promise<void> =>
  new Promise((resolve) => {
    if (flight.cut.signal.aborted) {
      resolve();

      return;
    }

    flight.cut.signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  });

/**
 * `body`, then `done()` once it was read to its end or abandoned and
 * `closed` aborted: the HTTP/2 stream closed, so its trailers were sent.
 */
export async function* landing(
  body: AsyncIterable<Uint8Array>,
  closed: AbortSignal,
  done: () => void,
): AsyncGenerator<Uint8Array> {
  try {
    yield* body;
  } finally {
    if (closed.aborted) {
      done();
    } else {
      closed.addEventListener('abort', done, { once: true });
    }
  }
}

/** The status of a call that `key`'s drain ended. */
export const drained = (key: InstanceKey): Status =>
  toStatus(
    new ContractError('generation_lost', `The instance ${key} drained.`),
  );

/**
 * The calls in flight of one relay, and the {@link CallRelay} members that
 * read or end them.
 */
export interface Flights
  extends Pick<
    CallRelay,
    | 'endResumable'
    | 'inFlight'
    | 'onCallEnded'
    | 'cancelDrained'
    | 'trackConnection'
    | 'receive'
    | 'channelEnded'
  > {
  /** Counts a call `caller` made, until {@link Flights.land}. */
  track(caller: InstanceRecord, resumable: boolean): Flight;
  /** The call ended: stops counting it, then tells the listeners. Idempotent. */
  land(flight: Flight): void;
  /** A new call pinned to `key`, with the next call id of its stream. */
  pin(key: InstanceKey): PinnedCall;
  /** Whether `call` is pinned to `key` and not ended. */
  isOpen(key: InstanceKey, call: PinnedCall): boolean;
  /**
   * Sends `CallCancel { reason }` for an open call and ends it with
   * `status`; does nothing for a call already ended.
   */
  cancel(
    key: InstanceKey,
    call: PinnedCall,
    reason: 'cancelled' | 'deadline' | 'drained',
    status: Status,
  ): void;
  /** Ends every pinned call with `status` and cancels every connection. */
  close(status: Status): void;
}

/** No call in flight; `channel` carries a pinned call's `CallCancel`. */
export const createFlights = (
  channel: (key: InstanceKey) => ControlChannel | undefined,
): Flights => {
  /** The calls pinned to each instance, and the next call id of its stream. */
  const pins = new Map<InstanceKey, Pins>();
  const flights = new Set<Flight>();
  const endedListeners = new Set<
    (to: InstanceKey | undefined, from: InstanceKey) => void
  >();

  const land = (flight: Flight): void => {
    if (!flights.delete(flight)) {
      return;
    }

    for (const listener of [...endedListeners]) {
      try {
        listener(flight.pinned?.key ?? flight.connection?.key, flight.from);
      } catch {
        // A failing listener stops neither the others nor the call's end.
      }
    }
  };
  /** Stops counting a proxied connection, then cancels it. Idempotent. */
  const cutConnection = (flight: Flight): void => {
    if (flight.connection === undefined || !flights.has(flight)) {
      return;
    }

    land(flight);

    try {
      flight.connection.cancel();
    } catch {
      // A failing `cancel` is ignored.
    }
  };
  const isOpen = (key: InstanceKey, call: PinnedCall): boolean =>
    pins.get(key)?.open.has(call.id) === true;
  const end = (key: InstanceKey, call: PinnedCall, status: Status): void => {
    if (pins.get(key)?.open.delete(call.id) === true) {
      call.push(status);
    }
  };
  const cancel: Flights['cancel'] = (key, call, reason, status) => {
    if (isOpen(key, call)) {
      channel(key)?.send({
        frame: { case: 'callCancel', value: { callId: call.id, reason } },
      });
      end(key, call, status);
    }
  };
  const track = (
    caller: InstanceRecord,
    resumable: boolean,
    connection?: Flight['connection'],
  ): Flight => {
    const flight: Flight = {
      from: instanceKey(caller),
      resumable,
      cut: new AbortController(),
      ...(connection === undefined ? {} : { connection }),
    };

    flights.add(flight);

    return flight;
  };

  return {
    track,
    land,
    pin: (key) => {
      const pinned = pins.get(key) ?? { nextId: 1n, open: new Map() };
      const call = new PinnedCall(pinned.nextId);

      pinned.nextId += 1n;
      pinned.open.set(call.id, call);
      pins.set(key, pinned);

      return call;
    },
    isOpen,
    cancel,
    endResumable: (key) => {
      for (const flight of [...flights]) {
        if (flight.resumable && flight.pinned?.key === key) {
          cancel(key, flight.pinned.call, 'drained', drained(key));
          land(flight);
        }
      }
    },
    inFlight: (key) =>
      [...flights].filter(
        (flight) =>
          flight.from === key ||
          flight.pinned?.key === key ||
          flight.connection?.key === key,
      ).length,
    onCallEnded: (listener) => {
      const entry = (to: InstanceKey | undefined, from: InstanceKey): void =>
        listener(to, from);

      endedListeners.add(entry);

      return () => {
        endedListeners.delete(entry);
      };
    },
    cancelDrained: (key) => {
      for (const flight of [...flights]) {
        const { pinned } = flight;

        if (flight.connection?.key === key) {
          cutConnection(flight);
        } else if (
          pinned !== undefined &&
          (pinned.key === key || flight.from === key)
        ) {
          cancel(pinned.key, pinned.call, 'drained', drained(key));
          land(flight);
        } else if (flight.from === key) {
          flight.cut.abort();
          land(flight);
        }
      }
    },
    trackConnection: (key, onCut) => {
      const flight = track(gatewayCaller, false, { key, cancel: onCut });

      return () => land(flight);
    },
    receive: (key, frame) => {
      const pinned = pins.get(key);
      const call = pinned?.open.get(frame.value.callId);

      if (frame.case === 'callCredit') {
        call?.grant(frame.value.messages);

        return true;
      }

      if (pinned === undefined || call === undefined) {
        return (
          pinned !== undefined &&
          frame.value.callId > 0n &&
          frame.value.callId < pinned.nextId
        );
      }

      if (frame.case === 'callEnd') {
        end(key, call, frame.value.status ?? create(StatusSchema));

        return true;
      }

      if (call.credit === 0) {
        return false;
      }

      call.credit -= 1;
      call.push(frame.value.payload);

      return true;
    },
    channelEnded: (key) => {
      const pinned = pins.get(key);

      pins.delete(key);

      for (const call of pinned?.open.values() ?? []) {
        call.push(
          toStatus(
            new ContractError(
              'generation_lost',
              `The control stream of ${key} ended.`,
            ),
          ),
        );
      }
    },
    close: (status) => {
      for (const [key, pinned] of pins) {
        for (const call of pinned.open.values()) {
          end(key, call, status);
        }
      }

      for (const flight of [...flights]) {
        cutConnection(flight);
      }
    },
  };
};
